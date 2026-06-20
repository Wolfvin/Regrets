#!/usr/bin/env ruby
# frozen_string_literal: true
# fingerprint_rb.rb — deterministic hash for regression contracts
# IDENTICAL algorithm to fingerprint.js / fingerprint.py / fingerprint_php.php.
# Same input must produce same 7-char base36 hash.
#
# Shared module — required by capture_ruby.rb and validate_ruby.rb.
# Do NOT duplicate these functions.
#
# Cross-stack consistency contract:
#   sha256(stableStringify(input) + '|' + stableStringify(output)) → base36 → first 7 chars
#
# Parity verified manually with JS, PHP, Python — see
# proof/ruby_keccak/PARITY.md for cross-stack hash comparison.

require 'json'
require 'digest'
require 'set'
require 'time'  # Time#iso8601 — needed for .regret timestamp + deep_clone of Time objects

module RegretTesting
  module Fingerprint
    module_function

    # ─── Stable JSON serialization (mirrors JS stableStringify / Python stable_dumps) ───
    # Keys sorted recursively. Compact separators (no spaces). UTF-8 preserved.

    def stable_dumps(obj)
      JSON.generate(_stable_sort(obj), ascii_only: false)
    end

    def _stable_sort(obj)
      case obj
      when nil, true, false, Integer, Float, String then obj
      when Symbol then obj.to_s
      when Array then obj.map { |v| _stable_sort(v) }
      when Hash
        # Sort keys alphabetically (string comparison), recurse values.
        sorted = obj.keys.sort_by { |k| k.to_s }
        result = {}
        sorted.each do |k|
          result[k.to_s] = _stable_sort(obj[k])
        end
        result
      when Time then obj.iso8601
      else
        # Best-effort: stringify via to_s. Matches PHP's behavior of falling
        # through to JSON.Marshal for unknown types.
        obj.to_s
      end
    end

    # ─── Normalize non-deterministic values before hashing ─────────────────────────
    # Implements the same rule set as fingerprint.js / fingerprint.py / fingerprint_php.php.
    # Unknown rules are silently ignored (forward-compat with new rules added to other stacks).

    def normalize(obj, rules = [])
      return obj if rules.nil? || rules.empty?

      case obj
      when String
        _normalize_string(obj, rules)
      when Integer
        _normalize_integer(obj, rules)
      when Float
        _normalize_float(obj, rules)
      when Array
        obj.map { |v| normalize(v, rules) }
      when Hash
        # autoIncrement:fields:field1,field2 — normalize only values in listed fields
        field_rule = rules.find { |r| r.is_a?(String) && r.start_with?('autoIncrement:fields:') }
        if field_rule
          id_fields = field_rule.split(':')[2]&.split(',') || []
          result = {}
          obj.each do |k, v|
            if id_fields.include?(k.to_s)
              result[k] = _normalize_id_value(v)
            else
              result[k] = normalize(v, rules)
            end
          end
          return result
        end
        # tokenOffsets: replace known offset keys with <OFFSET>
        if rules.include?('tokenOffsets')
          offset_keys = Set.new(%w[start end span_start span_end
                                   full_span_start full_span_end
                                   pin_cite_span_start pin_cite_span_end])
          result = {}
          obj.each do |k, v|
            if offset_keys.include?(k.to_s) && v.is_a?(Integer)
              result[k] = '<OFFSET>'
            else
              result[k] = normalize(v, rules)
            end
          end
          return result
        end
        # datetimeNow: replace serialized datetime dicts (from _serialize_time)
        # that represent "now".
        if rules.include?('datetimeNow') && obj.key?('__datetime__')
          today_iso = Time.now.utc.strftime('%Y-%m-%d')
          dt = obj['__datetime__']
          if dt.is_a?(String) && dt.start_with?(today_iso)
            return { '__datetime__' => '<DATETIME_NOW>', 'fold' => obj['fold'] || 0 }
          end
        end
        obj.transform_values { |v| normalize(v, rules) }
      else
        obj
      end
    end

    def _normalize_string(obj, rules)
      # timestamps: ISO 8601 → <TIMESTAMP>
      if rules.include?('timestamps') && obj.match?(/\A\d{4}-\d{2}-\d{2}T[\d:.Z+\-]+\z/)
        return '<TIMESTAMP>'
      end
      # uuids: standard UUID v4 → <UUID>
      if rules.include?('uuids') &&
         obj.match?(/\A[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\z/i)
        return '<UUID>'
      end
      # absPaths: leading slash → <ROOT>/...
      if rules.include?('absPaths') && obj.start_with?('/')
        parts = obj.split('/')
        return '<ROOT>/' + parts[3..].join('/') if parts.length >= 3
      end
      # dynamicDates: MMYYYY / YYYY patterns
      if rules.include?('dynamicDates')
        result = obj.gsub(/(0[1-9]|1[0-2])\d{4}/, '<MMYYYY>')
        result = result.gsub(/(?<!\d)(20\d{2}|19\d{2})(?!\d)/, '<YYYY>')
        return result
      end
      # normalizeNow: same as dynamicDates but for "now"-derived output
      if rules.include?('normalizeNow')
        result = obj.gsub(/(0[1-9]|1[0-2])\d{4}/, '<NOW_MMYYYY>')
        result = result.gsub(/(?<!\d)(20\d{2}|19\d{2})(?!\d)/, '<NOW_YYYY>')
        return result
      end
      # isoDates: replace any ISO 8601 date entirely with placeholder
      if rules.include?('isoDates')
        return obj.gsub(/\d{4}-\d{2}-\d{2}(T[\d:.]+(?:[Zz]|[+-]\d{2}:\d{2})?)?/, '<ISO_DATE>')
      end
      # timezoneOffsets: replace UTC offset strings
      if rules.include?('timezoneOffsets')
        return obj.gsub(/[Zz]|[+-]\d{2}:\d{2}/, '<TZ_OFFSET>')
      end
      # floatPrecision: strip trailing ".0" from number-like strings
      if rules.include?('floatPrecision')
        return obj.sub(/\A-?(\d+)\.0+\z/, '\1')
      end
      # incrementingIds: replace lodash/uniqueId-style or pure-numeric IDs
      if rules.include?('incrementingIds')
        m = obj.match(/\A(.+[-_:])(\d+)\z/)
        return m[1] + '<ID>' if m
        return '<ID>' if obj.match?(/\A\d+\z/) && obj.length <= 10
        return '<ID>' if obj.match?(/\A:r[s]?\d+:\z/)
        if obj.match?(/\A[A-Za-z0-9_-]{8,30}\z/) &&
           !obj.match?(/\A(true|false|null|undefined|NaN|Infinity)\z/)
          return '<ID>' if obj.match?(/[A-Za-z]/) && obj.match?(/\d/)
        end
      end
      # randomIds: replace high-entropy lowercase alphanumeric strings
      if rules.include?('randomIds') && obj.match?(/\A[a-z0-9]{8,24}\z/)
        letters = obj.scan(/[a-z]/).length
        digits = obj.scan(/[0-9]/).length
        unique_chars = obj.chars.uniq.length
        return '<RANDOM_ID>' if letters >= 3 && digits >= 2 && unique_chars >= 6
      end
      # autoIncrement: replace prefix-digits with prefix<ID>
      if rules.include?('autoIncrement')
        return obj.gsub(/([a-zA-Z_]+)\d+/, '\1<ID>')
      end
      obj
    end

    def _normalize_integer(obj, rules)
      if rules.include?('epochs') && obj > 1_000_000_000 && obj < 9_999_999_999_999
        return '<EPOCH>'
      end
      # currentYearBound: replace current year / next year
      if rules.include?('currentYearBound')
        this_year = Time.now.year
        return '<CURRENT_YEAR>'     if obj == this_year
        return '<CURRENT_YEAR+1>' if obj == this_year + 1
      end
      # autoIncrement (no :fields qualifier): replace small positive ints with <ID>
      if rules.include?('autoIncrement') &&
         !rules.any? { |r| r.is_a?(String) && r.start_with?('autoIncrement:fields:') } &&
         obj.between?(1, 9999)
        return '<ID>'
      end
      obj
    end

    def _normalize_float(obj, rules)
      if rules.include?('epochs') && obj > 1_000_000_000 && obj < 9_999_999_999_999
        return '<EPOCH>'
      end
      # floatTolerance: round to N decimal places (default 2)
      ft_rule = rules.find { |r| r.is_a?(String) && r.start_with?('floatTolerance') }
      if ft_rule
        decimals = ft_rule.include?(':') ? ft_rule.split(':')[1].to_i : 2
        factor = 10**decimals
        return (obj * factor).round.to_f / factor
      end
      # floatPrecision: whole floats → int; non-whole → round 2 decimals
      if rules.include?('floatPrecision') && obj.finite?
        return obj.to_i if obj == obj.to_i
        return (obj * 100).round.to_f / 100
      end
      obj
    end

    def _normalize_id_value(val)
      case val
      when String then val.gsub(/([a-zA-Z_]+)\d+/, '\1<ID>')
      when Integer then val.between?(1, 9999) ? '<ID>' : val
      else val
      end
    end

    # ─── Strip ignored fields from output before hashing ──────────────────────────

    def strip_fields(obj, fields = [])
      return obj if fields.nil? || fields.empty?

      case obj
      when Array
        obj.map { |v| strip_fields(v, fields) }
      when Hash
        result = {}
        obj.each do |k, v|
          result[k] = strip_fields(v, fields) unless fields.include?(k.to_s)
        end
        result
      else
        obj
      end
    end

    # ─── Base36 conversion (mirrors JS BigInt.toString(36) / Python to_base36) ───

    def to_base36(hex_str)
      # Ruby's Integer#to_s(36) produces lowercase base36 — matches JS/Python/PHP.
      hex_str.to_i(16).to_s(36)
    end

    # ─── Deep clone via JSON round-trip ───────────────────────────────────────────
    # Handles Ruby-specific concerns: Symbol keys → String, Time → ISO 8601,
    # arbitrary objects → snapshot via to_h / to_hash / instance_variables.

    def deep_clone(val)
      _deep_clone_inner(val, Set.new)
    end

    def _deep_clone_inner(val, seen)
      case val
      when nil, true, false, Integer, Float, String then val
      when Symbol then val.to_s
      when Array
        return '__circular__' if seen.include?(val.object_id)
        seen.add(val.object_id)
        result = val.map { |v| _deep_clone_inner(v, seen) }
        seen.delete(val.object_id)
        result
      when Hash
        return '__circular__' if seen.include?(val.object_id)
        seen.add(val.object_id)
        result = {}
        val.each do |k, v|
          result[k.to_s] = _deep_clone_inner(v, seen)
        end
        seen.delete(val.object_id)
        result
      when Time
        { '__datetime__' => val.iso8601, 'fold' => 0 }
      when ->(v) { v.respond_to?(:to_h) && !v.is_a?(String) && !v.is_a?(Array) }
        begin
          h = val.to_h
          return _deep_clone_inner(h, seen)
        rescue StandardError
          # fall through
        end
        val.to_s
      else
        val.to_s
      end
    end

    # ─── Core fingerprint function ────────────────────────────────────────────────

    def fingerprint(input_data, output_data, rules = [], ignore_fields = [])
      clean_input  = strip_fields(normalize(deep_clone(input_data),  rules), ignore_fields)
      clean_output = strip_fields(normalize(deep_clone(output_data), rules), ignore_fields)

      combined = stable_dumps(clean_input) + '|' + stable_dumps(clean_output)
      hash_hex = Digest::SHA256.hexdigest(combined)
      to_base36(hash_hex)[0, 7]
    end

    # ─── Fingerprint an entire call sequence (fingerprintLevel: full / watched) ───

    def fingerprint_sequence(calls, rules = [], ignore_fields = [])
      normalized = calls.map do |call|
        {
          'fn'     => call['fn'] || call[:fn],
          'args'   => strip_fields(normalize(deep_clone(call['args']   || call[:args]),   rules), ignore_fields),
          'result' => strip_fields(normalize(deep_clone(call['result'] || call[:result]), rules), ignore_fields)
        }
      end
      combined = stable_dumps(normalized)
      hash_hex = Digest::SHA256.hexdigest(combined)
      to_base36(hash_hex)[0, 7]
    end

    # ─── Extract structural schema (mirrors JS extractSchema / Python extract_schema) ─

    def extract_schema(obj)
      case obj
      when nil then 'null'
      when true, false then 'boolean'
      when Integer, Float then 'number'
      when String then 'string'
      when Symbol then 'string'
      when Array
        return 'array' if obj.empty?
        sample_size = [obj.length, 5].min
        schemas = []
        seen = Set.new
        sample_size.times do |i|
          s = extract_schema(obj[i])
          key = stable_dumps(s)
          unless seen.include?(key)
            seen.add(key)
            schemas << s
          end
        end
        schemas.length == 1 ? [schemas[0]] : schemas
      when Hash
        keys = obj.keys.map(&:to_s).sort
        schema = {}
        keys.each { |k| schema[k] = extract_schema(obj[k]) }
        schema
      else
        'unknown'
      end
    end
  end
end

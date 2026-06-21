#!/usr/bin/env ruby
# frozen_string_literal: true
# validate_ruby.rb — regression validator for Ruby clusters
# Reads .regret files, re-invokes functions with the same inputs, compares hashes,
# reports PASS/FAIL.
#
# Usage:
#   ruby scripts/validate_ruby.rb
#   ruby scripts/validate_ruby.rb --cluster process-invoice
#   ruby scripts/validate_ruby.rb --runs 5                # drift detection (5 runs per cluster)
#   ruby scripts/validate_ruby.rb --update process-invoice --reason "specific reason"
#   ruby scripts/validate_ruby.rb --fail-fast

SCRIPT_DIR = File.expand_path(File.dirname(__FILE__))
PROJECT_DIR = Dir.pwd

require_relative 'fingerprint_rb.rb'
require 'fileutils'
include RegretTesting::Fingerprint

# ─── CLI args ─────────────────────────────────────────────────────────────────

def get_arg(args, flag)
  i = args.index(flag)
  i && args[i + 1]
end

args       = ARGV.dup
cluster_filter  = get_arg(args, '--cluster')
fail_fast       = args.include?('--fail-fast')
runs            = (get_arg(args, '--runs') || '1').to_i
update_target   = get_arg(args, '--update')
update_reason   = get_arg(args, '--reason')
manifest_path   = get_arg(args, '--manifest') || File.join(PROJECT_DIR, 'regrets', 'manifest.json')
regret_dir      = File.join(PROJECT_DIR, 'regrets')
audit_log       = File.join(regret_dir, 'audit.log')

# ─── Validate --update usage ──────────────────────────────────────────────────

if update_target && !update_reason
  warn '❌ --update requires --reason'
  warn '   Example: --update process-invoice --reason "describe why behavior changed"'
  exit 1
end

if update_reason && update_reason.split(/\s+/).length < 4
  warn "❌ --reason is too vague: \"#{update_reason}\""
  warn '   Be specific. e.g. "tax rate updated from 11% to 12% per new regulation"'
  exit 1
end

# ─── Parse a .regret file ─────────────────────────────────────────────────────

def parse_regret(content)
  sections = content.split("\n---\n", 2)
  meta_section = sections[0]
  data_section = sections[1] || ''

  meta = {}
  meta_section.each_line do |line|
    line = line.chomp
    colon_idx = line.index(': ')
    next unless colon_idx

    key = line[0...colon_idx]
    val = line[(colon_idx + 2)..].strip

    case key
    when 'watches', 'normalize', 'ignoreFields', 'valuePaths'
      inner = val.tr('[]', '').strip
      meta[key] = inner.split(',').map(&:strip).reject(&:empty?)
    when 'version'
      meta[key] = val.to_i
    when 'multiArgs'
      meta[key] = val == 'true'
    else
      meta[key] = val
    end
  end

  input_line  = nil
  output_line = nil
  hash_line   = nil
  data_section.each_line do |line|
    line = line.chomp
    input_line  = line if line.start_with?('INPUT ')
    output_line = line if line.start_with?('OUTPUT ')
    hash_line   = line if line.start_with?('HASH ')
  end

  parsed_input  = nil
  parsed_output = nil
  if input_line
    s = input_line.sub(/\AINPUT\s+/, '')
    parsed_input = s == 'undefined' ? nil : JSON.parse(s)
  end
  if output_line
    s = output_line.sub(/\AOUTPUT\s+/, '')
    parsed_output = s == 'undefined' ? nil : JSON.parse(s)
  end

  meta.merge(
    'input'      => parsed_input,
    'output'     => parsed_output,
    'goldenHash' => hash_line ? hash_line.sub(/\AHASH\s+/, '').strip : nil,
    'raw'        => content
  )
end

# ─── Resolve entry callable (shared with capture_ruby.rb) ─────────────────────

def resolve_entry(entry, constructor_args)
  if entry.include?('#')
    class_name, method_name = entry.split('#', 2)
    klass = Object.const_get(class_name) rescue nil
    raise "Class not found: #{class_name}" unless klass

    instance = constructor_args ? klass.new(*constructor_args) : klass.new
    [instance, method_name.to_sym]
  elsif entry.include?('.')
    class_name, method_name = entry.split('.', 2)
    klass = Object.const_get(class_name) rescue nil
    raise "Class not found: #{class_name}" unless klass
    raise "Class method not found: #{entry}" unless klass.respond_to?(method_name)
    [klass, method_name.to_sym]
  else
    raise "Top-level function not found: #{entry}" unless Object.respond_to?(entry, true)
    [Object, entry.to_sym]
  end
end

def invoke_entry(receiver, method_name, input, multi_args)
  if multi_args && input.is_a?(Array)
    receiver.send(method_name, *input)
  elsif input.nil?
    receiver.send(method_name)
  else
    receiver.send(method_name, input)
  end
end

# ─── Run cluster N times ──────────────────────────────────────────────────────

def run_cluster(cluster_def, regret, runs)
  entry        = cluster_def['entry']
  file         = cluster_def['file'] || ''
  rules        = cluster_def['normalize'] || []
  ignore       = cluster_def['ignoreFields'] || []
  multi_args   = cluster_def['multiArgs'] || false
  constructor  = cluster_def['constructorArgs']
  fp_mode      = regret['fingerprintMode'] || cluster_def['fingerprintMode'] || 'value'
  value_paths  = regret['valuePaths'] || cluster_def['valuePaths'] || []

  abs_file = File.expand_path(file, PROJECT_DIR)
  require abs_file if file && !file.empty? && File.exist?(abs_file)

  hashes = []
  hashes_per_input = {}
  last_output = nil

  all_inputs = cluster_def['inputs'] || [regret['input']]
  inputs_to_validate = [regret['input']]
  all_inputs.each do |inp|
    inputs_to_validate << inp unless JSON.generate(inp) == JSON.generate(regret['input'])
  end

  runs.times do
    inputs_to_validate.each do |current_input|
      input_for_fp   = deep_clone(current_input)
      input_for_args = deep_clone(current_input)

      receiver, method_name = resolve_entry(entry, constructor)
      output = invoke_entry(receiver, method_name, input_for_args, multi_args)
      last_output = output

      case fp_mode
      when 'schema'
        schema = extract_schema(output)
        fp = fingerprint(input_for_fp, schema, rules, ignore)
      when 'mixed'
        schema = extract_schema(output)
        selected = {}
        value_paths.each do |path|
          key = path.to_s.sub(/^\$\./, '')
          val = output
          key.split('.').each do |part|
            val = val.is_a?(Hash) ? val[part] : nil
            break if val.nil?
          end
          selected[path] = val unless val.nil?
        end
        combined = { 'schema' => schema, 'values' => selected }
        fp = fingerprint(input_for_fp, combined, rules, ignore)
      else
        fp = fingerprint(input_for_fp, output, rules, ignore)
      end

      hashes << fp
      input_key = JSON.generate(current_input)
      hashes_per_input[input_key] ||= []
      hashes_per_input[input_key] << fp
    end
  end

  { 'hashes' => hashes, 'hashesPerInput' => hashes_per_input, 'lastOutput' => last_output }
end

# ─── Update a .regret (audit chain) ───────────────────────────────────────────

def update_regret(regret_path, regret, new_hash, live_output, reason)
  old_hash = regret['goldenHash']
  now = Time.now.utc.iso8601(6)
  safe_reason = reason.gsub(/[\r\n]+/, ' ')

  new_content = regret['raw']
  new_content = new_content.sub(/^fingerprint: .+$/m,  "fingerprint: #{new_hash}")
  new_content = new_content.sub(/^captured: .+$/m,     "captured: #{now}")
  new_content = new_content.sub(/^OUTPUT .+$/m,        'OUTPUT ' + JSON.generate(live_output, ascii_only: false))
  new_content = new_content.sub(/^HASH .+$/m,          "HASH   #{new_hash}")

  File.write(regret_path, new_content)

  # Hash chain — mirror PHP behavior: read last chain from audit.log if present.
  prev_chain = '0000000'
  if File.exist?(audit_log_path = File.join(PROJECT_DIR, 'regrets', 'audit.log'))
    log_content = File.read(audit_log_path).strip
    unless log_content.empty?
      log_content.each_line.to_a.reverse.each do |line|
        if line =~ /^\s*chain:\s*(\S+)/
          prev_chain = Regexp.last_match(1)
          break
        end
      end
    end
  end

  cluster_id = File.basename(regret_path, '.regret')
  entry = "#{now}  UPDATE  #{cluster_id}\n  old: #{old_hash}\n  new: #{new_hash}\n  reason: #{safe_reason}\n  by: AI refactor session"
  chain_hash = Digest::SHA256.hexdigest(prev_chain + entry)[0, 7]
  File.write(audit_log_path, "\n#{entry}\n  chain: #{chain_hash}", mode: 'a')

  { 'oldHash' => old_hash, 'newHash' => new_hash }
end

# ─── Main ─────────────────────────────────────────────────────────────────────

unless File.exist?(manifest_path)
  warn "❌ Could not read manifest: #{manifest_path}"
  exit 1
end
manifest = JSON.parse(File.read(manifest_path))

filter_id  = cluster_filter || update_target
regret_files = Dir.glob(File.join(regret_dir, '*.regret')).select do |f|
  # Skip callee files (.calls.X.regret) for now — those are JS-only.
  base = File.basename(f, '.regret')
  !base.include?('.calls.') && (!filter_id || base == filter_id)
end

if regret_files.empty?
  warn "❌ No .regret files found#{filter_id ? " for \"#{filter_id}\"" : ''}."
  exit 1
end

update_mode = !update_target.nil?
drift_mode  = runs > 1 && !update_mode

if update_mode
  puts
  puts "🔄 Update mode — cluster: #{update_target}"
  puts "   Reason: #{update_reason}"
  puts
elsif drift_mode
  puts
  puts "🔍 Drift detection — #{runs} runs per cluster..."
  puts
else
  puts
  puts "🔍 Validating #{regret_files.length} cluster(s)..."
  puts
end

results = []
regret_files.each do |path|
  id = File.basename(path, '.regret')
  regret = parse_regret(File.read(path))

  # Find matching cluster definition
  defn = manifest['clusters'].find { |c| c['id'] == id }
  unless defn
    puts "  ⚠️  #{id.ljust(35)} not in manifest — skipping"
    results << { 'id' => id, 'pass' => false }
    next
  end

  begin
    run_result = run_cluster(defn, regret, runs)
    hashes         = run_result['hashes']
    hashes_per_input = run_result['hashesPerInput']
    last_output    = run_result['lastOutput']

    live_hash = hashes[0]
    is_match = live_hash == regret['goldenHash']

    is_drift = false
    if drift_mode
      hashes_per_input.each_value do |input_hashes|
        if input_hashes.uniq.length > 1
          is_drift = true
          break
        end
      end
    end

    id_padded = id.ljust(35)

    if update_mode
      if is_match
        puts "  ℹ️  #{id_padded} unchanged — no update needed"
        results << { 'id' => id, 'pass' => true }
      else
        upd = update_regret(path, regret, live_hash, last_output, update_reason)
        puts "  ✅ #{id_padded} #{upd['oldHash']} → #{upd['newHash']}  UPDATED"
        results << { 'id' => id, 'pass' => true, 'updated' => true }
      end
    elsif drift_mode
      if is_drift
        puts "  ❌ #{id_padded} DRIFT  [#{hashes.join(' / ')}]"
        results << { 'id' => id, 'pass' => false, 'drift' => true }
      else
        icon = is_match ? '✅' : '❌'
        puts "  #{icon} #{id_padded} #{live_hash}  × #{runs}  " + (is_match ? 'PASS+STABLE' : 'FAIL')
        results << { 'id' => id, 'pass' => is_match }
      end
    else
      icon = is_match ? '✅' : '❌'
      hstr = is_match ? regret['goldenHash'] : "#{regret['goldenHash']} → #{live_hash}"
      puts "  #{icon} #{id_padded} #{hstr.ljust(22)} " + (is_match ? 'PASS' : 'FAIL')
      results << { 'id' => id, 'pass' => is_match, 'golden' => regret['goldenHash'], 'live' => live_hash }
    end
  rescue StandardError => e
    puts "  ❌ #{id.ljust(35)} ERROR: #{e.message}"
    results << { 'id' => id, 'pass' => false, 'error' => e.message }
  end

  last = results.last
  if !last['pass'] && fail_fast
    puts
    puts '  --fail-fast: stopping.'
    break
  end
end

# ─── Summary ──────────────────────────────────────────────────────────────────

passed  = results.count { |r| r['pass'] }
failed  = results.count { |r| !r['pass'] }
drifted = results.count { |r| r['drift'] }

puts
puts '─' * 60

if update_mode
  updated = results.count { |r| r['updated'] }
  puts "✅ Update complete. #{updated} updated."
  puts "   Audit: regrets/audit.log"
  exit 0
end

if drift_mode && drifted.positive?
  puts "❌ Drift in #{drifted} cluster(s). Add normalize rules and re-capture."
  exit 1
end

if failed.zero?
  puts "✅ All #{passed} tests passed#{drift_mode ? " (#{runs} runs — stable)" : ''}. Refactor is safe."
  puts
  exit 0
end

puts "❌ #{failed}/#{results.length} FAILED."
puts
results.reject { |r| r['pass'] }.each do |r|
  puts "  • #{r['id']}"
  if r['error']
    puts "    #{r['error']}"
  else
    puts "    Expected: #{r['golden']}  Got: #{r['live']}"
  end
end
puts
puts 'Fix the CODE — do not edit .regret files.'
puts 'Re-run: ruby scripts/validate_ruby.rb'
exit 1

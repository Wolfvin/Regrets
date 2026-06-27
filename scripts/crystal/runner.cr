# runner.cr — generic Crystal runner for Regrets capture & validate.
#
# Invoked by scripts/capture_crystal.sh and scripts/validate_crystal.sh.
# The bash driver generates a per-run wrapper that:
#   1. `require`s this runner
#   2. `require`s the user's Crystal source file (containing the entry function)
#   3. Calls RegretRunner.run(...) with the cluster config
#
# Modes:
#   capture:  invoke entry function with each input, compute fingerprint,
#             write .regret file (first input becomes the golden; all input→hash
#             pairs are recorded in an INPUTS line for multi-input validation).
#   validate: read .regret file, re-invoke entry with the same input,
#             compare live hash vs golden hash, print PASS/FAIL.

require "json"
require "time"
require "digest/sha256"
require "big"

require "./fingerprint"

module RegretRunner
  # ─── Manifest & cluster types ────────────────────────────────────────────

  struct Cluster
    include JSON::Serializable

    property id : String
    property entry : String
    property file : String
    property stack : String = "crystal"
    property fingerprintLevel : String = "entry"
    property watches : Array(String) = [] of String
    property inputs : Array(JSON::Any) = [] of JSON::Any
    property multiArgs : Bool = false
    property normalize : Array(String) = [] of String
    property ignoreFields : Array(String) = [] of String
    property description : String? = nil

    # Manual initializer with named args — JSON::Serializable only gives us
    # `new(pull : JSON::PullParser)`, but the generated runner .cr files
    # construct Cluster via named args.
    def initialize(
      *,
      @id : String,
      @entry : String,
      @file : String,
      @stack : String = "crystal",
      @fingerprintLevel : String = "entry",
      @watches : Array(String) = [] of String,
      @inputs : Array(JSON::Any) = [] of JSON::Any,
      @multiArgs : Bool = false,
      @normalize : Array(String) = [] of String,
      @ignoreFields : Array(String) = [] of String,
      @description : String? = nil
    )
    end
  end

  struct Manifest
    include JSON::Serializable
    property clusters : Array(Cluster)
  end

  # ─── Helpers ─────────────────────────────────────────────────────────────

  # Parse a .regret file → {meta, input_json, output_json, golden_hash}
  struct RegretFile
    property meta : Hash(String, String) = {} of String => String
    property input : JSON::Any = JSON::Any.new(nil)
    property output : JSON::Any = JSON::Any.new(nil)
    property golden_hash : String = ""
    property inputs_line : Array({ input: JSON::Any, hash: String }) = [] of { input: JSON::Any, hash: String }
  end

  def self.parse_regret(content : String) : RegretFile
    rf = RegretFile.new
    # CRLF -> LF guard: git core.autocrlf=true (Windows default) rewrites
    # .regret files to CRLF on checkout, turning the separator into
    # "\r\n---\r\n", which does not contain "\n---\n" as a substring, so
    # the split below silently fails to find it, leaving data_section
    # empty and rf.input nil (same root cause/severity as #522).
    content = content.gsub("\r\n", "\n")
    sections = content.split("\n---\n", 2)
    meta_section = sections[0]
    data_section = sections[1]? || ""

    meta_section.each_line do |line|
      colon_idx = line.index(": ")
      next unless colon_idx
      key = line[0...colon_idx]
      val = line[(colon_idx + 2)...].strip
      rf.meta[key] = val
    end

    # Parse INPUTS line (if present) — format:
    #   INPUTS [{"hash":"5nssd6s","input":"hello","output":"olleh"}, ...]
    data_section.each_line do |line|
      if line.starts_with?("INPUTS ")
        json_str = line[7..]
        begin
          arr = JSON.parse(json_str)
          if arr.raw.is_a?(Array)
            arr.as_a.each do |entry|
              input_val = entry["input"]? || JSON::Any.new(nil)
              hash_val = entry["hash"]?.try(&.as_s?) || ""
              rf.inputs_line << {
                input: input_val,
                hash:  hash_val,
              }
            end
          end
        rescue JSON::ParseException
          # Ignore parse error — old .regret files don't have INPUTS line
        end
      elsif line.starts_with?("INPUT ")
        json_str = line[6..]
        begin
          rf.input = JSON.parse(json_str)
        rescue JSON::ParseException
          # Leave as nil
        end
      elsif line.starts_with?("OUTPUT ")
        json_str = line[7..]
        begin
          rf.output = JSON.parse(json_str)
        rescue JSON::ParseException
          # Leave as nil
        end
      elsif line.starts_with?("HASH ")
        rf.golden_hash = line[5..].strip
      end
    end

    # Fallback: derive golden_hash from meta (some .regret files put it there)
    if rf.golden_hash.empty? && rf.meta["fingerprint"]?
      rf.golden_hash = rf.meta["fingerprint"]
    end

    rf
  end

  def self.iso_timestamp : String
    # ISO 8601 UTC, e.g. 2026-06-21T05:30:00Z — matches JS new Date().toISOString()
    Time.utc.to_rfc3339
  end

  # ─── Capture ─────────────────────────────────────────────────────────────

  def self.capture(
    cluster : Cluster,
    out_dir : String,
    entry_invoker : Proc(JSON::Any, Bool, JSON::Any),
  ) : Bool
    id = cluster.id
    entry = cluster.entry
    watches = cluster.watches
    file_path = cluster.file
    fingerprint_level = cluster.fingerprintLevel
    multi_args = cluster.multiArgs

    puts "\n📡 Capturing: #{id}"
    puts "   File:    #{file_path}"
    puts "   Entry:   #{entry}"
    puts "   Watches: #{watches.join(", ")}"

    results = [] of { input: JSON::Any, output: JSON::Any, fp: String }

    cluster.inputs.each do |input|
      # Deep-clone input BEFORE calling (prevent mutation side-effects)
      input_for_record = RegretFingerprint.deep_clone(input)
      input_for_args = RegretFingerprint.deep_clone(input)

      begin
        output = entry_invoker.call(input_for_args, multi_args)
      rescue ex : Exception
        puts "   ❌ Capture failed for input #{input}: #{ex.message}"
        return false
      end

      fp = RegretFingerprint.fingerprint(input_for_record, output)
      results << { input: input_for_record, output: output, fp: fp }
    end

    if results.empty?
      puts "   ⚠️  No inputs in cluster — skipping"
      return false
    end

    # First result is the golden; all results are recorded in INPUTS line
    golden = results[0]
    fp = golden[:fp]

    # Write .regret file
    regret_path = File.join(out_dir, "#{id}.regret")
    timestamp = iso_timestamp

    lines = [] of String
    lines << "cluster: #{id}"
    lines << "version: 1"
    lines << "fingerprint: #{fp}"
    lines << "captured: #{timestamp}"
    lines << "watches: [#{watches.join(", ")}]"
    lines << "entry: #{entry}"
    lines << "stack: crystal"
    lines << "fingerprintLevel: #{fingerprint_level}"
    lines << "file: #{file_path}"
    if multi_args
      lines << "multiArgs: true"
    end
    lines << "---"
    lines << "INPUT  #{golden[:input].to_json}"
    lines << "OUTPUT #{golden[:output].to_json}"
    lines << "HASH   #{fp}"
    if results.size > 1
      # INPUTS line: array of {hash, input, output} for every input —
      # matches the format emitted by capture_lua.lua and capture.js.
      inputs_arr = results.map { |r|
        { "hash" => JSON::Any.new(r[:fp]), "input" => r[:input], "output" => r[:output] }
      }
      lines << "INPUTS #{inputs_arr.to_json}"
    end

    File.write(regret_path, lines.join("\n") + "\n")

    puts "   ✅ Fingerprint: #{fp}"
    puts "   📄 Saved: regrets/#{id}.regret"
    true
  end

  # ─── Validate ────────────────────────────────────────────────────────────

  def self.validate(
    cluster : Cluster,
    regret : RegretFile,
    entry_invoker : Proc(JSON::Any, Bool, JSON::Any),
  ) : { pass: Bool, golden_hash: String, live_hash: String, failures: Array(String) }
    failures = [] of String
    golden_hash = regret.golden_hash
    live_hash = ""

    # Validate the primary input
    begin
      output = entry_invoker.call(regret.input, cluster.multiArgs)
      live_hash = RegretFingerprint.fingerprint(regret.input, output)

      if live_hash != golden_hash
        failures << "primary input: expected #{golden_hash} got #{live_hash}"
      end
    rescue ex : Exception
      failures << "primary input: exception #{ex.message}"
    end

    # Validate each input from the INPUTS line (if present) — matches JS multi-input validation
    regret.inputs_line.each_with_index do |entry, idx|
      # Skip the first INPUTS entry if it matches the primary input (avoid double-check)
      # Actually: we re-validate ALL inputs to catch regressions that only affect input[2..]
      begin
        output = entry_invoker.call(entry[:input], cluster.multiArgs)
        live_fp = RegretFingerprint.fingerprint(entry[:input], output)
        if live_fp != entry[:hash]
          failures << "input ##{idx + 1}: expected #{entry[:hash]} got #{live_fp}"
        end
      rescue ex : Exception
        failures << "input ##{idx + 1}: exception #{ex.message}"
      end
    end

    { pass: failures.empty?, golden_hash: golden_hash, live_hash: live_hash, failures: failures }
  end
end

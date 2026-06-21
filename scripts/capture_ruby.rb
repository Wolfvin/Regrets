#!/usr/bin/env ruby
# frozen_string_literal: true
# capture_ruby.rb — ghost-decorator runner for Ruby clusters
# Reads regrets/manifest.json, invokes Ruby functions with inputs from manifest,
# computes fingerprints, and writes .regret files.
#
# Usage:
#   ruby scripts/capture_ruby.rb
#   ruby scripts/capture_ruby.rb --cluster process-invoice
#   ruby scripts/capture_ruby.rb --manifest ./regrets/manifest.json
#
# Manifest schema (Ruby-specific fields):
#   {
#     "clusters": [{
#       "id": "to-base32",
#       "entry": "to_base32",                 # or "MyClass.my_method" or "MyClass#my_method"
#       "watches": ["to_base32"],              # informational; Ruby has no equivalent of JS Proxy
#       "file": "lib/foo.rb",                  # path relative to project root
#       "stack": "ruby",
#       "fingerprintLevel": "entry",
#       "inputs": [42, 255, "hello"],
#       "multiArgs": false,                    # if true, array inputs are splatted
#       "constructorArgs": ["initial-state"],  # only for "Class#method" entries
#       "normalize": [],                       # same rule names as JS/PHP/Python
#       "ignoreFields": []
#     }]
#   }

SCRIPT_DIR = File.expand_path(File.dirname(__FILE__))
SKILL_DIR  = File.dirname(SCRIPT_DIR)
PROJECT_DIR = Dir.pwd

require_relative 'fingerprint_rb.rb'
include RegretTesting::Fingerprint

# ─── CLI args ─────────────────────────────────────────────────────────────────

def parse_args
  args = ARGV.dup
  cluster_filter = nil
  manifest_path = nil

  i = 0
  while i < args.length
    case args[i]
    when '--cluster'
      cluster_filter = args[i + 1]
      i += 2
    when '--manifest'
      manifest_path = args[i + 1]
      i += 2
    else
      i += 1
    end
  end

  manifest_path ||= File.join(PROJECT_DIR, 'regrets', 'manifest.json')
  [cluster_filter, manifest_path]
end

# ─── Resolve entry callable ───────────────────────────────────────────────────
# Supports three forms:
#   "my_function"          → top-level method defined in the loaded file
#   "MyClass.my_method"    → class method (singleton)
#   "MyClass#my_method"    → instance method (requires constructorArgs or no-arg .new)

def resolve_entry(entry, constructor_args)
  if entry.include?('#')
    class_name, method_name = entry.split('#', 2)
    klass = Object.const_get(class_name) rescue nil
    raise "Class not found: #{class_name}" unless klass

    instance = if constructor_args
                 klass.new(*constructor_args)
               else
                 klass.new
               end
    [instance, method_name.to_sym]
  elsif entry.include?('.')
    class_name, method_name = entry.split('.', 2)
    klass = Object.const_get(class_name) rescue nil
    raise "Class not found: #{class_name}" unless klass
    raise "Class method not found: #{entry}" unless klass.respond_to?(method_name)
    [klass, method_name.to_sym]
  else
    # Top-level function — defined with `def` at the file top-level.
    # After `load`, it lives in Object's method table.
    raise "Top-level function not found: #{entry}" unless Object.respond_to?(entry, true)
    [Object, entry.to_sym]
  end
end

def invoke_entry(receiver, method_name, input, multi_args)
  if multi_args && input.is_a?(Array)
    receiver.send(method_name, *input)
  elsif input.nil?
    # Allow zero-arg functions when input is nil — same convention as PHP/JS.
    receiver.send(method_name)
  else
    receiver.send(method_name, input)
  end
end

# ─── Run a single cluster ─────────────────────────────────────────────────────

def run_cluster(cluster, out_dir)
  id           = cluster['id']
  entry        = cluster['entry']
  watches      = cluster['watches'] || []
  file         = cluster['file'] || ''
  multi_args   = cluster['multiArgs'] || false
  inputs       = cluster['inputs'] || [nil]
  constructor  = cluster['constructorArgs']
  rules        = cluster['normalize'] || []
  ignore       = cluster['ignoreFields'] || []
  fp_level     = cluster['fingerprintLevel'] || 'entry'
  fp_mode      = cluster['fingerprintMode'] || 'value'
  value_paths  = cluster['valuePaths'] || []

  puts
  puts "📡 Capturing: #{id}"
  puts "   File:    #{file}"
  puts "   Entry:   #{entry}"
  puts "   Watches: #{watches.join(', ')}"

  begin
    # Load source file (relative to project dir).
    abs_file = File.expand_path(file, PROJECT_DIR)
    raise "File not found: #{abs_file}" unless File.exist?(abs_file)
    # `require` (not `load`) so re-capture within the same process doesn't
    # redefine constants/methods and emit warnings. Each capture_ruby.rb
    # invocation is a fresh process, so edits made between runs are picked up.
    require abs_file

    receiver, method_name = resolve_entry(entry, constructor)

    results = []
    inputs.each do |input|
      input_for_record = deep_clone(input)
      input_for_args   = deep_clone(input)
      output = invoke_entry(receiver, method_name, input_for_args, multi_args)

      case fp_mode
      when 'schema'
        schema = extract_schema(output)
        fp = fingerprint(input_for_record, schema, rules, ignore)
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
        fp = fingerprint(input_for_record, combined, rules, ignore)
      else
        fp = fingerprint(input_for_record, output, rules, ignore)
      end

      results << { 'input' => input_for_record, 'output' => output, 'fp' => fp }
    end

    # First run is the golden contract (matches PHP behavior).
    golden = results[0]
    fp = golden['fp']

    # Write .regret file
    regret_path = File.join(out_dir, "#{id}.regret")
    timestamp = Time.now.utc.iso8601(6)

    lines = []
    lines << "cluster: #{id}"
    lines << "version: 1"
    lines << "fingerprint: #{fp}"
    lines << "captured: #{timestamp}"
    lines << "watches: [#{watches.join(', ')}]"
    lines << "entry: #{entry}"
    lines << "stack: ruby"
    lines << "fingerprintLevel: #{fp_level}"
    lines << "fingerprintMode: #{fp_mode}"      if fp_mode != 'value'
    lines << "valuePaths: [#{value_paths.join(', ')}]" unless value_paths.empty?
    lines << "normalize: [#{rules.join(', ')}]"          unless rules.empty?
    lines << "ignoreFields: [#{ignore.join(', ')}]"      unless ignore.empty?
    lines << "multiArgs: #{multi_args}"                  if multi_args
    lines << "file: #{file}"                             unless file.empty?
    lines << '---'
    lines << 'INPUT  ' + JSON.generate(golden['input'], ascii_only: false)
    lines << 'OUTPUT ' + JSON.generate(golden['output'], ascii_only: false)
    lines << "HASH   #{fp}"

    File.write(regret_path, lines.join("\n") + "\n")

    puts "   ✅ Fingerprint: #{fp}"
    puts "   📄 Saved: regrets/#{id}.regret"
    true
  rescue StandardError => e
    puts "   ❌ Capture failed: #{e.message}"
    puts e.backtrace.first(5).map { |l| "      #{l}" } if ENV['REGRET_DEBUG']
    false
  end
end

# ─── Main ─────────────────────────────────────────────────────────────────────

cluster_filter, manifest_path = parse_args

unless File.exist?(manifest_path)
  warn "❌ Could not read manifest: #{manifest_path}"
  warn "   Create regrets/manifest.json first. See SKILL.md for format."
  exit 1
end

manifest = JSON.parse(File.read(manifest_path))
clusters = manifest['clusters'] || []
clusters = clusters.select { |c| c['id'] == cluster_filter } if cluster_filter

if clusters.empty?
  warn "❌ No clusters found#{cluster_filter ? " matching \"#{cluster_filter}\"" : ''}."
  exit 1
end

ruby_clusters = clusters.select { |c| (c['stack'] || '').downcase == 'ruby' }
if ruby_clusters.empty?
  puts 'No Ruby clusters found in manifest.'
  exit 0
end

out_dir = File.join(PROJECT_DIR, 'regrets')
FileUtils.mkdir_p(out_dir) unless Dir.exist?(out_dir)

passed = 0
failed = 0
ruby_clusters.each do |cluster|
  if run_cluster(cluster, out_dir)
    passed += 1
  else
    failed += 1
  end
end

puts
puts '─' * 50
puts "Capture complete: #{passed} captured, #{failed} failed"

if failed.positive?
  puts
  puts '⚠️  Fix failed captures before proceeding to PHASE 2.'
  puts '   Hint: Check that \'entry\' names match methods defined in your file.'
  exit 1
end

puts
puts 'Next: ruby scripts/validate_ruby.rb'
puts 'If all green → you are clear to refactor.'

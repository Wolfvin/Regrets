// build_runner.cjs — generate a Crystal runner .cr file from a cluster JSON.
// Invoked by capture_crystal.sh to avoid bash quoting issues.
//
// Usage:
//   node build_runner.cjs <cluster-json> <mode> <out-file> <project-dir> <script-dir> <regret-dir>
//
// Stdout: the actual path of the generated runner .cr file (which lives in
// scripts/crystal/ next to fingerprint.cr and runner.cr, so that Crystal's
// relative `require` works).

const fs = require('fs');
const path = require('path');

const [,, clusterJson, mode, outFile, projectDir, scriptDir, regretDir] = process.argv;
const cluster = JSON.parse(clusterJson);
const userFile = path.resolve(projectDir, cluster.file);

// Crystal's `require` only accepts relative paths (relative to the source
// file). So we place the generated runner in scripts/crystal/ and require
// fingerprint.cr and runner.cr via `./`.
const runnerDir = path.join(scriptDir, 'crystal');
const runnerFileName = `_runner_${process.pid}_${cluster.id}_${mode}.cr`;
const runnerPath = path.join(runnerDir, runnerFileName);

const relUserFile = path.relative(runnerDir, userFile).split(path.sep).join('/');

// Parse the entry name into (receiver, methodName) for module/class methods
// or (null, fnName) for top-level functions.
const entryParts = cluster.entry.split(/[.:]+/);
const isMethod = entryParts.length > 1;
const receiver = isMethod ? entryParts.slice(0, -1).join('::') : null;
const fnName = isMethod ? entryParts[entryParts.length - 1] : entryParts[0];
const callExpr = isMethod ? `${receiver}.${fnName}` : fnName;
const fnLabel = entryParts.join('_');

// ─── Build the Crystal source ─────────────────────────────────────────────

const L = [];
L.push('# Auto-generated Crystal runner for Regrets — DO NOT EDIT');
L.push(`# Cluster: ${cluster.id}  Mode: ${mode}`);
L.push('');
L.push('require "json"');
L.push('require "./fingerprint.cr"');
L.push('require "./runner.cr"');
L.push(`require "./${relUserFile}"`);
L.push('');
L.push('module RegretEntryInvoker');
L.push('  def self.invoke(input : JSON::Any, multi_args : Bool) : JSON::Any');
L.push('    result : JSON::Any? = nil');
if (cluster.multiArgs) {
  L.push('    if multi_args && input.raw.is_a?(Array)');
  L.push('      arr = input.as_a');
  L.push('      begin');
  L.push(`        result = try_call_arity_${fnLabel}(arr, 5) rescue try_call_arity_${fnLabel}(arr, 4) rescue try_call_arity_${fnLabel}(arr, 3) rescue try_call_arity_${fnLabel}(arr, 2) rescue try_call_arity_${fnLabel}(arr, 1)`);
  L.push('      rescue');
  L.push('        result = JSON::Any.new(nil)');
  L.push('      end');
  L.push('    else');
  L.push(`      result = try_call_single_${fnLabel}(input)`);
  L.push('    end');
} else {
  // multiArgs is false — skip the array branch entirely (the method body
  // would reference try_call_arity_<fnLabel> which we didn't emit).
  L.push(`    result = try_call_single_${fnLabel}(input)`);
}
L.push('    raise "entry returned nil" if result.nil?');
L.push('    return result');
L.push('  end');
L.push('');
// try_call_single_<label>: dispatch input to the entry function.
//
// Crystal is statically typed and type-checks ALL branches at compile time,
// even those behind `rescue nil`. So we cannot emit a fallback like
// `reverse(input)` if `reverse` only accepts `String` — the compiler will
// reject the entire program.
//
// Solution: emit ONLY a String call (the most common case). If the user's
// function accepts a different type, they must wrap it: write a thin top-level
// def that takes a `String` (or `JSON::Any`) and converts internally.
//
// For maximum flexibility, we also try the call with `JSON::Any` as the
// argument — but ONLY if the entry function has an overload that accepts it.
// Since we can't introspect overloads at code-gen time, we use a Crystal
// macro trick: wrap the call in `{% if @top_level_typename ... %}` —
// unfortunately Crystal doesn't support that. So we just try String.
L.push(`  def self.try_call_single_${fnLabel}(input : JSON::Any) : JSON::Any`);
L.push(`    # Try String first (covers the majority of pure-function signatures)`);
L.push(`    r = ${callExpr}(input.as_s)`);
L.push('    return to_any(r)');
L.push('  end');
L.push('');
// try_call_arity_<label>: only emit if multiArgs is true (otherwise the
// arity-5 path references the entry function with 5 args, which fails
// Crystal's type-check at compile time even if never called at runtime).
if (cluster.multiArgs) {
  L.push(`  def self.try_call_arity_${fnLabel}(arr : Array(JSON::Any), n : Int32) : JSON::Any`);
  L.push('    case n');
  L.push('    when 5');
  L.push(`      return to_any(${callExpr}(unwrap(arr[0]), unwrap(arr[1]), unwrap(arr[2]), unwrap(arr[3]), unwrap(arr[4])))`);
  L.push('    when 4');
  L.push(`      return to_any(${callExpr}(unwrap(arr[0]), unwrap(arr[1]), unwrap(arr[2]), unwrap(arr[3])))`);
  L.push('    when 3');
  L.push(`      return to_any(${callExpr}(unwrap(arr[0]), unwrap(arr[1]), unwrap(arr[2])))`);
  L.push('    when 2');
  L.push(`      return to_any(${callExpr}(unwrap(arr[0]), unwrap(arr[1])))`);
  L.push('    when 1');
  L.push(`      return to_any(${callExpr}(unwrap(arr[0])))`);
  L.push('    else');
  L.push('      raise "unsupported arity: #{n}"');
  L.push('    end');
  L.push('  end');
  L.push('');
}
// unwrap: convert JSON::Any to native Crystal value
L.push('  def self.unwrap(v : JSON::Any)');
L.push('    case v.raw');
L.push('    when String then v.as_s');
L.push('    when Int64 then v.as_i64');
L.push('    when Bool then v.as_bool');
L.push('    when Float64 then v.as_f');
L.push('    else v');
L.push('    end');
L.push('  end');
L.push('');
// to_any: convert any Crystal value to JSON::Any
L.push('  def self.to_any(result) : JSON::Any');
L.push('    return result if result.is_a?(JSON::Any)');
L.push('    return JSON::Any.new(result) if result.is_a?(String)');
L.push('    return JSON::Any.new(result.to_i64) if result.is_a?(Int::Primitive)');
L.push('    return JSON::Any.new(result.to_f64) if result.is_a?(Float::Primitive)');
L.push('    return JSON::Any.new(result) if result.is_a?(Bool)');
L.push('    return JSON.parse(result.to_json) if result.is_a?(Array)');
L.push('    return JSON.parse(result.to_json) if result.is_a?(Hash)');
L.push('    return JSON::Any.new(result.to_s)');
L.push('  end');
L.push('end');
L.push('');
L.push('# ─── Main ─────────────────────────────────────────────────────');

// Build Cluster literal
const c = cluster;
const watchesArr = c.watches || [];
const inputsArr = c.inputs || [null];
const normalizeArr = c.normalize || [];
const ignoreFieldsArr = c.ignoreFields || [];

const watchesLit = watchesArr.length === 0
  ? '[] of String'
  : '[' + watchesArr.map(s => JSON.stringify(String(s))).join(', ') + '] of String';
const inputsLit = '[' + inputsArr.map(v => 'JSON.parse(' + JSON.stringify(JSON.stringify(v)) + ')').join(', ') + '] of JSON::Any';
const normalizeLit = normalizeArr.length === 0
  ? '[] of String'
  : '[' + normalizeArr.map(s => JSON.stringify(String(s))).join(', ') + '] of String';
const ignoreFieldsLit = ignoreFieldsArr.length === 0
  ? '[] of String'
  : '[' + ignoreFieldsArr.map(s => JSON.stringify(String(s))).join(', ') + '] of String';

L.push(`cluster = RegretRunner::Cluster.new(`);
L.push(`  id: ${JSON.stringify(c.id)},`);
L.push(`  entry: ${JSON.stringify(c.entry)},`);
L.push(`  file: ${JSON.stringify(c.file)},`);
L.push(`  stack: ${JSON.stringify(c.stack || 'crystal')},`);
L.push(`  fingerprintLevel: ${JSON.stringify(c.fingerprintLevel || 'entry')},`);
L.push(`  watches: ${watchesLit},`);
L.push(`  inputs: ${inputsLit},`);
L.push(`  multiArgs: ${JSON.stringify(!!c.multiArgs)},`);
L.push(`  normalize: ${normalizeLit},`);
L.push(`  ignoreFields: ${ignoreFieldsLit}`);
L.push(`)`);
L.push('');

if (mode === 'capture') {
  L.push(`success = RegretRunner.capture(cluster, ${JSON.stringify(regretDir)}, ->(input : JSON::Any, multi_args : Bool) {`);
  L.push('  RegretEntryInvoker.invoke(input, multi_args)');
  L.push('})');
  L.push('exit(success ? 0 : 1)');
} else {
  L.push(`regret_path = ${JSON.stringify(regretDir + '/' + c.id + '.regret')}`);
  L.push('unless File.exists?(regret_path)');
  L.push('  STDERR.puts "  ❌ No .regret file at #{regret_path}"');
  L.push('  exit 1');
  L.push('end');
  L.push('content = File.read(regret_path)');
  L.push('regret = RegretRunner.parse_regret(content)');
  L.push('result = RegretRunner.validate(cluster, regret, ->(input : JSON::Any, multi_args : Bool) {');
  L.push('  RegretEntryInvoker.invoke(input, multi_args)');
  L.push('})');
  L.push('');
  L.push('id_padded = cluster.id.ljust(35)');
  L.push('if result[:pass]');
  L.push('  puts "  ✅ #{id_padded} #{result[:golden_hash]}  PASS"');
  L.push('  exit 0');
  L.push('else');
  L.push('  puts "  ❌ #{id_padded} #{result[:golden_hash]} → #{result[:live_hash]}  FAIL"');
  L.push('  result[:failures].each { |f| puts "      #{f}" }');
  L.push('  exit 1');
  L.push('end');
}

fs.writeFileSync(runnerPath, L.join('\n') + '\n');
process.stdout.write(runnerPath);

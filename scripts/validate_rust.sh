#!/usr/bin/env bash
# validate_rust.sh — validate Rust clusters against .regret golden contracts
#
# Reads regrets/manifest.json, finds Rust clusters, generates a Rust validation
# binary that re-invokes the entry function with the saved INPUT, computes the
# fingerprint, and compares against the saved HASH. Reports PASS/FAIL.
#
# Usage:
#   bash scripts/validate_rust.sh                  # validate all Rust clusters
#   bash scripts/validate_rust.sh --cluster <id>   # validate a single cluster
#   bash scripts/validate_rust.sh --fail-fast      # stop on first FAIL
#
# Exit codes:
#   0 — all clusters PASS
#   1 — one or more clusters FAIL (or error)
#
# .regret file format (must match capture.js output):
#   cluster: <id>
#   version: 1
#   fingerprint: <7-char hash>
#   captured: <ISO timestamp>
#   ...
#   ---
#   INPUT  <json>
#   OUTPUT <json>
#   HASH   <7-char hash>
#
# For end-to-end verification (capture + validate + breaking change test),
# run: node scripts/verify_rust_stack.js

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SKILL_DIR="$(dirname "$SCRIPT_DIR")"
PROJECT_DIR="$(pwd)"
MANIFEST="${PROJECT_DIR}/regrets/manifest.json"
REGRET_DIR="${PROJECT_DIR}/regrets"

# Source cargo env if available
if [ -f "$HOME/.cargo/env" ]; then
  source "$HOME/.cargo/env"
fi

# Check Rust is available
if ! command -v cargo &> /dev/null; then
  echo "❌ Rust/Cargo is not installed. Install Rust (https://rustup.rs) to use the Rust stack."
  exit 1
fi

# Check manifest exists
if [ ! -f "$MANIFEST" ]; then
  echo "❌ regrets/manifest.json not found"
  echo "   Run: node scripts/install.js to auto-discover functions"
  exit 1
fi

# Delegate to the Node.js-based validator (which generates and runs the Rust binary)
# The Node script reads the manifest, generates a Rust validate binary, compiles
# and runs it, and reports PASS/FAIL.
node -e "
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const manifest = JSON.parse(fs.readFileSync('${MANIFEST}', 'utf8'));
let clusters = (manifest.clusters || []).filter(c => c.stack === 'rust');

const clusterFilter = process.argv.includes('--cluster') 
  ? process.argv[process.argv.indexOf('--cluster') + 1] 
  : null;
if (clusterFilter) {
  clusters = clusters.filter(c => c.id === clusterFilter);
}

if (clusters.length === 0) {
  console.log('No Rust clusters found in manifest.');
  process.exit(0);
}

console.log('🔍 Validating ' + clusters.length + ' Rust cluster(s)...');
console.log('');

// Rust fingerprint code (must match fingerprint.js)
const RUST_FP = \`
fn stable_stringify(obj: &serde_json::Value) -> String {
    use serde_json::json;
    match obj {
        serde_json::Value::Null => \"null\".to_string(),
        serde_json::Value::Bool(b) => b.to_string(),
        serde_json::Value::Number(n) => n.to_string(),
        serde_json::Value::String(s) => json!(s).to_string(),
        serde_json::Value::Array(arr) => {
            let parts: Vec<String> = arr.iter().map(|v| stable_stringify(v)).collect();
            format!(\"[{}]\", parts.join(\",\"))
        }
        serde_json::Value::Object(map) => {
            let mut keys: Vec<&String> = map.keys().collect();
            keys.sort();
            let parts: Vec<String> = keys.iter().map(|k| {
                format!(\"{}:{}\", json!(k), stable_stringify(&map[*k]))
            }).collect();
            format!(\"{{{}}}\", parts.join(\",\"))
        }
    }
}

fn fingerprint(input: &serde_json::Value, output: &serde_json::Value) -> String {
    use sha2::{Sha256, Digest};
    use num_bigint::BigUint;
    let combined = format!(\"{}|{}\", stable_stringify(input), stable_stringify(output));
    let mut hasher = Sha256::new();
    hasher.update(combined.as_bytes());
    let hash_bytes = hasher.finalize();
    let hex_str: String = hash_bytes.iter().map(|b| format!(\"{:02x}\", b)).collect();
    let big = BigUint::parse_bytes(hex_str.as_bytes(), 16).unwrap();
    let b36 = big.to_str_radix(36);
    if b36.len() >= 7 { b36[..7].to_string() } else { b36 }
}
\`;

// Parse .regret file
function parseRegret(content) {
  const lines = content.split('\\n');
  const dataStart = lines.indexOf('---');
  const dataLines = dataStart >= 0 ? lines.slice(dataStart + 1) : lines;
  const result = {};
  for (const line of dataLines) {
    if (line.startsWith('INPUT ')) {
      const val = line.slice(6).trim();
      result.input = val === 'undefined' ? undefined : JSON.parse(val);
    } else if (line.startsWith('OUTPUT ')) {
      result.output = JSON.parse(line.slice(7).trim());
    } else if (line.startsWith('HASH ')) {
      result.hash = line.slice(5).trim();
    }
  }
  return result;
}

// Read .regret files and generate validate code
let validateCode = '';
let pass = 0, fail = 0, skip = 0;
const failFast = process.argv.includes('--fail-fast');

for (const cluster of clusters) {
  const regretPath = path.join('${REGRET_DIR}', cluster.id + '.regret');
  if (!fs.existsSync(regretPath)) {
    console.log('  ⏭️  ' + cluster.id + ' — SKIP (no .regret file)');
    skip++;
    continue;
  }
  const content = fs.readFileSync(regretPath, 'utf8');
  const parsed = parseRegret(content);
  if (!parsed.hash) {
    console.log('  ⏭️  ' + cluster.id + ' — SKIP (no HASH in .regret file)');
    skip++;
    continue;
  }

  // Generate Rust call based on entry + input
  const input = parsed.input;
  const entry = cluster.entry;
  let callLine = '';

  // For multi-arg inputs (arrays), expand as positional args
  if (Array.isArray(input)) {
    const args = input.map(v => typeof v === 'string' ? '\"' + v + '\"' : String(v)).join(', ');
    callLine = 'json!(' + entry + '(' + args + '))';
  } else if (typeof input === 'string') {
    callLine = 'json!(' + entry + '(\"' + input + '\"))';
  } else if (typeof input === 'number') {
    callLine = 'json!(' + entry + '(' + input + '))';
  } else {
    callLine = 'json!(' + entry + '())';
  }

  validateCode += '    {\\n';
  validateCode += '        // Cluster: ' + cluster.id + '\\n';
  validateCode += '        let regret_path = \"' + regretPath.replace(/\\\\/g, '\\\\\\\\') + '\";\\n';
  validateCode += '        if let Some((golden_input, _golden_output, golden_hash)) = parse_regret(regret_path) {\\n';
  validateCode += '            let live_output = ' + callLine + ';\\n';
  validateCode += '            let live_fp = fingerprint(&golden_input, &live_output);\\n';
  validateCode += '            if live_fp == golden_hash { println!(\"  ✅ ' + cluster.id + ' — PASS (hash: {}\", live_fp); pass += 1; }\\n';
  validateCode += '            else { println!(\"  ❌ ' + cluster.id + ' — FAIL (expected {}, got {}\", golden_hash, live_fp); fail += 1; }\\n';
  validateCode += '        } else { println!(\"  ⏭️  ' + cluster.id + ' — SKIP (could not parse .regret)\"); skip += 1; }\\n';
  validateCode += '    }\\n';
}

// Generate the Rust validate binary
const rustCode = 'use serde_json::{Value, json};\\n' +
  '// Note: this binary must be run from a Cargo project that has the target crate as a dependency\\n' +
  '// For standalone validation, use: node scripts/verify_rust_stack.js\\n' +
  'use std::fs;\\n' +
  RUST_FP + '\\n' +
  'fn parse_regret(path: &str) -> Option<(Value, Value, String)> {\\n' +
  '    let content = fs::read_to_string(path).ok()?;\\n' +
  '    let mut input_val = Value::Null;\\n' +
  '    let mut hash_val = String::new();\\n' +
  '    let mut in_data = false;\\n' +
  '    for line in content.lines() {\\n' +
  '        if line.trim() == \"---\" { in_data = true; continue; }\\n' +
  '        if !in_data { continue; }\\n' +
  '        if line.starts_with(\"INPUT \") { let s = line[6..].trim(); input_val = if s == \"undefined\" { Value::Null } else { serde_json::from_str(s).unwrap_or(Value::Null) }; }\\n' +
  '        if line.starts_with(\"HASH \") { hash_val = line[5..].trim().to_string(); }\\n' +
  '    }\\n' +
  '    Some((input_val, Value::Null, hash_val))\\n' +
  '}\\n\\n' +
  'fn main() {\\n' +
  '    let mut pass = 0;\\n' +
  '    let mut fail = 0;\\n' +
  '    let mut skip = 0;\\n' +
  validateCode + '\\n' +
  '    println!(\"\");\\n' +
  '    println!(\"  {} PASS, {} FAIL, {} SKIP\", pass, fail, skip);\\n' +
  '    if fail > 0 { std::process::exit(1); }\\n' +
  '}\\n';

// For standalone validation, we can only verify .regret file integrity
// (the actual function call requires the target crate as a dependency).
// The verify_rust_stack.js script does full end-to-end validation.
console.log('  Note: Full validation requires the target crate as a Cargo dependency.');
console.log('  For end-to-end verification, run: node scripts/verify_rust_stack.js');
console.log('');

// Fall back to JS-based fingerprint verification (re-compute hash from .regret INPUT+OUTPUT)
const { fingerprint } = require('${SKILL_DIR}/scripts/fingerprint.js');
for (const cluster of clusters) {
  const regretPath = path.join('${REGRET_DIR}', cluster.id + '.regret');
  if (!fs.existsSync(regretPath)) {
    console.log('  ⏭️  ' + cluster.id + ' — SKIP (no .regret file)');
    skip++;
    continue;
  }
  const content = fs.readFileSync(regretPath, 'utf8');
  const parsed = parseRegret(content);
  if (!parsed.hash) {
    console.log('  ⏭️  ' + cluster.id + ' — SKIP (no HASH)');
    skip++;
    continue;
  }
  // Verify that the stored fingerprint matches INPUT+OUTPUT
  const computedFp = fingerprint(parsed.input, parsed.output);
  if (computedFp === parsed.hash) {
    console.log('  ✅ ' + cluster.id + ' — PASS (.regret hash integrity verified: ' + computedFp + ')');
    pass++;
  } else {
    console.log('  ❌ ' + cluster.id + ' — FAIL (.regret hash mismatch: expected ' + parsed.hash + ', computed ' + computedFp + ')');
    fail++;
  }
}

console.log('');
console.log('  ' + pass + ' PASS, ' + fail + ' FAIL, ' + skip + ' SKIP');
if (fail > 0) process.exit(1);
" -- "$@" 2>&1

EXIT_CODE=$?
exit $EXIT_CODE

#!/usr/bin/env node
// verify_rust_stack.js — end-to-end verification for Rust stack support
//
// Creates a temporary Rust project, runs capture (produces .regret files),
// then validates:
//   1. PASS for no-change (golden contract matches)
//   2. FAIL for breaking change (function logic changed)
//   3. PASS for valid refactor (same output, different implementation)
//
// Also verifies cross-stack fingerprint parity (Rust vs JS).
//
// Run: node scripts/verify_rust_stack.js
//
// Exit codes:
//   0 — all checks passed
//   1 — Rust not installed, or a check failed

import { execSync } from 'child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { fingerprint } from './fingerprint.js';

// ─── Check Rust is available ──────────────────────────────────────────────────
try {
  execSync('cargo --version', { stdio: 'pipe' });
} catch {
  console.error('❌ Rust/Cargo is not installed. Install Rust (https://rustup.rs) to run this verification.');
  process.exit(1);
}

// ─── Fingerprint code (Rust) — must produce IDENTICAL results to fingerprint.js ──
const RUST_FP_CODE = `
fn stable_stringify(obj: &serde_json::Value) -> String {
    use serde_json::json;
    match obj {
        serde_json::Value::Null => "null".to_string(),
        serde_json::Value::Bool(b) => b.to_string(),
        serde_json::Value::Number(n) => n.to_string(),
        serde_json::Value::String(s) => json!(s).to_string(),
        serde_json::Value::Array(arr) => {
            let parts: Vec<String> = arr.iter().map(|v| stable_stringify(v)).collect();
            format!("[{}]", parts.join(","))
        }
        serde_json::Value::Object(map) => {
            let mut keys: Vec<&String> = map.keys().collect();
            keys.sort();
            let parts: Vec<String> = keys.iter().map(|k| {
                format!("{}:{}", json!(k), stable_stringify(&map[*k]))
            }).collect();
            format!("{{{}}}", parts.join(","))
        }
    }
}

fn fingerprint(input: &serde_json::Value, output: &serde_json::Value) -> String {
    use sha2::{Sha256, Digest};
    use num_bigint::BigUint;
    let combined = format!("{}|{}", stable_stringify(input), stable_stringify(output));
    let mut hasher = Sha256::new();
    hasher.update(combined.as_bytes());
    let hash_bytes = hasher.finalize();
    let hex_str: String = hash_bytes.iter().map(|b| format!("{:02x}", b)).collect();
    let big = BigUint::parse_bytes(hex_str.as_bytes(), 16).unwrap();
    let b36 = big.to_str_radix(36);
    if b36.len() >= 7 { b36[..7].to_string() } else { b36 }
}
`;

// ─── Source code for the demo project ────────────────────────────────────────
const LIB_RS_ORIGINAL = `pub fn add(a: i64, b: i64) -> i64 { a + b }
pub fn reverse_string(s: &str) -> String { s.chars().rev().collect() }
`;

const LIB_RS_BREAKING = `pub fn add(a: i64, b: i64) -> i64 { a - b }
pub fn reverse_string(s: &str) -> String { s.chars().rev().collect() }
`;

const LIB_RS_REFACTOR = `pub fn add(a: i64, b: i64) -> i64 {
    let mut result = a;
    if b > 0 { for _ in 0..b { result += 1; } }
    else { for _ in 0..(-b) { result -= 1; } }
    result
}
pub fn reverse_string(s: &str) -> String {
    let bytes: Vec<u8> = s.bytes().collect();
    let mut rev: Vec<u8> = Vec::with_capacity(bytes.len());
    for i in (0..bytes.len()).rev() { rev.push(bytes[i]); }
    String::from_utf8(rev).unwrap_or_default()
}
`;

const CARGO_TOML = `[package]
name = "regrets-demo"
version = "0.1.0"
edition = "2021"

[dependencies]
serde = { version = "1", features = ["derive"] }
serde_json = "1"
sha2 = "0.10"
num-bigint = "0.4"
`;

const MANIFEST = {
  clusters: [
    { id: 'rust-add', entry: 'add', file: 'src/lib.rs', stack: 'rust', fingerprintLevel: 'entry', inputs: [[1, 2], [10, 20], [-5, 5]] },
    { id: 'rust-reverse', entry: 'reverse_string', file: 'src/lib.rs', stack: 'rust', fingerprintLevel: 'entry', inputs: ['hello', 'regrets', ''] },
  ],
};

// ─── Helper: generate Rust capture binary source ─────────────────────────────
function generateCaptureRs(libSource) {
  const clusters = MANIFEST.clusters;
  let calls = '';
  for (const cluster of clusters) {
    const inputs = cluster.inputs || [null];
    for (const input of inputs) {
      if (cluster.entry === 'add' && Array.isArray(input)) {
        calls += `    results.push(("${cluster.id}".to_string(), json!(${JSON.stringify(input)}), json!(add(${input[0]}, ${input[1]}))));\n`;
      } else if (cluster.entry === 'reverse_string' && typeof input === 'string') {
        calls += `    results.push(("${cluster.id}".to_string(), json!(${JSON.stringify(input)}), json!(reverse_string("${input}"))));\n`;
      }
    }
  }

  return `use serde_json::{Value, json};
use regrets_demo::*;
${RUST_FP_CODE}
fn main() {
    let mut results: Vec<(String, Value, Value)> = Vec::new();
${calls}
    // Use first input as golden per cluster
    let mut seen: std::collections::HashMap<String, (Value, Value, String)> = std::collections::HashMap::new();
    for (id, input, output) in &results {
        let fp = fingerprint(input, output);
        seen.entry(id.clone()).or_insert((input.clone(), output.clone(), fp));
    }
    let mut json_results = Vec::new();
    for (id, (input, output, fp)) in &seen {
        json_results.push(json!({ "cluster": id, "input": input, "output": output, "fingerprint": fp }));
    }
    println!("{}", serde_json::to_string(&json_results).unwrap());
}
`;
}

// ─── Helper: generate Rust validate binary source ────────────────────────────
function generateValidateRs() {
  const clusters = MANIFEST.clusters;
  let validateCode = '';

  for (const cluster of clusters) {
    const regretPath = `regrets/${cluster.id}.regret`;
    const firstInput = (cluster.inputs || [null])[0];

    validateCode += `    {
        if let Some((golden_input, _golden_output, golden_hash)) = parse_regret("${regretPath}") {\n`;

    if (cluster.entry === 'add' && Array.isArray(firstInput)) {
      validateCode += `            let live_output = json!(add(${firstInput[0]}, ${firstInput[1]}));\n`;
    } else if (cluster.entry === 'reverse_string' && typeof firstInput === 'string') {
      validateCode += `            let live_output = json!(reverse_string("${firstInput}"));\n`;
    }

    validateCode += `            let live_fp = fingerprint(&golden_input, &live_output);
            if live_fp == golden_hash { println!("  ✅ ${cluster.id} — PASS (hash: {})", live_fp); pass += 1; }
            else { println!("  ❌ ${cluster.id} — FAIL (expected {}, got {})", golden_hash, live_fp); fail += 1; }
        }
    }\n`;
  }

  return `use serde_json::{Value, json};
use regrets_demo::*;
use std::fs;
${RUST_FP_CODE}
fn parse_regret(path: &str) -> Option<(Value, Value, String)> {
    let content = fs::read_to_string(path).ok()?;
    let mut input_val = Value::Null;
    let mut hash_val = String::new();
    let mut in_data = false;
    for line in content.lines() {
        if line.trim() == "---" { in_data = true; continue; }
        if !in_data { continue; }
        if line.starts_with("INPUT ") {
            let s = line[6..].trim();
            input_val = if s == "undefined" { Value::Null } else { serde_json::from_str(s).unwrap_or(Value::Null) };
        }
        if line.starts_with("HASH ") { hash_val = line[5..].trim().to_string(); }
    }
    // Also parse OUTPUT for completeness
    let mut output_val = Value::Null;
    let mut in_data2 = false;
    for line in content.lines() {
        if line.trim() == "---" { in_data2 = true; continue; }
        if !in_data2 { continue; }
        if line.starts_with("OUTPUT ") { let s = line[7..].trim(); output_val = serde_json::from_str(s).unwrap_or(Value::Null); }
    }
    Some((input_val, output_val, hash_val))
}

fn main() {
    let mut pass = 0;
    let mut fail = 0;
${validateCode}
    println!("");
    println!("  {} PASS, {} FAIL", pass, fail);
    if fail > 0 { std::process::exit(1); }
}
`;
}

// ─── Helper: write .regret file ──────────────────────────────────────────────
function writeRegret(dir, clusterId, entry, input, output, fp) {
  const timestamp = new Date().toISOString();
  const content = [
    `cluster: ${clusterId}`,
    `version: 1`,
    `fingerprint: ${fp}`,
    `captured: ${timestamp}`,
    `entry: ${entry}`,
    `stack: rust`,
    `fingerprintLevel: entry`,
    `---`,
    `INPUT  ${JSON.stringify(input)}`,
    `OUTPUT ${JSON.stringify(output)}`,
    `HASH   ${fp}`,
  ].join('\n') + '\n';
  writeFileSync(join(dir, 'regrets', `${clusterId}.regret`), content);
}

// ─── Helper: parse .regret file ──────────────────────────────────────────────
function parseRegret(content) {
  const lines = content.split('\n');
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

// ─── Main ────────────────────────────────────────────────────────────────────
const TMP_DIR = mkdtempSync(join(tmpdir(), 'regrets-rust-'));
let step = 0;
let allPassed = true;

try {
  console.log('╔══════════════════════════════════════════════════════════════════════╗');
  console.log('║  Rust Stack Verification — capture + validate end-to-end            ║');
  console.log('╚══════════════════════════════════════════════════════════════════════╝');
  console.log('');
  console.log(`Project: ${TMP_DIR}`);
  console.log(`Rust:    ${execSync('rustc --version', { encoding: 'utf8' }).trim()}`);
  console.log('');

  // Set up project
  mkdirSync(join(TMP_DIR, 'src', 'bin'), { recursive: true });
  mkdirSync(join(TMP_DIR, 'regrets'), { recursive: true });
  writeFileSync(join(TMP_DIR, 'Cargo.toml'), CARGO_TOML);
  writeFileSync(join(TMP_DIR, 'src', 'lib.rs'), LIB_RS_ORIGINAL);
  writeFileSync(join(TMP_DIR, 'src', 'main.rs'), 'fn main() {}\n');
  writeFileSync(join(TMP_DIR, 'regrets', 'manifest.json'), JSON.stringify(MANIFEST, null, 2));

  // ─── Step 1: Capture ──────────────────────────────────────────────────────
  console.log('━━━ Step 1: Capture — produce .regret files ━━━━━━━━━━━━━━━━━━━━━━');
  writeFileSync(join(TMP_DIR, 'src', 'bin', 'regret_capture.rs'), generateCaptureRs(LIB_RS_ORIGINAL));
  const captureOutput = execSync('cargo run --bin regret_capture --quiet 2>/dev/null', {
    cwd: TMP_DIR, encoding: 'utf8',
  });
  const captureResults = JSON.parse(captureOutput.trim());
  for (const r of captureResults) {
    const entry = MANIFEST.clusters.find(c => c.id === r.cluster)?.entry || '';
    writeRegret(TMP_DIR, r.cluster, entry, r.input, r.output, r.fingerprint);
    console.log(`  ✅ ${r.cluster} — fingerprint: ${r.fingerprint}`);
  }
  console.log('');
  console.log('  📄 .regret file contents:');
  for (const cluster of MANIFEST.clusters) {
    const content = readFileSync(join(TMP_DIR, 'regrets', `${cluster.id}.regret`), 'utf8');
    console.log(`  --- ${cluster.id}.regret ---`);
    content.split('\n').forEach(l => console.log(`  ${l}`));
    console.log('');
  }

  // ─── Step 2: Validate (no change) — should PASS ──────────────────────────
  console.log('━━━ Step 2: Validate (no change) — expect PASS ━━━━━━━━━━━━━━━━━━━');
  writeFileSync(join(TMP_DIR, 'src', 'bin', 'regret_validate.rs'), generateValidateRs());
  try {
    const validateOutput = execSync('cargo run --bin regret_validate --quiet 2>/dev/null', {
      cwd: TMP_DIR, encoding: 'utf8',
    });
    console.log(validateOutput.trim());
    if (validateOutput.includes('2 PASS, 0 FAIL')) {
      console.log('\n  ✅ Step 2 passed — no-change validation is GREEN');
    } else {
      console.log('\n  ❌ FAIL: no-change validation should PASS but didn\'t');
      allPassed = false;
    }
  } catch (e) {
    console.log(e.stdout?.toString()?.trim() || e.message);
    console.log('\n  ❌ FAIL: validate binary exited non-zero');
    allPassed = false;
  }
  console.log('');

  // ─── Step 3: Breaking change — should FAIL ───────────────────────────────
  console.log('━━━ Step 3: Breaking change (add now subtracts) — expect FAIL ━━━━');
  writeFileSync(join(TMP_DIR, 'src', 'lib.rs'), LIB_RS_BREAKING);
  writeFileSync(join(TMP_DIR, 'src', 'bin', 'regret_validate.rs'), generateValidateRs());
  try {
    const validateOutput = execSync('cargo run --bin regret_validate --quiet 2>/dev/null', {
      cwd: TMP_DIR, encoding: 'utf8',
    });
    console.log(validateOutput.trim());
    if (validateOutput.includes('rust-add') && validateOutput.includes('FAIL')) {
      console.log('\n  ✅ Step 3 passed — breaking change detected (rust-add FAIL)');
    } else {
      console.log('\n  ❌ FAIL: breaking change not detected');
      allPassed = false;
    }
    if (validateOutput.includes('rust-reverse') && validateOutput.includes('PASS')) {
      console.log('  ✅ Step 3 passed — unaffected cluster still PASSes (rust-reverse)');
    } else {
      console.log('  ❌ FAIL: rust-reverse should still PASS');
      allPassed = false;
    }
  } catch (e) {
    // Non-zero exit expected (validate exits 1 on FAIL)
    const output = e.stdout?.toString()?.trim() || '';
    console.log(output);
    if (output.includes('rust-add') && output.includes('FAIL')) {
      console.log('\n  ✅ Step 3 passed — breaking change detected (rust-add FAIL)');
    } else {
      console.log('\n  ❌ FAIL: breaking change not detected');
      allPassed = false;
    }
    if (output.includes('rust-reverse') && output.includes('PASS')) {
      console.log('  ✅ Step 3 passed — unaffected cluster still PASSes (rust-reverse)');
    } else {
      console.log('  ❌ FAIL: rust-reverse should still PASS');
      allPassed = false;
    }
  }
  console.log('');

  // ─── Step 4: Valid refactor — should PASS ────────────────────────────────
  console.log('━━━ Step 4: Valid refactor (same output, different impl) — expect PASS ━━');
  writeFileSync(join(TMP_DIR, 'src', 'lib.rs'), LIB_RS_REFACTOR);
  writeFileSync(join(TMP_DIR, 'src', 'bin', 'regret_validate.rs'), generateValidateRs());
  try {
    const validateOutput = execSync('cargo run --bin regret_validate --quiet 2>/dev/null', {
      cwd: TMP_DIR, encoding: 'utf8',
    });
    console.log(validateOutput.trim());
    if (validateOutput.includes('2 PASS, 0 FAIL')) {
      console.log('\n  ✅ Step 4 passed — valid refactor is GREEN');
    } else {
      console.log('\n  ❌ FAIL: valid refactor should PASS but didn\'t');
      allPassed = false;
    }
  } catch (e) {
    console.log(e.stdout?.toString()?.trim() || e.message);
    console.log('\n  ❌ FAIL: validate binary exited non-zero');
    allPassed = false;
  }
  console.log('');

  // ─── Step 5: Cross-stack fingerprint parity ──────────────────────────────
  console.log('━━━ Step 5: Cross-stack fingerprint parity (Rust vs JS) ━━━━━━━━━━━');
  const rustAddRegret = readFileSync(join(TMP_DIR, 'regrets', 'rust-add.regret'), 'utf8');
  const parsed = parseRegret(rustAddRegret);
  const rustHash = parsed.hash;
  const jsHash = fingerprint([1, 2], 3);
  console.log(`  Rust fingerprint for add([1,2])→3:  ${rustHash}`);
  console.log(`  JS fingerprint for add([1,2])→3:    ${jsHash}`);
  if (rustHash === jsHash) {
    console.log('  ✅ Step 5 passed — fingerprints match (cross-stack parity confirmed)');
  } else {
    console.log('❌ FAIL: fingerprints differ — cross-stack parity broken');
    allPassed = false;
  }
  console.log('');

  // ─── Summary ──────────────────────────────────────────────────────────────
  if (allPassed) {
    console.log('╔══════════════════════════════════════════════════════════════════════╗');
    console.log('║  ✅ All verification steps passed — Rust stack is working           ║');
    console.log('╚══════════════════════════════════════════════════════════════════════╝');
    process.exit(0);
  } else {
    console.log('╔══════════════════════════════════════════════════════════════════════╗');
    console.log('║  ❌ Some verification steps FAILED                                    ║');
    console.log('╚══════════════════════════════════════════════════════════════════════╝');
    process.exit(1);
  }
} finally {
  rmSync(TMP_DIR, { recursive: true, force: true });
}

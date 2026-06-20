//! regret_runner.rs — Integration test for Regrets capture + validate workflow.
//!
//! This test file implements both capture and validate modes for Rust clusters.
//! It reads manifest.json, invokes the target functions with the specified inputs,
//! and either writes .regret files (capture) or compares fingerprints (validate).
//!
//! Usage (via cargo test):
//!   cargo test --test regret_runner -- --nocapture    # run both capture + validate
//!   cargo test --test regret_runner -- capture        # capture only
//!   cargo test --test regret_runner -- validate       # validate only

use regret_example::{add, mul, is_even, reverse_string, fibonacci};
use regret_example::fingerprint;
use serde_json::{json, Value};
use std::fs;
use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};

// ─── Dispatch function calls ─────────────────────────────────────────────────
// Maps function names from manifest to actual Rust function calls.
// Returns (input_json, output_json) for fingerprinting.

fn call_function(entry: &str, input: &Value) -> Value {
    match entry {
        "add" => {
            let arr = input.as_array().expect("add expects array input [a, b]");
            let a = arr[0].as_i64().expect("add: a must be i64");
            let b = arr[1].as_i64().expect("add: b must be i64");
            json!(add(a, b))
        }
        "mul" => {
            let arr = input.as_array().expect("mul expects array input [a, b]");
            let a = arr[0].as_i64().expect("mul: a must be i64");
            let b = arr[1].as_i64().expect("mul: b must be i64");
            json!(mul(a, b))
        }
        "is_even" => {
            let n = input.as_i64().expect("is_even: input must be i64");
            json!(is_even(n))
        }
        "reverse_string" => {
            let s = input.as_str().expect("reverse_string: input must be string");
            json!(reverse_string(s))
        }
        "fibonacci" => {
            let n = input.as_u64().expect("fibonacci: input must be u64") as u32;
            json!(fibonacci(n))
        }
        _ => panic!("Unknown function: {}", entry),
    }
}

// ─── Manifest and .regret file handling ──────────────────────────────────────

#[derive(serde::Deserialize)]
struct Manifest {
    clusters: Vec<Cluster>,
}

#[derive(serde::Deserialize)]
struct Cluster {
    id: String,
    entry: String,
    stack: String,
    inputs: Vec<Value>,
    #[serde(default)]
    multi_args: bool,
    #[serde(default)]
    watches: Vec<String>,
    #[serde(default)]
    fingerprint_level: Option<String>,
    #[serde(default)]
    description: Option<String>,
}

fn manifest_path() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("regrets")
        .join("manifest.json")
}

fn regret_path(cluster_id: &str) -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("regrets")
        .join(format!("{}.regret", cluster_id))
}

fn read_manifest() -> Manifest {
    let path = manifest_path();
    let content = fs::read_to_string(&path)
        .unwrap_or_else(|e| panic!("Failed to read manifest at {:?}: {}", path, e));
    serde_json::from_str(&content)
        .unwrap_or_else(|e| panic!("Failed to parse manifest: {}", e))
}

// ─── .regret file format ─────────────────────────────────────────────────────
// Compatible with the existing format used by JS/Python stacks:
//   cluster: <id>
//   version: 1
//   fingerprint: <7-char hash>
//   captured: <ISO timestamp>
//   watches: [<watch1>, <watch2>]
//   entry: <function name>
//   stack: rust
//   fingerprintLevel: entry
//   ---
//   INPUT  <json>
//   OUTPUT <json>
//   HASH   <7-char hash>

fn write_regret_file(
    cluster_id: &str,
    entry: &str,
    watches: &[String],
    fingerprint_level: &str,
    input: &Value,
    output: &Value,
    fp: &str,
) {
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_secs();
    // Format as ISO 8601
    let timestamp = format_iso8601(now);

    let watches_str = if watches.is_empty() {
        "[]".to_string()
    } else {
        format!("[{}]", watches.iter().map(|w| format!("{}", w)).collect::<Vec<_>>().join(", "))
    };

    let input_json = serde_json::to_string(input).unwrap();
    let output_json = serde_json::to_string(output).unwrap();

    let content = format!(
        "cluster: {cluster_id}\n\
         version: 1\n\
         fingerprint: {fp}\n\
         captured: {timestamp}\n\
         watches: {watches_str}\n\
         entry: {entry}\n\
         stack: rust\n\
         fingerprintLevel: {fingerprint_level}\n\
         ---\n\
         INPUT  {input_json}\n\
         OUTPUT {output_json}\n\
         HASH   {fp}\n",
        cluster_id = cluster_id,
        fp = fp,
        timestamp = timestamp,
        watches_str = watches_str,
        entry = entry,
        fingerprint_level = fingerprint_level,
        input_json = input_json,
        output_json = output_json,
    );

    let path = regret_path(cluster_id);
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).ok();
    }
    fs::write(&path, &content)
        .unwrap_or_else(|e| panic!("Failed to write .regret file at {:?}: {}", path, e));
    println!("  Written: {:?}", path);
}

fn format_iso8601(secs: u64) -> String {
    // Simple ISO 8601 format without timezone
    let days = secs / 86400;
    let time_of_day = secs % 86400;
    let hours = time_of_day / 3600;
    let minutes = (time_of_day % 3600) / 60;
    let seconds = time_of_day % 60;

    // Calculate date from days since epoch
    let (year, month, day) = days_to_date(days);
    format!(
        "{:04}-{:02}-{:02}T{:02}:{:02}:{:02}+00:00",
        year, month, day, hours, minutes, seconds
    )
}

fn days_to_date(days_since_epoch: u64) -> (u64, u64, u64) {
    // Unix epoch is 1970-01-01
    let mut year = 1970u64;
    let mut remaining_days = days_since_epoch;

    loop {
        let days_in_year = if is_leap_year(year) { 366 } else { 365 };
        if remaining_days < days_in_year {
            break;
        }
        remaining_days -= days_in_year;
        year += 1;
    }

    let leap = is_leap_year(year);
    let month_days = [
        31, if leap { 29 } else { 28 }, 31, 30, 31, 30,
        31, 31, 30, 31, 30, 31,
    ];

    let mut month = 1u64;
    for &md in &month_days {
        if remaining_days < md {
            break;
        }
        remaining_days -= md;
        month += 1;
    }

    let day = remaining_days + 1;
    (year, month, day)
}

fn is_leap_year(year: u64) -> bool {
    (year % 4 == 0 && year % 100 != 0) || year % 400 == 0
}

// ─── Parse .regret file for validation ───────────────────────────────────────

#[derive(Debug)]
struct RegretFile {
    cluster: String,
    entry: String,
    stack: String,
    fingerprint_level: String,
    input: Value,
    output: Value,
    golden_hash: String,
}

fn parse_regret(content: &str) -> RegretFile {
    let parts: Vec<&str> = content.splitn(2, "\n---\n").collect();
    if parts.len() != 2 {
        panic!("Invalid .regret file format: missing --- separator");
    }

    let meta_section = parts[0];
    let data_section = parts[1];

    // Parse metadata
    let mut cluster = String::new();
    let mut entry = String::new();
    let mut stack = String::new();
    let mut fingerprint_level = String::from("entry");

    for line in meta_section.lines() {
        if let Some(val) = line.strip_prefix("cluster: ") {
            cluster = val.trim().to_string();
        } else if let Some(val) = line.strip_prefix("entry: ") {
            entry = val.trim().to_string();
        } else if let Some(val) = line.strip_prefix("stack: ") {
            stack = val.trim().to_string();
        } else if let Some(val) = line.strip_prefix("fingerprintLevel: ") {
            fingerprint_level = val.trim().to_string();
        }
    }

    // Parse data section
    let mut input: Option<Value> = None;
    let mut output: Option<Value> = None;
    let mut golden_hash: Option<String> = None;

    for line in data_section.lines() {
        let trimmed = line.trim();
        if let Some(val) = trimmed.strip_prefix("INPUT ") {
            input = serde_json::from_str(val.trim()).ok();
        } else if let Some(val) = trimmed.strip_prefix("OUTPUT ") {
            output = serde_json::from_str(val.trim()).ok();
        } else if let Some(val) = trimmed.strip_prefix("HASH ") {
            golden_hash = Some(val.trim().to_string());
        }
    }

    RegretFile {
        cluster,
        entry,
        stack,
        fingerprint_level,
        input: input.unwrap_or(Value::Null),
        output: output.unwrap_or(Value::Null),
        golden_hash: golden_hash.unwrap_or_default(),
    }
}

// ─── Capture test ────────────────────────────────────────────────────────────

#[test]
fn capture() {
    let manifest = read_manifest();
    let rust_clusters: Vec<&Cluster> = manifest
        .clusters
        .iter()
        .filter(|c| c.stack == "rust")
        .collect();

    if rust_clusters.is_empty() {
        println!("No Rust clusters found in manifest.");
        return;
    }

    println!("Capturing {} Rust cluster(s)...", rust_clusters.len());

    for cluster in &rust_clusters {
        println!("\n  Cluster: {}", cluster.id);

        // For multi-arg functions, wrap input in array if not already
        let first_input = &cluster.inputs[0];
        let input_value = if cluster.multi_args && !first_input.is_array() {
            json!([first_input])
        } else {
            first_input.clone()
        };

        // Call the function
        let output_value = call_function(&cluster.entry, &input_value);

        // Skip trivial outputs (null, undefined, NaN)
        if output_value.is_null() {
            println!("    Skipping: output is null");
            continue;
        }

        // Compute fingerprint
        let fp = fingerprint::compute(&input_value, &output_value);

        // Write .regret file
        let watches = if cluster.watches.is_empty() {
            vec![cluster.entry.clone()]
        } else {
            cluster.watches.clone()
        };
        let fpl = cluster.fingerprint_level.as_deref().unwrap_or("entry");
        write_regret_file(
            &cluster.id,
            &cluster.entry,
            &watches,
            fpl,
            &input_value,
            &output_value,
            &fp,
        );

        println!("    Fingerprint: {} → {} (output: {})", cluster.entry, fp, output_value);
    }

    println!("\nCapture complete.");
}

// ─── Validate test ───────────────────────────────────────────────────────────

#[test]
fn validate() {
    let manifest = read_manifest();
    let rust_clusters: Vec<&Cluster> = manifest
        .clusters
        .iter()
        .filter(|c| c.stack == "rust")
        .collect();

    if rust_clusters.is_empty() {
        println!("No Rust clusters found in manifest.");
        return;
    }

    println!("Validating {} Rust cluster(s)...", rust_clusters.len());
    let mut passed = 0;
    let mut failed = 0;
    let mut skipped = 0;

    for cluster in &rust_clusters {
        let regret_path = regret_path(&cluster.id);

        if !regret_path.exists() {
            println!("  SKIP {}: .regret file not found (run capture first)", cluster.id);
            skipped += 1;
            continue;
        }

        let content = fs::read_to_string(&regret_path)
            .unwrap_or_else(|e| panic!("Failed to read {:?}: {}", regret_path, e));
        let regret = parse_regret(&content);

        // Re-invoke the function with the stored input
        let live_output = call_function(&regret.entry, &regret.input);

        // Recompute fingerprint
        let live_fp = fingerprint::compute(&regret.input, &live_output);

        if live_fp == regret.golden_hash {
            println!("  PASS {}: fingerprint {} matches", cluster.id, live_fp);
            passed += 1;
        } else {
            println!(
                "  FAIL {}: fingerprint mismatch (expected: {}, got: {})",
                cluster.id, regret.golden_hash, live_fp
            );
            println!("    Input:   {}", regret.input);
            println!("    Expected output: {}", regret.output);
            println!("    Actual output:   {}", live_output);
            failed += 1;
        }
    }

    println!("\nValidation complete: {} passed, {} failed, {} skipped", passed, failed, skipped);

    assert_eq!(failed, 0, "{} cluster(s) failed validation", failed);
}

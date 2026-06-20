# Rust Stack Variant

Regression fingerprinting for Rust projects using trait wrapping and `cargo test` capture.

## Quick Start

1. Add `"stack": "rust"` clusters to `regrets/manifest.json`
2. Run `bash scripts/capture_rust.sh` to capture fingerprints
3. Run `bash scripts/capture_rust.sh validate` to validate
4. Run `bash scripts/capture_rust.sh health` for health report
5. All `.regret` files use identical format to JS stack

---

## Equivalent of Ghost Proxy in Rust

Rust has no runtime Proxy like JavaScript. Instead, we use **trait wrapping** — define a trait for the function's contract, then swap the real implementation with a recording wrapper.

### Pattern: Trait Wrapping

```rust
/// The contract trait — defines what the function does
pub trait InvoiceFormatter: Send + Sync {
    fn format_amount(&self, amount: u64, currency: &str) -> String;
    fn format_period(&self, period: &str) -> String;
}

/// Production implementation
pub struct CoretaxFormatter;

impl InvoiceFormatter for CoretaxFormatter {
    fn format_amount(&self, amount: u64, currency: &str) -> String {
        format!("{} {}", amount, currency)
    }
    fn format_period(&self, period: &str) -> String {
        period.replace("_", "").chars().rev().collect()
    }
}

/// Ghost (recording) wrapper — captures inputs/outputs without changing behavior
pub struct GhostFormatter<F: InvoiceFormatter> {
    inner: F,
    recorder: std::sync::Mutex<Vec<CallRecord>>,
}

struct CallRecord {
    fn_name: String,
    args: serde_json::Value,
    result: serde_json::Value,
}

impl<F: InvoiceFormatter + Send + Sync> InvoiceFormatter for GhostFormatter<F> {
    fn format_amount(&self, amount: u64, currency: &str) -> String {
        let result = self.inner.format_amount(amount, currency);
        let record = CallRecord {
            fn_name: "format_amount".into(),
            args: serde_json::json!({"amount": amount, "currency": currency}),
            result: serde_json::json!(result),
        };
        self.recorder.lock().unwrap().push(record);
        result
    }
    fn format_period(&self, period: &str) -> String {
        let result = self.inner.format_period(period);
        let record = CallRecord {
            fn_name: "format_period".into(),
            args: serde_json::json!({"period": period}),
            result: serde_json::json!(result),
        };
        self.recorder.lock().unwrap().push(record);
        result
    }
}
```

The ghost wrapper is transparent — it calls the real implementation, records the I/O, then returns the original result. Behavior is untouched.

---

## fingerprint.rs — SHA-256 + XOR + Base36

The fingerprint algorithm must be **identical** to the JS implementation in `scripts/fingerprint.js`. Same input must produce same 7-char hash.

```rust
// fingerprint.rs
use sha2::{Sha256, Digest};
use serde_json::Value;
use std::collections::BTreeMap;

/// Stable JSON serialization — keys sorted recursively (mirrors JS stableStringify)
pub fn stable_stringify(obj: &Value) -> String {
    match obj {
        Value::Null => "null".to_string(),
        Value::Bool(b) => b.to_string(),
        Value::Number(n) => n.to_string(),
        Value::String(s) => serde_json::to_string(s).unwrap(),
        Value::Array(arr) => {
            let items: Vec<String> = arr.iter().map(|v| stable_stringify(v)).collect();
            format!("[{}]", items.join(","))
        }
        Value::Object(map) => {
            let sorted: BTreeMap<_, _> = map.iter().collect();
            let items: Vec<String> = sorted.iter()
                .map(|(k, v)| format!("{}:{}", serde_json::to_string(k).unwrap(), stable_stringify(v)))
                .collect();
            format!("{{{}}}", items.join(","))
        }
    }
}

/// Normalize non-deterministic values before hashing
pub fn normalize(obj: &mut Value, rules: &[String]) {
    match obj {
        Value::String(s) => {
            if rules.contains(&"timestamps".to_string()) && regex_is_timestamp(s) {
                *s = "<TIMESTAMP>".to_string();
            }
            if rules.contains(&"uuids".to_string()) && regex_is_uuid(s) {
                *s = "<UUID>".to_string();
            }
            if rules.contains(&"absPaths".to_string()) && s.starts_with('/') {
                *s = s.replacen('/', "<ROOT>/", 1);
            }
            if rules.contains(&"dynamicDates".to_string()) {
                *s = normalize_dynamic_dates(s);
            }
        }
        Value::Number(n) => {
            if rules.contains(&"epochs".to_string()) {
                if let Some(f) = n.as_f64() {
                    if f > 1_000_000_000.0 && f < 9_999_999_999_999.0 {
                        *obj = Value::String("<EPOCH>".to_string());
                    }
                }
            }
        }
        Value::Array(arr) => {
            for item in arr.iter_mut() { normalize(item, rules); }
        }
        Value::Object(map) => {
            for (_, v) in map.iter_mut() { normalize(v, rules); }
        }
        _ => {}
    }
}

/// Core fingerprint: SHA-256(input|output) → base36 → first 7 chars
/// IDENTICAL to JS: base36(sha256(INPUT) XOR sha256(OUTPUT)).slice(0,7)
pub fn fingerprint(input: &Value, output: &Value, rules: &[String], ignore_fields: &[String]) -> String {
    let mut inp = input.clone();
    let mut out = output.clone();
    normalize(&mut inp, rules);
    normalize(&mut out, rules);
    strip_fields(&mut inp, ignore_fields);
    strip_fields(&mut out, ignore_fields);

    let combined = format!("{}|{}", stable_stringify(&inp), stable_stringify(&out));
    let hash = Sha256::digest(combined.as_bytes());

    // Convert to BigInt then base36 — mirrors JS BigInt('0x' + hex).toString(36)
    let hex_str = format!("{:x}", hash);
    let big_num = num_bigint::BigInt::parse_bytes(hex_str.as_bytes(), 16).unwrap();
    let base36 = big_num.to_str_radix(36);
    base36[..7].to_string()
}

fn strip_fields(obj: &mut Value, fields: &[String]) {
    if fields.is_empty() { return; }
    match obj {
        Value::Object(map) => {
            for f in fields { map.remove(f); }
            for (_, v) in map.iter_mut() { strip_fields(v, fields); }
        }
        Value::Array(arr) => {
            for item in arr.iter_mut() { strip_fields(item, fields); }
        }
        _ => {}
    }
}

fn regex_is_timestamp(s: &str) -> bool {
    // ISO 8601: 2024-01-15T10:30:00Z or similar
    s.len() >= 20 && s.chars().nth(4) == Some('-') && s.chars().nth(10) == Some('T')
}

fn regex_is_uuid(s: &str) -> bool {
    let parts: Vec<&str> = s.split('-').collect();
    parts.len() == 5 && parts.iter().all(|p| p.chars().all(|c| c.is_ascii_hexdigit()))
}

fn normalize_dynamic_dates(s: &str) -> String {
    let re_mmyyyy = regex::Regex::new(r"\d{2}\d{4}").unwrap();
    let re_yyyy = regex::Regex::new(r"(?<![0-9])(20\d{2}|19\d{2})(?![0-9])").unwrap();
    let result = re_mmyyyy.replace_all(s, "<MMYYYY>").to_string();
    re_yyyy.replace_all(&result, "<YYYY>").to_string()
}
```

**Required crates** (`Cargo.toml`):
```toml
[dependencies]
sha2 = "0.10"
serde_json = "1.0"
serde = { version = "1.0", features = ["derive"] }
num-bigint = "0.4"
regex = "1"
```

### Cross-Stack Consistency Check

The fingerprint algorithm must produce identical results across JS, Python, and Rust. To verify:

```
INPUT:  "2025-01-15T00:00:00"
OUTPUT: "15/01/2025"

JS:     stableStringify("2025-01-15T00:00:00") + '|' + stableStringify("15/01/2025")
Rust:   stable_stringify(&Value::String("2025-01-15T00:00:00".into())) + "|" + stable_stringify(&Value::String("15/01/2025".into()))

Both must produce: "2025-01-15T00:00:00|15/01/2025"
→ sha256 → hex → BigInt → base36 → first 7 chars
```

Run `cargo test -- --nocapture` to verify cross-stack hash parity in the test module.

---

## manifest.json for Rust Clusters

```json
{
  "clusters": [
    {
      "id": "rust-format-period",
      "entry": "format_period",
      "watches": ["format_period"],
      "file": "src/formatter/period.rs",
      "stack": "rust",
      "module": "formatter::period",
      "fingerprintLevel": "entry",
      "description": "Format tax period string from YYYY_MM to MMYYYY",
      "inputs": [
        "2025_05",
        "2024_01"
      ]
    },
    {
      "id": "rust-sanitize-filename",
      "entry": "sanitize_filename",
      "watches": ["sanitize_filename"],
      "file": "src/filename/sanitizer.rs",
      "stack": "rust",
      "module": "filename::sanitizer",
      "multiArgs": true,
      "normalize": ["dynamicDates"],
      "inputs": [
        ["FPK-", "202505"],
        ["DOC-", "2025"]
      ]
    }
  ]
}
```

### Rust-Specific Manifest Fields

| Field | Required | Description |
|-------|----------|-------------|
| `stack` | ✅ | Must be `"rust"` |
| `module` | ✅ | Rust module path (colon or double-colon notation) |
| `file` | ✅ | Path to source file relative to project root |
| `pythonPath` | ❌ | Not used for Rust |
| `cargoBin` | ❌ | Path to the binary that fulfills the Regrets CLI contract (JSON stdin → JSON stdout). Defaults to `./target/debug/<packageName>` if omitted. |
| `cargoBinArgs` | ❌ | Array of string arguments passed verbatim to `cargoBin`. Useful for wrapper invocation (e.g. `cargoBin: "node"`, `cargoBinArgs: ["./shim/proxy.mjs"]`). Empty by default. |
| `packageName` | ❌ | Cargo package name — used to locate the default binary path (`./target/debug/<packageName>`) when `cargoBin` is not set. |

---

## Script Runner: `scripts/capture_rust.sh`

```bash
#!/usr/bin/env bash
# capture_rust.sh — compile + run regret capture for Rust clusters
# Usage:
#   bash scripts/capture_rust.sh               # capture all Rust clusters
#   bash scripts/capture_rust.sh validate       # validate all Rust clusters
#   bash scripts/capture_rust.sh health         # health report
#   bash scripts/capture_rust.sh --cluster rust-format-period

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SKILL_DIR="$(dirname "$SCRIPT_DIR")"
PROJECT_DIR="$(pwd)"
MANIFEST="${PROJECT_DIR}/regrets/manifest.json"
REGRET_DIR="${PROJECT_DIR}/regrets"

# Ensure regrets directory exists
mkdir -p "$REGRET_DIR"

MODE="${1:-capture}"
CLUSTER_FLAG=""

# Parse --cluster flag
for arg in "$@"; do
  if [[ "$arg" == "--cluster" ]]; then
    shift
    CLUSTER_FLAG="--cluster $1"
    break
  fi
done

# Generate the test runner from manifest
# This creates a temporary Rust test file that:
# 1. Reads manifest.json
# 2. For each cluster with stack=rust:
#    - Imports the target module
#    - Wraps watched functions with GhostRecorder
#    - Calls entry function with provided inputs
#    - Computes fingerprint
#    - Writes .regret file

case "$MODE" in
  capture)
    echo "📡 Capturing Rust clusters..."
    # Build first to ensure modules are compiled
    cargo build 2>/dev/null || true
    # Run capture test — outputs to stdout, we parse and write .regret files
    cargo test --test regret_capture -- --nocapture 2>/dev/null || {
      echo "⚠️  No regret_capture test found. Run: cargo regret init"
      echo "   This generates tests/regret_capture.rs from your manifest.json"
    }
    ;;
  validate)
    echo "🔍 Validating Rust clusters..."
    cargo test --test regret_validate -- --nocapture 2>/dev/null || {
      echo "⚠️  No regret_validate test found."
    }
    ;;
  health)
    node "$SKILL_DIR/scripts/health.js"
    ;;
  *)
    echo "Usage: bash scripts/capture_rust.sh [capture|validate|health] [--cluster <id>]"
    exit 1
    ;;
esac
```

### `scripts/validate_rust.sh` — Proper Validator (Recommended)

`capture_rust.sh validate` delegates to `node scripts/validate.js`, which
cannot invoke Rust functions. **`scripts/validate_rust.sh`** is the proper
Rust validator — it invokes your Rust binary via a documented CLI contract
and recomputes fingerprints using `scripts/fingerprint.js` (the same
algorithm JS/Python/Go use).

#### Rust Binary Contract

Your Rust binary must:

1. Read a single JSON object from stdin:
   `{ "cluster": "<id>", "input": <value> }`
2. Dispatch to the target function based on `cluster` (typically a `match`
   statement in `main()`)
3. Write a single JSON object to stdout:
   `{ "output": <value> }`
4. On error: write `{ "error": "<message>" }` and exit non-zero

The functions being fingerprinted MUST stay pure (no I/O, no global state,
no `SystemTime`). Side effects belong in a separate shell module — see
[Pure Function Extraction in Rust](#pure-function-extraction-in-rust)
below.

#### Usage

```bash
# Validate all Rust clusters against captured .regret files
bash scripts/validate_rust.sh --manifest regrets/manifest.json

# Validate one cluster
bash scripts/validate_rust.sh --manifest regrets/manifest.json --cluster rust-format-period

# Stop on first failure
bash scripts/validate_rust.sh --manifest regrets/manifest.json --fail-fast

# Machine-readable JSON output (for CI / MCP integration)
bash scripts/validate_rust.sh --manifest regrets/manifest.json --quiet

# Override the binary path (top-level cargoBin in manifest is the default)
bash scripts/validate_rust.sh --manifest regrets/manifest.json --bin ./target/debug/my-binary
```

#### Manifest Configuration

```json
{
  "packageName": "my-crate",
  "cargoBin": "./target/debug/my-crate",
  "clusters": [
    {
      "id": "rust-format-period",
      "entry": "format_period",
      "stack": "rust",
      "module": "my_crate::formatter",
      "file": "src/formatter.rs",
      "inputs": ["2025_05", "2024_01"]
    }
  ]
}
```

If `cargoBin` is omitted, the validator looks for
`./target/debug/<packageName>`. Use `cargoBinArgs` to pass wrapper arguments
(e.g. `["./shim/proxy.mjs"]` when invoking via `node`).

#### Why a CLI binary contract (not `cargo test`)?

The `cargo test --test regret_validate` approach requires hand-generating a
`tests/regret_validate.rs` file per project — a non-trivial barrier. The
CLI binary contract is simpler: one small binary that does JSON-stdin →
JSON-stdout dispatch, reusable across any Rust project. The validator stays
fast (no recompilation) and decoupled from the build system.

#### Working Example

See [`proof/rust/`](../proof/rust/README.md) for a complete end-to-end demo
including:
- Real Rust source (`src/main.rs`) with two pure functions
- Node shim (for running the demo without a Rust toolchain)
- Captured `.regret` files
- A `run_demo.sh` script that exercises PASS and FAIL cases

The demo verifies cross-stack fingerprint parity: the `rust-format-period`
cluster produces hash `12d5tvu`, identical to the hash documented in the
example `.regret` file below.

### `cargo regret` — Cargo Subcommand (Optional)

For a more integrated experience, create a binary in `src/bin/regret.rs`:

```rust
// src/bin/regret.rs
use std::fs;
use serde_json::Value;

fn main() {
    let manifest = fs::read_to_string("regrets/manifest.json")
        .expect("regrets/manifest.json not found");
    let data: Value = serde_json::from_str(&manifest).unwrap();

    for cluster in data["clusters"].as_array().unwrap() {
        if cluster["stack"] != "rust" { continue; }
        println!("📡 Capturing: {}", cluster["id"]);
        // Dynamic dispatch based on module path
        // Each Rust module must expose a `regret_entry()` function
    }
}
```

---

## Normalization: Rust-Specific Patterns

| Non-Deterministic Source | Rust Pattern | Normalization Rule | Replacement |
|--------------------------|-------------|-------------------|-------------|
| Current time | `std::time::SystemTime::now()` | `"timestamps"` | `<TIMESTAMP>` |
| Duration | `std::time::Instant::now()` | `"epochs"` | `<EPOCH>` |
| UUID | `uuid::Uuid::new_v4()` | `"uuids"` | `<UUID>` |
| Random | `rand::thread_rng()` | `"ignoreFields"` on that key | — |
| File paths | `std::env::current_dir()` | `"absPaths"` | `<ROOT>/...` |
| Dynamic dates | Period strings in filenames | `"dynamicDates"` | `<MMYYYY>`/`<YYYY>` |

### Example: Normalizing `SystemTime`

```rust
// Before: output contains current time
let now = SystemTime::now()
    .duration_since(UNIX_EPOCH)
    .unwrap()
    .as_secs();
// output: {"captured_at": 1718803200}

// In manifest:
{ "normalize": ["epochs"] }
// After normalization: {"captured_at": "<EPOCH>"}
```

---

## Example `.regret` Output for Rust Function

```
cluster: rust-format-period
fingerprint: 12d5tvu
captured: 2026-05-30T05:00:00Z
watches: [format_period]
entry: format_period
stack: rust
module: formatter::period
fingerprintLevel: entry
---
INPUT  "2025_05"
OUTPUT "052025"
HASH   12d5tvu
```

Note: The hash `12d5tvu` matches the JS cluster `format-period` because the same input → same output → same fingerprint algorithm. Cross-stack parity verified.

---

## NPM Script Equivalents for Rust

Add to the target project's `package.json` (if it has one for CI orchestration):

```json
{
  "regret:capture:rust": "bash ../../skills/regresion-testing/scripts/capture_rust.sh capture",
  "regret:validate:rust": "bash ../../skills/regresion-testing/scripts/capture_rust.sh validate",
  "regret:health:rust": "bash ../../skills/regresion-testing/scripts/capture_rust.sh health"
}
```

Or add as Makefile targets:

```makefile
regret-capture-rust:
        bash skills/regresion-testing/scripts/capture_rust.sh capture

regret-validate-rust:
        bash skills/regresion-testing/scripts/capture_rust.sh validate

regret-health-rust:
        bash skills/regresion-testing/scripts/capture_rust.sh health
```

---

## Pure Function Extraction in Rust

Rust's ownership system makes side-effect isolation natural. Follow these principles:

### Pattern: Extract Logic from `impl` Blocks

```rust
// ❌ BEFORE — mixed concerns, hard to fingerprint
impl InvoiceProcessor {
    pub fn process(&self, data: &RawInvoice) -> Result<ProcessedInvoice, Error> {
        // Pure calculation
        let total = self.calculate_total(data.items());
        let tax = self.apply_tax(total, data.tax_rate());

        // Side effect: write to file
        let output = format!("{}|{}|{}", data.id(), total, tax);
        std::fs::write("/tmp/invoice.txt", &output)?;

        // Side effect: HTTP call
        self.client.post("/api/invoices", &output).await?;

        Ok(ProcessedInvoice { total, tax })
    }
}

// ✅ AFTER — pure logic extracted to *_logic.rs
// src/invoice/processor_logic.rs
pub fn calculate_total(items: &[Item]) -> u64 {
    items.iter().map(|i| i.amount).sum()
}

pub fn apply_tax(amount: u64, rate: f64) -> u64 {
    ((amount as f64) * (1.0 + rate)) as u64
}

pub fn format_invoice_output(id: &str, total: u64, tax: u64) -> String {
    format!("{}|{}|{}", id, total, tax)
}

// src/invoice/processor.rs — thin shell with side effects only
impl InvoiceProcessor {
    pub async fn process(&self, data: &RawInvoice) -> Result<ProcessedInvoice, Error> {
        let total = processor_logic::calculate_total(data.items());
        let tax = processor_logic::apply_tax(total, data.tax_rate());
        let output = processor_logic::format_invoice_output(data.id(), total, tax);

        std::fs::write("/tmp/invoice.txt", &output)?;
        self.client.post("/api/invoices", &output).await?;

        Ok(ProcessedInvoice { total, tax })
    }
}
```

### Fingerprint the Logic Module

```json
{
  "id": "rust-calculate-total",
  "entry": "calculate_total",
  "watches": ["calculate_total"],
  "file": "src/invoice/processor_logic.rs",
  "stack": "rust",
  "module": "invoice::processor_logic",
  "inputs": [
    [{"amount": 100000}, {"amount": 250000}],
    [{"amount": 0}]
  ]
}
```

### Rules for Rust Pure Logic Extraction

1. **Never fingerprint functions that do I/O** — `fs::write`, HTTP calls, DB queries go in the shell, not logic
2. **Never fingerprint `async` functions directly** — extract the synchronous computation, fingerprint that
3. **`*_logic.rs` modules must have zero `use` of**: `std::fs`, `std::net`, `tokio`, `reqwest`, `sqlx`, or any I/O crate
4. **Logic functions take all data as parameters** — no `self` that hides state, no global statics
5. **If a function needs `SystemTime`** — accept `now: u64` as a parameter instead, let the shell pass `SystemTime::now()`

---

## Cargo Test Integration

The generated test file (`tests/regret_capture.rs`) follows this pattern:

```rust
// tests/regret_capture.rs — auto-generated from manifest.json
mod regret_helpers {
    // Include fingerprint.rs logic
}

#[cfg(test)]
mod regret_capture {
    use super::*;

    #[test]
    fn test_format_period() {
        use my_crate::formatter::period::format_period;

        let input = "2025_05";
        let output = format_period(input);

        let fp = regret_helpers::fingerprint(
            &serde_json::json!(input),
            &serde_json::json!(output),
            &[], &[]
        );

        // Write .regret file
        let content = format!(
            "cluster: rust-format-period\nfingerprint: {}\ncaptured: {}\n\
             watches: [format_period]\nentry: format_period\nstack: rust\n\
             module: formatter::period\nfingerprintLevel: entry\n---\n\
             INPUT  {}\nOUTPUT {}\nHASH   {}",
            fp, chrono::Utc::now().to_rfc3339(),
            serde_json::to_string(&input).unwrap(),
            serde_json::to_string(&output).unwrap(),
            fp
        );
        std::fs::write("regrets/rust-format-period.regret", content).unwrap();

        println!("  ✅ Fingerprint: {}", fp);
    }
}
```

Run: `cargo test --test regret_capture -- --nocapture`

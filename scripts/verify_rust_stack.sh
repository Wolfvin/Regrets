#!/usr/bin/env bash
# verify_rust_stack.sh — one-command end-to-end verifier for the Rust stack.
#
# Runs the full capture → validate cycle against the bundled fixture
# (references/rust) and asserts:
#   1. capture writes .regret files for all 5 clusters
#   2. validate (no code change) exits 0, prints PASS for all clusters
#   3. validate (breaking change to add()) exits non-zero, prints FAIL for one
#   4. validate (valid refactor — same output) exits 0, prints PASS
#   5. --cluster filter isolates a single cluster (regression test for #355 CLI bug)
#   6. cross-stack parity: Rust HASH === JS fingerprint() for the same I/O
#
# Self-contained — no setup needed beyond `cargo` on PATH. Skips with exit 77
# if Rust toolchain is missing (CI environments without Rust).
#
# Usage:
#   bash scripts/verify_rust_stack.sh
#   bash scripts/verify_rust_stack.sh --quiet    # only print final summary
#
# Exits 0 if all checks pass, non-zero otherwise.

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SKILL_DIR="$(dirname "$SCRIPT_DIR")"
FIXTURE="$SKILL_DIR/references/rust"
LIB_RS="$FIXTURE/src/lib.rs"

QUIET=0
if [[ "${1:-}" == "--quiet" ]]; then
  QUIET=1
fi

log() {
  if [[ "$QUIET" -eq 0 ]]; then
    echo "$@"
  fi
}

PASS_COUNT=0
FAIL_COUNT=0
record_pass() { PASS_COUNT=$((PASS_COUNT + 1)); }
record_fail() { FAIL_COUNT=$((FAIL_COUNT + 1)); }

# ─── Preflight: cargo must be on PATH ────────────────────────────────────────
if ! command -v cargo &>/dev/null; then
  echo "⚠️  cargo is not installed. Install Rust toolchain to verify the Rust stack."
  echo "   See: https://rustup.rs/"
  echo "   Skipping verify_rust_stack.sh."
  exit 77  # standard "skip" exit code (used by CI)
fi

CARGO_VERSION=$(cargo --version)
RUSTC_VERSION=$(rustc --version)
log "ℹ️  Using: $CARGO_VERSION / $RUSTC_VERSION"
log ""

# Backup lib.rs so we can mutate + restore
cp "$LIB_RS" /tmp/lib.rs.verify-backup

run_cargo_validate() {
  # Suppress cargo's compile noise; only show test output
  (cd "$FIXTURE" && cargo test --test regret_runner -- validate --nocapture 2>&1)
}

# ─── 1. capture — write .regret files for all 5 clusters ────────────────────
log "─── 1. capture — write .regret files for all 5 Rust clusters ───"

# Clean slate: remove .regret files so we know capture wrote them
rm -f "$FIXTURE/regrets/"*.regret

CAPTURE_OUT=$(bash "$SCRIPT_DIR/capture_rust.sh" --project "$FIXTURE" 2>&1)
CAPTURE_EXIT=$?

if [[ $CAPTURE_EXIT -ne 0 ]]; then
  echo "❌ FAIL: capture_rust.sh exited $CAPTURE_EXIT"
  echo "$CAPTURE_OUT" | tail -20
  record_fail
else
  # Count .regret files written
  REGRET_COUNT=$(ls "$FIXTURE/regrets/"*.regret 2>/dev/null | wc -l)
  if [[ $REGRET_COUNT -eq 5 ]]; then
    log "  ✅ PASS: $REGRET_COUNT .regret files written (expected 5)"
    record_pass
  else
    echo "❌ FAIL: expected 5 .regret files, got $REGRET_COUNT"
    record_fail
  fi

  # Verify required fields present in each .regret file
  REQUIRED_FIELDS="cluster version fingerprint captured watches entry stack fingerprintLevel INPUT OUTPUT HASH"
  ALL_FIELDS_OK=1
  for f in "$FIXTURE/regrets/"*.regret; do
    for field in $REQUIRED_FIELDS; do
      if ! grep -q "^${field}" "$f" 2>/dev/null; then
        echo "❌ FAIL: $f missing field '$field'"
        ALL_FIELDS_OK=0
        break
      fi
    done
  done
  if [[ $ALL_FIELDS_OK -eq 1 ]]; then
    log "  ✅ PASS: all required fields present in all .regret files"
    record_pass
  else
    record_fail
  fi
fi
log ""

# ─── 2. validate (no code change) — exit 0, PASS ─────────────────────────────
log "─── 2. validate (no code change) — exit 0, PASS ───"

VALOUT=$(run_cargo_validate)
VALEXIT=$?

if [[ $VALEXIT -eq 0 ]] && echo "$VALOUT" | grep -q "5 passed, 0 failed"; then
  log "  ✅ PASS: validate (no change) prints PASS for all 5 clusters, exit 0"
  record_pass
else
  echo "❌ FAIL: validate (no change) did not produce expected PASS (exit=$VALEXIT)"
  echo "$VALOUT" | tail -20
  record_fail
fi
log ""

# ─── 3. breaking change — validate exit non-zero, FAIL ───────────────────────
log "─── 3. breaking change (add() returns a-b) — validate exit non-zero, FAIL ───"

python3 -c "
# #521: explicit encoding='utf-8' — lib.rs contains em-dashes
# in comments. On Windows native Python, open() defaults to cp1252
# which raises UnicodeDecodeError on the multi-byte UTF-8 sequences.
with open('$LIB_RS', encoding='utf-8') as f:
    src = f.read()
old = 'pub fn add(a: i64, b: i64) -> i64 {\n    a + b\n}'
new = 'pub fn add(a: i64, b: i64) -> i64 {\n    a - b\n}'
assert old in src, 'add() body not found'
with open('$LIB_RS', 'w', encoding='utf-8') as f:
    f.write(src.replace(old, new))
"

BREAKOUT=$(run_cargo_validate)
BREAKEXIT=$?

# Restore immediately
cp /tmp/lib.rs.verify-backup "$LIB_RS"

if [[ $BREAKEXIT -ne 0 ]] && echo "$BREAKOUT" | grep -qE "1 failed|FAIL rust-add"; then
  log "  ✅ PASS: breaking change detected (FAIL rust-add, exit non-zero)"
  record_pass
else
  echo "❌ FAIL: breaking change not detected (exit=$BREAKEXIT)"
  echo "$BREAKOUT" | tail -20
  record_fail
fi
log ""

# ─── 4. valid refactor (same output) — exit 0, PASS ──────────────────────────
log "─── 4. valid refactor (add() uses loop, same output) — exit 0, PASS ───"

python3 -c "
# #521: explicit encoding='utf-8' (see comment in step 3 above).
with open('$LIB_RS', encoding='utf-8') as f:
    src = f.read()
old = 'pub fn add(a: i64, b: i64) -> i64 {\n    a + b\n}'
new = '''pub fn add(a: i64, b: i64) -> i64 {
    // Refactored: same output via iterative increment
    let mut result = a;
    let mut inc = b;
    let step = if inc >= 0 { 1i64 } else { -1i64 };
    let abs_inc = if inc >= 0 { inc } else { -inc };
    for _ in 0..abs_inc {
        result += step;
    }
    result
}'''
assert old in src, 'add() body not found'
with open('$LIB_RS', 'w', encoding='utf-8') as f:
    f.write(src.replace(old, new))
"

REFACTOROUT=$(run_cargo_validate)
REFACTOREXIT=$?

# Restore immediately
cp /tmp/lib.rs.verify-backup "$LIB_RS"

if [[ $REFACTOREXIT -eq 0 ]] && echo "$REFACTOROUT" | grep -q "5 passed, 0 failed"; then
  log "  ✅ PASS: valid refactor accepted (PASS, exit 0)"
  record_pass
else
  echo "❌ FAIL: valid refactor was rejected (exit=$REFACTOREXIT)"
  echo "$REFACTOROUT" | tail -20
  record_fail
fi
log ""

# ─── 5. --cluster filter (regression test for CLI bug) ───────────────────────
log "─── 5. --cluster filter isolates a single cluster (regression for #355 CLI bug) ───"

# Test with --project X --cluster Y (originally mis-parsed)
FILTER_OUT=$(bash "$SCRIPT_DIR/validate_rust.sh" --project "$FIXTURE" --cluster rust-add 2>&1)
FILTER_EXIT=$?

if [[ $FILTER_EXIT -eq 0 ]] && echo "$FILTER_OUT" | grep -q "1 passed, 0 failed"; then
  log "  ✅ PASS: --cluster rust-add isolates 1 cluster (was bug: 'No Rust clusters found')"
  record_pass
else
  echo "❌ FAIL: --cluster filter did not isolate 1 cluster (exit=$FILTER_EXIT)"
  echo "$FILTER_OUT" | tail -10
  record_fail
fi

# Also test the reverse order
FILTER_OUT2=$(bash "$SCRIPT_DIR/validate_rust.sh" --cluster rust-fibonacci --project "$FIXTURE" 2>&1)
FILTER_EXIT2=$?

if [[ $FILTER_EXIT2 -eq 0 ]] && echo "$FILTER_OUT2" | grep -q "1 passed, 0 failed"; then
  log "  ✅ PASS: --cluster before --project also works (order-independent)"
  record_pass
else
  echo "❌ FAIL: --cluster before --project did not work (exit=$FILTER_EXIT2)"
  echo "$FILTER_OUT2" | tail -10
  record_fail
fi
log ""

# ─── 6. cross-stack parity — Rust HASH matches JS fingerprint() ──────────────
log "─── 6. cross-stack parity — Rust HASH matches JS fingerprint() ───"

PARITY_OUT=$(node --input-type=module -e "
import { fingerprint } from '$SKILL_DIR/scripts/fingerprint.js';
const cases = [
  { name: 'rust-add', input: [1,2], output: 3, rust_hash: '63qoext' },
  { name: 'rust-mul', input: [3,4], output: 12, rust_hash: '1udz6ou' },
  { name: 'rust-is-even', input: 4, output: true, rust_hash: '56d0z1f' },
  { name: 'rust-reverse-string', input: 'hello', output: 'olleh', rust_hash: '5nssd6s' },
  { name: 'rust-fibonacci', input: 0, output: 0, rust_hash: '5m8e79v' },
];
let all_pass = true;
for (const c of cases) {
  const js_hash = fingerprint(c.input, c.output);
  const match = js_hash === c.rust_hash ? '✅' : '❌';
  if (js_hash !== c.rust_hash) all_pass = false;
  console.log('  ' + c.name + ': Rust=' + c.rust_hash + ' JS=' + js_hash + ' ' + match);
}
console.log(all_pass ? 'ALL_MATCH' : 'MISMATCH');
" 2>&1)

if echo "$PARITY_OUT" | grep -q "ALL_MATCH"; then
  log "$PARITY_OUT"
  log "  ✅ PASS: Rust HASH === JS fingerprint() for all 5 clusters"
  record_pass
else
  echo "❌ FAIL: cross-stack parity mismatch"
  echo "$PARITY_OUT"
  record_fail
fi
log ""

# ─── Summary ─────────────────────────────────────────────────────────────────
echo ""
echo "═══════════════════════════════════════════════════════════════"
echo "  Rust stack verification: $PASS_COUNT passed, $FAIL_COUNT failed"
echo "═══════════════════════════════════════════════════════════════"
echo ""

# Restore lib.rs (idempotent)
cp /tmp/lib.rs.verify-backup "$LIB_RS" 2>/dev/null || true
rm -f /tmp/lib.rs.verify-backup

if [[ $FAIL_COUNT -eq 0 ]]; then
  exit 0
else
  exit 1
fi

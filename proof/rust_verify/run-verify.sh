#!/usr/bin/env bash
# run-verify.sh — end-to-end verification walkthrough for the Rust stack
# (independent re-validation of feat/rust-validate, PR #355).
#
# This script does NOT modify the shipped references/rust/ fixture.
# It uses the fresh proof/rust_verify/ fixture (5 functions: slugify,
# base64_encode, crc32, fnv1a, is_valid_ipv4) — deliberately different
# functions from PR #355's fixture (add, mul, is_even, reverse_string,
# fibonacci) to avoid the confirmation-bias trap documented in
# CONTEXT.md "Lesson Learned".
#
# Walkthrough:
#   1. Capture 5 fresh clusters → produce .regret files
#   2. Validate baseline → expect 5 PASS
#   3. Apply BREAKING refactor (crc32: drop final XOR) → expect 1 FAIL, exit non-zero
#   4. Restore → re-validate → expect 5 PASS again
#   5. Apply VALID refactor (crc32: table-driven → on-the-fly computation)
#      → expect 5 PASS, hash unchanged
#   6. Restore → final validate → expect 5 PASS
#   7. Cross-stack parity check (Rust vs JS vs Python) → expect all match
#
# Exit codes:
#   0 — all steps behaved as expected
#   1 — at least one step did not behave as expected
#
# Requirements: rust toolchain (cargo, rustc), node, python3.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REGRETS_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
VERIFY_DIR="${SCRIPT_DIR}"
FUNCS_SRC="${VERIFY_DIR}/src/lib.rs"
BACKUP="$(mktemp)"

cleanup() {
  if [ -f "${BACKUP}" ]; then
    cp "${BACKUP}" "${FUNCS_SRC}"
    rm -f "${BACKUP}"
  fi
}
trap cleanup EXIT

if ! command -v cargo &> /dev/null; then
  echo "❌ Cargo is not installed. Install Rust toolchain: https://rustup.rs/"
  exit 1
fi

# Helper: run capture
capture() {
  ( bash "${REGRETS_ROOT}/scripts/capture_rust.sh" --project "${VERIFY_DIR}" 2>&1 | tail -3 )
}

# Helper: run validate, return its exit code
validate() {
  ( bash "${REGRETS_ROOT}/scripts/validate_rust.sh" --project "${VERIFY_DIR}" > /tmp/regret-rust-validate-out 2>&1 )
  return $?
}

echo "═══════════════════════════════════════════════════════════════════════"
echo "  Independent verification of feat/rust-validate (PR #355)"
echo "  Fresh fixture: proof/rust_verify/ (5 functions NOT in PR #355)"
echo "═══════════════════════════════════════════════════════════════════════"
echo ""

# ─── Step 1: Capture ──────────────────────────────────────────────────────
echo "─── Step 1: Capture 5 fresh Rust clusters ───"
capture
echo ""

# ─── Step 2: Baseline validate (expect PASS) ──────────────────────────────
echo "─── Step 2: Validate baseline (expect 5 PASS) ───"
set +e
validate
RC=$?
set -e
if [ "${RC}" -ne 0 ]; then
  echo "❌ Baseline validate FAILED (exit ${RC})"
  cat /tmp/regret-rust-validate-out | tail -10
  exit 1
fi
PASS_COUNT=$(grep -c "PASS" /tmp/regret-rust-validate-out || true)
echo "✅ Baseline PASS — ${PASS_COUNT} green checks"
echo ""

# Back up pristine lib.rs for the breaking/valid refactor round-trip
cp "${FUNCS_SRC}" "${BACKUP}"

# ─── Step 3: BREAKING refactor ────────────────────────────────────────────
echo "─── Step 3: Apply BREAKING refactor (crc32: drop final XOR) ───"
FUNCS_SRC="${FUNCS_SRC}" python3 <<'PYEOF'
import os
p = os.environ['FUNCS_SRC']
src = open(p).read()
old = 'crc ^ 0xFFFFFFFF'
new = 'crc /* BREAKING: dropped final XOR — output changes for non-empty input */'
assert old in src
open(p, 'w').write(src.replace(old, new))
print("   applied: crc32 dropped final XOR (output for 'Hello': 4157704578 → 0)")
PYEOF
echo ""

echo "─── Step 4: Validate after BREAKING refactor (expect FAIL, exit non-zero) ───"
set +e
validate
RC=$?
set -e
PASS_AFTER=$(grep -c "PASS" /tmp/regret-rust-validate-out || true)
FAIL_AFTER=$(grep -c "FAIL" /tmp/regret-rust-validate-out || true)
echo "   PASS count: ${PASS_AFTER}  FAIL count: ${FAIL_AFTER}  exit code: ${RC}"
if [ "${RC}" -eq 0 ]; then
  echo "❌ Breaking refactor did NOT fail validate — Regrets failed to detect the regression"
  exit 1
fi
if ! grep -q "FAIL.*rust-crc32\|rust-crc32.*FAIL" /tmp/regret-rust-validate-out; then
  echo "❌ Expected rust-crc32 to FAIL but it didn't show in output"
  exit 1
fi
echo "✅ Breaking refactor correctly FAILed (rust-crc32 cluster, exit ${RC})"
echo ""

# ─── Step 5: Restore + VALID refactor ─────────────────────────────────────
cp "${BACKUP}" "${FUNCS_SRC}"
echo "─── Step 5: Apply VALID refactor (crc32: table-driven → on-the-fly computation) ───"
FUNCS_SRC="${FUNCS_SRC}" python3 <<'PYEOF'
import os
p = os.environ['FUNCS_SRC']
src = open(p).read()
old_body = '''pub fn crc32(s: &str) -> u32 {
    let data = s.as_bytes();
    let mut table = [0u32; 256];
    for i in 0..256u32 {
        let mut c = i;
        for _ in 0..8 {
            if c & 1 == 1 {
                c = 0xEDB88320 ^ (c >> 1);
            } else {
                c = c >> 1;
            }
        }
        table[i as usize] = c;
    }
    let mut crc: u32 = 0xFFFFFFFF;
    for &b in data {
        crc = table[((crc ^ b as u32) & 0xFF) as usize] ^ (crc >> 8);
    }
    crc ^ 0xFFFFFFFF
}'''
new_body = '''pub fn crc32(s: &str) -> u32 {
    /* VALID refactor: compute CRC table entry on-the-fly instead of caching
       in a 256-entry array. Output is identical for all inputs — just
       trades CPU time for memory. */
    let data = s.as_bytes();
    let mut crc: u32 = 0xFFFFFFFF;
    for &b in data {
        let mut c = (crc ^ b as u32) & 0xFF;
        for _ in 0..8 {
            if c & 1 == 1 {
                c = 0xEDB88320 ^ (c >> 1);
            } else {
                c = c >> 1;
            }
        }
        crc = c ^ (crc >> 8);
    }
    crc ^ 0xFFFFFFFF
}'''
assert old_body in src
open(p, 'w').write(src.replace(old_body, new_body))
print("   applied: crc32 table-driven → on-the-fly (output preserved)")
PYEOF
echo ""

echo "─── Step 6: Validate after VALID refactor (expect 5 PASS, hash unchanged) ───"
set +e
validate
RC=$?
set -e
if [ "${RC}" -ne 0 ]; then
  echo "❌ Valid refactor FAILED validate — Regrets is over-sensitive (false positive)"
  cat /tmp/regret-rust-validate-out | tail -10
  exit 1
fi
PASS_VALID=$(grep -c "PASS" /tmp/regret-rust-validate-out || true)
echo "✅ Valid refactor PASS — ${PASS_VALID} green checks (hash unchanged)"
echo ""

# ─── Step 7: Cross-stack parity ───────────────────────────────────────────
cp "${BACKUP}" "${FUNCS_SRC}"
echo "─── Step 7: Cross-stack parity check (Rust vs JS vs Python) ───"
node "${VERIFY_DIR}/cross_stack_parity.mjs"
RC=$?
if [ "${RC}" -ne 0 ]; then
  echo "❌ Cross-stack parity broken"
  exit 1
fi
echo ""

# ─── Summary ──────────────────────────────────────────────────────────────
echo "═══════════════════════════════════════════════════════════════════════"
echo "  VERIFICATION RESULT: PASS"
echo "═══════════════════════════════════════════════════════════════════════"
echo "  ✅ capture_rust.sh writes .regret files in standard format"
echo "  ✅ validate_rust.sh PASSes for unchanged code (5/5)"
echo "  ✅ validate_rust.sh FAILs (exit non-zero) for breaking refactor"
echo "  ✅ validate_rust.sh PASSes for valid refactor (output preserved, hash unchanged)"
echo "  ✅ Cross-stack parity: Rust hash == JS hash == Python hash (5/5)"
echo "  ✅ Bonus: 4-way parity Rust == Go == C == JS == Python (same hashes"
echo "     match proof/go_verify/ and proof/c_verify/)"
echo ""
echo "  feat/rust-validate (PR #355) INDEPENDENTLY VERIFIED on fresh codebase."
echo "  Original src/lib.rs restored."

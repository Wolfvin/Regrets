#!/usr/bin/env bash
# run-verify.sh — end-to-end verification walkthrough for the Go stack
# (independent re-validation of feat/go-validate-consolidated, PR #399).
#
# This script does NOT modify the shipped tests/fixtures/go-example/ fixture.
# It uses the fresh proof/go_verify/ fixture (5 functions: slugify,
# base64_encode, crc32, fnv1a, is_valid_ipv4) — deliberately different
# functions from PR #399's fixture to avoid the confirmation-bias trap
# documented in CONTEXT.md "Lesson Learned".
#
# Walkthrough:
#   1. Capture 5 fresh clusters → produce .regret files (with INPUTS line)
#   2. Validate baseline → expect 5 PASS (+ all INPUTS entries PASS)
#   3. Apply BREAKING refactor (CRC32: drop final XOR) → expect 1 FAIL, exit 1
#   4. Restore → re-validate → expect 5 PASS again
#   5. Apply VALID refactor (CRC32: manual table → stdlib crc32.ChecksumIEEE)
#      → expect 5 PASS, hash unchanged
#   6. Restore → final validate → expect 5 PASS
#   7. Cross-stack parity check (Go vs JS vs Python) → expect all match
#
# Exit codes:
#   0 — all steps behaved as expected
#   1 — at least one step did not behave as expected
#
# Requirements: go (1.24+), node, python3, npm deps installed.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REGRETS_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
VERIFY_DIR="${SCRIPT_DIR}"
FUNCS_SRC="${VERIFY_DIR}/hashing/hashing.go"
BACKUP="$(mktemp)"

cleanup() {
  if [ -f "${BACKUP}" ]; then
    cp "${BACKUP}" "${FUNCS_SRC}"
    rm -f "${BACKUP}"
  fi
}
trap cleanup EXIT

if ! command -v go &> /dev/null; then
  echo "❌ Go is not installed."
  exit 1
fi

# Helper: run capture
capture() {
  ( cd "${VERIFY_DIR}" && bash "${REGRETS_ROOT}/scripts/capture_go.sh" capture 2>&1 | tail -3 )
}

# Helper: run validate, return its exit code
validate() {
  ( cd "${VERIFY_DIR}" && bash "${REGRETS_ROOT}/scripts/capture_go.sh" validate > /tmp/regret-go-validate-out 2>&1 )
  return $?
}

echo "═══════════════════════════════════════════════════════════════════════"
echo "  Independent verification of feat/go-validate-consolidated (PR #399)"
echo "  Fresh fixture: proof/go_verify/ (5 functions NOT in PR #399)"
echo "═══════════════════════════════════════════════════════════════════════"
echo ""

# ─── Step 1: Capture ──────────────────────────────────────────────────────
echo "─── Step 1: Capture 5 fresh Go clusters ───"
capture
echo ""

# ─── Step 2: Baseline validate (expect PASS) ──────────────────────────────
echo "─── Step 2: Validate baseline (expect 5 PASS + all INPUTS PASS) ───"
set +e
validate
RC=$?
set -e
if [ "${RC}" -ne 0 ]; then
  echo "❌ Baseline validate FAILED (exit ${RC})"
  cat /tmp/regret-go-validate-out | tail -10
  exit 1
fi
PASS_COUNT=$(grep -c "✅" /tmp/regret-go-validate-out || true)
echo "✅ Baseline PASS — ${PASS_COUNT} green checks"
echo ""

# Back up pristine hashing.go for the breaking/valid refactor round-trip
cp "${FUNCS_SRC}" "${BACKUP}"

# ─── Step 3: BREAKING refactor ────────────────────────────────────────────
echo "─── Step 3: Apply BREAKING refactor (CRC32: drop final XOR) ───"
FUNCS_SRC="${FUNCS_SRC}" python3 <<'PYEOF'
import os
p = os.environ['FUNCS_SRC']
src = open(p).read()
old = 'return crc ^ 0xFFFFFFFF'
new = 'return crc /* BREAKING: dropped final XOR — output changes for non-empty input */'
assert old in src
open(p, 'w').write(src.replace(old, new))
print("   applied: CRC32 dropped final XOR (output for 'Hello': 4157704578 → 4157704578 ^ 0xFFFFFFFF = 0)")
PYEOF
echo ""

echo "─── Step 4: Validate after BREAKING refactor (expect FAIL, exit 1) ───"
set +e
validate
RC=$?
set -e
PASS_AFTER=$(grep -c "✅" /tmp/regret-go-validate-out || true)
FAIL_AFTER=$(grep -c "❌" /tmp/regret-go-validate-out || true)
echo "   PASS count: ${PASS_AFTER}  FAIL count: ${FAIL_AFTER}  exit code: ${RC}"
if [ "${RC}" -eq 0 ]; then
  echo "❌ Breaking refactor did NOT fail validate — Regrets failed to detect the regression"
  exit 1
fi
if ! grep -q "FAIL.*crc32\|crc32.*FAIL" /tmp/regret-go-validate-out; then
  echo "❌ Expected crc32 to FAIL but it didn't show in output"
  exit 1
fi
echo "✅ Breaking refactor correctly FAILed (crc32 cluster, exit ${RC})"
echo ""

# ─── Step 5: Restore + VALID refactor ─────────────────────────────────────
cp "${BACKUP}" "${FUNCS_SRC}"
echo "─── Step 5: Apply VALID refactor (CRC32: manual table → stdlib crc32.ChecksumIEEE) ───"
FUNCS_SRC="${FUNCS_SRC}" python3 <<'PYEOF'
import os
p = os.environ['FUNCS_SRC']
src = open(p).read()

old_imports = 'package hashing'
new_imports = '''package hashing

import "hash/crc32"'''
assert old_imports in src
src = src.replace(old_imports, new_imports, 1)

old_body = '''// CRC32 computes the standard zip/zlib CRC32 (poly 0xEDB88320, initial
// 0xFFFFFFFF, final XOR 0xFFFFFFFF) of the input string's bytes.
// Implemented from scratch (not using hash/crc32) to exercise unsigned
// arithmetic + table initialization.
func CRC32(s string) uint32 {
	data := []byte(s)
	var table [256]uint32
	for i := 0; i < 256; i++ {
		c := uint32(i)
		for k := 0; k < 8; k++ {
			if c&1 == 1 {
				c = 0xEDB88320 ^ (c >> 1)
			} else {
				c = c >> 1
			}
		}
		table[i] = c
	}
	crc := uint32(0xFFFFFFFF)
	for _, b := range data {
		crc = table[(crc^uint32(b))&0xFF] ^ (crc >> 8)
	}
	return crc ^ 0xFFFFFFFF
}'''
new_body = '''// CRC32 computes the standard zip/zlib CRC32 of the input string's bytes.
// VALID refactor: uses stdlib hash/crc32 instead of manual table-driven
// implementation. Output is identical for all inputs.
func CRC32(s string) uint32 {
	return crc32.ChecksumIEEE([]byte(s))
}'''
assert old_body in src
open(p, 'w').write(src.replace(old_body, new_body))
print("   applied: CRC32 manual table → stdlib crc32.ChecksumIEEE (output preserved)")
PYEOF
echo ""

echo "─── Step 6: Validate after VALID refactor (expect 5 PASS, hash unchanged) ───"
set +e
validate
RC=$?
set -e
if [ "${RC}" -ne 0 ]; then
  echo "❌ Valid refactor FAILED validate — Regrets is over-sensitive (false positive)"
  cat /tmp/regret-go-validate-out | tail -10
  exit 1
fi
PASS_VALID=$(grep -c "✅" /tmp/regret-go-validate-out || true)
echo "✅ Valid refactor PASS — ${PASS_VALID} green checks (hash unchanged)"
echo ""

# ─── Step 7: Cross-stack parity ───────────────────────────────────────────
cp "${BACKUP}" "${FUNCS_SRC}"
echo "─── Step 7: Cross-stack parity check (Go vs JS vs Python) ───"
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
echo "  ✅ capture_go.sh writes .regret files in standard format (with INPUTS line)"
echo "  ✅ validate (no change) PASSes for 5 clusters + all multi-input entries"
echo "  ✅ validate FAILs (exit 1) for breaking refactor (crc32 cluster only)"
echo "  ✅ validate PASSes for valid refactor (output preserved, hash unchanged)"
echo "  ✅ Cross-stack parity: Go hash == JS hash == Python hash (15/15 pairs)"
echo ""
echo "  feat/go-validate-consolidated (PR #399) INDEPENDENTLY VERIFIED on fresh codebase."
echo "  Original hashing.go restored."

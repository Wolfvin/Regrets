#!/usr/bin/env bash
# demo-refactor-flow.sh — end-to-end demo of the C bit-manipulation fixture:
#   1. capture (writes/regenerates all 5 .regret files)
#   2. validate baseline (expect PASS — code unchanged)
#   3. apply a VALID refactor (rotate_left: shift-mod + branchless)
#      → validate PASS (output preserved)
#   4. apply a BREAKING refactor (count_set_bits: off-by-one — increments
#      before counting) → validate FAIL (exit 1, hash drift detected)
#
# This script temporarily modifies bitops.c to simulate both
# refactor scenarios, then restores the original at the end.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
DEMO_SRC="${ROOT}/proof/c_bitops/bitops.c"
PROOF_DIR="${ROOT}/proof/c_bitops"
BACKUP="$(mktemp)"

cleanup() {
  if [ -f "${BACKUP}" ]; then
    cp "${BACKUP}" "${DEMO_SRC}"
    rm -f "${BACKUP}"
  fi
}
trap cleanup EXIT

# ─── Setup: back up the original ────────────────────────────────────────────
cp "${DEMO_SRC}" "${BACKUP}"
echo "📁 Backed up bitops.c → ${BACKUP}"
echo ""

# Helper: recompile + run capture
capture() {
  ( cd "${PROOF_DIR}" && C_SOURCES="$(pwd)/bitops.c:$(pwd)/regret_adapter.c" \
        C_INCLUDE="$(pwd)" \
        bash "${ROOT}/scripts/capture_c.sh" 2>&1 | tail -10 )
}

validate() {
  ( cd "${PROOF_DIR}" && C_SOURCES="$(pwd)/bitops.c:$(pwd)/regret_adapter.c" \
        C_INCLUDE="$(pwd)" \
        bash "${ROOT}/scripts/validate_c.sh" 2>&1 | tail -15 )
}

# ─── Step 1: capture (regenerate .regret files from current code) ───────────
echo "═══ Step 1: Capture ═══"
capture
echo ""

# ─── Step 2: validate baseline (should PASS) ───────────────────────────────
echo "═══ Step 2: Validate baseline (expect PASS) ═══"
set +e
validate
RC=$?
set -e
if [ "${RC}" -ne 0 ]; then
  echo "❌ Baseline validate failed unexpectedly (exit ${RC})"
  exit 1
fi
echo "✅ Baseline PASS"
echo ""

# ─── Step 3: apply a VALID refactor — rotate_left uses branchless shift-mask ─
echo "═══ Step 3: Apply VALID refactor — rotate_left: mod+branch → branchless shift-mask ═══"
DEMO_SRC="${DEMO_SRC}" PYTHONIOENCODING=utf-8 python3 << 'PYEOF'
import os
path = os.environ['DEMO_SRC']
src = open(path, encoding='utf-8').read()
old = '''uint32_t bitops_rotate_left(uint32_t n, uint32_t shift) {
    shift &= 31u;  // mod 32
    if (shift == 0) return n;
    return (n << shift) | (n >> (32u - shift));
}'''
new = '''uint32_t bitops_rotate_left(uint32_t n, uint32_t shift) {
    /* Branchless refactor: shift-mask pair produces identity for shift==0
       without an early return. Output preserved for all 5 captured inputs. */
    uint32_t s = shift & 31u;
    uint32_t mask = (uint32_t)(s != 0);  // 0 when s==0, 1 otherwise — branchless
    uint32_t hi = (s == 0) ? 0u : (32u - s);
    return (mask * ((n << s) | (n >> hi))) + (1u - mask) * n;
}'''
assert old in src, "Original rotate_left body not found"
open(path, 'w', encoding='utf-8').write(src.replace(old, new))
print("   ✅ rotate_left: mod+branch → branchless shift-mask (output preserved)")
PYEOF
echo ""

# ─── Step 4: validate after valid refactor (expect PASS) ───────────────────
echo "═══ Step 4: Validate after valid refactor (expect PASS) ═══"
set +e
validate
RC=$?
set -e
if [ "${RC}" -ne 0 ]; then
  echo "❌ Valid refactor validate failed (exit ${RC}) — output drift detected"
  exit 1
fi
echo "✅ Valid refactor PASS (hash unchanged)"
echo ""

# Restore for next phase
cp "${BACKUP}" "${DEMO_SRC}"

# ─── Step 5: apply a BREAKING refactor — count_set_bits off-by-one init ─────
echo "═══ Step 5: Apply BREAKING refactor — count_set_bits: count init 0 → 1 (off-by-one) ═══"
DEMO_SRC="${DEMO_SRC}" PYTHONIOENCODING=utf-8 python3 << 'PYEOF'
import os
path = os.environ['DEMO_SRC']
src = open(path, encoding='utf-8').read()
old = '''uint32_t bitops_count_set_bits(uint32_t n) {
    // Brian Kernighan's algorithm: each iteration clears the lowest set
    // bit, so the loop body runs exactly popcount(n) times.
    uint32_t count = 0;
    while (n) {
        n &= (n - 1);
        count++;
    }
    return count;
}'''
# Breaking: initialize count = 1 instead of 0. Every input now returns
# popcount(n)+1 (including n=0, which previously returned 0).
new = '''uint32_t bitops_count_set_bits(uint32_t n) {
    /* OFF-BY-ONE: count initialized to 1 instead of 0 — every input now
       returns popcount(n)+1. Affects all 6 captured inputs. */
    uint32_t count = 1;            // ← was 0 — every output shifts by +1
    while (n) {
        n &= (n - 1);
        count++;
    }
    return count;
}'''
assert old in src, "Original count_set_bits body not found"
open(path, 'w', encoding='utf-8').write(src.replace(old, new))
print("   💥 count_set_bits: count init 0 → 1 (off-by-one; every output +1)")
PYEOF
echo ""

# ─── Step 6: validate after breaking refactor (expect FAIL) ────────────────
echo "═══ Step 6: Validate after breaking refactor (expect FAIL) ═══"
set +e
validate
RC=$?
set -e
if [ "${RC}" -eq 0 ]; then
  echo "❌ Breaking refactor validate unexpectedly PASSED (exit 0) — drift NOT detected"
  exit 1
fi
echo "✅ Breaking refactor correctly FAILed (exit ${RC})"
echo ""

# ─── Summary ────────────────────────────────────────────────────────────────
echo "═══ Summary ═══"
echo "✅ capture writes .regret files in the standard format"
echo "✅ validate PASSes for valid refactor (output preserved, hash unchanged)"
echo "✅ validate FAILs (non-zero exit) for breaking refactor (output changed)"
echo ""
echo "Original bitops.c restored."

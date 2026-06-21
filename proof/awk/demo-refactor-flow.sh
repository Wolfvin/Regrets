#!/usr/bin/env bash
# demo-refactor-flow.sh — end-to-end demo of capture → valid refactor PASSes
# → breaking refactor FAILs.
#
# This script temporarily modifies fibonacci.awk to simulate both
# refactor scenarios, then restores the original at the end.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
DEMO_SRC="${ROOT}/proof/awk/fibonacci.awk"
PROOF_DIR="${ROOT}/proof/awk"
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
echo "📁 Backed up fibonacci.awk → ${BACKUP}"
echo ""

# Helper: recompile + run capture
capture() {
  ( cd "${PROOF_DIR}" && node "${ROOT}/scripts/capture_awk.mjs" 2>&1 | tail -5 )
}

validate() {
  ( cd "${PROOF_DIR}" && node "${ROOT}/scripts/validate_awk.mjs" 2>&1 | tail -15 )
}

# ─── Step 1: capture (regenerate .regret files from current code) ───────────
echo "═══ Step 1: Capture ═══"
capture
echo ""

# ─── Step 2: validate baseline (should PASS) ───────────────────────────────
echo "═══ Step 2: Validate baseline (expect PASS for all 6 clusters) ═══"
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

# ─── Step 3: apply a VALID refactor (fibonacci: iterative → closed-form) ───
echo "═══ Step 3: Apply VALID refactor — fibonacci iterative → closed-form (Binet) ═══"
cat > "${DEMO_SRC}" << 'AWKEOF'
# fibonacci.awk — REFACTORED to closed-form (Binet's formula).
# Output preserved for n=10 (still returns 55).
BEGIN {
  getline n
  print fib(n + 0)
}

function fib(n,  phi, psi, result) {
  if (n < 0) return -1
  if (n == 0) return 0
  if (n == 1) return 1
  # Binet's formula: F(n) = (phi^n - psi^n) / sqrt(5)
  phi = (1 + sqrt(5)) / 2
  psi = (1 - sqrt(5)) / 2
  result = (phi ^ n - psi ^ n) / sqrt(5)
  # Round to nearest integer (awk's int() truncates, so add 0.5 first)
  return int(result + 0.5)
}
AWKEOF
echo "   ✅ fibonacci: iterative → Binet's formula (output preserved for n=10)"
echo ""

echo "═══ Step 4: Validate after valid refactor (expect PASS) ═══"
set +e
validate
RC=$?
set -e
if [ "${RC}" -ne 0 ]; then
  echo "❌ Valid refactor FAILED validate (exit ${RC}) — should have PASSED"
  exit 1
fi
echo "✅ Valid refactor PASS (output preserved, hash unchanged)"
echo ""

# ─── Step 5: restore + apply a BREAKING refactor ────────────────────────────
cp "${BACKUP}" "${DEMO_SRC}"
echo "═══ Step 5: Apply BREAKING refactor — fibonacci becomes 1-indexed (n=10 → 89) ═══"
cat > "${DEMO_SRC}" << 'AWKEOF'
# fibonacci.awk — BREAKING refactor: now 1-indexed (n=10 → 89 instead of 55).
BEGIN {
  getline n
  print fib(n + 0)
}

function fib(n,  a, b, c, i) {
  if (n < 0) return -1
  if (n == 0) return 1
  if (n == 1) return 1
  a = 1; b = 1
  for (i = 2; i <= n; i++) {
    c = a + b
    a = b
    b = c
  }
  return b
}
AWKEOF
echo "   ✅ fibonacci: 0-indexed → 1-indexed (output CHANGED for n=10: 55 → 89)"
echo ""

echo "═══ Step 6: Validate after breaking refactor (expect FAIL) ═══"
set +e
validate
RC=$?
set -e
if [ "${RC}" -eq 0 ]; then
  echo "❌ Breaking refactor PASSed validate (exit 0) — should have FAILED"
  exit 1
fi
echo "✅ Breaking refactor correctly FAILed (exit ${RC})"
echo ""

# ─── Done ───────────────────────────────────────────────────────────────────
echo "═══ Summary ═══"
echo "✅ capture writes .regret files in the standard format"
echo "✅ validate PASSes for valid refactor (output preserved)"
echo "✅ validate FAILs (non-zero exit) for breaking refactor (output changed)"
echo ""
echo "Original fibonacci.awk restored."

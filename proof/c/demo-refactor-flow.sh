#!/usr/bin/env bash
# demo-refactor-flow.sh — end-to-end demo of capture → valid refactor PASSes
# → breaking refactor FAILs.
#
# This script temporarily modifies demo_math.c to simulate both
# refactor scenarios, then restores the original at the end.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
DEMO_SRC="${ROOT}/proof/c/demo_math.c"
PROOF_DIR="${ROOT}/proof/c"
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
echo "📁 Backed up demo_math.c → ${BACKUP}"
echo ""

# Helper: recompile + run capture
capture() {
  ( cd "${PROOF_DIR}" && C_SOURCES="$(pwd)/demo_math.c:$(pwd)/regret_adapter.c" \
        C_INCLUDE="$(pwd)" \
        bash "${ROOT}/scripts/capture_c.sh" 2>&1 | tail -5 )
}

validate() {
  ( cd "${PROOF_DIR}" && C_SOURCES="$(pwd)/demo_math.c:$(pwd)/regret_adapter.c" \
        C_INCLUDE="$(pwd)" \
        bash "${ROOT}/scripts/validate_c.sh" 2>&1 | tail -10 )
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

# ─── Step 3: apply a VALID refactor (fibonacci: iterative → Binet) ──────────
echo "═══ Step 3: Apply VALID refactor — fibonacci iterative → Binet's formula ═══"
DEMO_SRC="${DEMO_SRC}" python3 << 'PYEOF'
import os
path = os.environ['DEMO_SRC']
src = open(path).read()
old = '''long demo_fibonacci(int n) {
    if (n < 0) return -1;  // error sentinel (skipped via trivial guard? no — non-null)
    if (n == 0) return 0L;
    if (n == 1) return 1L;
    long a = 0, b = 1;
    for (int i = 2; i <= n; i++) {
        long c = a + b;
        a = b;
        b = c;
    }
    return b;
}'''
new = '''long demo_fibonacci(int n) {
    /* Binet's closed-form formula — refactor (output preserved for n=10). */
    if (n < 0) return -1;
    if (n == 0) return 0L;
    if (n == 1) return 1L;
    double phi = (1.0 + sqrt(5.0)) / 2.0;
    double psi = (1.0 - sqrt(5.0)) / 2.0;
    return (long)ldexp((pow(phi, n) - pow(psi, n)) / sqrt(5.0), 0);
}'''
assert old in src, "Original fibonacci body not found"
open(path, 'w').write(src.replace(old, new))
print("   ✅ fibonacci: iterative → Binet's formula (output preserved for n=10)")
PYEOF
# Need to add math.h include for sqrt/pow/ldexp
DEMO_SRC="${DEMO_SRC}" python3 << 'PYEOF'
import os
path = os.environ['DEMO_SRC']
src = open(path).read()
# Add math.h if not already included
if '#include <math.h>' not in src:
    src = src.replace('#include <ctype.h>', '#include <ctype.h>\n#include <math.h>')
open(path, 'w').write(src)
PYEOF
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
DEMO_SRC="${DEMO_SRC}" python3 << 'PYEOF'
import os
path = os.environ['DEMO_SRC']
src = open(path).read()
old = '''long demo_fibonacci(int n) {
    if (n < 0) return -1;  // error sentinel (skipped via trivial guard? no — non-null)
    if (n == 0) return 0L;
    if (n == 1) return 1L;
    long a = 0, b = 1;
    for (int i = 2; i <= n; i++) {
        long c = a + b;
        a = b;
        b = c;
    }
    return b;
}'''
new = '''long demo_fibonacci(int n) {
    /* BREAKING refactor: now 1-indexed (n=10 → 89 instead of 55). */
    if (n < 0) return -1;
    if (n == 0) return 1L;
    if (n == 1) return 1L;
    long a = 1, b = 1;
    for (int i = 2; i <= n; i++) {
        long c = a + b;
        a = b;
        b = c;
    }
    return b;
}'''
assert old in src
open(path, 'w').write(src.replace(old, new))
print("   ✅ fibonacci: 0-indexed → 1-indexed (output CHANGED for n=10: 55 → 89)")
PYEOF
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
echo "Original demo_math.c restored."

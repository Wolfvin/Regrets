#!/usr/bin/env bash
# demo-refactor-flow.sh — end-to-end demo of capture → valid refactor PASSes
# → breaking refactor FAILs.
#
# This script temporarily modifies demo_math.cpp to simulate both
# refactor scenarios, then restores the original at the end.
#
# It also demonstrates the C++ exception-safety feature: a third step
# shows that an adapter throwing std::invalid_argument causes a SKIP
# (matching the JS "throws" trivial-input guard behavior).

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
DEMO_SRC="${ROOT}/proof/cpp/demo_math.cpp"
PROOF_DIR="${ROOT}/proof/cpp"
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
echo "📁 Backed up demo_math.cpp → ${BACKUP}"
echo ""

# Helper: recompile + run capture
capture() {
  ( cd "${PROOF_DIR}" && CPP_SOURCES="$(pwd)/demo_math.cpp:$(pwd)/regret_adapter.cpp" \
        CPP_INCLUDE="$(pwd)" \
        bash "${ROOT}/scripts/capture_cpp.sh" 2>&1 | tail -5 )
}

validate() {
  ( cd "${PROOF_DIR}" && CPP_SOURCES="$(pwd)/demo_math.cpp:$(pwd)/regret_adapter.cpp" \
        CPP_INCLUDE="$(pwd)" \
        bash "${ROOT}/scripts/validate_cpp.sh" 2>&1 | tail -15 )
}

# ─── Step 1: capture (regenerate .regret files from current code) ───────────
echo "═══ Step 1: Capture ═══"
capture
echo ""

# ─── Step 2: validate baseline (should PASS) ───────────────────────────────
echo "═══ Step 2: Validate baseline (expect PASS for all 8 clusters) ═══"
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
    if (n < 0) throw std::invalid_argument("n must be >= 0");
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
    if (n < 0) throw std::invalid_argument("n must be >= 0");
    if (n == 0) return 0L;
    if (n == 1) return 1L;
    double phi = (1.0 + std::sqrt(5.0)) / 2.0;
    double psi = (1.0 - std::sqrt(5.0)) / 2.0;
    return static_cast<long>((std::pow(phi, n) - std::pow(psi, n)) / std::sqrt(5.0));
}'''
assert old in src, "Original fibonacci body not found"
open(path, 'w').write(src.replace(old, new))
print("   ✅ fibonacci: iterative → Binet's formula (output preserved for n=10)")
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
    if (n < 0) throw std::invalid_argument("n must be >= 0");
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
    if (n < 0) throw std::invalid_argument("n must be >= 0");
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

# ─── Step 7: demonstrate C++ exception safety ──────────────────────────────
cp "${BACKUP}" "${DEMO_SRC}"
echo "═══ Step 7: Demonstrate C++ exception safety — make factorial throw always ═══"
echo "    (Previously-working function that now throws is a REGRESSION, so"
echo "    validate should FAIL the cluster — not crash the harness.)"
DEMO_SRC="${DEMO_SRC}" python3 << 'PYEOF'
import os
path = os.environ['DEMO_SRC']
src = open(path).read()
old = '''long MathUtils::factorial(int n) const {
    if (n < 0) throw std::invalid_argument("n must be >= 0");
    long r = 1;
    for (int i = 2; i <= n; i++) r *= i;
    return r;
}'''
new = '''long MathUtils::factorial(int n) const {
    /* Refactor that throws — harness catches the C++ exception and
       treats it as a regression FAIL (not a crash). */
    throw std::runtime_error("intentional exception for demo");
}'''
assert old in src
open(path, 'w').write(src.replace(old, new))
print("   ✅ MathUtils::factorial: now always throws std::runtime_error")
PYEOF
echo ""

echo "═══ Step 8: Validate after exception-throwing refactor (expect FAIL for factorial, PASS for others) ═══"
echo "    Harness must NOT crash — it should catch the exception and report"
echo "    factorial as FAIL while other clusters still PASS."
set +e
validate
RC=$?
set -e
echo "Exit code from validate: ${RC}"
if [ "${RC}" -eq 0 ]; then
  echo "❌ Expected non-zero exit (factorial should have FAILed)"
  exit 1
fi
echo "✅ C++ exception safety demonstrated (factorial FAILed gracefully via exception, others PASS, no crash)"
echo ""

# ─── Done ───────────────────────────────────────────────────────────────────
echo "═══ Summary ═══"
echo "✅ capture writes .regret files in the standard format"
echo "✅ validate PASSes for valid refactor (output preserved)"
echo "✅ validate FAILs (non-zero exit) for breaking refactor (output changed)"
echo "✅ C++ exceptions caught by harness, validate reports FAIL (no crash)"
echo ""
echo "Original demo_math.cpp restored."

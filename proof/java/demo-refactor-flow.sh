#!/usr/bin/env bash
# demo-refactor-flow.sh — end-to-end demo of capture → valid refactor PASSes
# → breaking refactor FAILs.
#
# This script temporarily modifies RegretJava.java to simulate both
# refactor scenarios, then restores the original at the end.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
JAVA_FILE="${ROOT}/scripts/regret_java/RegretJava.java"
PROOF_DIR="${ROOT}/proof/java"
BACKUP="$(mktemp)"

cleanup() {
  if [ -f "${BACKUP}" ]; then
    cp "${BACKUP}" "${JAVA_FILE}"
    rm -f "${BACKUP}"
  fi
}
trap cleanup EXIT

# ─── Setup: back up the original ────────────────────────────────────────────
cp "${JAVA_FILE}" "${BACKUP}"
echo "📁 Backed up RegretJava.java → ${BACKUP}"
echo ""

# ─── Step 1: capture (regenerate .regret files from current code) ───────────
echo "═══ Step 1: Capture ═══"
( cd "${PROOF_DIR}" && bash "${ROOT}/scripts/capture_java.sh" )
echo ""

# ─── Step 2: validate baseline (should PASS) ───────────────────────────────
echo "═══ Step 2: Validate baseline (expect PASS) ═══"
set +e
( cd "${PROOF_DIR}" && bash "${ROOT}/scripts/validate_java.sh" )
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
JAVA_FILE="${JAVA_FILE}" python3 << 'PYEOF'
import os
path = os.environ['JAVA_FILE']
src = open(path).read()
old = '''    /** Compute the n-th Fibonacci number (0-indexed, iterative). */
    public static long fibonacci(int n) {
        if (n < 0) throw new IllegalArgumentException("n must be >= 0");
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
new = '''    /** Compute the n-th Fibonacci number (0-indexed, via Binet's formula — refactor). */
    public static long fibonacci(int n) {
        if (n < 0) throw new IllegalArgumentException("n must be >= 0");
        if (n == 0) return 0L;
        if (n == 1) return 1L;
        double phi = (1.0 + Math.sqrt(5.0)) / 2.0;
        double psi = (1.0 - Math.sqrt(5.0)) / 2.0;
        return Math.round((Math.pow(phi, n) - Math.pow(psi, n)) / Math.sqrt(5.0));
    }'''
assert old in src, "Original fibonacci body not found"
open(path, 'w').write(src.replace(old, new))
print("   ✅ fibonacci: iterative → Binet's formula (output preserved for n=10)")
PYEOF
echo ""

echo "═══ Step 4: Validate after valid refactor (expect PASS) ═══"
set +e
( cd "${PROOF_DIR}" && bash "${ROOT}/scripts/validate_java.sh" )
RC=$?
set -e
if [ "${RC}" -ne 0 ]; then
  echo "❌ Valid refactor FAILED validate (exit ${RC}) — should have PASSED"
  exit 1
fi
echo "✅ Valid refactor PASS (output preserved, hash unchanged)"
echo ""

# ─── Step 5: restore + apply a BREAKING refactor ────────────────────────────
cp "${BACKUP}" "${JAVA_FILE}"
echo "═══ Step 5: Apply BREAKING refactor — fibonacci becomes 1-indexed (n=10 → 89) ═══"
JAVA_FILE="${JAVA_FILE}" python3 << 'PYEOF'
import os
path = os.environ['JAVA_FILE']
src = open(path).read()
old = '''    /** Compute the n-th Fibonacci number (0-indexed, iterative). */
    public static long fibonacci(int n) {
        if (n < 0) throw new IllegalArgumentException("n must be >= 0");
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
new = '''    /** Compute the n-th Fibonacci number (1-indexed — BREAKING refactor). */
    public static long fibonacci(int n) {
        if (n < 0) throw new IllegalArgumentException("n must be >= 0");
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
( cd "${PROOF_DIR}" && bash "${ROOT}/scripts/validate_java.sh" )
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
echo "Original RegretJava.java restored."

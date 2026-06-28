#!/usr/bin/env bash
# verify_java_stack.sh — one-command end-to-end verifier for the Java stack.
#
# Runs the full capture → validate → refactor-PASS → breaking-FAIL flow
# against the proof/java/ fixture, then verifies cross-stack fingerprint
# parity (Java HASH vs JS fingerprint() for the same input/output pairs).
#
# This script is the Java analogue of scripts/verify_perl_stack.sh. It is
# intended for:
#   - Operators who want a single command to confirm the Java stack works
#     on their machine (after installing a JDK).
#   - CI jobs that want to gate Java-stack changes on a green end-to-end
#     signal without depending on the Node test runner.
#   - Workers extending the Java stack who want a fast feedback loop
#     during development.
#
# Run from anywhere (the script resolves its own paths):
#   bash scripts/verify_java_stack.sh
#
# Exit codes:
#   0 — all checks passed
#   1 — at least one check failed
#
# What this script verifies:
#   1. `java` is on PATH (JDK 16+ required for single-file source mode)
#   2. `bash scripts/capture_java.sh` writes .regret files in the standard
#      format (cluster/version/fingerprint/captured/INPUT/OUTPUT/HASH fields).
#   3. `bash scripts/validate_java.sh` PASSes (exit 0) when the captured
#      code is unchanged.
#   4. `bash scripts/validate_java.sh` PASSes (exit 0) after a VALID
#      refactor (fibonacci: iterative → Binet's formula — output preserved).
#   5. `bash scripts/validate_java.sh` FAILs (exit ≠ 0) after a BREAKING
#      refactor (fibonacci: 0-indexed → 1-indexed — output changes).
#   6. The Java HASH matches JS fingerprint() for every proof/java cluster
#      (cross-stack parity).
#
# This script is safe to run repeatedly — it restores RegretJava.java to
# its original state on exit, even on failure or interrupt.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(dirname "$SCRIPT_DIR")"
JAVA_FILE="${SCRIPT_DIR}/regret_java/RegretJava.java"
PROOF_DIR="${REPO_DIR}/proof/java"
PARITY_SCRIPT="${PROOF_DIR}/verify-parity.mjs"
DEMO_SCRIPT="${PROOF_DIR}/demo-refactor-flow.sh"

# ANSI colors (disabled if stdout is not a TTY)
if [ -t 1 ]; then
    GREEN='\033[0;32m'
    RED='\033[0;31m'
    YELLOW='\033[0;33m'
    BOLD='\033[1m'
    NC='\033[0m'
else
    GREEN='' RED='' YELLOW='' BOLD='' NC=''
fi

pass() { echo -e "${GREEN}✅ PASS${NC}: $1"; }
fail() { echo -e "${RED}❌ FAIL${NC}: $1"; FAILED=1; }
info() { echo -e "${YELLOW}ℹ️ ${NC} $1"; }
section() { echo -e "\n${BOLD}═══ $1 ═══${NC}"; }

FAILED=0

# ─── 1. Check prerequisites ────────────────────────────────────────────────────

section "1. Check prerequisites"

if ! command -v java &> /dev/null; then
    fail "java is not installed (need JDK 16+ for single-file source mode)"
    exit 1
fi

JAVA_VERSION=$(java -version 2>&1 | head -1 | sed 's/.*"\([0-9]*\)\..*/\1/')
info "Java major version: ${JAVA_VERSION}"
if [ "${JAVA_VERSION}" -lt 16 ] 2>/dev/null; then
    fail "JDK 16+ required (single-file source mode, JEP 330). Got: ${JAVA_VERSION}"
    exit 1
fi
pass "JDK ${JAVA_VERSION} available (≥ 16, single-file source mode supported)"

if [ ! -f "${JAVA_FILE}" ]; then
    fail "missing ${JAVA_FILE}"
    exit 1
fi
pass "RegretJava.java found"

if [ ! -d "${PROOF_DIR}" ]; then
    fail "missing proof directory: ${PROOF_DIR}"
    exit 1
fi
pass "proof/java/ fixture directory found"

# ─── 2. Capture (regenerate .regret files from current code) ───────────────────

section "2. Capture (write .regret files)"

# Capture writes into proof/java/regrets/. Back them up first so we can
# restore the original timestamps if the user runs this script in-place.
BACKUP_DIR="$(mktemp -d)"
cp -r "${PROOF_DIR}/regrets/." "${BACKUP_DIR}/"
info "Backed up proof/java/regrets/ → ${BACKUP_DIR}/"
trap 'cp -r "${BACKUP_DIR}/." "${PROOF_DIR}/regrets/" && rm -rf "${BACKUP_DIR}"' EXIT

if ( cd "${PROOF_DIR}" && bash "${SCRIPT_DIR}/capture_java.sh" ) > /tmp/java_capture.out 2>&1; then
    pass "capture_java.sh completed successfully"
else
    fail "capture_java.sh crashed"
    cat /tmp/java_capture.out
    exit 1
fi

# Verify each expected .regret file exists and has the standard fields
EXPECTED_CLUSTERS="add fibonacci reverse parse-csv-line format-bytes stats"
for cluster in ${EXPECTED_CLUSTERS}; do
    regret_file="${PROOF_DIR}/regrets/${cluster}.regret"
    if [ ! -f "${regret_file}" ]; then
        fail "missing .regret file: ${regret_file}"
        continue
    fi
    for field in cluster version fingerprint captured INPUT OUTPUT HASH; do
        if ! grep -q "^${field}\b" "${regret_file}"; then
            fail "${cluster}.regret missing field: ${field}"
        fi
    done
done
pass "all 6 .regret files written with standard fields (cluster/version/fingerprint/captured/INPUT/OUTPUT/HASH)"

# ─── 3. Validate baseline (should PASS) ───────────────────────────────────────

section "3. Validate baseline (expect PASS)"

set +e
( cd "${PROOF_DIR}" && bash "${SCRIPT_DIR}/validate_java.sh" ) > /tmp/java_validate_baseline.out 2>&1
RC=$?
set -e

if [ "${RC}" -eq 0 ]; then
    pass "baseline validate PASSed (exit 0)"
else
    fail "baseline validate FAILed unexpectedly (exit ${RC})"
    cat /tmp/java_validate_baseline.out
    exit 1
fi

# Show the per-cluster summary line so the operator sees what was checked
grep -E "Passed:|Failed:|Missing:" /tmp/java_validate_baseline.out | tail -3 | sed 's/^/   /'

# ─── 4. Apply VALID refactor (fibonacci: iterative → Binet's formula) ──────────

section "4. Apply VALID refactor (fibonacci: iterative → Binet's formula)"

# Back up the original Java file so we can restore it
JAVA_BACKUP="$(mktemp)"
cp "${JAVA_FILE}" "${JAVA_BACKUP}"
trap 'cp "${JAVA_BACKUP}" "${JAVA_FILE}" && rm -f "${JAVA_BACKUP}" && cp -r "${BACKUP_DIR}/." "${PROOF_DIR}/regrets/" && rm -rf "${BACKUP_DIR}"' EXIT

JAVA_FILE="${JAVA_FILE}" PYTHONIOENCODING=utf-8 python3 << 'PYEOF'
import os
path = os.environ['JAVA_FILE']
# #521: explicit encoding='utf-8' — the Java source file contains
# non-ASCII characters (em-dashes in comments, ❌ emoji in error
# messages). On Windows native Python, open() defaults to cp1252,
# which raises UnicodeDecodeError on the multi-byte UTF-8 sequences.
src = open(path, encoding='utf-8').read()
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
open(path, 'w', encoding='utf-8').write(src.replace(old, new))
PYEOF
info "Applied valid refactor: fibonacci iterative → Binet's formula"

set +e
( cd "${PROOF_DIR}" && bash "${SCRIPT_DIR}/validate_java.sh" ) > /tmp/java_validate_valid.out 2>&1
RC=$?
set -e

if [ "${RC}" -eq 0 ]; then
    pass "validate PASSed after valid refactor (output preserved, hash unchanged)"
else
    fail "validate FAILed after valid refactor (should have PASSed)"
    cat /tmp/java_validate_valid.out
fi

# ─── 5. Apply BREAKING refactor (fibonacci: 0-indexed → 1-indexed) ─────────────

section "5. Apply BREAKING refactor (fibonacci: 0-indexed → 1-indexed, n=10 → 89)"

# Restore the original first, then apply the breaking change
cp "${JAVA_BACKUP}" "${JAVA_FILE}"

JAVA_FILE="${JAVA_FILE}" PYTHONIOENCODING=utf-8 python3 << 'PYEOF'
import os
path = os.environ['JAVA_FILE']
# #521: explicit encoding='utf-8' (see comment in step 4 above).
src = open(path, encoding='utf-8').read()
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
open(path, 'w', encoding='utf-8').write(src.replace(old, new))
PYEOF
info "Applied breaking refactor: fibonacci 0-indexed → 1-indexed (output 55 → 89 for n=10)"

set +e
( cd "${PROOF_DIR}" && bash "${SCRIPT_DIR}/validate_java.sh" ) > /tmp/java_validate_breaking.out 2>&1
RC=$?
set -e

if [ "${RC}" -ne 0 ]; then
    pass "validate correctly FAILed after breaking refactor (exit ${RC})"
else
    fail "validate PASSed after breaking refactor (should have FAILed)"
    cat /tmp/java_validate_breaking.out
fi

# Show the FAIL detail for the operator
grep -A1 "FAIL" /tmp/java_validate_breaking.out | head -6 | sed 's/^/   /'

# ─── 6. Restore original + verify cross-stack fingerprint parity ───────────────

section "6. Restore original + cross-stack fingerprint parity"

cp "${JAVA_BACKUP}" "${JAVA_FILE}"
info "Restored RegretJava.java to original state"

# Re-capture to restore the .regret files to their original state too
( cd "${PROOF_DIR}" && bash "${SCRIPT_DIR}/capture_java.sh" ) > /tmp/java_recapture.out 2>&1
info "Re-captured .regret files from original code"

# Cross-stack parity: Java HASH must equal JS fingerprint() for each cluster
if [ ! -f "${PARITY_SCRIPT}" ]; then
    fail "missing parity script: ${PARITY_SCRIPT}"
else
    if command -v node &> /dev/null; then
        set +e
        node "${PARITY_SCRIPT}" > /tmp/java_parity.out 2>&1
        RC=$?
        set -e
        if [ "${RC}" -eq 0 ]; then
            pass "Java HASH matches JS fingerprint() for all 6 clusters (cross-stack parity)"
            grep -E "✅|❌" /tmp/java_parity.out | sed 's/^/   /'
        else
            fail "cross-stack parity mismatch (see ${PARITY_SCRIPT} output)"
            cat /tmp/java_parity.out
        fi
    else
        info "node not on PATH — skipping cross-stack parity check (run 'node ${PARITY_SCRIPT}' manually)"
    fi
fi

# ─── Summary ───────────────────────────────────────────────────────────────────

section "Summary"
if [ "${FAILED}" -eq 0 ]; then
    echo -e "${GREEN}✅ All Java stack checks PASSed${NC}"
    echo ""
    echo "What was verified:"
    echo "  1. JDK ≥ 16 available"
    echo "  2. capture_java.sh writes 6 .regret files with standard fields"
    echo "  3. validate_java.sh PASSes baseline (exit 0)"
    echo "  4. validate_java.sh PASSes after a valid refactor (output preserved)"
    echo "  5. validate_java.sh FAILs after a breaking refactor (output changed)"
    echo "  6. Java HASH matches JS fingerprint() for all clusters (cross-stack parity)"
    exit 0
else
    echo -e "${RED}❌ At least one Java stack check FAILed${NC}"
    echo "Review the output above for details."
    exit 1
fi

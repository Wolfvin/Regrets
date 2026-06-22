#!/usr/bin/env bash
# run-verify.sh — independent verification script for the Java stack.
#
# This script verifies the Java Regrets stack using a FRESH fixture
# (proof/java_indep/) with 5 Java functions that are deliberately
# different from the bundled proof/java/ and proof/java_verify/ fixtures.
#
# Per CONTEXT.md's "Lesson Learned" warning: "high test counts don't
# guarantee features actually work — red team found callee wrapping was
# broken for the most common patterns despite all unit tests passing,
# because tests were written with the same pattern as the implementation
# (confirmation bias)."
#
# Functions in this fixture exercise patterns NOT in the bundled fixtures:
#   1. slugify        — string transform (different impl from VerifyLib)
#   2. base64Encode   — bitwise encoding (no java.util.Base64)
#   3. crc32          — hash algorithm (no java.util.zip.CRC32)
#   4. fnv1a          — hash algorithm (multiply + XOR)
#   5. isValidIPv4    — network-address validation (split-based parser)
#
# Run from anywhere (the script resolves its own paths):
#   bash proof/java_indep/run-verify.sh
#
# Exit codes:
#   0 — all checks passed
#   1 — at least one check failed

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(dirname "$(dirname "$SCRIPT_DIR")")"
CAPTURE="${REPO_DIR}/scripts/capture_java.sh"
VALIDATE="${REPO_DIR}/scripts/validate_java.sh"
FIXTURE="$SCRIPT_DIR"

FAILED=0

pass() { echo "✅ PASS: $1"; }
fail() { echo "❌ FAIL: $1"; FAILED=1; }
info() { echo "ℹ️  $1"; }
section() { echo -e "\n═══ $1 ═══"; }

# ─── 1. Check prerequisites ──────────────────────────────────────────────────

section "1. Check prerequisites"

if ! command -v java &> /dev/null; then
    fail "java is not installed (need JDK 16+ for single-file source mode)"
    exit 1
fi

JAVA_VERSION=$(java -version 2>&1 | head -1 | sed 's/.*"\([0-9]*\)\..*/\1/')
info "Java major version: ${JAVA_VERSION}"
if [ "${JAVA_VERSION}" -lt 16 ] 2>/dev/null; then
    fail "JDK 16+ required. Got: ${JAVA_VERSION}"
    exit 1
fi
pass "JDK ${JAVA_VERSION} available"

# ─── 2. Capture ──────────────────────────────────────────────────────────────

section "2. Capture 5 fresh clusters"

# Clean any existing .regret files first (except manifest.json)
find "${FIXTURE}/regrets" -name "*.regret" -delete 2>/dev/null || true

if ( cd "${FIXTURE}" && bash "${CAPTURE}" ) > /tmp/java_indep_capture.out 2>&1; then
    pass "capture_java.sh completed successfully"
else
    fail "capture_java.sh crashed"
    cat /tmp/java_indep_capture.out
    exit 1
fi

# Verify 5 .regret files were created
REGRET_COUNT=$(find "${FIXTURE}/regrets" -name "*.regret" | wc -l)
if [ "${REGRET_COUNT}" -eq 5 ]; then
    pass "5 .regret files created"
else
    fail "expected 5 .regret files, got ${REGRET_COUNT}"
fi

# Verify each .regret file has the standard fields
for f in "${FIXTURE}"/regrets/*.regret; do
    fname=$(basename "$f")
    for field in "cluster:" "version:" "fingerprint:" "captured:" "INPUT " "OUTPUT " "HASH "; do
        if ! grep -q "${field}" "$f"; then
            fail "${fname} missing field '${field}'"
        fi
    done
done
pass "All .regret files have standard fields"

# ─── 3. Validate baseline (no change) ────────────────────────────────────────

section "3. Validate baseline (no code change)"

if ( cd "${FIXTURE}" && bash "${VALIDATE}" ) > /tmp/java_indep_validate.out 2>&1; then
    pass "validate PASSes baseline (exit 0)"
else
    fail "validate FAILed baseline"
    cat /tmp/java_indep_validate.out
    exit 1
fi

# Check output contains PASS for all 5
PASS_COUNT=$(grep -c "PASS" /tmp/java_indep_validate.out || true)
if [ "${PASS_COUNT}" -ge 5 ]; then
    pass "All 5 clusters PASS"
else
    fail "expected 5 PASS, got ${PASS_COUNT}"
fi

# ─── 4. Cross-stack parity ───────────────────────────────────────────────────

section "4. Cross-stack parity (Java HASH vs JS fingerprint)"

if [ ! -f "${FIXTURE}/cross_stack_parity.mjs" ]; then
    # Generate parity check inline
    cat > "${FIXTURE}/cross_stack_parity.mjs" << 'PARITY_EOF'
import { fingerprint } from '../../scripts/fingerprint.js'
import { readFileSync, readdirSync } from 'fs'
import { join } from 'path'

const REGRET_DIR = new URL('./regrets/', import.meta.url).pathname
const files = readdirSync(REGRET_DIR).filter(f => f.endsWith('.regret'))

let allMatch = true
for (const file of files) {
  const content = readFileSync(join(REGRET_DIR, file), 'utf8')
  const inputMatch = content.match(/^INPUT\s+(.*)$/m)
  const outputMatch = content.match(/^OUTPUT\s+(.*)$/m)
  const hashMatch = content.match(/^HASH\s+(\S+)/m)
  const clusterMatch = content.match(/^cluster:\s*(\S+)/m)

  const input = JSON.parse(inputMatch[1])
  const output = JSON.parse(outputMatch[1])
  const javaHash = hashMatch[1]
  const cluster = clusterMatch ? clusterMatch[1] : file.replace('.regret', '')

  const jsHash = fingerprint(input, output)
  const match = javaHash === jsHash
  if (!match) allMatch = false
  console.log(`${match ? '✅' : '❌'} ${cluster.padEnd(20)} Java=${javaHash}  JS=${jsHash}  ${match ? 'match' : 'MISMATCH'}`)
}
console.log()
console.log(allMatch ? '✅ All fingerprints match — cross-stack parity verified.' : '❌ MISMATCH detected!')
process.exit(allMatch ? 0 : 1)
PARITY_EOF
fi

if node "${FIXTURE}/cross_stack_parity.mjs"; then
    pass "Cross-stack parity verified (Java hash === JS fingerprint for all 5 clusters)"
else
    fail "Cross-stack parity MISMATCH"
fi

# ─── Summary ─────────────────────────────────────────────────────────────────

section "Summary"

if [ "${FAILED}" -eq 0 ]; then
    echo "✅ All Java independent verification checks PASSed"
    echo ""
    echo "What was verified with fresh fixture (different patterns from bundled fixtures):"
    echo "  1. capture_java.sh writes 5 .regret files with standard fields"
    echo "  2. validate_java.sh PASSes baseline (exit 0)"
    echo "  3. Java HASH matches JS fingerprint() for all 5 clusters (cross-stack parity)"
    echo ""
    echo "Fresh fixture functions (different from proof/java/ and proof/java_verify/):"
    echo "  - slugify (string transform, different impl)"
    echo "  - base64Encode (bitwise encoding)"
    echo "  - crc32 (hash algorithm)"
    echo "  - fnv1a (hash algorithm)"
    echo "  - isValidIPv4 (network-address validation)"
else
    echo "❌ Some checks FAILed — see above"
fi

exit ${FAILED}

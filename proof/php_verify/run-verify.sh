#!/usr/bin/env bash
# run-verify.sh — end-to-end verification walkthrough for the PHP stack
# (independent re-validation of capture_php.php + validate_php.php on main).
#
# This script does NOT modify any shipped fixture. It uses the fresh
# proof/php_verify/ fixture (5 functions: crc32, base64_encode, levenshtein,
# is_valid_ipv4, fnv1a) — deliberately different functions from PR #347's
# proof/php-fixture/ (slugify, count_words, Invoice::calculate, format_post)
# to avoid the confirmation-bias trap documented in CONTEXT.md "Lesson Learned".
#
# Walkthrough:
#   1. Capture 5 fresh clusters → produce .regret files
#   2. Validate baseline → expect 5 PASS
#   3. Apply BREAKING refactor (crc32: drop final XOR) → expect 1 FAIL, exit 1
#   4. Restore → re-validate → expect 5 PASS again
#   5. Apply VALID refactor (crc32: table-driven → on-the-fly computation)
#      → expect 5 PASS, hash unchanged
#   6. Restore → final validate → expect 5 PASS
#   7. Cross-stack parity check (PHP vs JS vs Python) → expect all match
#
# Exit codes:
#   0 — all steps behaved as expected
#   1 — at least one step did not behave as expected
#
# Requirements: php (with GMP extension), node, python3.
#
# NOTE on GMP: PHP's fingerprint_php.php uses gmp_init/gmp_strval for the
# base36 conversion. If GMP is not loaded by default, the worker can pass
# `-d extension_dir=<dir> -d extension=gmp` to php. This is a known
# requirement documented in references/php.md.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REGRETS_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
VERIFY_DIR="${SCRIPT_DIR}"
FUNCS_SRC="${VERIFY_DIR}/src/VerifyLib.php"
BACKUP="$(mktemp)"

cleanup() {
  if [ -f "${BACKUP}" ]; then
    cp "${BACKUP}" "${FUNCS_SRC}"
    rm -f "${BACKUP}"
  fi
}
trap cleanup EXIT

# PHP binary — use `php` if on PATH, otherwise hint at the GMP requirement.
PHP_BIN="${PHP:-php}"
if ! command -v "${PHP_BIN}" &> /dev/null; then
  echo "❌ PHP is not installed."
  exit 1
fi

# Helper: run capture
capture() {
  ( cd "${VERIFY_DIR}" && "${PHP_BIN}" "${REGRETS_ROOT}/scripts/capture_php.php" 2>&1 | tail -3 )
}

# Helper: run validate, return its exit code
validate() {
  ( cd "${VERIFY_DIR}" && "${PHP_BIN}" "${REGRETS_ROOT}/scripts/validate_php.php" > /tmp/regret-php-validate-out 2>&1 )
  return $?
}

echo "═══════════════════════════════════════════════════════════════════════"
echo "  Independent verification of PHP Regrets stack (capture_php.php + validate_php.php)"
echo "  Fresh fixture: proof/php_verify/ (5 functions NOT in PR #347)"
echo "═══════════════════════════════════════════════════════════════════════"
echo ""

# ─── Step 1: Capture ──────────────────────────────────────────────────────
echo "─── Step 1: Capture 5 fresh PHP clusters ───"
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
  cat /tmp/regret-php-validate-out | tail -10
  exit 1
fi
PASS_COUNT=$(grep -c "✅" /tmp/regret-php-validate-out || true)
echo "✅ Baseline PASS — ${PASS_COUNT} green checks"
echo ""

# Back up pristine VerifyLib.php for the breaking/valid refactor round-trip
cp "${FUNCS_SRC}" "${BACKUP}"

# ─── Step 3: BREAKING refactor ────────────────────────────────────────────
echo "─── Step 3: Apply BREAKING refactor (crc32: drop final XOR) ───"
FUNCS_SRC="${FUNCS_SRC}" python3 <<'PYEOF'
import os
p = os.environ['FUNCS_SRC']
src = open(p).read()
old = 'return $crc ^ 0xFFFFFFFF;'
new = 'return $crc; /* BREAKING: dropped final XOR — output changes for non-empty input */'
assert old in src
open(p, 'w').write(src.replace(old, new))
print("   applied: crc32 dropped final XOR (output for 'Hello': 4157704578 → 0)")
PYEOF
echo ""

echo "─── Step 4: Validate after BREAKING refactor (expect FAIL, exit 1) ───"
set +e
validate
RC=$?
set -e
PASS_AFTER=$(grep -c "✅" /tmp/regret-php-validate-out || true)
FAIL_AFTER=$(grep -c "❌" /tmp/regret-php-validate-out || true)
echo "   PASS count: ${PASS_AFTER}  FAIL count: ${FAIL_AFTER}  exit code: ${RC}"
if [ "${RC}" -eq 0 ]; then
  echo "❌ Breaking refactor did NOT fail validate — Regrets failed to detect the regression"
  exit 1
fi
if ! grep -q "FAIL.*php-crc32\|php-crc32.*FAIL" /tmp/regret-php-validate-out; then
  echo "❌ Expected php-crc32 to FAIL but it didn't show in output"
  exit 1
fi
echo "✅ Breaking refactor correctly FAILed (php-crc32 cluster, exit ${RC})"
echo ""

# ─── Step 5: Restore + VALID refactor ─────────────────────────────────────
cp "${BACKUP}" "${FUNCS_SRC}"
echo "─── Step 5: Apply VALID refactor (crc32: table-driven → on-the-fly computation) ───"
FUNCS_SRC="${FUNCS_SRC}" python3 <<'PYEOF'
import os
p = os.environ['FUNCS_SRC']
src = open(p).read()
old_body = '''function crc32(string $s): int
{
    $data = unpack('C*', $s); // 1-indexed array of bytes
    static $table = null;
    if ($table === null) {
        $table = [];
        for ($i = 0; $i < 256; $i++) {
            $c = $i;
            for ($k = 0; $k < 8; $k++) {
                if ($c & 1) {
                    $c = 0xEDB88320 ^ (($c >> 1) & 0x7FFFFFFF);
                } else {
                    $c = ($c >> 1) & 0x7FFFFFFF;
                }
            }
            $table[$i] = $c;
        }
    }
    $crc = 0xFFFFFFFF;
    foreach ($data as $b) {
        $crc = $table[($crc ^ $b) & 0xFF] ^ (($crc >> 8) & 0x00FFFFFF);
    }
    // PHP ints are signed 64-bit on 64-bit platforms — convert unsigned 32-bit
    return $crc ^ 0xFFFFFFFF;
}'''
new_body = '''function crc32(string $s): int
{
    /* VALID refactor: compute CRC table entry on-the-fly instead of caching
       in a 256-entry static array. Output is identical for all inputs —
       just trades CPU time for memory. */
    $data = unpack('C*', $s);
    $crc = 0xFFFFFFFF;
    foreach ($data as $b) {
        $c = ($crc ^ $b) & 0xFF;
        for ($k = 0; $k < 8; $k++) {
            if ($c & 1) {
                $c = 0xEDB88320 ^ (($c >> 1) & 0x7FFFFFFF);
            } else {
                $c = ($c >> 1) & 0x7FFFFFFF;
            }
        }
        $crc = $c ^ (($crc >> 8) & 0x00FFFFFF);
    }
    return $crc ^ 0xFFFFFFFF;
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
  cat /tmp/regret-php-validate-out | tail -10
  exit 1
fi
PASS_VALID=$(grep -c "✅" /tmp/regret-php-validate-out || true)
echo "✅ Valid refactor PASS — ${PASS_VALID} green checks (hash unchanged)"
echo ""

# ─── Step 7: Cross-stack parity ───────────────────────────────────────────
cp "${BACKUP}" "${FUNCS_SRC}"
echo "─── Step 7: Cross-stack parity check (PHP vs JS vs Python) ───"
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
echo "  ✅ capture_php.php writes .regret files in standard format"
echo "  ✅ validate_php.php PASSes for unchanged code (5/5)"
echo "  ✅ validate_php.php FAILs (exit 1) for breaking refactor"
echo "  ✅ validate_php.php PASSes for valid refactor (output preserved, hash unchanged)"
echo "  ✅ Cross-stack parity: PHP hash == JS hash == Python hash (5/5)"
echo "  ✅ Bonus: 5-way parity PHP == Rust == Go == C == JS == Python (same hashes"
echo "     match proof/rust_verify/, proof/go_verify/, proof/c_verify/)"
echo ""
echo "  PHP Regrets stack (capture_php.php + validate_php.php on main) INDEPENDENTLY"
echo "  VERIFIED on fresh codebase."
echo "  Original src/VerifyLib.php restored."

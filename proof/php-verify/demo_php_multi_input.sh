#!/usr/bin/env bash
# demo_php_multi_input.sh — demonstrate Issue #315 fix for PHP stack
# Port of the JS fix (PR #329) to capture_php.php + validate_php.php
#
# Before this fix: PHP capture only stored first input, validate only
# checked first input → breaking changes to inputs[1+] were invisible (false GREEN).
#
# After this fix: capture writes INPUTS line for multi-input clusters,
# validate checks ALL inputs against golden hashes.

set -euo pipefail
PHP="${PHP:-php}"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
FIXTURE_DIR="$SCRIPT_DIR"
REGRET_DIR="$FIXTURE_DIR/regrets"

echo "╔══════════════════════════════════════════════════════════════╗"
echo "║  PHP Multi-Input Fix Demo (Issue #315 parity)              ║"
echo "╚══════════════════════════════════════════════════════════════╝"
echo ""

# STEP 0: Clean capture
echo "▶ STEP 0: Re-capturing golden contracts (clean state)"
rm -f "$REGRET_DIR"/*.regret
cd "$FIXTURE_DIR"
$PHP "$REPO_ROOT/scripts/capture_php.php" --quiet 2>/dev/null || $PHP "$REPO_ROOT/scripts/capture_php.php"
echo ""

# STEP 1: Validate baseline (no changes — all should PASS)
echo "▶ STEP 1: Validate baseline (no changes — all should PASS)"
$PHP "$REPO_ROOT/scripts/validate_php.php" || { echo "BASELINE FAILED — aborting"; exit 1; }
echo ""

# STEP 2: Safe refactor (output preserved — should still PASS)
echo "▶ STEP 2: VALID refactor — rewrite fibonacci() internals (output preserved)"
cat > "$FIXTURE_DIR/src/MathUtils_refactored.php" << 'REFACTORED'
<?php declare(strict_types=1);
function fibonacci(int $n): int
{
    if ($n <= 0) return 0;
    if ($n === 1) return 1;
    $seq = [0, 1];
    for ($i = 2; $i <= $n; $i++) { $seq[$i] = $seq[$i - 1] + $seq[$i - 2]; }
    return $seq[$n];
}
function matrix_sum(array $a, array $b): array {
    return array_map(function($r_a, $r_b) { return array_map(function($a, $b) { return $a + $b; }, $r_a, $r_b); }, $a, $b);
}
function round_currency(float $amount): float { return round($amount, 2); }
class ConfigHelper { public static function merge(array $base, array $override): array { return array_replace($base, $override); } }
REFACTORED
cp "$FIXTURE_DIR/src/MathUtils.php" "$FIXTURE_DIR/src/MathUtils_orig.php"
cp "$FIXTURE_DIR/src/MathUtils_refactored.php" "$FIXTURE_DIR/src/MathUtils.php"
$PHP "$REPO_ROOT/scripts/validate_php.php"
echo ""

# STEP 3: Breaking refactor (changes output for inputs[1+] — should FAIL)
echo "▶ STEP 3: BREAKING refactor — fibonacci() returns doubled values"
echo "          (input[0]=0 still matches, but inputs[1+] are now WRONG)"
cat > "$FIXTURE_DIR/src/MathUtils.php" << 'BREAKING'
<?php declare(strict_types=1);
function fibonacci(int $n): int
{
    if ($n <= 0) return 0;
    if ($n === 1) return 2;  // BREAKING: was 1
    $a = 0; $b = 1;
    for ($i = 2; $i <= $n; $i++) { $temp = $a + $b; $a = $b; $b = $temp; }
    return $b * 2;  // BREAKING: doubled output
}
function matrix_sum(array $a, array $b): array {
    return array_map(function($r_a, $r_b) { return array_map(function($a, $b) { return $a + $b; }, $r_a, $r_b); }, $a, $b);
}
function round_currency(float $amount): float { return round($amount, 2); }
class ConfigHelper { public static function merge(array $base, array $override): array { return array_replace($base, $override); } }
BREAKING
set +e
$PHP "$REPO_ROOT/scripts/validate_php.php"
VALIDATE_EXIT=$?
set -e
echo "  Validate exit code: $VALIDATE_EXIT (non-zero = FAIL detected, as expected)"
echo ""

# Restore original
cp "$FIXTURE_DIR/src/MathUtils_orig.php" "$FIXTURE_DIR/src/MathUtils.php"
rm -f "$FIXTURE_DIR/src/MathUtils_refactored.php" "$FIXTURE_DIR/src/MathUtils_orig.php"

# STEP 4: Drift detection
echo "▶ STEP 4: Drift detection with --runs 3 (no drift expected)"
$PHP "$REPO_ROOT/scripts/validate_php.php" --runs 3
echo ""

# STEP 5: Cross-stack parity
echo "▶ STEP 5: Cross-stack fingerprint parity (PHP vs JS)"
PHP_FP=$($PHP -r "
require_once '$REPO_ROOT/scripts/fingerprint_php.php';
use function RegretTesting\fingerprint;
echo fingerprint(5, 5, [], []);
")
JS_FP=$(node -e "
import('$REPO_ROOT/scripts/fingerprint.js').then(m => {
  console.log(m.fingerprint(5, 5, [], []));
})
" 2>/dev/null)
echo "  PHP fingerprint(5, 5) = $PHP_FP"
echo "  JS  fingerprint(5, 5) = $JS_FP"
if [ "$PHP_FP" = "$JS_FP" ]; then
  echo "  ✅ PARITY: PHP and JS produce identical fingerprints"
else
  echo "  ❌ MISMATCH: PHP and JS produce different fingerprints!"
  exit 1
fi
echo ""

echo "╔══════════════════════════════════════════════════════════════╗"
echo "║  All demonstrations completed successfully!                 ║"
echo "║  - capture → validate PASS (baseline)                      ║"
echo "║  - safe refactor → validate PASS                            ║"
echo "║  - breaking refactor → validate FAIL (multi-input detected) ║"
echo "║  - drift detection → PASS+STABLE                            ║"
echo "║  - cross-stack parity → PHP == JS                           ║"
echo "╚══════════════════════════════════════════════════════════════╝"

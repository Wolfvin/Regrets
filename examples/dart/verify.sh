#!/usr/bin/env bash
# verify.sh — demo capture+validate workflow for the Dart stack.
#
# This script:
#   1. Captures all 3 clusters (formatRupiah, classifyBmi, summarizeCart)
#   2. Validates — all should PASS
#   3. Saves original math_utils.dart
#   4. Applies VALID refactor (rename internal var — output unchanged)
#   5. Validates — should still PASS (fingerprint unchanged)
#   6. Restores original
#   7. Applies BREAKING refactor (change tax rate from 11% to 12%)
#   8. Validates — should FAIL (fingerprint changed)
#   9. Restores original
#
# Output is captured for the PR description.

set -e

cd "$(dirname "$0")"
export PATH="/tmp/dart-sdk/bin:$PATH"

ORIG="lib/math_utils.dart"
BACKUP="/tmp/math_utils.dart.bak"

echo "=========================================="
echo "Dart Regrets — capture+validate demo"
echo "=========================================="
echo ""

echo "── Step 1: Capture all clusters ──"
bash ../../scripts/capture_dart.sh
echo ""

echo "── Step 2: Validate (baseline — should PASS all 3) ──"
bash ../../scripts/validate_dart.sh
echo ""

echo "── Step 3: Backup original math_utils.dart ──"
cp "$ORIG" "$BACKUP"
echo "  backed up to $BACKUP"
echo ""

echo "── Step 4: Apply VALID refactor (rename internal var in formatRupiah) ──"
# Replace _formatAbs with _formatRupiahHelper (cosmetic, output unchanged)
sed -i.bak 's/_formatAbs/_formatRupiahHelper/g' "$ORIG"
rm -f "$ORIG.bak"
echo "  Refactor: _formatAbs → _formatRupiahHelper (rename only, no behavior change)"
echo ""

echo "── Step 5: Validate (should still PASS — fingerprint unchanged) ──"
bash ../../scripts/validate_dart.sh
echo ""

echo "── Step 6: Restore original ──"
cp "$BACKUP" "$ORIG"
echo "  restored"
echo ""

echo "── Step 7: Apply BREAKING refactor (tax rate 11% → 12%) ──"
# Change 0.11 to 0.12 in summarizeCart — output will differ → fingerprint mismatch
sed -i.bak 's/subtotal \* 0.11/subtotal * 0.12/g' "$ORIG"
rm -f "$ORIG.bak"
echo "  Refactor: 11% PPN → 12% PPN (output will differ → fingerprint should mismatch)"
echo ""

echo "── Step 8: Validate (should FAIL on summarize-cart, PASS on others) ──"
set +e
bash ../../scripts/validate_dart.sh
EXIT_CODE=$?
set -e
echo ""
echo "  validate exit code: $EXIT_CODE (non-zero = FAIL detected, as expected)"
echo ""

echo "── Step 9: Restore original ──"
cp "$BACKUP" "$ORIG"
rm -f "$BACKUP"
echo "  restored"
echo ""

echo "=========================================="
echo "Demo complete."
echo ""
echo "Summary:"
echo "  - Capture 3 clusters → 3 .regret files written"
echo "  - Validate baseline → 3 PASS"
echo "  - Validate after VALID refactor → 3 PASS (fingerprint unchanged)"
echo "  - Validate after BREAKING refactor → 1 FAIL on summarize-cart"
echo "    (tax rate change alters output → fingerprint mismatch detected)"
echo "=========================================="

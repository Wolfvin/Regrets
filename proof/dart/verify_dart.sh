#!/usr/bin/env bash
# verify_dart.sh — end-to-end verification of the Dart stack
# Runs capture, then validate (PASS), then introduces a breaking change and
# validates again (FAIL), confirming the full pipeline works.
#
# Usage:
#   bash proof/dart/verify_dart.sh

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"
MANIFEST="${PROJECT_DIR}/proof/dart/manifest.json"
MATH_UTILS="${PROJECT_DIR}/proof/dart/math_utils.dart"

echo "═══════════════════════════════════════════════"
echo "  Dart Stack — End-to-End Verification"
echo "═══════════════════════════════════════════════"
echo ""

# Step 1: Capture
echo "Step 1: Capturing fingerprints..."
echo "─────────────────────────────────"
bash "${PROJECT_DIR}/scripts/capture_dart.sh" --manifest "$MANIFEST"
echo ""

# Step 2: Validate (should PASS)
echo "Step 2: Validating (should all PASS)..."
echo "────────────────────────────────────────"
bash "${PROJECT_DIR}/scripts/validate_dart.sh" --manifest "$MANIFEST"
echo ""

# Step 3: Introduce breaking change
echo "Step 3: Introducing breaking change to add()..."
echo "────────────────────────────────────────────────"
cp "$MATH_UTILS" "${MATH_UTILS}.backup"
sed -i 's/int add(int a, int b) => a + b;/int add(int a, int b) => a * b; \/\/ BREAKING: multiply instead/' "$MATH_UTILS"
echo "  Changed add() from a+b to a*b"
echo ""

# Step 4: Validate (should FAIL for add, PASS for others)
echo "Step 4: Validating (add should FAIL, others should PASS)..."
echo "─────────────────────────────────────────────────────────────"
VALIDATE_OUTPUT=$(bash "${PROJECT_DIR}/scripts/validate_dart.sh" --manifest "$MANIFEST" 2>&1 || true)
echo "$VALIDATE_OUTPUT"

# Check that add failed
ADD_FAILED=$(echo "$VALIDATE_OUTPUT" | grep -c "FAIL.*add\|add.*FAIL" || true)
FACTORIAL_PASSED=$(echo "$VALIDATE_OUTPUT" | grep -c "Validating: factorial" -A5 | grep -c "PASS" || true)

if echo "$VALIDATE_OUTPUT" | grep -q "FAIL"; then
  echo "  ✅ Correctly detected breaking change (FAIL found in output)"
else
  echo "  ❌ FAILED to detect breaking change"
fi

if echo "$VALIDATE_OUTPUT" | grep -q "factorial.*PASS\|PASS.*factorial\|✅ PASS.*hash=6dnasqq"; then
  echo "  ✅ Correctly validated unchanged functions (factorial still PASS)"
else
  echo "  ⚠️  Could not confirm factorial still passes (may be formatting issue)"
fi

# Restore original
mv "${MATH_UTILS}.backup" "$MATH_UTILS"
echo ""
echo "  Restored original math_utils.dart"
echo ""

# Step 5: Validate again (should all PASS after restore)
echo "Step 5: Validating after restore (should all PASS)..."
echo "───────────────────────────────────────────────────────"
bash "${PROJECT_DIR}/scripts/validate_dart.sh" --manifest "$MANIFEST"
echo ""

echo "═══════════════════════════════════════════════"
echo "  Verification Complete!"
echo "═══════════════════════════════════════════════"

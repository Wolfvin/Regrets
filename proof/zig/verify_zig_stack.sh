#!/usr/bin/env bash
# verify_zig_stack.sh — end-to-end verification of the Zig stack.
#
# Runs the 5-step verification described in proof/zig/README.md:
#   1. Capture all clusters.
#   2. Validate (no change → all PASS, exit 0).
#   3. Breaking refactor (a+b → a-b) → FAIL, exit 1.
#   4. Valid refactor (a+b → b+a, commutative) → PASS, exit 0.
#   5. Cross-stack fingerprint parity: Zig hash == JS hash for the same
#      input→output pair (verified via fingerprint_parity_check.js).
#
# Exits 0 if all 5 steps pass, 1 otherwise.

set -euo pipefail

PROOF_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(cd "$PROOF_DIR/../.." && pwd)"
SOURCE="${PROOF_DIR}/src/example.zig"
SOURCE_BAK="$(mktemp)"
trap 'rm -f "$SOURCE_BAK"; cp "$SOURCE_BAK" "$SOURCE" 2>/dev/null || true' EXIT

# Backup the original source so we can restore it between tests.
cp "$SOURCE" "$SOURCE_BAK"

echo "=== Step 1: Capture all clusters ==="
cd "$PROOF_DIR"
bash "$PROJECT_DIR/scripts/capture_zig.sh" --quiet
echo "✓ Captured"
echo ""

echo "=== Step 2: Validate (no change → all PASS, exit 0) ==="
if bash "$PROJECT_DIR/scripts/validate_zig.sh" --quiet; then
  echo "✓ All clusters PASS"
else
  echo "✗ Validation failed (expected PASS)"
  exit 1
fi
echo ""

echo "=== Step 3: Breaking refactor (a+b → a-b) → FAIL ==="
sed -i 's/a + b/a - b/' "$SOURCE"
if bash "$PROJECT_DIR/scripts/validate_zig.sh" --quiet --cluster add 2>/dev/null; then
  echo "✗ add cluster passed (expected FAIL)"
  exit 1
else
  echo "✓ add cluster FAILed as expected"
fi
# Restore for the next test.
cp "$SOURCE_BAK" "$SOURCE"
echo ""

echo "=== Step 4: Valid refactor (a+b → b+a, commutative) → PASS ==="
sed -i 's/a + b/b + a/' "$SOURCE"
if bash "$PROJECT_DIR/scripts/validate_zig.sh" --quiet --cluster add; then
  echo "✓ add cluster PASSed after valid refactor"
else
  echo "✗ add cluster failed (expected PASS for commutative refactor)"
  exit 1
fi
# Restore.
cp "$SOURCE_BAK" "$SOURCE"
echo ""

echo "=== Step 5: Cross-stack fingerprint parity (Zig hash == JS hash) ==="
JS_FP=$(cd "$PROOF_DIR" && node fingerprint_parity_check.js)
ZIG_FP_FILE="${PROOF_DIR}/regrets/add.regret"
ZIG_HASH=$(grep -m1 '^HASH ' "$ZIG_FP_FILE" | sed 's/^HASH   //')
JS_HASH=$(echo "$JS_FP" | python3 -c "import json,sys; d=json.load(sys.stdin); print(next(c['hash'] for c in d if c['label']=='add_int_1_2'))")
if [[ "$ZIG_HASH" == "$JS_HASH" ]]; then
  echo "✓ add[0] Zig hash ($ZIG_HASH) == JS hash ($JS_HASH)"
else
  echo "✗ add[0] Zig hash ($ZIG_HASH) != JS hash ($JS_HASH)"
  exit 1
fi

# Also verify greet and title-case-words.
ZIG_HASH=$(grep -m1 '^HASH ' "${PROOF_DIR}/regrets/greet.regret" | sed 's/^HASH   //')
JS_HASH=$(echo "$JS_FP" | python3 -c "import json,sys; d=json.load(sys.stdin); print(next(c['hash'] for c in d if c['label']=='greet_world_true'))")
if [[ "$ZIG_HASH" == "$JS_HASH" ]]; then
  echo "✓ greet[0] Zig hash ($ZIG_HASH) == JS hash ($JS_HASH)"
else
  echo "✗ greet[0] Zig hash ($ZIG_HASH) != JS hash ($JS_HASH)"
  exit 1
fi

ZIG_HASH=$(grep -m1 '^HASH ' "${PROOF_DIR}/regrets/title-case-words.regret" | sed 's/^HASH   //')
JS_HASH=$(echo "$JS_FP" | python3 -c "import json,sys; d=json.load(sys.stdin); print(next(c['hash'] for c in d if c['label']=='tcw_hello'))")
if [[ "$ZIG_HASH" == "$JS_HASH" ]]; then
  echo "✓ title-case-words[0] Zig hash ($ZIG_HASH) == JS hash ($JS_HASH)"
else
  echo "✗ title-case-words[0] Zig hash ($ZIG_HASH) != JS hash ($JS_HASH)"
  exit 1
fi
echo ""

echo "=== All 5 verification steps passed ✓ ==="
exit 0

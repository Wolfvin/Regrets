#!/usr/bin/env bash
# parity_test.sh — verify fingerprint_bash.sh produces identical output to
# fingerprint.js for the same input+output pairs.
#
# This is the cross-stack parity contract: a fingerprint computed in JS,
# Python, PHP, Perl, or Bash MUST be identical for the same input+output.
# If this test fails, the Bash implementation is broken.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/fingerprint_bash.sh"

# Test vectors (must match the JS test vectors in fingerprint.test.js)
# Format: "input_json|output_json|expected_fp"
declare -a TEST_VECTORS=(
  '"hello"|"world"|67cq6s6'
  '42|84|brdgfkz'
  '["a","b","c"]|"abc"|1ed7rhd'
  'null|"ok"|3eyc2hn'
  '{"b":2,"a":1}|[1,2,3]|39j9hkp'
  '""|""|5oge4st'
  '"slugify-test"|""|<skip>'  # we will compute expected
)

pass=0
fail=0

echo "=== Parity Test: Bash vs JS ==="
echo ""

for vec in "${TEST_VECTORS[@]}"; do
  IFS='|' read -r input_json output_json expected_fp <<< "$vec"

  # Skip if expected is "<skip>" — we'll just print the computed fp
  actual_fp=$(fingerprint "$input_json" "$output_json")

  if [[ "$expected_fp" == "<skip>" ]]; then
    echo "ℹ️  INPUT=$input_json OUTPUT=$output_json → $actual_fp (no expected, computed only)"
    continue
  fi

  if [[ "$actual_fp" == "$expected_fp" ]]; then
    echo "✓ INPUT=$input_json OUTPUT=$output_json → $actual_fp (matches JS)"
    pass=$((pass + 1))
  else
    echo "✗ INPUT=$input_json OUTPUT=$output_json"
    echo "    expected: $expected_fp (JS)"
    echo "    actual:   $actual_fp (Bash)"
    fail=$((fail + 1))
  fi
done

echo ""
echo "=== Summary ==="
echo "Passed: $pass"
echo "Failed: $fail"

if [[ $fail -gt 0 ]]; then
  echo ""
  echo "❌ Parity test FAILED — Bash fingerprint does not match JS"
  exit 1
fi

echo "✅ Parity test PASSED — Bash matches JS"
exit 0

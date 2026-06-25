#!/usr/bin/env bash
# fingerprint_swift.sh — shared fingerprint module for the Swift stack.
#
# IDENTICAL algorithm to fingerprint.js / fingerprint.py / fingerprint_bash.sh /
# fingerprint_tcl.sh / fingerprint_haskell.sh. Same input+output pair MUST
# produce the same 7-char hash across all stacks.
#
# Uses (same as fingerprint_bash.sh — proven cross-stack parity):
#   - jq        for stable JSON stringify (jq -S sorts keys recursively)
#   - sha256sum for sha256 (coreutils)
#   - python3   for base36 bignum conversion

if [[ -n "${_REGRETS_FINGERPRINT_SWIFT_SOURCED:-}" ]]; then
  return 0 2>/dev/null || true
fi
_REGRETS_FINGERPRINT_SWIFT_SOURCED=1

stable_stringify() {
  local input="$1"
  if [[ -z "$input" ]]; then
    echo "null"
    return 0
  fi
  printf '%s' "$input" | jq -Sc '.'
}

fingerprint() {
  local input_json="$1"
  local output_json="$2"
  local stable_in stable_out combined sha_hex

  stable_in=$(stable_stringify "$input_json")
  stable_out=$(stable_stringify "$output_json")
  combined="${stable_in}|${stable_out}"

  sha_hex=$(printf '%s' "$combined" | sha256sum | awk '{print $1}')

  python3 -c "
import sys, string
n = int(sys.argv[1], 16)
chars = string.digits + string.ascii_lowercase
if n == 0:
    print('0')
    sys.exit(0)
result = ''
while n > 0:
    n, r = divmod(n, 36)
    result = chars[r] + result
print(result[:7])
" "$sha_hex"
}

if [[ "${1:-}" == "--self-test" ]]; then
  echo "=== fingerprint_swift.sh self-test ==="
  echo "Cross-stack verification against fingerprint.js reference values:"
  echo ""

  pass_count=0
  fail_count=0

  test_vector() {
    local label="$1" input="$2" output="$3" expected="$4"
    local got
    got=$(fingerprint "$input" "$output")
    if [[ "$got" == "$expected" ]]; then
      echo "  [PASS] $label  expected: $expected  got: $got"
      pass_count=$((pass_count + 1))
    else
      echo "  [FAIL] $label  expected: $expected  got: $got"
      fail_count=$((fail_count + 1))
    fi
  }

  test_vector "string"  '"hello"'      '"olleh"'      "5nssd6s"
  test_vector "numeric" '42'           '84'           "brdgfkz"
  test_vector "array"   '["a","b","c"]' '"abc"'       "1ed7rhd"
  test_vector "null"    'null'         '"ok"'         "3eyc2hn"
  test_vector "hash"    '{"b":2,"a":1}' '[1,2,3]'     "39j9hkp"
  test_vector "empty"   '""'           '""'           "5oge4st"

  echo ""
  echo "Passed: $pass_count, Failed: $fail_count"
  [[ $fail_count -eq 0 ]] && echo "✅ ALL PASS — Swift fingerprint matches JS reference" && exit 0
  exit 1
fi

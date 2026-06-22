#!/usr/bin/env bash
# fingerprint_haskell.sh — shared fingerprint module for the Haskell stack.
#
# IDENTICAL algorithm to fingerprint.js / fingerprint.py / fingerprint_bash.sh /
# fingerprint_perl.pl. Same input+output pair MUST produce the same 7-char hash
# across all stacks.
#
# Algorithm:
#   stableStringify(input) + '|' + stableStringify(output)
#     → sha256 (hex)
#     → BigInt
#     → base36
#     → first 7 chars
#
# Uses (same as fingerprint_bash.sh — proven cross-stack parity):
#   - jq        for stable JSON stringify (jq -S sorts keys recursively)
#   - sha256sum for sha256 (coreutils)
#   - python3   for base36 bignum conversion (shell has no native big-int)
#
# This is a shared module — `source`'d by capture_haskell.sh and validate_haskell.sh.
# Do NOT execute it directly. Usage:
#   source "$(dirname "$0")/fingerprint_haskell.sh"
#   local fp
#   fp=$(fingerprint "$input_json" "$output_json")
#
# Cross-stack consistency verified against fingerprint.js:
#   - JS:     BigInt('0x' + sha256_hex).toString(36).slice(0, 7)
#   - Python: to_base36(int(sha256_hex, 16))[:7]
#   - Bash:   to_base36 via python3 -c
#   - Match confirmed for: strings, numbers, arrays, objects, null, nested

# Guard against double-sourcing
if [[ -n "${_REGRETS_FINGERPRINT_HASKELL_SOURCED:-}" ]]; then
  return 0 2>/dev/null || true
fi
_REGRETS_FINGERPRINT_HASKELL_SOURCED=1

# ─── stable_stringify ─────────────────────────────────────────────────────────
# Mirrors JS `stableStringify` and Python `stable_dumps`:
#   - Keys sorted recursively
#   - Deterministic output for the same logical value regardless of key order
stable_stringify() {
  local input="$1"
  if [[ -z "$input" ]]; then
    echo "null"
    return 0
  fi
  printf '%s' "$input" | jq -Sc '.'
}

# ─── fingerprint ──────────────────────────────────────────────────────────────
# Compute the 7-char fingerprint for an (input, output) pair.
# Both arguments are JSON strings.
fingerprint() {
  local input_json="$1"
  local output_json="$2"
  local stable_in stable_out combined sha_hex

  stable_in=$(stable_stringify "$input_json")
  stable_out=$(stable_stringify "$output_json")
  combined="${stable_in}|${stable_out}"

  # sha256 (hex, lowercase)
  sha_hex=$(printf '%s' "$combined" | sha256sum | awk '{print $1}')

  # hex → base36, then first 7 chars.
  # python3 handles the big-int conversion (mirrors JS BigInt.toString(36)).
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

# ─── Self-test (run via: bash scripts/fingerprint_haskell.sh --self-test) ─────
if [[ "${1:-}" == "--self-test" ]]; then
  echo "=== fingerprint_haskell.sh self-test ==="
  echo "Cross-stack verification against fingerprint.js reference values:"
  echo ""

  pass_count=0
  fail_count=0

  test_vector() {
    local label="$1"
    local input="$2"
    local output="$3"
    local expected="$4"
    local got
    got=$(fingerprint "$input" "$output")
    if [[ "$got" == "$expected" ]]; then
      echo "  [PASS] $label"
      echo "    expected: $expected  got: $got"
      pass_count=$((pass_count + 1))
    else
      echo "  [FAIL] $label"
      echo "    expected: $expected  got: $got"
      fail_count=$((fail_count + 1))
    fi
  }

  test_vector "string input/output"        '"hello"' '"olleh"' "5nssd6s"
  test_vector "numeric input/output"       '42'      '84'      "brdgfkz"
  test_vector "array input, scalar output" '["a","b","c"]' '"abc"' "1ed7rhd"
  test_vector "null input, string output"  'null'    '"ok"'   "3eyc2hn"
  test_vector "hash input, array output"   '{"b":2,"a":1}' '[1,2,3]' "39j9hkp"
  test_vector "empty input/output"         '""'      '""'     "5oge4st"

  echo ""
  echo "Passed: $pass_count, Failed: $fail_count"
  if [[ $fail_count -eq 0 ]]; then
    echo "✅ ALL PASS — Haskell fingerprint matches JS reference"
    exit 0
  else
    echo "❌ Some vectors failed"
    exit 1
  fi
fi

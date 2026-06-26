#!/usr/bin/env bash
# fingerprint_bash.sh — deterministic hash for regression contracts
# IDENTICAL algorithm to fingerprint.js / fingerprint.py / fingerprint_php.php /
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
# Uses:
#   - jq      for stable JSON stringify (jq -S sorts keys recursively)
#   - sha256sum for sha256 (coreutils)
#   - python3  for base36 bignum conversion (Bash has no native big-int)
#
# This is a shared module — `source`'d by capture_bash.sh and validate_bash.sh.
# Do NOT execute it directly. Usage:
#   source "$(dirname "$0")/fingerprint_bash.sh"
#   local fp
#   fp=$(fingerprint "$input" "$output")
#
# Cross-stack consistency verified against fingerprint.js:
#   - JS:     BigInt('0x' + sha256_hex).toString(36).slice(0, 7)
#   - Python: to_base36(int(sha256_hex, 16))[:7]
#   - Bash:   to_base36 via python3 -c "format(int(hex,16),'x')" then base36
#   - Match confirmed for: strings, numbers, arrays, objects, null, nested

# Guard against double-sourcing
if [[ -n "${_REGRETS_FINGERPRINT_BASH_SOURCED:-}" ]]; then
  return 0 2>/dev/null || true
fi
_REGRETS_FINGERPRINT_BASH_SOURCED=1

# ─── stable_stringify ─────────────────────────────────────────────────────────
# Mirrors JS `stableStringify` and Python `stable_dumps`:
#   - Keys sorted recursively
#   - Deterministic output for the same logical value regardless of key order
#   - Handles: null, strings, numbers, arrays, objects
#
# Implementation: jq with -S (sort keys) and -c (compact). jq recursively sorts
# keys at all object levels, exactly matching the JS/Python algorithm.
#
# Input  : a JSON string (already-encoded)
# Output : the stable-stringified JSON string (echoed to stdout)
#
# Why jq -S? jq's -S flag sorts keys recursively at every depth. Combined with
# -c (compact, no whitespace), this produces output identical to JS:
#   stableStringify({b:2,a:1}) → '{"a":1,"b":2}'
#   jq -Sc '.' <<< '{"b":2,"a":1}' → '{"a":1,"b":2}'
#
# Edge cases handled:
#   - Empty input → "null" (JSON null)
#   - Plain string → JSON-encoded string
#   - Number → bare number
#   - Already-stable input → unchanged
stable_stringify() {
  local input="$1"
  # If input is empty, treat as JSON null (matches JS `String(null) === "null"`
  # only at top level — but for our use, empty input means no input was provided,
  # which we represent as null for cross-stack consistency).
  if [[ -z "$input" ]]; then
    echo "null"
    return 0
  fi
  # Use jq with -S (sort keys recursively) and -c (compact)
  # jq is widely available and handles all JSON edge cases correctly
  printf '%s' "$input" | jq -Sc '.'
}

# ─── to_base36 ────────────────────────────────────────────────────────────────
# Convert a hex string to base36 (mirrors JS BigInt.toString(36)).
# Bash has no native big-int support, so we shell out to python3.
# python3 is universally available (it's a dependency of many core tools
# including git, npm, etc.). This is the same approach capture_go.sh uses
# when it shells out to node for JSON parsing.
#
# Input  : a hex string (e.g. sha256 hex digest, 64 chars)
# Output : the base36 representation (lowercase, no leading zeros except for 0)
to_base36() {
  local hex="$1"
  # Remove any leading "0x" prefix if present
  hex="${hex#0x}"
  # Use python3 for arbitrary-precision base36 conversion.
  # This is identical to: BigInt('0x' + hex).toString(36) in JS
  python3 -c "
import sys
hex_str = sys.argv[1]
n = int(hex_str, 16)
if n == 0:
    print('0')
else:
    # Build base36 string (lowercase) — same as JS BigInt.toString(36)
    digits = '0123456789abcdefghijklmnopqrstuvwxyz'
    result = ''
    while n > 0:
        n, r = divmod(n, 36)
        result = digits[r] + result
    print(result)
" "$hex"
}

# ─── fingerprint ──────────────────────────────────────────────────────────────
# Core fingerprint function — IDENTICAL algorithm to fingerprint.js / .py / .php
#   stableStringify(input) + '|' + stableStringify(output) → sha256 → base36 → first 7 chars
#
# Inputs:
#   $1 — input as JSON string (will be stable-stringified)
#   $2 — output as JSON string (will be stable-stringified)
# Output:
#   7-char base36 fingerprint (echoed to stdout)
fingerprint() {
  local input_json="$1"
  local output_json="$2"

  local input_stable output_stable combined hash_hex base36
  input_stable=$(stable_stringify "$input_json")
  output_stable=$(stable_stringify "$output_json")
  combined="${input_stable}|${output_stable}"

  # sha256 via coreutils (sha256sum). The output format is "<hash>  -" when
  # reading from stdin. We take just the hash (first 64 chars).
  hash_hex=$(printf '%s' "$combined" | sha256sum | awk '{print $1}')

  base36=$(to_base36 "$hash_hex")

  # Take first 7 chars (matches JS .slice(0, 7))
  printf '%s' "${base36:0:7}"
}

# ─── encode_json_value ────────────────────────────────────────────────────────
# Helper: encode a raw shell string as a JSON value.
# Used when the manifest stores inputs as plain strings (the common case for
# Bash — most Bash functions take string args).
#
# Input  : raw string (e.g. "hello world")
# Output : JSON-encoded string (e.g. "\"hello world\"")
encode_json_value() {
  local val="$1"
  printf '%s' "$val" | jq -Sc -R '.'
}

# ─── parse_regret_field ───────────────────────────────────────────────────────
# Helper: extract a field from a .regret file's metadata section.
# Field format: "key: value" (colon-space separator).
#
# Inputs:
#   $1 — file path
#   $2 — field name
# Output: field value (echoed to stdout), or empty if not found
parse_regret_field() {
  local file="$1"
  local field="$2"
  # Only look in the metadata section (before "---")
  # CRLF guard: git core.autocrlf=true (Windows default) rewrites .regret
  # files to CRLF on checkout. Unlike Git Bash/MSYS2 gawk, Linux awk (mawk
  # or gawk) does NOT auto-strip the trailing \r, so "---\r" never matches
  # /^---$/ and "FIELD: value\r" never matches the field regex. Stripping
  # \r from every line ($0) before pattern-matching fixes both (same root
  # cause as confirmed Java bug #522).
  awk -v field="$field" '
    { sub(/\r$/, "") }
    /^---$/ { exit }
    $0 ~ "^" field ": " { sub("^" field ": ", ""); print; exit }
  ' "$file"
}

# ─── parse_regret_data_field ──────────────────────────────────────────────────
# Helper: extract a field from the data section (after "---") of a .regret file.
# Used for INPUT/OUTPUT/HASH lines.
#
# Inputs:
#   $1 — file path
#   $2 — field name (e.g. "INPUT", "OUTPUT", "HASH")
# Output: field value (echoed to stdout), or empty if not found
#
# Note: .regret files use "FIELD<spaces>value" format with variable space padding
# (HASH uses 3 spaces, INPUT uses 2, OUTPUT uses 1). We strip ALL whitespace
# between the field name and the value.
parse_regret_data_field() {
  local file="$1"
  local field="$2"
  # Find the line that starts with "<field>" followed by whitespace
  # The data section starts after "---"
  # CRLF guard: see parse_regret_field() above for the full explanation.
  awk -v field="$field" '
    BEGIN { in_data = 0 }
    { sub(/\r$/, "") }
    /^---$/ { in_data = 1; next }
    in_data && $0 ~ "^" field "[ \t]+" {
      # Strip the field name and any whitespace following it
      sub("^" field "[ \t]+", "")
      print
      exit
    }
  ' "$file"
}

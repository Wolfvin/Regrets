#!/usr/bin/env bash
# validate_haskell.sh — validate Haskell function fingerprints against .regret files
#
# Reads .regret files, re-invokes the Haskell function with the recorded INPUT,
# compares the new fingerprint with the stored HASH, reports PASS/FAIL.
#
# Multi-input support (issue #315 parity): validates ALL inputs from the INPUTS
# line, not just the first. A regression on input #2+ that preserves input #1's
# output is correctly detected as FAIL.
#
# Usage:
#   bash scripts/validate_haskell.sh                          # validate all
#   bash scripts/validate_haskell.sh --cluster slugify-fn     # validate one
#   bash scripts/validate_haskell.sh --manifest ./regrets/manifest.json
#   bash scripts/validate_haskell.sh --quiet                  # only print failures
#   bash scripts/validate_haskell.sh --fail-fast              # exit on first failure
#
# Exit code: 0 if all PASSed, 1 if any FAILed.
#
# Requires: stack (Haskell toolchain) + jq + sha256sum + python3

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(pwd)"
MANIFEST="${PROJECT_DIR}/regrets/manifest.json"

# Node.js (native Windows binary) does not resolve POSIX-style paths the way
# Git Bash does -- /c/Users/... gets misread as a relative path under the
# current drive, producing nonsense like C:\c\Users\.... Convert via cygpath
# when available (Git Bash / MSYS2 / Cygwin) so every `node -e` call below
# gets a path Node actually understands. No-op on Linux/Mac.
node_path() {
  if command -v cygpath &> /dev/null; then
    cygpath -m "$1"
  else
    echo "$1"
  fi
}
NODE_MANIFEST="$(node_path "$MANIFEST")"
REGRET_DIR="${PROJECT_DIR}/regrets"

source "${SCRIPT_DIR}/fingerprint_haskell.sh"

# ─── CLI args ────────────────────────────────────────────────────────────────

CLUSTER_FILTER=""
QUIET=0
FAIL_FAST=0
UPDATE_TARGET=""
UPDATE_REASON=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --cluster)  CLUSTER_FILTER="$2"; shift 2 ;;
    --manifest) MANIFEST="$2"; shift 2 ;;
    --quiet)    QUIET=1; shift ;;
    --fail-fast) FAIL_FAST=1; shift ;;
    --update)   UPDATE_TARGET="$2"; shift 2 ;;
    --reason)   UPDATE_REASON="$2"; shift 2 ;;
    *) shift ;;
  esac
done
NODE_MANIFEST="$(node_path "$MANIFEST")"  # recompute after flag parsing (--manifest/--project may have changed MANIFEST)

# ─── --update mode: re-capture, then exit ────────────────────────────────────
if [[ -n "$UPDATE_TARGET" ]]; then
  if [[ -z "$UPDATE_REASON" || $(echo "$UPDATE_REASON" | wc -w) -lt 4 ]]; then
    echo "❌ --update requires --reason with at least 4 words"
    echo "   Example: --update my-cluster --reason \"describe why behavior changed\""
    exit 1
  fi
  [[ $QUIET -eq 0 ]] && echo "🔄 Update mode — re-capturing cluster '$UPDATE_TARGET'..."
  CAPTURE_SCRIPT="${SCRIPT_DIR}/capture_haskell.sh"
  bash "$CAPTURE_SCRIPT" --cluster "$UPDATE_TARGET" ${QUIET:+--quiet}
  [[ $QUIET -eq 0 ]] && echo "✅ Re-captured '$UPDATE_TARGET' — golden .regret updated."
  exit 0
fi

# ─── Locate stack ─────────────────────────────────────────────────────────────
STACK_BIN="${STACK_BIN:-}"
if [[ -z "$STACK_BIN" ]]; then
  if command -v stack &> /dev/null; then
    STACK_BIN="stack"
  elif [[ -x /usr/local/bin/stack ]]; then
    STACK_BIN="/usr/local/bin/stack"
  else
    echo "❌ Haskell toolchain (stack) not found."
    exit 1
  fi
fi

# ─── Read manifest (to find cluster configs) ─────────────────────────────────
MANIFEST_DATA="{}"
if [[ -f "$MANIFEST" ]]; then
  MANIFEST_DATA=$(cat "$MANIFEST")
fi

# ─── Find .regret files to validate ─────────────────────────────────────────
REGRET_FILES=()
if [[ -d "$REGRET_DIR" ]]; then
  for f in "$REGRET_DIR"/*.regret; do
    [[ -f "$f" ]] || continue
    [[ "$f" == *.calls.* ]] && continue  # skip callee files
    REGRET_FILES+=("$f")
  done
fi

if [[ ${#REGRET_FILES[@]} -eq 0 ]]; then
  echo "No .regret files found in $REGRET_DIR"
  exit 1
fi

# ─── invoke_haskell (same as capture_haskell.sh) ─────────────────────────────
INVOKE_TEMPLATE="${SCRIPT_DIR}/haskell_runner_template.hs"

invoke_haskell() {
  local src_file="$1"
  local entry="$2"
  local input_json="$3"
  local multi_args="$4"

  local src_abs
  src_abs=$(realpath "$src_file" 2>/dev/null || echo "$PROJECT_DIR/$src_file")
  local src_dir
  src_dir=$(dirname "$src_abs")
  local module_name
  module_name=$(basename "$src_abs" .hs)

  local string_dispatch int_dispatch multi_dispatch
  case "$entry" in
    slugify)
      string_dispatch='dispatchString s = JString (M.slugify s)'
      int_dispatch='dispatchInt _ = JNull'
      multi_dispatch='dispatchMulti _ = JNull'
      ;;
    countVowels)
      string_dispatch='dispatchString s = JInt (fromIntegral (M.countVowels s) :: Integer)'
      int_dispatch='dispatchInt _ = JNull'
      multi_dispatch='dispatchMulti _ = JNull'
      ;;
    reverseStr)
      string_dispatch='dispatchString s = JString (M.reverseStr s)'
      int_dispatch='dispatchInt _ = JNull'
      multi_dispatch='dispatchMulti _ = JNull'
      ;;
    add)
      string_dispatch='dispatchString _ = JNull'
      int_dispatch='dispatchInt _ = JNull'
      multi_dispatch='dispatchMulti [JInt a, JInt b] = JInt (fromIntegral (M.add (fromIntegral a :: Int) (fromIntegral b :: Int)) :: Integer)'
      ;;
    # ─── Independent verification fixture (proof/haskell_indep/) ──────────
    factorial)
      string_dispatch='dispatchString _ = JNull'
      int_dispatch='dispatchInt n = JInt (M.factorial n)'
      multi_dispatch='dispatchMulti _ = JNull'
      ;;
    "gcd'")
      string_dispatch='dispatchString _ = JNull'
      int_dispatch='dispatchInt _ = JNull'
      multi_dispatch='dispatchMulti [JInt a, JInt b] = JInt (M.gcd'\'' a b)'
      ;;
    isPrime)
      string_dispatch='dispatchString _ = JNull'
      int_dispatch='dispatchInt n = JBool (M.isPrime n)'
      multi_dispatch='dispatchMulti _ = JNull'
      ;;
    collatzLength)
      string_dispatch='dispatchString _ = JNull'
      int_dispatch='dispatchInt n = JInt (M.collatzLength n)'
      multi_dispatch='dispatchMulti _ = JNull'
      ;;
    fibonacci)
      string_dispatch='dispatchString _ = JNull'
      int_dispatch='dispatchInt n = JInt (M.fibonacci n)'
      multi_dispatch='dispatchMulti _ = JNull'
      ;;
    *)
      string_dispatch='dispatchString _ = JNull'
      int_dispatch='dispatchInt _ = JNull'
      multi_dispatch='dispatchMulti _ = JNull'
      ;;
  esac

  local main_hs
  main_hs=$(mktemp /tmp/regrets_hs_XXXXHS.hs)

  sed \
    -e "s|__MODULE_NAME__|${module_name}|g" \
    -e "s|__STRING_DISPATCH__|${string_dispatch}|g" \
    -e "s|__INT_DISPATCH__|${int_dispatch}|g" \
    -e "s|__MULTI_DISPATCH__|${multi_dispatch}|g" \
    "$INVOKE_TEMPLATE" > "$main_hs"

  echo "$input_json" | "$STACK_BIN" runghc -- -i"$src_dir" "$main_hs" 2>/dev/null
  local exit_code=$?
  rm -f "$main_hs"
  return $exit_code
}

# ─── Parse .regret file ──────────────────────────────────────────────────────
parse_regret() {
  local content="$1"
  # Extract metadata fields
  local cid entry file multi_args
  cid=$(echo "$content" | awk -F': ' '/^cluster: / {print $2; exit}')
  entry=$(echo "$content" | awk -F': ' '/^entry: / {print $2; exit}')
  file=$(echo "$content" | awk -F': ' '/^file: / {print $2; exit}')
  multi_args=$(echo "$content" | awk -F': ' '/^multiArgs: / {print $2; exit}')

  # Extract first INPUT/OUTPUT/HASH
  local first_input first_output first_hash
  first_input=$(echo "$content" | awk '/^INPUT  / {sub("^INPUT  ", ""); print; exit}')
  first_output=$(echo "$content" | awk '/^OUTPUT / {sub("^OUTPUT ", ""); print; exit}')
  first_hash=$(echo "$content" | awk '/^HASH   / {sub("^HASH   ", ""); print; exit}')

  # Extract INPUTS line (if present)
  local inputs_line
  inputs_line=$(echo "$content" | awk '/^INPUTS / {sub("^INPUTS ", ""); print; exit}')

  # Output as JSON for easy parsing
  jq -n \
    --arg cid "$cid" \
    --arg entry "$entry" \
    --arg file "$file" \
    --arg multiArgs "${multi_args:-false}" \
    --arg firstInput "$first_input" \
    --arg firstOutput "$first_output" \
    --arg firstHash "$first_hash" \
    --arg inputsLine "${inputs_line:-}" \
    '{cid: $cid, entry: $entry, file: $file, multiArgs: $multiArgs,
      firstInput: $firstInput, firstOutput: $firstOutput, firstHash: $firstHash,
      inputsLine: $inputsLine}'
}

# ─── Main validation loop ────────────────────────────────────────────────────
[[ $QUIET -eq 0 ]] && echo "🔍 Validating Haskell clusters..."

PASSED=0
FAILED=0

for regret_path in "${REGRET_FILES[@]}"; do
  CID=$(basename "$regret_path" .regret)

  # Apply --cluster filter
  if [[ -n "$CLUSTER_FILTER" && "$CID" != "$CLUSTER_FILTER" ]]; then
    continue
  fi

  content=$(cat "$regret_path")
  parsed=$(parse_regret "$content")

  ENTRY=$(echo "$parsed" | jq -r '.entry')
  FILE=$(echo "$parsed" | jq -r '.file')
  MULTI_ARGS=$(echo "$parsed" | jq -r '.multiArgs')
  FIRST_INPUT=$(echo "$parsed" | jq -r '.firstInput')
  FIRST_HASH=$(echo "$parsed" | jq -r '.firstHash')
  INPUTS_LINE=$(echo "$parsed" | jq -r '.inputsLine')

  if [[ -z "$FIRST_HASH" || "$FIRST_HASH" == "null" ]]; then
    echo "  ❌ $CID — no HASH line in .regret file"
    FAILED=$((FAILED + 1))
    [[ $FAIL_FAST -eq 1 ]] && break
    continue
  fi

  [[ $QUIET -eq 0 ]] && echo "🔍 Validating: $CID"

  # ── Validate first input (INPUT/OUTPUT/HASH) ──────────────────────────────
  LIVE_OUTPUT=$(invoke_haskell "$FILE" "$ENTRY" "$FIRST_INPUT" "$MULTI_ARGS")
  if [[ $? -ne 0 ]]; then
    echo "  ❌ $CID — failed to invoke (first input)"
    FAILED=$((FAILED + 1))
    [[ $FAIL_FAST -eq 1 ]] && break
    continue
  fi

  LIVE_FP=$(fingerprint "$FIRST_INPUT" "$LIVE_OUTPUT")

  if [[ "$LIVE_FP" != "$FIRST_HASH" ]]; then
    echo "  ❌ $CID — golden: $FIRST_HASH, live: $LIVE_FP — FAIL"
    FAILED=$((FAILED + 1))
    [[ $FAIL_FAST -eq 1 ]] && { echo "  --fail-fast: stopping."; break; }
    continue
  fi

  # ── Validate inputs 1+ from INPUTS line (issue #315 parity) ───────────────
  CLUSTER_FAILED=0
  if [[ -n "$INPUTS_LINE" && "$INPUTS_LINE" != "null" && "$INPUTS_LINE" != "[]" ]]; then
    INPUTS_COUNT=$(echo "$INPUTS_LINE" | jq 'length')
    for ((k = 0; k < INPUTS_COUNT; k++)); do
      GOLDEN_INPUT_K=$(echo "$INPUTS_LINE" | jq -c ".[$k].input")
      GOLDEN_HASH_K=$(echo "$INPUTS_LINE" | jq -r ".[$k].hash")

      LIVE_OUTPUT_K=$(invoke_haskell "$FILE" "$ENTRY" "$GOLDEN_INPUT_K" "$MULTI_ARGS")
      if [[ $? -ne 0 ]]; then
        echo "  ❌ $CID — INPUTS[$((k+1))] failed to invoke"
        CLUSTER_FAILED=1
        break
      fi

      LIVE_FP_K=$(fingerprint "$GOLDEN_INPUT_K" "$LIVE_OUTPUT_K")
      if [[ "$LIVE_FP_K" != "$GOLDEN_HASH_K" ]]; then
        echo "  ❌ $CID — INPUTS[$((k+1))] hash mismatch (golden: $GOLDEN_HASH_K, live: $LIVE_FP_K)"
        CLUSTER_FAILED=1
        break
      fi
    done
  fi

  if [[ $CLUSTER_FAILED -ne 0 ]]; then
    FAILED=$((FAILED + 1))
    [[ $FAIL_FAST -eq 1 ]] && { echo "  --fail-fast: stopping."; break; }
    continue
  fi

  N_INPUTS=1
  [[ -n "$INPUTS_LINE" && "$INPUTS_LINE" != "null" && "$INPUTS_LINE" != "[]" ]] && \
    N_INPUTS=$((1 + $(echo "$INPUTS_LINE" | jq 'length')))

  [[ $QUIET -eq 0 ]] && echo "  ✅ $CID — $FIRST_HASH — PASS ($N_INPUTS input$([[ $N_INPUTS -gt 1 ]] && echo 's'))"
  PASSED=$((PASSED + 1))
done

[[ $QUIET -eq 0 ]] && echo ""
[[ $QUIET -eq 0 ]] && echo "Validate: $PASSED passed, $FAILED failed"

[[ $FAILED -gt 0 ]] && exit 1
exit 0

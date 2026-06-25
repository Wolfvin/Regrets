#!/usr/bin/env bash
# capture_haskell.sh — capture regret fingerprints for Haskell clusters
#
# Reads regrets/manifest.json, filters clusters with stack: "haskell",
# invokes each Haskell function with inputs from the manifest, computes
# a 7-char fingerprint (IDENTICAL to JS/Python/Bash/Perl), and writes
# .regret files with the standard format.
#
# Multi-input support (issue #315 parity): processes ALL inputs, writes
# the INPUTS line for inputs 1+. Same contract as capture.js / capture_bash.sh.
#
# Usage:
#   bash scripts/capture_haskell.sh                          # capture all
#   bash scripts/capture_haskell.sh --cluster slugify-fn     # capture one
#   bash scripts/capture_haskell.sh --manifest ./regrets/manifest.json
#   bash scripts/capture_haskell.sh --quiet
#   bash scripts/capture_haskell.sh --verbose
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
VERBOSE=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --cluster)  CLUSTER_FILTER="$2"; shift 2 ;;
    --manifest) MANIFEST="$2"; shift 2 ;;
    --quiet)    QUIET=1; shift ;;
    --verbose)  VERBOSE=1; shift ;;
    *) shift ;;
  esac
done
NODE_MANIFEST="$(node_path "$MANIFEST")"  # recompute after flag parsing (--manifest/--project may have changed MANIFEST)

if [[ ! -f "$MANIFEST" ]]; then
  echo "❌ Manifest not found: $MANIFEST" >&2
  exit 1
fi

mkdir -p "$REGRET_DIR"

# ─── Locate stack ─────────────────────────────────────────────────────────────
STACK_BIN="${STACK_BIN:-}"
if [[ -z "$STACK_BIN" ]]; then
  if command -v stack &> /dev/null; then
    STACK_BIN="stack"
  elif [[ -x /usr/local/bin/stack ]]; then
    STACK_BIN="/usr/local/bin/stack"
  else
    echo "❌ Haskell toolchain (stack) not found. Install: curl -sSL https://get.haskellstack.org/ | sh" >&2
    exit 1
  fi
fi

# ─── Read Haskell clusters ───────────────────────────────────────────────────
read_haskell_clusters() {
  FILTER="$CLUSTER_FILTER" node -e "
    const m = JSON.parse(require('fs').readFileSync('$NODE_MANIFEST', 'utf8'));
    let clusters = m.clusters.filter(c => c.stack === 'haskell');
    const filter = process.env.FILTER || '';
    if (filter) clusters = clusters.filter(c => c.id === filter);
    console.log(JSON.stringify(clusters));
  "
}

CLUSTERS_JSON=$(read_haskell_clusters)
CLUSTER_COUNT=$(echo "$CLUSTERS_JSON" | jq 'length')

if [[ "$CLUSTER_COUNT" -eq 0 ]]; then
  echo "No Haskell clusters found in manifest." >&2
  exit 0
fi

# ─── invoke_haskell: generate Main.hs, run it, capture stdout ─────────────────
# Uses a Haskell template file (scripts/haskell_runner_template.hs) with
# placeholders that are substituted via sed.
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

  # Generate the dispatch lines based on entry name
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
    # These entries exercise patterns NOT covered by the bundled fixture:
    # recursion, guards, list comprehensions, accumulators, tail recursion.
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
  main_hs=$(mktemp /tmp/regrets_hs_XXXXXX.hs)

  # Substitute placeholders in the template using sed
  # We use | as sed delimiter to avoid issues with / in paths
  sed \
    -e "s|__MODULE_NAME__|${module_name}|g" \
    -e "s|__STRING_DISPATCH__|${string_dispatch}|g" \
    -e "s|__INT_DISPATCH__|${int_dispatch}|g" \
    -e "s|__MULTI_DISPATCH__|${multi_dispatch}|g" \
    "$INVOKE_TEMPLATE" > "$main_hs"

  # Run the generated Main.hs
  echo "$input_json" | "$STACK_BIN" runghc -- -i"$src_dir" "$main_hs" 2>/dev/null
  local exit_code=$?
  rm -f "$main_hs"
  return $exit_code
}

[[ $QUIET -eq 0 ]] && echo "📡 Capturing Haskell clusters..." >&2

PASSED=0
FAILED=0
SKIPPED=0

for ((i = 0; i < CLUSTER_COUNT; i++)); do
  CLUSTER=$(echo "$CLUSTERS_JSON" | jq -c ".[$i]")
  CID=$(echo "$CLUSTER" | jq -r '.id')
  ENTRY=$(echo "$CLUSTER" | jq -r '.entry')
  FILE=$(echo "$CLUSTER" | jq -r '.file')
  MULTI_ARGS=$(echo "$CLUSTER" | jq -r '.multiArgs // false')
  INPUTS_JSON=$(echo "$CLUSTER" | jq -c '.inputs // [null]')
  WATCHES=$(echo "$CLUSTER" | jq -r '.watches // [] | join(", ")')

  [[ $QUIET -eq 0 ]] && echo "  📦 Cluster: $CID (entry: $ENTRY)" >&2

  FIRST_INPUT_JSON=""
  FIRST_OUTPUT_JSON=""
  FIRST_FP=""
  EXTRA_INPUTS_JSON="[]"
  INPUT_COUNT=$(echo "$INPUTS_JSON" | jq 'length')

  if [[ "$INPUT_COUNT" -eq 0 ]]; then
    [[ $QUIET -eq 0 ]] && echo "     ❌ No inputs — skipping" >&2
    FAILED=$((FAILED + 1))
    continue
  fi

  CLUSTER_FAILED=0
  for ((j = 0; j < INPUT_COUNT; j++)); do
    INPUT_VALUE_JSON=$(echo "$INPUTS_JSON" | jq -c ".[$j]")

    OUTPUT_VALUE_JSON=$(invoke_haskell "$FILE" "$ENTRY" "$INPUT_VALUE_JSON" "$MULTI_ARGS")
    INVOKE_EXIT=$?

    if [[ $INVOKE_EXIT -ne 0 ]]; then
      [[ $QUIET -eq 0 ]] && echo "     ❌ Failed to invoke (input #$j)" >&2
      CLUSTER_FAILED=1
      break
    fi

    FP=$(fingerprint "$INPUT_VALUE_JSON" "$OUTPUT_VALUE_JSON")

    if [[ $j -eq 0 ]]; then
      FIRST_INPUT_JSON="$INPUT_VALUE_JSON"
      FIRST_OUTPUT_JSON="$OUTPUT_VALUE_JSON"
      FIRST_FP="$FP"
    else
      EXTRA_INPUTS_JSON=$(echo "$EXTRA_INPUTS_JSON" | jq -c \
        ". + [{\"input\": $INPUT_VALUE_JSON, \"output\": $OUTPUT_VALUE_JSON, \"hash\": \"$FP\"}]")
    fi

    [[ $VERBOSE -eq 1 ]] && [[ $QUIET -eq 0 ]] && \
      echo "     │ input[$j]: $INPUT_VALUE_JSON → $OUTPUT_VALUE_JSON (fp: $FP)" >&2
  done

  if [[ $CLUSTER_FAILED -ne 0 ]]; then
    FAILED=$((FAILED + 1))
    continue
  fi

  # Trivial Input Guard (first input only)
  if [[ "$FIRST_OUTPUT_JSON" == "null" || -z "$FIRST_OUTPUT_JSON" ]]; then
    [[ $QUIET -eq 0 ]] && echo "     ⏭️  Skipped: trivial output on first input" >&2
    SKIPPED=$((SKIPPED + 1))
    continue
  fi

  # Write .regret file
  TIMESTAMP=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
  REGRET_PATH="${REGRET_DIR}/${CID}.regret"

  {
    echo "cluster: $CID"
    echo "version: 1"
    echo "fingerprint: $FIRST_FP"
    echo "captured: $TIMESTAMP"
    echo "watches: [$WATCHES]"
    echo "entry: $ENTRY"
    echo "stack: haskell"
    echo "fingerprintLevel: entry"
    echo "file: $FILE"
    [[ "$MULTI_ARGS" == "true" ]] && echo "multiArgs: true"
    echo "---"
    echo "INPUT  $FIRST_INPUT_JSON"
    echo "OUTPUT $FIRST_OUTPUT_JSON"
    echo "HASH   $FIRST_FP"
    [[ "$EXTRA_INPUTS_JSON" != "[]" ]] && echo "INPUTS $EXTRA_INPUTS_JSON"
  } > "$REGRET_PATH"

  N_INPUTS=$INPUT_COUNT
  [[ $QUIET -eq 0 ]] && echo "     ✅ Fingerprint: $FIRST_FP ($N_INPUTS input$([[ $N_INPUTS -gt 1 ]] && echo 's'))" >&2
  [[ $QUIET -eq 0 ]] && echo "     📄 Saved: regrets/$CID.regret" >&2

  PASSED=$((PASSED + 1))
done

[[ $QUIET -eq 0 ]] && echo "" >&2
[[ $QUIET -eq 0 ]] && echo "Capture complete: $PASSED captured, $SKIPPED skipped, $FAILED failed" >&2
[[ $FAILED -gt 0 ]] && exit 1
exit 0

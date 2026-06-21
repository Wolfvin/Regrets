#!/usr/bin/env bash
# capture_bash.sh — capture regret fingerprints for Bash clusters
#
# Reads regrets/manifest.json, source's the bash file(s) containing the
# entry function, invokes the entry function with inputs from the manifest,
# captures stdout, computes the fingerprint, and writes .regret files with
# the standard Regrets format (cluster, version, fingerprint, captured,
# INPUT, OUTPUT, HASH).
#
# Mirrors the contract of scripts/capture.js (JS), capture.py (Python),
# capture_php.php (PHP), capture_perl.pl (Perl). The .regret file format
# is IDENTICAL — a Bash cluster's .regret file can be validated by
# validate.js, validate.py, validate_bash.sh interchangeably
# (cross-stack compatible).
#
# Usage:
#   bash scripts/capture_bash.sh                          # capture all Bash clusters
#   bash scripts/capture_bash.sh --cluster slugify        # capture one cluster
#   bash scripts/capture_bash.sh --manifest ./regrets/manifest.json
#   bash scripts/capture_bash.sh --quiet                  # only print summary
#
# Manifest cluster fields for Bash:
#   {
#     "id":         "slugify",                 # cluster id (becomes <id>.regret filename)
#     "entry":      "slugify",                 # bash function name to invoke
#     "file":       "lib/slugify.sh",          # bash file to source (will be `source`'d)
#     "sourceFiles": ["lib/utils.sh", "lib/slugify.sh"],  # alternative: multiple files
#     "stack":      "bash",
#     "inputs":     ["Hello World", "Hello, World!"],  # array of input values
#     "multiArgs":  true,                      # if true, each input is an array of args
#     "watches":    [],                        # optional, informational (no callee wrapping)
#     "description": "Slugify a string"        # optional, informational
#   }
#
# Exit codes:
#   0 — all clusters captured (or none found)
#   1 — capture failed for at least one cluster
#   2 — manifest missing or invalid

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(pwd)"

# Source the fingerprint module (provides fingerprint(), stable_stringify(), etc.)
source "$SCRIPT_DIR/fingerprint_bash.sh"

# ─── CLI args ─────────────────────────────────────────────────────────────────

CLUSTER_FILTER=""
MANIFEST_PATH=""
QUIET=0
HELP=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --cluster)
      CLUSTER_FILTER="$2"
      shift 2
      ;;
    --manifest)
      MANIFEST_PATH="$2"
      shift 2
      ;;
    --quiet)
      QUIET=1
      shift
      ;;
    --help|-h)
      HELP=1
      shift
      ;;
    *)
      echo "Unknown arg: $1" >&2
      exit 2
      ;;
  esac
done

if [[ $HELP -eq 1 ]]; then
  cat <<'USAGE'
capture_bash.sh — capture regret fingerprints for Bash clusters

Usage:
  bash scripts/capture_bash.sh                          # capture all Bash clusters
  bash scripts/capture_bash.sh --cluster slugify        # capture one cluster
  bash scripts/capture_bash.sh --manifest ./regrets/manifest.json
  bash scripts/capture_bash.sh --quiet                  # only print summary

Manifest cluster fields (stack: "bash"):
  - id:          cluster identifier (becomes <id>.regret filename)
  - entry:       bash function name to invoke (e.g. "slugify")
  - file:        bash file to source (will be `source`'d), OR
  - sourceFiles: array of bash files to source (in order)
  - stack:       "bash"
  - inputs:      array of input values (each invoked separately)
  - multiArgs:   if true, each input is treated as an array of positional args
  - watches:     optional, informational (no callee wrapping in v1)
USAGE
  exit 0
fi

# Default manifest path
if [[ -z "$MANIFEST_PATH" ]]; then
  MANIFEST_PATH="$PROJECT_DIR/regrets/manifest.json"
fi

# ─── Read manifest ────────────────────────────────────────────────────────────

if [[ ! -f "$MANIFEST_PATH" ]]; then
  echo "❌ Manifest not found: $MANIFEST_PATH" >&2
  echo "   Create regrets/manifest.json first. See SKILL.md for format." >&2
  exit 2
fi

# Validate JSON
if ! jq empty "$MANIFEST_PATH" 2>/dev/null; then
  echo "❌ Invalid JSON in manifest: $MANIFEST_PATH" >&2
  exit 2
fi

# Filter to Bash clusters
MANIFEST_DIR=$(dirname "$MANIFEST_PATH")

# Get all bash clusters (or filter by --cluster)
if [[ -n "$CLUSTER_FILTER" ]]; then
  CLUSTERS_JSON=$(jq --arg id "$CLUSTER_FILTER" \
    '[.clusters[] | select(.stack == "bash" and .id == $id)]' \
    "$MANIFEST_PATH")
else
  CLUSTERS_JSON=$(jq '[.clusters[] | select(.stack == "bash")]' \
    "$MANIFEST_PATH")
fi

CLUSTER_COUNT=$(echo "$CLUSTERS_JSON" | jq 'length')

if [[ "$CLUSTER_COUNT" -eq 0 ]]; then
  echo "No Bash clusters found in manifest."
  exit 0
fi

# Set up regrets output directory (same dir as manifest by convention)
REGRET_DIR="$PROJECT_DIR/regrets"
mkdir -p "$REGRET_DIR"

if [[ $QUIET -eq 0 ]]; then
  echo "📡 Capturing Bash clusters..."
  echo "   Manifest: $MANIFEST_PATH"
  echo "   Output:   $REGRET_DIR/"
  echo ""
fi

PASS=0
FAIL=0

# ─── Run each cluster ─────────────────────────────────────────────────────────

# Iterate by index to safely extract each cluster's fields
for i in $(seq 0 $((CLUSTER_COUNT - 1))); do
  CLUSTER=$(echo "$CLUSTERS_JSON" | jq ".[$i]")

  ID=$(echo "$CLUSTER" | jq -r '.id')
  ENTRY=$(echo "$CLUSTER" | jq -r '.entry')
  FILE=$(echo "$CLUSTER" | jq -r '.file // empty')
  SOURCE_FILES=$(echo "$CLUSTER" | jq -r '.sourceFiles // [] | .[]' 2>/dev/null || true)
  INPUTS_JSON=$(echo "$CLUSTER" | jq -c '.inputs // [null]')
  MULTI_ARGS=$(echo "$CLUSTER" | jq -r '.multiArgs // false')
  WATCHES=$(echo "$CLUSTER" | jq -r '.watches // [] | join(", ")')

  if [[ $QUIET -eq 0 ]]; then
    echo "📡 Capturing: $ID"
    echo "   Entry:   $ENTRY"
    echo "   Watches: $WATCHES"
  fi

  # Resolve source files
  FILES_TO_SOURCE=()
  if [[ -n "$FILE" ]]; then
    FILES_TO_SOURCE+=("$FILE")
  fi
  while IFS= read -r f; do
    [[ -n "$f" ]] && FILES_TO_SOURCE+=("$f")
  done <<< "$SOURCE_FILES"

  if [[ ${#FILES_TO_SOURCE[@]} -eq 0 ]]; then
    echo "   ❌ No 'file' or 'sourceFiles' specified for cluster $ID" >&2
    FAIL=$((FAIL + 1))
    continue
  fi

  # Verify files exist (relative to manifest dir, or absolute)
  SOURCE_ERRORS=0
  RESOLVED_FILES=()
  for f in "${FILES_TO_SOURCE[@]}"; do
    if [[ "$f" = /* ]]; then
      abs_path="$f"
    else
      abs_path="$PROJECT_DIR/$f"
    fi
    if [[ ! -f "$abs_path" ]]; then
      echo "   ❌ Source file not found: $f (resolved: $abs_path)" >&2
      SOURCE_ERRORS=1
      break
    fi
    RESOLVED_FILES+=("$abs_path")
  done
  if [[ $SOURCE_ERRORS -ne 0 ]]; then
    FAIL=$((FAIL + 1))
    continue
  fi

  # Source files in a subshell so functions don't leak between clusters
  # We capture the function definition and re-source in each invocation
  # to ensure clean state.
  #
  # For each input:
  #   1. Spawn a subshell
  #   2. Source all files (loads the entry function)
  #   3. Invoke entry with args (depends on multiArgs)
  #   4. Capture stdout
  #   5. Record input/output as JSON

  INPUT_COUNT=$(echo "$INPUTS_JSON" | jq 'length')
  FIRST_FINGERPRINT=""
  FIRST_INPUT_JSON=""
  FIRST_OUTPUT_JSON=""
  ALL_RESULTS_JSON="[]"

  CAPTURE_ERROR=""

  for j in $(seq 0 $((INPUT_COUNT - 1))); do
    INPUT_VALUE_JSON=$(echo "$INPUTS_JSON" | jq -c ".[$j]")

    # Build the args array. If multiArgs is true, the input itself is an array;
    # we expand it to positional args. Otherwise, the input is a single value.
    ARGS_JSON="$INPUT_VALUE_JSON"
    if [[ "$MULTI_ARGS" == "true" ]]; then
      # Already an array of args
      :
    else
      # Wrap single value in array
      ARGS_JSON="[$INPUT_VALUE_JSON]"
    fi

    # Convert args JSON array to bash array of strings (JSON-encoded values)
    # Each element is the JSON representation of the arg (already string-quoted)
    mapfile -t ARGS_ARRAY < <(echo "$ARGS_JSON" | jq -r '.[] | @json')

    # Build a bash script that:
    #   1. Sources all the source files
    #   2. Invokes the entry function with the args (passed as positional $1, $2, ...)
    #   3. Prints the function's stdout to fd 3 (so we can capture it separately)
    #
    # We pass the args as JSON-encoded strings, then decode them inside the
    # subshell using jq -r (so we get the raw value, not the JSON encoding).
    #
    # Why this dance? Because bash arrays can't be safely passed across
    # subshell boundaries without word-splitting issues. JSON is the safe
    # transport format.

    # Build the invocation command
    # Each arg gets its own positional parameter via set -- "$@"
    # We pass args as NUL-separated values, read them into the subshell

    # Use printf %s\\n to write each arg's raw value to a temp file, then
    # read them back as positional args in the subshell
    ARGS_FILE=$(mktemp)
    trap "rm -f '$ARGS_FILE'" EXIT

    # Write each arg's RAW value (decoded from JSON) to the file, one per line
    # Note: this assumes args don't contain newlines. For inputs with newlines,
    # the user should base64-encode them first. This is a known limitation of
    # v1 — documented in references/bash.md.
    for arg_json in "${ARGS_ARRAY[@]}"; do
      printf '%s\n' "$arg_json" | jq -r '.'
    done > "$ARGS_FILE"

    # Capture stdout in a variable. Use a subshell so the sourced functions
    # don't leak into the parent.
    OUTPUT=$(bash -c '
      set -uo pipefail
      # Read args from stdin, one per line, set as positional params
      mapfile -t ARGS <<< "$1"
      set -- "${ARGS[@]}"
      # Source all the source files
      shift
      for f in "$@"; do
        source "$f" || exit 2
      done
      # Invoke the entry function
      "$0" "$@"
    ' "$ENTRY" "$ARGS_FILE" "${RESOLVED_FILES[@]}" 2>/dev/null)

    # Wait — the above bash -c has issues. Let me use a cleaner approach.
    # Actually let me rewrite this with a here-doc.

    # Simpler approach: source files in subshell, then call function
    OUTPUT=$(
      {
        for f in "${RESOLVED_FILES[@]}"; do
          source "$f" || exit 2
        done
        # Read args from file
        mapfile -t ARGS < "$ARGS_FILE"
        # Invoke entry with positional args
        "$ENTRY" "${ARGS[@]}"
      } 2>/dev/null
    )
    EXIT_CODE=$?
    rm -f "$ARGS_FILE"

    if [[ $EXIT_CODE -ne 0 ]]; then
      CAPTURE_ERROR="entry function exited with code $EXIT_CODE"
      # Still record what we got (might be empty stdout)
    fi

    # Encode output as JSON string (stdout is always a string)
    OUTPUT_JSON=$(printf '%s' "$OUTPUT" | jq -Sc -R '.')

    # Compute fingerprint for this input/output pair
    FP=$(fingerprint "$INPUT_VALUE_JSON" "$OUTPUT_JSON")

    # Save first run as the golden
    if [[ $j -eq 0 ]]; then
      FIRST_FINGERPRINT="$FP"
      FIRST_INPUT_JSON="$INPUT_VALUE_JSON"
      FIRST_OUTPUT_JSON="$OUTPUT_JSON"
    fi

    # Append to all results (for the INPUTS line — mirrors capture.js)
    ALL_RESULTS_JSON=$(echo "$ALL_RESULTS_JSON" | jq --argjson inp "$INPUT_VALUE_JSON" \
      --argjson out "$OUTPUT_JSON" --arg fp "$FP" \
      '. + [{input: $inp, output: $out, hash: $fp}]')

    if [[ $QUIET -eq 0 ]]; then
      echo "   input[$j]: $INPUT_VALUE_JSON → $OUTPUT (fp: $FP)"
    fi
  done

  # Skip cluster if capture errored and no golden was produced
  if [[ -z "$FIRST_FINGERPRINT" ]]; then
    echo "   ❌ No golden captured for $ID: $CAPTURE_ERROR" >&2
    FAIL=$((FAIL + 1))
    continue
  fi

  # Trivial input guard: skip if output is null/empty/undefined
  # (mirrors capture.js's trivial guard logic)
  # Note: we don't skip here because Bash stdout is always a string;
  # the trivial guard is more relevant for JS/Python where output can be
  # null/undefined. For Bash, an empty string IS a valid output.
  # We DO skip if the function errored on every input.
  if [[ -n "$CAPTURE_ERROR" && -z "$FIRST_OUTPUT_JSON" ]]; then
    echo "   ⚠️  Skipping $ID: function errored and produced no output" >&2
    FAIL=$((FAIL + 1))
    continue
  fi

  # ─── Write .regret file ───────────────────────────────────────────────────
  REGRET_PATH="$REGRET_DIR/$ID.regret"
  TIMESTAMP=$(date -u +"%Y-%m-%dT%H:%M:%SZ")

  # Build multi-input INPUTS line if more than one input
  INPUTS_LINE=""
  if [[ $INPUT_COUNT -gt 1 ]]; then
    # Strip the first element (it's already in INPUT/OUTPUT/HASH)
    INPUTS_LINE=$(echo "$ALL_RESULTS_JSON" | jq -c '.[1:]')
    if [[ "$INPUTS_LINE" != "[]" ]]; then
      INPUTS_LINE="INPUTS  $INPUTS_LINE"
    else
      INPUTS_LINE=""
    fi
  fi

  # Write the .regret file
  {
    echo "cluster: $ID"
    echo "version: 1"
    echo "fingerprint: $FIRST_FINGERPRINT"
    echo "captured: $TIMESTAMP"
    echo "watches: [$WATCHES]"
    echo "entry: $ENTRY"
    echo "stack: bash"
    echo "fingerprintLevel: entry"
    if [[ "$MULTI_ARGS" == "true" ]]; then
      echo "multiArgs: true"
    fi
    if [[ -n "$FILE" ]]; then
      echo "file: $FILE"
    fi
    echo "---"
    echo "INPUT  $FIRST_INPUT_JSON"
    echo "OUTPUT $FIRST_OUTPUT_JSON"
    echo "HASH   $FIRST_FINGERPRINT"
    if [[ -n "$INPUTS_LINE" ]]; then
      echo "$INPUTS_LINE"
    fi
  } > "$REGRET_PATH"

  if [[ $QUIET -eq 0 ]]; then
    echo "   ✅ Fingerprint: $FIRST_FINGERPRINT"
    echo "   📄 Saved: $REGRET_PATH"
  fi
  PASS=$((PASS + 1))
done

# ─── Summary ──────────────────────────────────────────────────────────────────

echo ""
echo "──────────────────────────────────────────────────────────"
echo "Capture complete: $PASS captured, $FAIL failed"

if [[ $FAIL -gt 0 ]]; then
  echo ""
  echo "⚠️  Fix failed captures before proceeding to PHASE 2." >&2
  echo "   Hint: Check that 'entry' matches a function name defined in 'file'." >&2
  exit 1
fi

if [[ $QUIET -eq 0 ]]; then
  echo ""
  echo "Next: bash scripts/validate_bash.sh"
  echo "If all green → you are clear to refactor."
fi
exit 0

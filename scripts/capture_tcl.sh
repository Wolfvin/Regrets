#!/usr/bin/env bash
# capture_tcl.sh — capture regret fingerprints for Tcl clusters
#
# Reads regrets/manifest.json, filters clusters with stack: "tcl",
# invokes each Tcl proc with inputs from the manifest, computes a 7-char
# fingerprint (IDENTICAL to JS/Python/Bash/Perl/Haskell), and writes
# .regret files with the standard format.
#
# Multi-input support (issue #315 parity): processes ALL inputs, writes
# the INPUTS line for inputs 1+.
#
# Usage:
#   bash scripts/capture_tcl.sh                          # capture all
#   bash scripts/capture_tcl.sh --cluster slugify-fn     # capture one
#   bash scripts/capture_tcl.sh --quiet
#   bash scripts/capture_tcl.sh --verbose
#
# Requires: tclsh + jq + sha256sum + python3

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(pwd)"
MANIFEST="${PROJECT_DIR}/regrets/manifest.json"
REGRET_DIR="${PROJECT_DIR}/regrets"

source "${SCRIPT_DIR}/fingerprint_tcl.sh"

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

if [[ ! -f "$MANIFEST" ]]; then
  echo "❌ Manifest not found: $MANIFEST" >&2
  exit 1
fi

mkdir -p "$REGRET_DIR"

# ─── Locate tclsh ────────────────────────────────────────────────────────────
TCL_BIN="${TCL_BIN:-}"
if [[ -z "$TCL_BIN" ]]; then
  if command -v tclsh &> /dev/null; then
    TCL_BIN="tclsh"
  elif command -v tclsh8.6 &> /dev/null; then
    TCL_BIN="tclsh8.6"
  elif [[ -x /tmp/tcl-install/usr/local/bin/tclsh8.6 ]]; then
    TCL_BIN="/tmp/tcl-install/usr/local/bin/tclsh8.6"
    export LD_LIBRARY_PATH="/tmp/tcl-install/usr/local/lib:${LD_LIBRARY_PATH:-}"
  else
    echo "❌ Tcl interpreter (tclsh) not found." >&2
    exit 1
  fi
fi

# ─── Read Tcl clusters ───────────────────────────────────────────────────────
read_tcl_clusters() {
  FILTER="$CLUSTER_FILTER" node -e "
    const m = JSON.parse(require('fs').readFileSync('$MANIFEST', 'utf8'));
    let clusters = m.clusters.filter(c => c.stack === 'tcl');
    const filter = process.env.FILTER || '';
    if (filter) clusters = clusters.filter(c => c.id === filter);
    console.log(JSON.stringify(clusters));
  "
}

CLUSTERS_JSON=$(read_tcl_clusters)
CLUSTER_COUNT=$(echo "$CLUSTERS_JSON" | jq 'length')

if [[ "$CLUSTER_COUNT" -eq 0 ]]; then
  echo "No Tcl clusters found in manifest." >&2
  exit 0
fi

# ─── invoke_tcl: source the file, call the proc, return JSON output ──────────
# Args: $1 = source file, $2 = entry proc name, $3 = input JSON, $4 = multiArgs
# Stdout: the proc's return value as JSON
invoke_tcl() {
  local src_file="$1"
  local entry="$2"
  local input_json="$3"
  local multi_args="$4"

  local src_abs
  src_abs=$(realpath "$src_file" 2>/dev/null || echo "$PROJECT_DIR/$src_file")

  # Generate a Tcl runner script
  local runner
  runner=$(mktemp /tmp/regrets_tcl_XXXXXX.tcl)

  cat > "$runner" << TCLSCRIPT
# Load the source file
source "$src_abs"

# Read JSON input from stdin
gets stdin input_line

# Invoke the entry proc
set result [$entry \$input_line]

# Output the result
puts \$result
TCLSCRIPT

  # For multiArgs, we need to pass multiple args. Extract array elements.
  if [[ "$multi_args" == "true" ]]; then
    # Extract array elements as separate values
    local args_str
    args_str=$(echo "$input_json" | jq -r '. | map(tostring) | join(" ")')

    # Generate a multi-arg runner
    cat > "$runner" << TCLSCRIPT
# Load the source file
source "$src_abs"

# Invoke the entry proc with multiple args
set result [$entry $args_str]

# Output the result
puts \$result
TCLSCRIPT
  else
    # Single arg: extract the raw value from JSON
    local raw_value
    raw_value=$(echo "$input_json" | jq -r '.')

    cat > "$runner" << TCLSCRIPT
# Load the source file
source "$src_abs"

# Invoke the entry proc
set result [$entry {$raw_value}]

# Output the result
puts \$result
TCLSCRIPT
  fi

  # Run the Tcl runner
  "$TCL_BIN" "$runner" 2>/dev/null
  local exit_code=$?
  rm -f "$runner"
  return $exit_code
}

# ─── JSON-encode a Tcl output value ──────────────────────────────────────────
# Tcl returns everything as strings. We need to determine if the output is a
# number, string, or JSON value, and encode it accordingly.
encode_output() {
  local raw="$1"
  local input_json="$2"

  # Try to determine the type from the input — if input was a string, output
  # is likely a string. If input was a number, output is likely a number.
  # For simplicity: if the raw output is a valid JSON value, use it as-is.
  # Otherwise, JSON-encode it as a string.
  if echo "$raw" | jq -e '.' >/dev/null 2>&1; then
    # Already valid JSON — use as-is (but normalize via jq)
    echo "$raw" | jq -c '.'
  else
    # Not valid JSON — encode as a JSON string
    echo "$raw" | jq -R -c '.'
  fi
}

[[ $QUIET -eq 0 ]] && echo "📡 Capturing Tcl clusters..." >&2

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

    RAW_OUTPUT=$(invoke_tcl "$FILE" "$ENTRY" "$INPUT_VALUE_JSON" "$MULTI_ARGS")
    INVOKE_EXIT=$?

    if [[ $INVOKE_EXIT -ne 0 ]]; then
      [[ $QUIET -eq 0 ]] && echo "     ❌ Failed to invoke (input #$j)" >&2
      CLUSTER_FAILED=1
      break
    fi

    # JSON-encode the output
    OUTPUT_VALUE_JSON=$(encode_output "$RAW_OUTPUT" "$INPUT_VALUE_JSON")

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
    echo "stack: tcl"
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

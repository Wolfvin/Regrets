#!/usr/bin/env bash
# capture_jq.sh — jq stack capture: invoke jq functions and write .regret files
#
# Reads regrets/manifest.json, finds clusters with stack=jq, invokes each
# function with each input via `jq`, computes fingerprint, writes .regret files
# in the standard format.
#
# Usage:
#   bash scripts/capture_jq.sh                           # capture all jq clusters
#   bash scripts/capture_jq.sh --cluster jq-slugify      # capture specific cluster
#   bash scripts/capture_jq.sh --manifest ./regrets/manifest.json
#   bash scripts/capture_jq.sh --quiet
#
# Prerequisites:
#   - jq 1.6+ (jq --version)
#   - sha256sum, python3
#   - .regret files are written to the same directory as the manifest
#
# jq function invocation patterns:
#   Zero-arg function (def funcname: <uses .>):    echo '<input>' | jq -c -L <dir> 'include "<file>"; funcname'
#   Multi-arg function (def funcname(a;b): ...):    echo 'null' | jq -c -L <dir> 'include "<file>"; funcname(<a>;<b>)'
#
# .regret file format (compatible with JS/Python/Bash/Make stacks):
#   cluster: <id>
#   version: 1
#   fingerprint: <7-char hash>
#   captured: <ISO timestamp>
#   entry: <function name>
#   stack: jq
#   file: <path to .jq file>
#   ---
#   INPUT  <json>
#   OUTPUT <json>
#   HASH   <7-char hash>

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/fingerprint_jq.sh"

# ─── Parse CLI args ──────────────────────────────────────────────────────────
CLUSTER_FILTER=""
MANIFEST_PATH="regrets/manifest.json"
QUIET=false

while [[ $# -gt 0 ]]; do
  case "$1" in
    --cluster)
      shift
      CLUSTER_FILTER="$1"
      shift
      ;;
    --manifest)
      shift
      MANIFEST_PATH="$1"
      shift
      ;;
    --quiet)
      QUIET=true
      shift
      ;;
    --help|-h)
      echo "Usage: bash scripts/capture_jq.sh [OPTIONS]"
      echo ""
      echo "Options:"
      echo "  --cluster <id>   Capture only the specified cluster"
      echo "  --manifest <path> Path to manifest.json"
      echo "  --quiet          Only print summary line"
      echo "  --help           Show this help message"
      exit 0
      ;;
    *)
      echo "Unknown option: $1" >&2
      exit 1
      ;;
  esac
done

MANIFEST_FULL="$(cd "$(dirname "$MANIFEST_PATH")" && pwd)/$(basename "$MANIFEST_PATH")"
REGRET_DIR="$(dirname "$MANIFEST_FULL")"

if [[ ! -f "$MANIFEST_FULL" ]]; then
  echo "✗ Manifest not found: $MANIFEST_FULL" >&2
  exit 1
fi

if ! command -v jq &> /dev/null; then
  echo "❌ jq is not installed." >&2
  exit 1
fi

# ─── Get jq clusters ─────────────────────────────────────────────────────────
CLUSTERS=$(list_jq_clusters "$MANIFEST_FULL")
if [[ -z "$CLUSTERS" ]]; then
  echo "No jq clusters found in manifest."
  exit 0
fi

CAPTURED=0
SKIPPED=0

while IFS= read -r cluster_id; do
  # jq.exe (Windows build) emits CRLF line endings on -r text output, so
  # every cluster_id but the last one (command substitution strips only
  # the final trailing newline) carries a trailing \r here, making every
  # subsequent jq lookup keyed on this id silently return empty/null.
  cluster_id="${cluster_id%$'\r'}"
  [[ -z "$cluster_id" ]] && continue

  if [[ -n "$CLUSTER_FILTER" && "$cluster_id" != "$CLUSTER_FILTER" ]]; then
    continue
  fi

  entry=$(read_cluster_field "$MANIFEST_FULL" "$cluster_id" "entry")
  jq_file=$(read_cluster_field "$MANIFEST_FULL" "$cluster_id" "file")
  multi_args=$(read_cluster_field "$MANIFEST_FULL" "$cluster_id" "multiArgs")
  inputs_json=$(get_cluster_inputs "$MANIFEST_FULL" "$cluster_id")

  # Resolve .jq file path relative to manifest dir
  jq_path="${REGRET_DIR}/${jq_file}"
  if [[ ! -f "$jq_path" ]]; then
    echo "✗ ${cluster_id}: jq file not found: ${jq_path}" >&2
    SKIPPED=$((SKIPPED + 1))
    continue
  fi

  # The .jq file's directory is used as the jq module path (-L)
  jq_dir=$(dirname "$jq_path")
  jq_basename=$(basename "$jq_path" .jq)

  # Determine the first input to capture (single .regret per cluster, using first input)
  first_input=$(echo "$inputs_json" | python3 -c "import json,sys; data=json.load(sys.stdin); print(json.dumps(data[0]))")

  # Build the jq program
  if [[ "$multi_args" == "true" ]]; then
    # Multi-arg: input is an array, each element becomes a separate function arg
    # jq uses `;` as the argument separator
    args_str=$(echo "$first_input" | python3 -c "
import json, sys
data = json.load(sys.stdin)
if isinstance(data, list):
    print(';'.join(json.dumps(v) for v in data))
else:
    print(json.dumps(data))
")
    jq_program="include \"${jq_basename}\"; ${entry}(${args_str})"
    # For multi-arg functions, the input to jq is irrelevant (we pass null)
    jq_input='null'
  else
    # Zero-arg function: input is piped via `.`
    jq_program="include \"${jq_basename}\"; ${entry}"
    jq_input="$first_input"
  fi

  # Invoke jq
  output=$(echo "$jq_input" | jq -c "$jq_program" -L "$jq_dir" 2>/dev/null) || {
    echo "✗ ${cluster_id}: jq invocation failed for entry '${entry}'" >&2
    SKIPPED=$((SKIPPED + 1))
    continue
  }

  if [[ -z "$output" ]]; then
    echo "✗ ${cluster_id}: no output captured from jq function '${entry}'" >&2
    SKIPPED=$((SKIPPED + 1))
    continue
  fi

  # Build the input/output JSON for fingerprinting
  input_json="$first_input"
  output_json="$output"

  # Compute fingerprint
  fp=$(fingerprint "$input_json" "$output_json")

  # Build INPUTS line (hash of each input) for multi-input clusters
  inputs_count=$(echo "$inputs_json" | python3 -c "import json,sys; print(len(json.load(sys.stdin)))")
  inputs_line=""
  if [[ "$inputs_count" -gt 1 ]]; then
    inputs_line=$(echo "$inputs_json" | python3 -c "
import json, sys, hashlib
inputs = json.load(sys.stdin)
hashes = []
for inp in inputs:
    s = json.dumps(inp, sort_keys=True, ensure_ascii=False)
    h = hashlib.sha256(s.encode()).hexdigest()
    n = int(h[:16], 16)
    b36 = ''
    while n > 0:
        n, r = divmod(n, 36)
        b36 = '0123456789abcdefghijklmnopqrstuvwxyz'[r] + b36
    hashes.append(b36[:7])
print('INPUTS ' + ' '.join(hashes))
")
  fi

  # Write .regret file
  timestamp=$(format_iso8601)
  regret_path="${REGRET_DIR}/${cluster_id}.regret"

  {
    echo "cluster: ${cluster_id}"
    echo "version: 1"
    echo "fingerprint: ${fp}"
    echo "captured: ${timestamp}"
    echo "entry: ${entry}"
    echo "stack: jq"
    echo "file: ${jq_file}"
    if [[ -n "$inputs_line" ]]; then
      echo "$inputs_line"
    fi
    echo "---"
    echo "INPUT  ${input_json}"
    echo "OUTPUT ${output_json}"
    echo "HASH   ${fp}"
  } > "$regret_path"

  if [[ "$QUIET" == "false" ]]; then
    echo "✓ ${cluster_id}: ${fp} (${inputs_count} input(s))"
  fi
  CAPTURED=$((CAPTURED + 1))

done <<< "$CLUSTERS"

if [[ "$QUIET" == "false" ]]; then
  echo ""
  echo "📡 Captured ${CAPTURED} jq cluster(s), skipped ${SKIPPED}"
fi

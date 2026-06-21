#!/usr/bin/env bash
# capture_bash.sh — capture Bash function fingerprints as .regret files
#
# Reads regrets/manifest.json, filters clusters with stack: "bash",
# invokes each function with inputs from manifest, computes fingerprint
# (sha256 → base36 7-char, IDENTIK with JS/Python/PHP/Perl), writes
# .regret files with the standard format.
#
# Usage:
#   bash scripts/capture_bash.sh                          # capture all bash clusters
#   bash scripts/capture_bash.sh --cluster slugify        # capture specific cluster
#   bash scripts/capture_bash.sh --manifest ./custom.json # custom manifest path
#   bash scripts/capture_bash.sh --quiet                  # only print summary
#   bash scripts/capture_bash.sh --verbose                # print extra detail
#
# .regret file format (IDENTIK with JS/Python implementations):
#   cluster: <cluster-id>
#   version: 1
#   fingerprint: <7-char-hash>
#   captured: <ISO-8601-timestamp>
#   entry: <function-name>
#   stack: bash
#   file: <source-file>
#   fingerprintLevel: entry
#   ---
#   INPUT  <json-value>
#   OUTPUT <raw-string>
#   HASH   <7-char-hash>
#
# Trivial input guard (matches JS implementation):
#   Output empty/null → cluster is SKIPPED (no .regret file written).

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SKILL_DIR="$(dirname "$SCRIPT_DIR")"
PROJECT_DIR="$(pwd)"
MANIFEST="${PROJECT_DIR}/regrets/manifest.json"
REGRET_DIR="${PROJECT_DIR}/regrets"

# Source shared fingerprint module
# shellcheck source=./fingerprint_bash.sh
source "${SCRIPT_DIR}/fingerprint_bash.sh"

# ─── CLI args ────────────────────────────────────────────────────────────────

CLUSTER_FILTER=""
QUIET=0
VERBOSE=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --cluster)
      CLUSTER_FILTER="$2"
      shift 2
      ;;
    --manifest)
      MANIFEST="$2"
      shift 2
      ;;
    --quiet)
      QUIET=1
      shift
      ;;
    --verbose)
      VERBOSE=1
      shift
      ;;
    *)
      shift
      ;;
  esac
done

if [[ ! -f "$MANIFEST" ]]; then
  echo "❌ Manifest not found: $MANIFEST" >&2
  exit 1
fi

mkdir -p "$REGRET_DIR"

# ─── Helper: log ─────────────────────────────────────────────────────────────

log()   { [[ $QUIET -eq 0 ]] && echo "$1"; }
vlog()  { [[ $VERBOSE -eq 1 ]] && echo "  $1" >&2; }
error() { echo "❌ $1" >&2; }

# ─── Main capture loop ───────────────────────────────────────────────────────

# Get all bash clusters: <id>\t<entry>\t<file>\t<multiArgs>\t<inputs_count>
CLUSTERS=$(manifest_list_bash_clusters "$MANIFEST")

if [[ -z "$CLUSTERS" ]]; then
  log "ℹ️  No bash clusters found in manifest"
  exit 0
fi

CAPTURED_COUNT=0
SKIPPED_COUNT=0
FAILED_COUNT=0

while IFS=$'\t' read -r cluster_id entry file multi_args inputs_count; do
  [[ -z "$cluster_id" ]] && continue

  # Apply cluster filter
  if [[ -n "$CLUSTER_FILTER" && "$cluster_id" != "$CLUSTER_FILTER" ]]; then
    continue
  fi

  log ""
  log "📦 Capturing cluster: $cluster_id"

  if [[ -z "$entry" ]]; then
    error "Cluster $cluster_id has no 'entry' field — skipping"
    FAILED_COUNT=$((FAILED_COUNT + 1))
    continue
  fi

  if [[ -z "$file" ]]; then
    error "Cluster $cluster_id has no 'file' field — skipping (bash stack requires 'file' pointing to .sh source)"
    FAILED_COUNT=$((FAILED_COUNT + 1))
    continue
  fi

  # Resolve file path (relative to project dir)
  SOURCE_FILE="${PROJECT_DIR}/${file}"
  if [[ ! -f "$SOURCE_FILE" ]]; then
    error "Source file not found: $SOURCE_FILE"
    FAILED_COUNT=$((FAILED_COUNT + 1))
    continue
  fi

  vlog "  Source: $file"
  vlog "  Entry:  $entry"
  vlog "  Multi-args: $multi_args"
  vlog "  Inputs: $inputs_count"

  # Read inputs as JSON array
  INPUTS_JSON=$(python3 -c '
import json, sys
with open(sys.argv[1]) as f:
    manifest = json.load(f)
cluster_id = sys.argv[2]
cluster = next((c for c in manifest["clusters"] if c["id"] == cluster_id), None)
inputs = cluster.get("inputs", []) if cluster else []
print(json.dumps(inputs))
' "$MANIFEST" "$cluster_id")

  # For single-input case, we write one .regret file per cluster (using first input).
  # This matches the JS pattern where each cluster has one .regret file
  # (the JS implementation captures multiple calls but the .regret file
  # represents the canonical input→output pair).
  #
  # For Bash, we use the FIRST input as the canonical pair.
  # Future enhancement: support multiple .regret files per cluster.

  # Extract first input as JSON
  FIRST_INPUT_JSON=$(python3 -c '
import json, sys
inputs = json.loads(sys.argv[1])
if not inputs:
    sys.exit(1)
print(json.dumps(inputs[0]))
' "$INPUTS_JSON" 2>/dev/null)

  if [[ -z "$FIRST_INPUT_JSON" ]]; then
    error "Cluster $cluster_id has no inputs — skipping"
    SKIPPED_COUNT=$((SKIPPED_COUNT + 1))
    continue
  fi

  vlog "  Input: $FIRST_INPUT_JSON"

  # Build the invocation:
  # - Source the file to load the function
  # - Call the function with the input args
  # - Capture stdout
  #
  # For multiArgs: true, input is an array → each element becomes a positional arg
  # For single arg (default), input is a scalar → passed as $1

  # Build args array via python3 (handles both single and multi-arg cases)
  # Use NUL-separated output to avoid shell-quoting issues with read -a
  mapfile -d '' -t INVOCATION_ARGS < <(python3 -c '
import json, sys
inputs_first = json.loads(sys.argv[1])
multi_args = sys.argv[2] == "true"
if multi_args and isinstance(inputs_first, list):
    args = [str(x) if not isinstance(x, str) else x for x in inputs_first]
else:
    val = inputs_first
    args = [str(val) if not isinstance(val, str) else val]
# Emit each arg NUL-separated (no shell quoting needed)
sys.stdout.write("\0".join(args))
' "$FIRST_INPUT_JSON" "$multi_args")

  # Invoke the function in a clean subshell
  # - Source the file (defines the function)
  # - Call the function with args (quoted to handle spaces/special chars)
  # - Capture stdout (stderr discarded)
  #
  # Build a quoted-args string for the bash -c invocation
  QUOTED_ARGS=""
  for arg in "${INVOCATION_ARGS[@]}"; do
    QUOTED_ARGS+=" $(printf '%q' "$arg")"
  done

  OUTPUT=$(bash -c "
set -euo pipefail
source '$SOURCE_FILE'
'$entry'$QUOTED_ARGS
" 2>/dev/null)
  INVOCATION_EXIT=$?

  if [[ $INVOCATION_EXIT -ne 0 ]]; then
    vlog "  ⚠️  Function exited with code $INVOCATION_EXIT (output may be partial)"
  fi

  vlog "  Output: $OUTPUT"

  # Trivial input guard — skip if output is empty/null
  # (matches JS implementation behavior)
  if [[ -z "$OUTPUT" ]]; then
    log "  ⏭️  Skipping — trivial output (empty)"
    SKIPPED_COUNT=$((SKIPPED_COUNT + 1))
    continue
  fi

  # Compute fingerprint
  HASH=$(fingerprint "$FIRST_INPUT_JSON" "$OUTPUT")

  if [[ -z "$HASH" ]]; then
    error "Failed to compute fingerprint for $cluster_id"
    FAILED_COUNT=$((FAILED_COUNT + 1))
    continue
  fi

  vlog "  Hash: $HASH"

  # Build .regret file content
  TIMESTAMP=$(iso_timestamp)
  REGRET_FILE="${REGRET_DIR}/${cluster_id}.regret"

  {
    echo "cluster: ${cluster_id}"
    echo "version: 1"
    echo "fingerprint: ${HASH}"
    echo "captured: ${TIMESTAMP}"
    echo "entry: ${entry}"
    echo "stack: bash"
    echo "file: ${file}"
    echo "fingerprintLevel: entry"
    echo "---"
    # INPUT line: JSON value (single line, even for arrays)
    printf 'INPUT  %s\n' "$FIRST_INPUT_JSON"
    # OUTPUT line: raw string. If multi-line, only first line is in OUTPUT
    # (matches JS implementation — OUTPUT is single-line).
    # For multi-line output, we use the first line; future enhancement
    # could support multi-line via escape sequences.
    OUTPUT_FIRST_LINE="${OUTPUT%%$'\n'*}"
    printf 'OUTPUT %s\n' "$OUTPUT_FIRST_LINE"
    echo "HASH   ${HASH}"
  } > "$REGRET_FILE"

  log "  ✅ Wrote $REGRET_FILE (hash: $HASH)"
  CAPTURED_COUNT=$((CAPTURED_COUNT + 1))

done <<< "$CLUSTERS"

# ─── Summary ─────────────────────────────────────────────────────────────────

log ""
log "════════════════════════════════════════════════════════════════"
log "  Bash capture complete"
log "════════════════════════════════════════════════════════════════"
log "  Captured: $CAPTURED_COUNT"
log "  Skipped:  $SKIPPED_COUNT"
log "  Failed:   $FAILED_COUNT"
log ""

if [[ $FAILED_COUNT -gt 0 ]]; then
  exit 1
fi
exit 0

#!/usr/bin/env bash
# validate_jq.sh — jq stack validator: re-invoke functions and compare hashes
#
# Reads .regret files, re-invokes jq functions with stored inputs,
# recomputes fingerprints, and reports PASS/FAIL.
#
# Usage:
#   bash scripts/validate_jq.sh                           # validate all jq clusters
#   bash scripts/validate_jq.sh --cluster jq-slugify      # validate specific cluster
#   bash scripts/validate_jq.sh --manifest ./regrets/manifest.json
#   bash scripts/validate_jq.sh --fail-fast               # stop on first failure
#   bash scripts/validate_jq.sh --quiet
#
# Exit codes:
#   0 — all clusters PASS
#   1 — one or more clusters FAIL or missing .regret file

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/fingerprint_jq.sh"

# ─── Parse CLI args ──────────────────────────────────────────────────────────
CLUSTER_FILTER=""
MANIFEST_PATH="regrets/manifest.json"
FAIL_FAST=false
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
    --fail-fast)
      FAIL_FAST=true
      shift
      ;;
    --quiet)
      QUIET=true
      shift
      ;;
    --help|-h)
      echo "Usage: bash scripts/validate_jq.sh [OPTIONS]"
      echo ""
      echo "Options:"
      echo "  --cluster <id>   Validate only the specified cluster"
      echo "  --manifest <path> Path to manifest.json"
      echo "  --fail-fast      Stop on first failure"
      echo "  --quiet          Only print summary"
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

PASSED=0
FAILED=0
SKIPPED=0

while IFS= read -r cluster_id; do
  # jq.exe (Windows build) emits CRLF line endings on -r text output, so
  # every cluster_id but the last one carries a trailing \r here, making
  # every subsequent jq lookup keyed on this id silently return empty/null.
  cluster_id="${cluster_id%$'\r'}"
  [[ -z "$cluster_id" ]] && continue

  if [[ -n "$CLUSTER_FILTER" && "$cluster_id" != "$CLUSTER_FILTER" ]]; then
    continue
  fi

  regret_path="${REGRET_DIR}/${cluster_id}.regret"

  if [[ ! -f "$regret_path" ]]; then
    echo "✗ ${cluster_id}: .regret file not found — run capture first" >&2
    FAILED=$((FAILED + 1))
    if [[ "$FAIL_FAST" == "true" ]]; then break; fi
    continue
  fi

  # Parse .regret file
  golden_hash=""
  golden_input=""
  golden_output=""
  jq_file=""
  entry=""

  in_data=false
  while IFS= read -r line; do
    # Strip trailing \r: git core.autocrlf=true (standard Windows git
    # setting) rewrites .regret files to CRLF on checkout. bash's `read`
    # only splits on \n, so $line keeps a trailing \r, and `[[ "$line" ==
    # "---" ]]` never matches ("---\r" != "---"), breaking separator
    # detection (same root cause/severity as the confirmed Java bug, #522).
    line="${line%$'\r'}"
    if [[ "$line" == "---" ]]; then
      in_data=true
      continue
    fi
    if [[ "$in_data" == "false" ]]; then
      case "$line" in
        fingerprint:*) golden_hash="${line#fingerprint: }" ;;
        entry:*) entry="${line#entry: }" ;;
        file:*) jq_file="${line#file: }" ;;
      esac
    else
      case "$line" in
        INPUT\ *) golden_input="${line#INPUT  }" ;;
        OUTPUT\ *) golden_output="${line#OUTPUT }" ;;
        HASH\ *) golden_hash="${line#HASH   }" ;;
      esac
    fi
  done < "$regret_path"

  # Get manifest fields for re-invocation
  if [[ -z "$entry" ]]; then
    entry=$(read_cluster_field "$MANIFEST_FULL" "$cluster_id" "entry")
  fi
  if [[ -z "$jq_file" ]]; then
    jq_file=$(read_cluster_field "$MANIFEST_FULL" "$cluster_id" "file")
  fi
  multi_args=$(read_cluster_field "$MANIFEST_FULL" "$cluster_id" "multiArgs")

  jq_path="${REGRET_DIR}/${jq_file}"
  if [[ ! -f "$jq_path" ]]; then
    echo "✗ ${cluster_id}: jq file not found: ${jq_path}" >&2
    FAILED=$((FAILED + 1))
    if [[ "$FAIL_FAST" == "true" ]]; then break; fi
    continue
  fi

  jq_dir=$(dirname "$jq_path")
  jq_basename=$(basename "$jq_path" .jq)

  # Re-invoke the function with the stored input
  first_input="$golden_input"

  if [[ "$multi_args" == "true" ]]; then
    args_str=$(echo "$first_input" | python3 -c "
import json, sys
data = json.load(sys.stdin)
if isinstance(data, list):
    print(';'.join(json.dumps(v) for v in data))
else:
    print(json.dumps(data))
")
    jq_program="include \"${jq_basename}\"; ${entry}(${args_str})"
    jq_input='null'
  else
    jq_program="include \"${jq_basename}\"; ${entry}"
    jq_input="$first_input"
  fi

  output=$(echo "$jq_input" | jq -c "$jq_program" -L "$jq_dir" 2>/dev/null) || {
    echo "✗ ${cluster_id}: jq invocation failed for entry '${entry}'" >&2
    FAILED=$((FAILED + 1))
    if [[ "$FAIL_FAST" == "true" ]]; then break; fi
    continue
  }

  if [[ -z "$output" ]]; then
    echo "✗ ${cluster_id}: no output captured from jq function '${entry}'" >&2
    FAILED=$((FAILED + 1))
    if [[ "$FAIL_FAST" == "true" ]]; then break; fi
    continue
  fi

  current_hash=$(fingerprint "$first_input" "$output")

  if [[ "$current_hash" == "$golden_hash" ]]; then
    if [[ "$QUIET" == "false" ]]; then
      echo "✓ ${cluster_id}: PASS (${current_hash})"
    fi
    PASSED=$((PASSED + 1))
  else
    echo "✗ ${cluster_id}: FAIL" >&2
    echo "  Expected hash: ${golden_hash}" >&2
    echo "  Actual hash:   ${current_hash}" >&2
    golden_out_str=$(echo "$golden_output" | python3 -c "import json,sys; print(json.dumps(json.load(sys.stdin)))" 2>/dev/null || echo "$golden_output")
    echo "  Expected output: ${golden_out_str}" >&2
    echo "  Actual output:   ${output}" >&2
    FAILED=$((FAILED + 1))
    if [[ "$FAIL_FAST" == "true" ]]; then break; fi
  fi

done <<< "$CLUSTERS"

if [[ "$QUIET" == "false" ]]; then
  echo ""
  echo "🔍 ${PASSED}/$((PASSED + FAILED + SKIPPED)) jq clusters passed"
fi

exit $([[ $FAILED -gt 0 ]] && echo 1 || echo 0)

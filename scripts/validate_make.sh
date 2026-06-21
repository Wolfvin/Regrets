#!/usr/bin/env bash
# validate_make.sh — Make stack validator: re-invoke functions and compare hashes
#
# Reads .regret files, re-invokes Make functions with stored inputs,
# recomputes fingerprints, and reports PASS/FAIL.
#
# Usage:
#   bash scripts/validate_make.sh                           # validate all Make clusters
#   bash scripts/validate_make.sh --cluster make-slugify    # validate specific cluster
#   bash scripts/validate_make.sh --manifest ./regrets/manifest.json
#   bash scripts/validate_make.sh --fail-fast               # stop on first failure
#   bash scripts/validate_make.sh --quiet
#
# Exit codes:
#   0 — all clusters PASS
#   1 — one or more clusters FAIL or missing .regret file

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/fingerprint_make.sh"

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
      echo "Usage: bash scripts/validate_make.sh [OPTIONS]"
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

if ! command -v make &> /dev/null; then
  echo "❌ GNU Make is not installed." >&2
  exit 1
fi

# ─── Get Make clusters ──────────────────────────────────────────────────────
CLUSTERS=$(list_make_clusters "$MANIFEST_FULL")
if [[ -z "$CLUSTERS" ]]; then
  echo "No Make clusters found in manifest."
  exit 0
fi

PASSED=0
FAILED=0
SKIPPED=0

while IFS= read -r cluster_id; do
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
  mk_file=""
  entry=""
  has_inputs_line=false

  # Read meta section (before ---) and data section (after ---)
  in_data=false
  while IFS= read -r line; do
    if [[ "$line" == "---" ]]; then
      in_data=true
      continue
    fi
    if [[ "$in_data" == "false" ]]; then
      # Meta section
      case "$line" in
        fingerprint:*) golden_hash="${line#fingerprint: }" ;;
        entry:*) entry="${line#entry: }" ;;
        file:*) mk_file="${line#file: }" ;;
        INPUTS:*) has_inputs_line=true ;;
      esac
    else
      # Data section
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
  if [[ -z "$mk_file" ]]; then
    mk_file=$(read_cluster_field "$MANIFEST_FULL" "$cluster_id" "file")
  fi
  multi_args=$(read_cluster_field "$MANIFEST_FULL" "$cluster_id" "multiArgs")

  mk_path="${REGRET_DIR}/${mk_file}"
  if [[ ! -f "$mk_path" ]]; then
    echo "✗ ${cluster_id}: Make file not found: ${mk_path}" >&2
    FAILED=$((FAILED + 1))
    if [[ "$FAIL_FAST" == "true" ]]; then break; fi
    continue
  fi

  # Re-invoke the function with the stored input
  first_input="$golden_input"

  if [[ "$multi_args" == "true" ]]; then
    call_args=$(echo "$first_input" | python3 -c "
import json, sys
data = json.load(sys.stdin)
if isinstance(data, list):
    print(','.join(str(v) for v in data))
else:
    print(str(data))
")
  else
    call_args=$(echo "$first_input" | python3 -c "
import json, sys
data = json.load(sys.stdin)
if isinstance(data, str):
    print(data)
else:
    print(json.dumps(data))
")
  fi

  tmp_mk=$(mktemp)
  cat > "$tmp_mk" << EOF
include ${mk_path}
\$(error \$(call ${entry},${call_args}))
EOF

  output_raw=$(make -f "$tmp_mk" 2>&1 1>/dev/null || true)
  rm -f "$tmp_mk"

  output=$(echo "$output_raw" | sed -n 's/.*\*\*\* \(.*\)\. *Stop\.$/\1/p' | head -1)

  if [[ -z "$output" ]]; then
    echo "✗ ${cluster_id}: no output captured from \$(call ${entry})" >&2
    FAILED=$((FAILED + 1))
    if [[ "$FAIL_FAST" == "true" ]]; then break; fi
    continue
  fi

  output_json=$(python3 -c "import json,sys; print(json.dumps(sys.argv[1]))" "$output")
  current_hash=$(fingerprint "$first_input" "$output_json")

  if [[ "$current_hash" == "$golden_hash" ]]; then
    if [[ "$QUIET" == "false" ]]; then
      echo "✓ ${cluster_id}: PASS (${current_hash})"
    fi
    PASSED=$((PASSED + 1))
  else
    echo "✗ ${cluster_id}: FAIL" >&2
    echo "  Expected hash: ${golden_hash}" >&2
    echo "  Actual hash:   ${current_hash}" >&2
    # Parse golden output for diff
    golden_out_str=$(echo "$golden_output" | python3 -c "import json,sys; print(json.load(sys.stdin))" 2>/dev/null || echo "$golden_output")
    echo "  Expected output: ${golden_out_str}" >&2
    echo "  Actual output:   ${output}" >&2
    FAILED=$((FAILED + 1))
    if [[ "$FAIL_FAST" == "true" ]]; then break; fi
  fi

done <<< "$CLUSTERS"

if [[ "$QUIET" == "false" ]]; then
  echo ""
  echo "🔍 ${PASSED}/$((PASSED + FAILED + SKIPPED)) Make clusters passed"
fi

exit $([[ $FAILED -gt 0 ]] && echo 1 || echo 0)

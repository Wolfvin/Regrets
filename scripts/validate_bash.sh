#!/usr/bin/env bash
# validate_bash.sh — validate regret fingerprints for Bash clusters
#
# Reads .regret files from regrets/, re-source's the bash file(s), re-invokes
# the entry function with the stored INPUT, recomputes the fingerprint, and
# compares against the stored HASH. Reports PASS or FAIL per cluster.
#
# Mirrors the contract of scripts/validate.js (JS), validate.py (Python),
# validate_php.php (PHP), validate_perl.pl (Perl). Can validate .regret files
# created by capture_bash.sh AND by capture.js / capture.py (cross-stack
# compatible — only the fingerprint algorithm matters).
#
# Usage:
#   bash scripts/validate_bash.sh                          # validate all .regret files
#   bash scripts/validate_bash.sh --cluster slugify        # validate one
#   bash scripts/validate_bash.sh --manifest ./regrets/manifest.json
#   bash scripts/validate_bash.sh --quiet                  # only print failures
#   bash scripts/validate_bash.sh --fail-fast              # exit on first FAIL
#
# Exit code: 0 if all validated, 1 if any FAILed.

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(pwd)"

# Source the fingerprint module
source "$SCRIPT_DIR/fingerprint_bash.sh"

# ─── CLI args ─────────────────────────────────────────────────────────────────

CLUSTER_FILTER=""
MANIFEST_PATH=""
QUIET=0
FAIL_FAST=0
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
    --fail-fast)
      FAIL_FAST=1
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
validate_bash.sh — validate regret fingerprints for Bash clusters

Usage:
  bash scripts/validate_bash.sh                          # validate all .regret files
  bash scripts/validate_bash.sh --cluster slugify        # validate one
  bash scripts/validate_bash.sh --manifest ./regrets/manifest.json
  bash scripts/validate_bash.sh --quiet                  # only print failures
  bash scripts/validate_bash.sh --fail-fast              # exit on first FAIL

Exit code: 0 if all validated, 1 if any FAILed.
USAGE
  exit 0
fi

# Default manifest path
if [[ -z "$MANIFEST_PATH" ]]; then
  MANIFEST_PATH="$PROJECT_DIR/regrets/manifest.json"
fi

if [[ ! -f "$MANIFEST_PATH" ]]; then
  echo "❌ Manifest not found: $MANIFEST_PATH" >&2
  exit 2
fi

if ! jq empty "$MANIFEST_PATH" 2>/dev/null; then
  echo "❌ Invalid JSON in manifest: $MANIFEST_PATH" >&2
  exit 2
fi

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

REGRET_DIR="$PROJECT_DIR/regrets"

if [[ $QUIET -eq 0 ]]; then
  echo "🔍 Validating Bash clusters..."
  echo "   Manifest: $MANIFEST_PATH"
  echo ""
fi

PASS=0
FAIL=0
FAILED_CLUSTERS=()

# ─── Validate each cluster ────────────────────────────────────────────────────

for i in $(seq 0 $((CLUSTER_COUNT - 1))); do
  CLUSTER=$(echo "$CLUSTERS_JSON" | jq ".[$i]")

  ID=$(echo "$CLUSTER" | jq -r '.id')
  ENTRY=$(echo "$CLUSTER" | jq -r '.entry')
  FILE=$(echo "$CLUSTER" | jq -r '.file // empty')
  SOURCE_FILES=$(echo "$CLUSTER" | jq -r '.sourceFiles // [] | .[]' 2>/dev/null || true)
  MULTI_ARGS=$(echo "$CLUSTER" | jq -r '.multiArgs // false')

  REGRET_PATH="$REGRET_DIR/$ID.regret"

  if [[ ! -f "$REGRET_PATH" ]]; then
    echo "❌ Missing .regret file for cluster $ID: $REGRET_PATH" >&2
    FAIL=$((FAIL + 1))
    FAILED_CLUSTERS+=("$ID (no .regret file)")
    if [[ $FAIL_FAST -eq 1 ]]; then exit 1; fi
    continue
  fi

  if [[ $QUIET -eq 0 ]]; then
    echo "🔍 Validating: $ID"
  fi

  # Parse the .regret file
  GOLDEN_INPUT=$(parse_regret_data_field "$REGRET_PATH" "INPUT")
  GOLDEN_OUTPUT=$(parse_regret_data_field "$REGRET_PATH" "OUTPUT")
  GOLDEN_HASH=$(parse_regret_data_field "$REGRET_PATH" "HASH")

  # Parse INPUTS line (multi-input contract) if present
  GOLDEN_INPUTS_LINE=$(awk '/^INPUTS  / { sub("^INPUTS  ", ""); print; exit }' "$REGRET_PATH")

  if [[ -z "$GOLDEN_HASH" ]]; then
    echo "❌ $ID: missing HASH line in .regret file" >&2
    FAIL=$((FAIL + 1))
    FAILED_CLUSTERS+=("$ID (no HASH)")
    if [[ $FAIL_FAST -eq 1 ]]; then exit 1; fi
    continue
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
    echo "❌ $ID: no 'file' or 'sourceFiles' specified" >&2
    FAIL=$((FAIL + 1))
    FAILED_CLUSTERS+=("$ID (no source files)")
    if [[ $FAIL_FAST -eq 1 ]]; then exit 1; fi
    continue
  fi

  # Resolve paths (relative to project dir)
  RESOLVED_FILES=()
  for f in "${FILES_TO_SOURCE[@]}"; do
    if [[ "$f" = /* ]]; then
      abs_path="$f"
    else
      abs_path="$PROJECT_DIR/$f"
    fi
    if [[ ! -f "$abs_path" ]]; then
      echo "❌ $ID: source file not found: $f" >&2
      FAIL=$((FAIL + 1))
      FAILED_CLUSTERS+=("$ID (missing source: $f)")
      if [[ $FAIL_FAST -eq 1 ]]; then exit 1; fi
      continue 2
    fi
    RESOLVED_FILES+=("$abs_path")
  done

  # ─── Re-run entry with golden input ──────────────────────────────────────
  invoke_entry() {
    local input_json="$1"
    # Build args array
    if [[ "$MULTI_ARGS" == "true" ]]; then
      ARGS_JSON="$input_json"
    else
      ARGS_JSON="[$input_json]"
    fi

    # Write args to a temp file (one per line, decoded from JSON)
    local args_file
    args_file=$(mktemp)
    echo "$ARGS_JSON" | jq -r '.[]' > "$args_file"

    # Source files in subshell, then call function with positional args
    local output
    output=$(
      {
        for f in "${RESOLVED_FILES[@]}"; do
          source "$f" || exit 2
        done
        mapfile -t ARGS < "$args_file"
        "$ENTRY" "${ARGS[@]}"
      } 2>/dev/null
    )
    rm -f "$args_file"
    printf '%s' "$output"
  }

  # Re-run with first input (the golden)
  LIVE_OUTPUT=$(invoke_entry "$GOLDEN_INPUT")
  LIVE_OUTPUT_JSON=$(printf '%s' "$LIVE_OUTPUT" | jq -Sc -R '.')
  LIVE_HASH=$(fingerprint "$GOLDEN_INPUT" "$LIVE_OUTPUT_JSON")

  # Compare primary hash
  if [[ "$LIVE_HASH" != "$GOLDEN_HASH" ]]; then
    echo "❌ $ID: HASH mismatch"
    echo "   golden: $GOLDEN_HASH"
    echo "   live:   $LIVE_HASH"
    echo "   INPUT:  $GOLDEN_INPUT"
    echo "   golden OUTPUT: $GOLDEN_OUTPUT"
    echo "   live OUTPUT:   $LIVE_OUTPUT_JSON"
    FAIL=$((FAIL + 1))
    FAILED_CLUSTERS+=("$ID (hash mismatch)")
    if [[ $FAIL_FAST -eq 1 ]]; then exit 1; fi
    continue
  fi

  # ─── Multi-input validation (INPUTS line) ────────────────────────────────
  # If the .regret file has an INPUTS line, re-validate each saved input
  MULTI_INPUT_FAIL=0
  if [[ -n "$GOLDEN_INPUTS_LINE" && "$GOLDEN_INPUTS_LINE" != "[]" ]]; then
    INPUTS_COUNT=$(echo "$GOLDEN_INPUTS_LINE" | jq 'length')
    for k in $(seq 0 $((INPUTS_COUNT - 1))); do
      GOLDEN_INPUT_K=$(echo "$GOLDEN_INPUTS_LINE" | jq -c ".[$k].input")
      GOLDEN_HASH_K=$(echo "$GOLDEN_INPUTS_LINE" | jq -r ".[$k].hash")

      LIVE_OUTPUT_K=$(invoke_entry "$GOLDEN_INPUT_K")
      LIVE_OUTPUT_K_JSON=$(printf '%s' "$LIVE_OUTPUT_K" | jq -Sc -R '.')
      LIVE_HASH_K=$(fingerprint "$GOLDEN_INPUT_K" "$LIVE_OUTPUT_K_JSON")

      if [[ "$LIVE_HASH_K" != "$GOLDEN_HASH_K" ]]; then
        echo "❌ $ID: INPUTS[$((k+1))] hash mismatch"
        echo "   golden: $GOLDEN_HASH_K"
        echo "   live:   $LIVE_HASH_K"
        echo "   INPUT:  $GOLDEN_INPUT_K"
        MULTI_INPUT_FAIL=1
        break
      fi
    done
  fi

  if [[ $MULTI_INPUT_FAIL -ne 0 ]]; then
    FAIL=$((FAIL + 1))
    FAILED_CLUSTERS+=("$ID (multi-input mismatch)")
    if [[ $FAIL_FAST -eq 1 ]]; then exit 1; fi
    continue
  fi

  if [[ $QUIET -eq 0 ]]; then
    echo "   ✅ PASS  $ID  (hash: $LIVE_HASH)"
  else
    echo "✅ $ID"
  fi
  PASS=$((PASS + 1))
done

# ─── Summary ──────────────────────────────────────────────────────────────────

echo ""
echo "──────────────────────────────────────────────────────────"
echo "Validate: $PASS passed, $FAIL failed"

if [[ $FAIL -gt 0 ]]; then
  echo ""
  echo "Failed clusters:"
  for c in "${FAILED_CLUSTERS[@]}"; do
    echo "  - $c"
  done
  exit 1
fi

if [[ $QUIET -eq 0 ]]; then
  echo ""
  echo "✅ All Bash clusters validated. You are clear to refactor."
fi
exit 0

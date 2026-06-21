#!/usr/bin/env bash
# validate_bash.sh — validate Bash function fingerprints against .regret files
#
# Reads .regret files, re-invokes the bash function with the recorded INPUT,
# compares the new fingerprint with the stored HASH, reports PASS/FAIL.
#
# Usage:
#   bash scripts/validate_bash.sh                          # validate all bash clusters
#   bash scripts/validate_bash.sh --cluster slugify        # validate specific cluster
#   bash scripts/validate_bash.sh --fail-fast              # exit on first failure
#   bash scripts/validate_bash.sh --manifest ./custom.json # custom manifest path
#   bash scripts/validate_bash.sh --update slugify --reason "algorithm changed"
#   bash scripts/validate_bash.sh --quiet                  # only print summary
#   bash scripts/validate_bash.sh --verbose                # print extra detail
#
# Exit codes:
#   0 — all clusters PASS
#   1 — one or more clusters FAIL (or validation error)

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
FAIL_FAST=0
QUIET=0
VERBOSE=0
UPDATE_TARGET=""
UPDATE_REASON=""

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
    --fail-fast)
      FAIL_FAST=1
      shift
      ;;
    --quiet)
      QUIET=1
      shift
      ;;
    --verbose)
      VERBOSE=1
      shift
      ;;
    --update)
      UPDATE_TARGET="$2"
      shift 2
      ;;
    --reason)
      UPDATE_REASON="$2"
      shift 2
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

# ─── Helper: log ─────────────────────────────────────────────────────────────

log()   { [[ $QUIET -eq 0 ]] && echo "$1"; }
vlog()  { [[ $VERBOSE -eq 1 ]] && echo "  $1" >&2; }
error() { echo "❌ $1" >&2; }

# ─── Update mode ─────────────────────────────────────────────────────────────
# `regret update <id> --reason "..."` → re-capture the .regret file with current code,
# write audit.log entry, exit 0 (no validation comparison).
if [[ -n "$UPDATE_TARGET" ]]; then
  log "🔄 Update mode: re-capturing $UPDATE_TARGET"
  log "   Reason: ${UPDATE_REASON:-<no reason provided>}"

  # Re-run capture for the specific cluster
  if ! bash "${SCRIPT_DIR}/capture_bash.sh" --cluster "$UPDATE_TARGET" --manifest "$MANIFEST" $([[ $QUIET -eq 1 ]] && echo --quiet) $([[ $VERBOSE -eq 1 ]] && echo --verbose); then
    error "Re-capture failed for $UPDATE_TARGET"
    exit 1
  fi

  # Append to audit.log (matches JS implementation pattern)
  AUDIT_LOG="${REGRET_DIR}/audit.log"
  TIMESTAMP=$(iso_timestamp)
  GIT_AUTHOR=$(git config user.name 2>/dev/null || echo "unknown")
  GIT_SHA=$(git rev-parse --short HEAD 2>/dev/null || echo "no-git")

  {
    echo "[${TIMESTAMP}] UPDATE cluster=${UPDATE_TARGET} reason=\"${UPDATE_REASON}\" author=${GIT_AUTHOR} sha=${GIT_SHA}"
  } >> "$AUDIT_LOG"

  log "  ✅ Updated $UPDATE_TARGET — audit logged"
  exit 0
fi

# ─── Validate mode ───────────────────────────────────────────────────────────

# Get all bash clusters
CLUSTERS=$(manifest_list_bash_clusters "$MANIFEST")

if [[ -z "$CLUSTERS" ]]; then
  log "ℹ️  No bash clusters found in manifest"
  exit 0
fi

PASS_COUNT=0
FAIL_COUNT=0
SKIP_COUNT=0

while IFS=$'\t' read -r cluster_id entry file multi_args inputs_count; do
  [[ -z "$cluster_id" ]] && continue

  # Apply cluster filter
  if [[ -n "$CLUSTER_FILTER" && "$cluster_id" != "$CLUSTER_FILTER" ]]; then
    continue
  fi

  log ""
  log "🔍 Validating cluster: $cluster_id"

  REGRET_FILE="${REGRET_DIR}/${cluster_id}.regret"

  if [[ ! -f "$REGRET_FILE" ]]; then
    error "Missing .regret file: $REGRET_FILE"
    error "  Run: bash scripts/capture_bash.sh --cluster $cluster_id"
    FAIL_COUNT=$((FAIL_COUNT + 1))
    if [[ $FAIL_FAST -eq 1 ]]; then
      log ""
      log "❌ FAIL-FAST: stopping on first failure"
      log ""
      log "════════════════════════════════════════════════════════════════"
      log "  Bash validate: FAIL (fail-fast)"
      log "  Pass: $PASS_COUNT  Fail: $FAIL_COUNT  Skip: $SKIP_COUNT"
      log "════════════════════════════════════════════════════════════════"
      exit 1
    fi
    continue
  fi

  # Parse .regret file: extract cluster, entry, file, INPUT, OUTPUT, HASH
  # Format:
  #   cluster: <id>
  #   version: 1
  #   fingerprint: <hash>
  #   captured: <ts>
  #   entry: <name>
  #   stack: bash
  #   file: <path>
  #   fingerprintLevel: entry
  #   ---
  #   INPUT  <json>
  #   OUTPUT <raw>
  #   HASH   <hash>

  STORED_CLUSTER=""
  STORED_ENTRY=""
  STORED_FILE=""
  STORED_INPUT=""
  STORED_OUTPUT=""
  STORED_HASH=""
  IN_BODY=0

  while IFS= read -r line; do
    if [[ "$line" == "---" ]]; then
      IN_BODY=1
      continue
    fi
    if [[ $IN_BODY -eq 0 ]]; then
      # Header section — match "key: value" pattern
      if [[ "$line" =~ ^cluster:(.*)$ ]]; then
        STORED_CLUSTER="${BASH_REMATCH[1]# }"  # strip leading space
      elif [[ "$line" =~ ^entry:(.*)$ ]]; then
        STORED_ENTRY="${BASH_REMATCH[1]# }"
      elif [[ "$line" =~ ^file:(.*)$ ]]; then
        STORED_FILE="${BASH_REMATCH[1]# }"
      elif [[ "$line" =~ ^fingerprint:(.*)$ ]]; then
        STORED_HASH="${BASH_REMATCH[1]# }"
      fi
    else
      # Body section — match "KEY <value>" pattern (KEY + spaces + value)
      if [[ "$line" =~ ^INPUT[[:space:]]+(.*)$ ]]; then
        STORED_INPUT="${BASH_REMATCH[1]}"
      elif [[ "$line" =~ ^OUTPUT[[:space:]]+(.*)$ ]]; then
        STORED_OUTPUT="${BASH_REMATCH[1]}"
      elif [[ "$line" =~ ^HASH[[:space:]]+(.*)$ ]]; then
        STORED_HASH="${BASH_REMATCH[1]}"
      fi
    fi
  done < "$REGRET_FILE"

  vlog "  Stored entry:  $STORED_ENTRY"
  vlog "  Stored file:   $STORED_FILE"
  vlog "  Stored input:  $STORED_INPUT"
  vlog "  Stored output: $STORED_OUTPUT"
  vlog "  Stored hash:   $STORED_HASH"

  # Resolve source file (relative to project dir)
  SOURCE_FILE="${PROJECT_DIR}/${STORED_FILE}"
  if [[ ! -f "$SOURCE_FILE" ]]; then
    error "Source file not found: $SOURCE_FILE"
    FAIL_COUNT=$((FAIL_COUNT + 1))
    if [[ $FAIL_FAST -eq 1 ]]; then
      log ""
      log "❌ FAIL-FAST: stopping on first failure"
      exit 1
    fi
    continue
  fi

  # Build invocation args from stored INPUT
  # Use NUL-separated output to avoid shell-quoting issues
  mapfile -d '' -t INVOCATION_ARGS < <(python3 -c '
import json, sys
input_json = sys.argv[1]
multi_args = sys.argv[2] == "true"
val = json.loads(input_json)
if multi_args and isinstance(val, list):
    args = [str(x) if not isinstance(x, str) else x for x in val]
else:
    args = [str(val) if not isinstance(val, str) else val]
sys.stdout.write("\0".join(args))
' "$STORED_INPUT" "$multi_args")

  # Build a quoted-args string for the bash -c invocation
  QUOTED_ARGS=""
  for arg in "${INVOCATION_ARGS[@]}"; do
    QUOTED_ARGS+=" $(printf '%q' "$arg")"
  done

  # Re-invoke the function
  FRESH_OUTPUT=$(bash -c "
set -euo pipefail
source '$SOURCE_FILE'
'$STORED_ENTRY'$QUOTED_ARGS
" 2>/dev/null)
  INVOCATION_EXIT=$?

  if [[ $INVOCATION_EXIT -ne 0 ]]; then
    vlog "  ⚠️  Function exited with code $INVOCATION_EXIT"
  fi

  vlog "  Fresh output: $FRESH_OUTPUT"

  # Trivial guard — empty output should not match a non-empty stored output
  if [[ -z "$FRESH_OUTPUT" && -n "$STORED_OUTPUT" ]]; then
    log "  ❌ FAIL — function returned empty output, expected non-empty"
    FAIL_COUNT=$((FAIL_COUNT + 1))
    if [[ $FAIL_FAST -eq 1 ]]; then
      log ""
      log "❌ FAIL-FAST: stopping on first failure"
      log ""
      log "════════════════════════════════════════════════════════════════"
      log "  Bash validate: FAIL (fail-fast)"
      log "  Pass: $PASS_COUNT  Fail: $FAIL_COUNT  Skip: $SKIP_COUNT"
      log "════════════════════════════════════════════════════════════════"
      exit 1
    fi
    continue
  fi

  # Take first line of fresh output (matches capture behavior)
  FRESH_OUTPUT_FIRST_LINE="${FRESH_OUTPUT%%$'\n'*}"

  # Compute fresh fingerprint
  FRESH_HASH=$(fingerprint "$STORED_INPUT" "$FRESH_OUTPUT_FIRST_LINE")

  vlog "  Fresh hash:   $FRESH_HASH"

  # Compare
  if [[ "$FRESH_HASH" == "$STORED_HASH" ]]; then
    log "  ✅ PASS — hash match ($STORED_HASH)"
    PASS_COUNT=$((PASS_COUNT + 1))
  else
    log "  ❌ FAIL — hash mismatch"
    log "     Stored:  $STORED_HASH"
    log "     Fresh:   $FRESH_HASH"
    log "     Input:   $STORED_INPUT"
    log "     Stored output: $STORED_OUTPUT"
    log "     Fresh output:  $FRESH_OUTPUT_FIRST_LINE"
    FAIL_COUNT=$((FAIL_COUNT + 1))
    if [[ $FAIL_FAST -eq 1 ]]; then
      log ""
      log "❌ FAIL-FAST: stopping on first failure"
      log ""
      log "════════════════════════════════════════════════════════════════"
      log "  Bash validate: FAIL (fail-fast)"
      log "  Pass: $PASS_COUNT  Fail: $FAIL_COUNT  Skip: $SKIP_COUNT"
      log "════════════════════════════════════════════════════════════════"
      exit 1
    fi
  fi

done <<< "$CLUSTERS"

# ─── Summary ─────────────────────────────────────────────────────────────────

log ""
log "════════════════════════════════════════════════════════════════"
log "  Bash validate complete"
log "════════════════════════════════════════════════════════════════"
log "  Pass: $PASS_COUNT"
log "  Fail: $FAIL_COUNT"
log "  Skip: $SKIP_COUNT"
log ""

if [[ $FAIL_COUNT -gt 0 ]]; then
  exit 1
fi
exit 0

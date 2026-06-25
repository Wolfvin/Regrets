#!/usr/bin/env bash
# validate_tcl.sh — validate Tcl function fingerprints against .regret files
#
# Reads .regret files, re-invokes the Tcl proc with the recorded INPUT,
# compares the new fingerprint with the stored HASH, reports PASS/FAIL.
#
# Multi-input support (issue #315 parity): validates ALL inputs from the
# INPUTS line, not just the first.
#
# Usage:
#   bash scripts/validate_tcl.sh                          # validate all
#   bash scripts/validate_tcl.sh --cluster slugify-fn     # validate one
#   bash scripts/validate_tcl.sh --quiet
#   bash scripts/validate_tcl.sh --fail-fast
#   bash scripts/validate_tcl.sh --update <id> --reason "..."
#
# Exit code: 0 if all PASSed, 1 if any FAILed.

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(pwd)"
MANIFEST="${PROJECT_DIR}/regrets/manifest.json"
REGRET_DIR="${PROJECT_DIR}/regrets"

# tclsh (MSYS2/MinGW build) and node.exe (native Windows) do not resolve
# Git Bash's POSIX path mapping (/c/Users/..., /tmp/...) — both fail to open
# files at paths bash itself resolves fine. Convert via cygpath when
# available (Git Bash / MSYS2 / Cygwin) for any path handed to either.
# No-op on Linux/Mac. See issue #519.
node_path() {
  if command -v cygpath &> /dev/null; then
    cygpath -m "$1"
  else
    echo "$1"
  fi
}
NODE_MANIFEST="$(node_path "$MANIFEST")"

source "${SCRIPT_DIR}/fingerprint_tcl.sh"

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

# ─── --update mode ───────────────────────────────────────────────────────────
if [[ -n "$UPDATE_TARGET" ]]; then
  if [[ -z "$UPDATE_REASON" || $(echo "$UPDATE_REASON" | wc -w) -lt 4 ]]; then
    echo "❌ --update requires --reason with at least 4 words" >&2
    exit 1
  fi
  [[ $QUIET -eq 0 ]] && echo "🔄 Update mode — re-capturing cluster '$UPDATE_TARGET'..." >&2
  bash "${SCRIPT_DIR}/capture_tcl.sh" --cluster "$UPDATE_TARGET" ${QUIET:+--quiet} >&2
  [[ $QUIET -eq 0 ]] && echo "✅ Re-captured '$UPDATE_TARGET' — golden .regret updated." >&2
  exit 0
fi

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

# ─── invoke_tcl (same as capture_tcl.sh) ─────────────────────────────────────
invoke_tcl() {
  local src_file="$1"
  local entry="$2"
  local input_json="$3"
  local multi_args="$4"

  local src_abs
  src_abs=$(realpath "$src_file" 2>/dev/null || echo "$PROJECT_DIR/$src_file")
  src_abs="$(node_path "$src_abs")"

  local runner
  runner=$(mktemp /tmp/regrets_tcl_XXXXXX.tcl)

  if [[ "$multi_args" == "true" ]]; then
    local args_str
    args_str=$(echo "$input_json" | jq -r '. | map(tostring) | join(" ")')
    cat > "$runner" << TCLSCRIPT
source "$src_abs"
set result [$entry $args_str]
puts \$result
TCLSCRIPT
  else
    local raw_value
    raw_value=$(echo "$input_json" | jq -r '.')
    cat > "$runner" << TCLSCRIPT
source "$src_abs"
set result [$entry {$raw_value}]
puts \$result
TCLSCRIPT
  fi

  "$TCL_BIN" "$runner" 2>/dev/null
  local exit_code=$?
  rm -f "$runner"
  return $exit_code
}

# ─── JSON-encode a Tcl output value ──────────────────────────────────────────
encode_output() {
  local raw="$1"
  if echo "$raw" | jq -e '.' >/dev/null 2>&1; then
    echo "$raw" | jq -c '.'
  else
    echo "$raw" | jq -R -c '.'
  fi
}

# ─── Find .regret files ──────────────────────────────────────────────────────
REGRET_FILES=()
if [[ -d "$REGRET_DIR" ]]; then
  for f in "$REGRET_DIR"/*.regret; do
    [[ -f "$f" ]] || continue
    [[ "$f" == *.calls.* ]] && continue
    REGRET_FILES+=("$f")
  done
fi

if [[ ${#REGRET_FILES[@]} -eq 0 ]]; then
  echo "No .regret files found in $REGRET_DIR" >&2
  exit 1
fi

# ─── Main validation loop ────────────────────────────────────────────────────
[[ $QUIET -eq 0 ]] && echo "🔍 Validating Tcl clusters..."

PASSED=0
FAILED=0

for regret_path in "${REGRET_FILES[@]}"; do
  CID=$(basename "$regret_path" .regret)

  if [[ -n "$CLUSTER_FILTER" && "$CID" != "$CLUSTER_FILTER" ]]; then
    continue
  fi

  content=$(cat "$regret_path")

  ENTRY=$(echo "$content" | awk -F': ' '/^entry: / {print $2; exit}')
  FILE=$(echo "$content" | awk -F': ' '/^file: / {print $2; exit}')
  MULTI_ARGS=$(echo "$content" | awk -F': ' '/^multiArgs: / {print $2; exit}')
  MULTI_ARGS="${MULTI_ARGS:-false}"
  FIRST_INPUT=$(echo "$content" | awk '/^INPUT  / {sub("^INPUT  ", ""); print; exit}')
  FIRST_HASH=$(echo "$content" | awk '/^HASH   / {sub("^HASH   ", ""); print; exit}')
  INPUTS_LINE=$(echo "$content" | awk '/^INPUTS / {sub("^INPUTS ", ""); print; exit}')

  if [[ -z "$FIRST_HASH" ]]; then
    echo "  ❌ $CID — no HASH line in .regret file"
    FAILED=$((FAILED + 1))
    [[ $FAIL_FAST -eq 1 ]] && break
    continue
  fi

  [[ $QUIET -eq 0 ]] && echo "🔍 Validating: $CID"

  # ── Validate first input ──────────────────────────────────────────────────
  RAW_OUTPUT=$(invoke_tcl "$FILE" "$ENTRY" "$FIRST_INPUT" "$MULTI_ARGS")
  if [[ $? -ne 0 ]]; then
    echo "  ❌ $CID — failed to invoke (first input)"
    FAILED=$((FAILED + 1))
    [[ $FAIL_FAST -eq 1 ]] && break
    continue
  fi

  LIVE_OUTPUT=$(encode_output "$RAW_OUTPUT")
  LIVE_FP=$(fingerprint "$FIRST_INPUT" "$LIVE_OUTPUT")

  if [[ "$LIVE_FP" != "$FIRST_HASH" ]]; then
    echo "  ❌ $CID — golden: $FIRST_HASH, live: $LIVE_FP — FAIL"
    FAILED=$((FAILED + 1))
    [[ $FAIL_FAST -eq 1 ]] && { echo "  --fail-fast: stopping."; break; }
    continue
  fi

  # ── Validate inputs 1+ from INPUTS line ───────────────────────────────────
  CLUSTER_FAILED=0
  if [[ -n "$INPUTS_LINE" && "$INPUTS_LINE" != "[]" ]]; then
    INPUTS_COUNT=$(echo "$INPUTS_LINE" | jq 'length')
    for ((k = 0; k < INPUTS_COUNT; k++)); do
      GOLDEN_INPUT_K=$(echo "$INPUTS_LINE" | jq -c ".[$k].input")
      GOLDEN_HASH_K=$(echo "$INPUTS_LINE" | jq -r ".[$k].hash")

      RAW_OUTPUT_K=$(invoke_tcl "$FILE" "$ENTRY" "$GOLDEN_INPUT_K" "$MULTI_ARGS")
      if [[ $? -ne 0 ]]; then
        echo "  ❌ $CID — INPUTS[$((k+1))] failed to invoke"
        CLUSTER_FAILED=1
        break
      fi

      LIVE_OUTPUT_K=$(encode_output "$RAW_OUTPUT_K")
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
  [[ -n "$INPUTS_LINE" && "$INPUTS_LINE" != "[]" ]] && \
    N_INPUTS=$((1 + $(echo "$INPUTS_LINE" | jq 'length')))

  [[ $QUIET -eq 0 ]] && echo "  ✅ $CID — $FIRST_HASH — PASS ($N_INPUTS input$([[ $N_INPUTS -gt 1 ]] && echo 's'))"
  PASSED=$((PASSED + 1))
done

[[ $QUIET -eq 0 ]] && echo ""
[[ $QUIET -eq 0 ]] && echo "Validate: $PASSED passed, $FAILED failed"

[[ $FAILED -gt 0 ]] && exit 1
exit 0

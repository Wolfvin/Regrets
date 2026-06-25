#!/usr/bin/env bash
# validate_swift.sh — validate Swift function fingerprints against .regret files
#
# Reads .regret files, re-invokes the Swift function with the recorded INPUT,
# compares the new fingerprint with the stored HASH, reports PASS/FAIL.
#
# Multi-input support (issue #315 parity): validates ALL inputs from the
# INPUTS line, not just the first.
#
# Usage:
#   bash scripts/validate_swift.sh                          # validate all
#   bash scripts/validate_swift.sh --cluster slugify-fn     # validate one
#   bash scripts/validate_swift.sh --quiet
#   bash scripts/validate_swift.sh --fail-fast
#   bash scripts/validate_swift.sh --update <id> --reason "..."
#
# Exit code: 0 if all PASSed, 1 if any FAILed.

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

source "${SCRIPT_DIR}/fingerprint_swift.sh"

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
NODE_MANIFEST="$(node_path "$MANIFEST")"  # recompute after flag parsing (--manifest/--project may have changed MANIFEST)

# ─── --update mode ───────────────────────────────────────────────────────────
if [[ -n "$UPDATE_TARGET" ]]; then
  if [[ -z "$UPDATE_REASON" || $(echo "$UPDATE_REASON" | wc -w) -lt 4 ]]; then
    echo "❌ --update requires --reason with at least 4 words" >&2
    exit 1
  fi
  [[ $QUIET -eq 0 ]] && echo "🔄 Update mode — re-capturing cluster '$UPDATE_TARGET'..." >&2
  bash "${SCRIPT_DIR}/capture_swift.sh" --cluster "$UPDATE_TARGET" ${QUIET:+--quiet} >&2
  [[ $QUIET -eq 0 ]] && echo "✅ Re-captured '$UPDATE_TARGET' — golden .regret updated." >&2
  exit 0
fi

# ─── Locate swift ────────────────────────────────────────────────────────────
SWIFT_BIN="${SWIFT_BIN:-}"
if [[ -z "$SWIFT_BIN" ]]; then
  if command -v swift &> /dev/null; then
    SWIFT_BIN="swift"
  elif [[ -x /tmp/swift-5.10.1-RELEASE-ubuntu22.04/usr/bin/swift ]]; then
    SWIFT_BIN="/tmp/swift-5.10.1-RELEASE-ubuntu22.04/usr/bin/swift"
    export LD_LIBRARY_PATH="/tmp:/usr/lib/x86_64-linux-gnu:${LD_LIBRARY_PATH:-}"
  else
    echo "❌ Swift toolchain not found." >&2
    exit 1
  fi
fi

# ─── invoke_swift (same as capture_swift.sh) ─────────────────────────────────
invoke_swift() {
  local src_file="$1"
  local entry="$2"
  local input_json="$3"
  local multi_args="$4"

  local src_abs
  src_abs=$(realpath "$src_file" 2>/dev/null || echo "$PROJECT_DIR/$src_file")
  local src_content
  src_content=$(cat "$src_abs")

  local main_swift
  main_swift=$(mktemp /tmp/regrets_swift_XXXXXX.swift)

  local dispatch_code
  case "$entry" in
    slugify)
      dispatch_code='let cleaned = stripQuotes(input); let result = slugify(cleaned); print("\"\(result)\"")'
      ;;
    countVowels)
      dispatch_code='let cleaned = stripQuotes(input); let result = countVowels(cleaned); print(result)'
      ;;
    reverseStr)
      dispatch_code='let cleaned = stripQuotes(input); let result = reverseStr(cleaned); print("\"\(result)\"")'
      ;;
    add)
      dispatch_code='let parts = input.trimmingCharacters(in: CharacterSet(charactersIn: "[]")).split(separator: ","); let a = Int(parts[0]) ?? 0; let b = Int(parts[1]) ?? 0; print(add(a, b))'
      ;;
    *)
      dispatch_code='print("null")'
      ;;
  esac

  cat > "$main_swift" << SWIFT
import Foundation
$src_content
func stripQuotes(_ s: String) -> String {
    var result = s.trimmingCharacters(in: .whitespaces)
    if result.hasPrefix("\"") && result.hasSuffix("\"") {
        result = String(result.dropFirst().dropLast())
    }
    return result
}
let input = readLine() ?? ""
$dispatch_code
SWIFT

  echo "$input_json" | "$SWIFT_BIN" "$main_swift" 2>/dev/null
  local exit_code=$?
  rm -f "$main_swift"
  return $exit_code
}

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
[[ $QUIET -eq 0 ]] && echo "🔍 Validating Swift clusters..."

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

  RAW_OUTPUT=$(invoke_swift "$FILE" "$ENTRY" "$FIRST_INPUT" "$MULTI_ARGS")
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

  CLUSTER_FAILED=0
  if [[ -n "$INPUTS_LINE" && "$INPUTS_LINE" != "[]" ]]; then
    INPUTS_COUNT=$(echo "$INPUTS_LINE" | jq 'length')
    for ((k = 0; k < INPUTS_COUNT; k++)); do
      GOLDEN_INPUT_K=$(echo "$INPUTS_LINE" | jq -c ".[$k].input")
      GOLDEN_HASH_K=$(echo "$INPUTS_LINE" | jq -r ".[$k].hash")

      RAW_OUTPUT_K=$(invoke_swift "$FILE" "$ENTRY" "$GOLDEN_INPUT_K" "$MULTI_ARGS")
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

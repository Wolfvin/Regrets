#!/usr/bin/env bash
# capture_swift.sh — capture regret fingerprints for Swift clusters
#
# Reads regrets/manifest.json, filters clusters with stack: "swift",
# invokes each Swift function with inputs from the manifest, computes
# a 7-char fingerprint (IDENTICAL to JS/Python/Bash/Perl/Haskell/Tcl),
# and writes .regret files with the standard format.
#
# Multi-input support (issue #315 parity): processes ALL inputs, writes
# the INPUTS line for inputs 1+.
#
# Usage:
#   bash scripts/capture_swift.sh                          # capture all
#   bash scripts/capture_swift.sh --cluster slugify-fn     # capture one
#   bash scripts/capture_swift.sh --quiet
#   bash scripts/capture_swift.sh --verbose
#
# Requires: swift (Swift toolchain) + jq + sha256sum + python3

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
NODE_MANIFEST="$(node_path "$MANIFEST")"  # recompute after flag parsing (--manifest/--project may have changed MANIFEST)

if [[ ! -f "$MANIFEST" ]]; then
  echo "❌ Manifest not found: $MANIFEST" >&2
  exit 1
fi

mkdir -p "$REGRET_DIR"

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

# ─── Read Swift clusters ─────────────────────────────────────────────────────
read_swift_clusters() {
  FILTER="$CLUSTER_FILTER" node -e "
    const m = JSON.parse(require('fs').readFileSync('$NODE_MANIFEST', 'utf8'));
    let clusters = m.clusters.filter(c => c.stack === 'swift');
    const filter = process.env.FILTER || '';
    if (filter) clusters = clusters.filter(c => c.id === filter);
    console.log(JSON.stringify(clusters));
  "
}

CLUSTERS_JSON=$(read_swift_clusters)
CLUSTER_COUNT=$(echo "$CLUSTERS_JSON" | jq 'length')

if [[ "$CLUSTER_COUNT" -eq 0 ]]; then
  echo "No Swift clusters found in manifest." >&2
  exit 0
fi

# ─── invoke_swift: generate a Main.swift, run it, capture stdout ──────────────
# Args: $1 = source file, $2 = entry function name, $3 = input JSON, $4 = multiArgs
# Stdout: the function's output (JSON-encoded)
invoke_swift() {
  local src_file="$1"
  local entry="$2"
  local input_json="$3"
  local multi_args="$4"

  local src_abs
  src_abs=$(realpath "$src_file" 2>/dev/null || echo "$PROJECT_DIR/$src_file")

  # Read the source file content (to inline it into the runner)
  local src_content
  src_content=$(cat "$src_abs")

  local main_swift
  main_swift=$(mktemp /tmp/regrets_swift_XXXXXX.swift)

  # Generate the dispatch code based on entry name
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
      # multiArgs: input is a JSON array like [1,2]
      dispatch_code='let parts = input.trimmingCharacters(in: CharacterSet(charactersIn: "[]")).split(separator: ","); let a = Int(parts[0]) ?? 0; let b = Int(parts[1]) ?? 0; print(add(a, b))'
      ;;
    *)
      dispatch_code='print("null")'
      ;;
  esac

  cat > "$main_swift" << SWIFT
import Foundation

// ─── Inlined source ──────────────────────────────────────────────────────
$src_content

// ─── Helper: strip JSON string quotes ────────────────────────────────────
func stripQuotes(_ s: String) -> String {
    var result = s.trimmingCharacters(in: .whitespaces)
    if result.hasPrefix("\"") && result.hasSuffix("\"") {
        result = String(result.dropFirst().dropLast())
    }
    return result
}

// ─── Main: read input from stdin, dispatch, print result ─────────────────
let input = readLine() ?? ""
$dispatch_code
SWIFT

  echo "$input_json" | "$SWIFT_BIN" "$main_swift" 2>/dev/null
  local exit_code=$?
  rm -f "$main_swift"
  return $exit_code
}

# ─── JSON-encode a Swift output value ────────────────────────────────────────
encode_output() {
  local raw="$1"
  if echo "$raw" | jq -e '.' >/dev/null 2>&1; then
    echo "$raw" | jq -c '.'
  else
    echo "$raw" | jq -R -c '.'
  fi
}

# ─── Main capture loop ───────────────────────────────────────────────────────
[[ $QUIET -eq 0 ]] && echo "📡 Capturing Swift clusters..." >&2

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

    RAW_OUTPUT=$(invoke_swift "$FILE" "$ENTRY" "$INPUT_VALUE_JSON" "$MULTI_ARGS")
    INVOKE_EXIT=$?

    if [[ $INVOKE_EXIT -ne 0 ]]; then
      [[ $QUIET -eq 0 ]] && echo "     ❌ Failed to invoke (input #$j)" >&2
      CLUSTER_FAILED=1
      break
    fi

    OUTPUT_VALUE_JSON=$(encode_output "$RAW_OUTPUT")
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

  if [[ "$FIRST_OUTPUT_JSON" == "null" || -z "$FIRST_OUTPUT_JSON" ]]; then
    [[ $QUIET -eq 0 ]] && echo "     ⏭️  Skipped: trivial output on first input" >&2
    SKIPPED=$((SKIPPED + 1))
    continue
  fi

  TIMESTAMP=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
  REGRET_PATH="${REGRET_DIR}/${CID}.regret"

  {
    echo "cluster: $CID"
    echo "version: 1"
    echo "fingerprint: $FIRST_FP"
    echo "captured: $TIMESTAMP"
    echo "watches: [$WATCHES]"
    echo "entry: $ENTRY"
    echo "stack: swift"
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

#!/usr/bin/env bash
# capture_make.sh — Make stack capture: invoke Make functions and write .regret files
#
# Reads regrets/manifest.json, finds clusters with stack=make, invokes each
# function with each input via $(call funcname, args...), computes fingerprint,
# writes .regret files in the standard format.
#
# Usage:
#   bash scripts/capture_make.sh                           # capture all Make clusters
#   bash scripts/capture_make.sh --cluster make-slugify    # capture specific cluster
#   bash scripts/capture_make.sh --manifest ./regrets/manifest.json
#   bash scripts/capture_make.sh --quiet
#
# Prerequisites:
#   - GNU Make 4.x (make --version)
#   - sha256sum, python3, jq
#   - .regret files are written to the same directory as the manifest
#
# .regret file format (compatible with JS/Python/Bash/Perl stacks):
#   cluster: <id>
#   version: 1
#   fingerprint: <7-char hash>
#   captured: <ISO timestamp>
#   entry: <function name>
#   stack: make
#   file: <path to .mk file>
#   ---
#   INPUT  <json>
#   OUTPUT <json>
#   HASH   <7-char hash>

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/fingerprint_make.sh"

# ─── Windows Git Bash path conversion (#519) ────────────────────────────────
# GNU Make (native Windows binary) and Python (native Windows binary) do not
# resolve POSIX-style paths the way Git Bash does — /c/Users/... gets
# misread as a relative path under the current drive, producing nonsense
# like C:\c\Users\.... Convert via cygpath when available (Git Bash / MSYS2
# / Cygwin) so every `make -f` invocation and every `${mk_path}` heredoc
# interpolation gets a path Make/Python actually understand. No-op on
# Linux/Mac.
tool_path() {
  if command -v cygpath &> /dev/null; then
    cygpath -m "$1"
  else
    echo "$1"
  fi
}

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
      echo "Usage: bash scripts/capture_make.sh [OPTIONS]"
      echo ""
      echo "Options:"
      echo "  --cluster <id>   Capture only the specified cluster"
      echo "  --manifest <path> Path to manifest.json (default: regrets/manifest.json)"
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

# ─── Check prerequisites ─────────────────────────────────────────────────────
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

CAPTURED=0
SKIPPED=0

while IFS= read -r cluster_id; do
  [[ -z "$cluster_id" ]] && continue

  if [[ -n "$CLUSTER_FILTER" && "$cluster_id" != "$CLUSTER_FILTER" ]]; then
    continue
  fi

  entry=$(read_cluster_field "$MANIFEST_FULL" "$cluster_id" "entry")
  mk_file=$(read_cluster_field "$MANIFEST_FULL" "$cluster_id" "file")
  multi_args=$(read_cluster_field "$MANIFEST_FULL" "$cluster_id" "multiArgs")
  inputs_json=$(get_cluster_inputs "$MANIFEST_FULL" "$cluster_id")

  # Resolve mk file path relative to manifest dir.
  # #519: convert to a Windows-friendly path via cygpath so that GNU Make
  # (native Windows binary) and the heredoc `include` directive below can
  # resolve it. No-op on Linux/Mac.
  mk_path="${REGRET_DIR}/${mk_file}"
  if [[ ! -f "$mk_path" ]]; then
    echo "✗ ${cluster_id}: Make file not found: ${mk_path}" >&2
    SKIPPED=$((SKIPPED + 1))
    continue
  fi
  mk_path_make="$(tool_path "$mk_path")"

  # Determine the first input to capture (single .regret per cluster, using first input)
  # For multi-input clusters, we write an INPUTS line listing all input hashes.
  # #521: PYTHONIOENCODING=utf-8 so json.load(stdin) handles UTF-8 multi-byte
  # inputs correctly on Windows native Python (default cp1252 would crash).
  first_input=$(echo "$inputs_json" | PYTHONIOENCODING=utf-8 python3 -c "import json,sys; data=json.load(sys.stdin); print(json.dumps(data[0]))")

  # Build the $(call) arguments from the first input
  if [[ "$multi_args" == "true" ]]; then
    # Multi-arg: input is an array, each element is a separate call arg
    call_args=$(echo "$first_input" | PYTHONIOENCODING=utf-8 python3 -c '
import json, sys
data = json.load(sys.stdin)
if isinstance(data, list):
    # Each element becomes a call arg
    print(",".join(str(v) for v in data))
else:
    print(str(data))
')
  else
    # Single-arg: input is passed as $1
    call_args=$(echo "$first_input" | PYTHONIOENCODING=utf-8 python3 -c '
import json, sys
data = json.load(sys.stdin)
if isinstance(data, str):
    print(data)
else:
    print(json.dumps(data))
')
  fi

  # Invoke the Make function via a temporary Makefile that uses $(error ...)
  # to capture the expansion output. The $(error) function outputs its
  # argument to stderr and exits make with a non-zero code, allowing us
  # to capture the expansion without side effects.
  # #519: use mk_path_make (cygpath-converted) so native Windows GNU Make
  # can resolve the include path.
  tmp_mk=$(mktemp)
  cat > "$tmp_mk" << EOF
include ${mk_path_make}
\$(error \$(call ${entry},${call_args}))
EOF

  # Run make and capture stderr (the $(error) output goes to stderr)
  output_raw=$(make -f "$tmp_mk" 2>&1 1>/dev/null || true)
  rm -f "$tmp_mk"

  # The output is everything after "Makefile:N: *** " and before " Stop."
  # GNU Make format: "Makefile:3: *** <expansion>.  Stop."
  output=$(echo "$output_raw" | sed -n 's/.*\*\*\* \(.*\)\. *Stop\.$/\1/p' | head -1)

  if [[ -z "$output" ]]; then
    echo "✗ ${cluster_id}: no output captured from \$(call ${entry})" >&2
    SKIPPED=$((SKIPPED + 1))
    continue
  fi

  # Build the input/output JSON for fingerprinting
  # Input: the first input as-is (JSON value)
  # Output: the expansion string
  # #521: PYTHONIOENCODING=utf-8 — output may contain non-ASCII chars
  # (Make functions can return unicode strings), and json.dumps with
  # ensure_ascii=True would escape them as \uXXXX but the *input* via
  # sys.argv still needs UTF-8 decoding on Windows native Python.
  input_json="$first_input"
  output_json=$(PYTHONIOENCODING=utf-8 python3 -c "import json,sys; print(json.dumps(sys.argv[1]))" "$output")

  # Compute fingerprint
  fp=$(fingerprint "$input_json" "$output_json")

  # Build INPUTS line (hash of each input) for multi-input clusters
  inputs_count=$(echo "$inputs_json" | PYTHONIOENCODING=utf-8 python3 -c "import json,sys; print(len(json.load(sys.stdin)))")
  inputs_line=""
  if [[ "$inputs_count" -gt 1 ]]; then
    # Compute hash of each input for the INPUTS line
    # #521: PYTHONIOENCODING=utf-8 — json.dumps uses ensure_ascii=False
    # which can produce non-ASCII stdout on Windows native Python.
    inputs_line=$(echo "$inputs_json" | PYTHONIOENCODING=utf-8 python3 -c "
import json, sys, hashlib
inputs = json.load(sys.stdin)
hashes = []
for inp in inputs:
    s = json.dumps(inp, sort_keys=True, ensure_ascii=False)
    h = hashlib.sha256(s.encode()).hexdigest()
    # Take first 7 chars of base36 of first 64 bits
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
    echo "stack: make"
    echo "file: ${mk_file}"
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
  echo "📡 Captured ${CAPTURED} Make cluster(s), skipped ${SKIPPED}"
fi

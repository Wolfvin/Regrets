#!/usr/bin/env bash
# validate_make.sh — Make stack validator: re-invoke functions and compare hashes
#
# Reads .regret files, re-invokes Make functions with stored inputs,
# recomputes fingerprints, and reports PASS/FAIL.
#
# In --update mode, re-computes the fingerprint for one cluster with current
# code, writes the new hash to the .regret file (top-level HASH and any
# INPUTS line entries), and appends an entry to regrets/audit.log with a
# chain hash for tamper-evident history.
#
# Usage:
#   bash scripts/validate_make.sh                           # validate all Make clusters
#   bash scripts/validate_make.sh --cluster make-slugify    # validate specific cluster
#   bash scripts/validate_make.sh --manifest ./regrets/manifest.json
#   bash scripts/validate_make.sh --fail-fast               # stop on first failure
#   bash scripts/validate_make.sh --quiet
#   bash scripts/validate_make.sh --update make-slugify --reason "tax rate changed"
#
# Exit codes:
#   0 — all clusters PASS (or update succeeded)
#   1 — one or more clusters FAIL, missing .regret file, or update failed

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/fingerprint_make.sh"

# ─── Windows Git Bash path conversion (#519) ────────────────────────────────
# GNU Make (native Windows binary) and Python (native Windows binary) do not
# resolve POSIX-style paths the way Git Bash does — /c/Users/... gets
# misread as a relative path under the current drive, producing nonsense
# like C:\c\Users\.... Convert via cygpath when available (Git Bash / MSYS2
# / Cygwin) so every `make -f` invocation, every `${mk_path}` heredoc
# interpolation, and every `MK_PATH` env var passed to Python gets a path
# Make/Python actually understand. No-op on Linux/Mac.
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
FAIL_FAST=false
QUIET=false
UPDATE_TARGET=""
UPDATE_REASON=""

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
    --update)
      shift
      UPDATE_TARGET="$1"
      shift
      ;;
    --reason)
      shift
      UPDATE_REASON="$1"
      shift
      ;;
    --help|-h)
      echo "Usage: bash scripts/validate_make.sh [OPTIONS]"
      echo ""
      echo "Options:"
      echo "  --cluster <id>    Validate only the specified cluster"
      echo "  --manifest <path> Path to manifest.json"
      echo "  --fail-fast       Stop on first failure"
      echo "  --quiet           Only print summary"
      echo "  --update <id>     Update the .regret file for <id> with current code's hash"
      echo "  --reason \"...\"   Required with --update (min 4 words); recorded in audit.log"
      echo "  --help            Show this help message"
      exit 0
      ;;
    *)
      echo "Unknown option: $1" >&2
      exit 1
      ;;
  esac
done

# ─── Validate --update / --reason contract ──────────────────────────────────
if [[ -n "$UPDATE_TARGET" && -z "$UPDATE_REASON" ]]; then
  echo "❌ --update requires --reason" >&2
  echo "   Example: --update make-slugify --reason \"slugify now strips diacritics per spec v2\"" >&2
  exit 1
fi

if [[ -n "$UPDATE_REASON" ]]; then
  REASON_WORDS=$(echo "$UPDATE_REASON" | wc -w | tr -d ' ')
  if [[ "$REASON_WORDS" -lt 4 ]]; then
    echo "❌ --reason is too vague: \"$UPDATE_REASON\"" >&2
    echo "   Be specific. e.g. \"slugify now strips diacritics per spec v2\"" >&2
    exit 1
  fi
fi

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

# ─── Update mode: only target the --update cluster ──────────────────────────
if [[ -n "$UPDATE_TARGET" ]]; then
  CLUSTER_FILTER="$UPDATE_TARGET"
fi

# ─── Helpers for --update mode ──────────────────────────────────────────────

# Compute the chain hash for a new audit.log entry.
# Format: first 7 chars of sha256(prev_chain + "\n" + entry_content).
# Args: <prev_chain> <entry_content>
compute_chain_hash() {
  local prev_chain="$1"
  local entry_content="$2"
  printf '%s\n%s' "$prev_chain" "$entry_content" | sha256sum | cut -d' ' -f1 | python3 -c "
import sys
h = sys.stdin.read().strip()
n = int(h, 16)
b36 = ''
while n > 0:
    n, r = divmod(n, 36)
    b36 = '0123456789abcdefghijklmnopqrstuvwxyz'[r] + b36
sys.stdout.write(b36[:7])
"
}

# Get git short SHA (best-effort).
get_git_sha() {
  git rev-parse --short HEAD 2>/dev/null || echo ""
}

# Get last chain hash from audit.log (or '0000000' if no prior entry).
get_last_chain() {
  local audit_log="$1"
  if [[ -f "$audit_log" ]]; then
    local last_chain
    last_chain=$(grep -E '^\s*chain:\s*\S+' "$audit_log" 2>/dev/null | tail -1 | sed -E 's/^\s*chain:\s*//' || true)
    if [[ -n "$last_chain" ]]; then
      echo "$last_chain"
      return 0
    fi
  fi
  echo "0000000"
}

# Re-compute hashes for ALL inputs of a cluster (for INPUTS line refresh).
# Args: <manifest_path> <cluster_id> <mk_path> <entry> <multi_args>
# Outputs: space-separated list of input hashes (one per input).
#
# #519: caller is expected to pass a cygpath-converted `mk_path` via the
# MK_PATH env var so that the `f.write(f"include {mk_path}\n")` line below
# produces a path native Windows GNU Make can resolve.
# #521: PYTHONIOENCODING=utf-8 set by caller so json.load(stdin) handles
# UTF-8 multi-byte inputs correctly on Windows native Python.
recompute_inputs_hashes() {
  local manifest="$1"
  local cluster_id="$2"
  local mk_path="$3"
  local entry="$4"
  local multi_args="$5"

  local inputs_json
  inputs_json=$(get_cluster_inputs "$manifest" "$cluster_id")

  echo "$inputs_json" | MK_PATH="$mk_path" ENTRY="$entry" MULTI_ARGS="$multi_args" PYTHONIOENCODING=utf-8 python3 -c '
import json, sys, hashlib, subprocess, os

inputs = json.load(sys.stdin)
mk_path = os.environ["MK_PATH"]
entry = os.environ["ENTRY"]
multi_args = os.environ["MULTI_ARGS"] == "true"

def invoke_make(inp):
    if multi_args and isinstance(inp, list):
        call_args = ",".join(str(v) for v in inp)
    elif isinstance(inp, str):
        call_args = inp
    else:
        call_args = json.dumps(inp)
    # Write temp Makefile
    import tempfile
    with tempfile.NamedTemporaryFile(mode="w", suffix=".mk", delete=False) as f:
        f.write(f"include {mk_path}\n")
        f.write(f"$(error $(call {entry},{call_args}))\n")
        tmp = f.name
    try:
        result = subprocess.run(["make", "-f", tmp], capture_output=True, text=True)
        # Parse "*** <output>.  Stop." from stderr
        import re
        m = re.search(r"\*\*\* (.+)\. *Stop\.$", result.stderr.strip() or result.stdout.strip())
        if not m:
            return None
        return m.group(1)
    finally:
        os.unlink(tmp)

def stable_stringify(obj):
    if obj is None: return "null"
    if obj is True: return "true"
    if obj is False: return "false"
    if isinstance(obj, int) and not isinstance(obj, bool): return str(obj)
    if isinstance(obj, float):
        if obj != obj: return "\"__nan__\""
        if obj == float("inf"): return "\"__infinity__\""
        if obj == float("-inf"): return "\"__neg_infinity__\""
        if obj == int(obj) and abs(obj) < 1e15: return str(int(obj))
        return repr(obj)
    if isinstance(obj, str): return json.dumps(obj, ensure_ascii=False)
    if isinstance(obj, list): return "[" + ",".join(stable_stringify(v) for v in obj) + "]"
    if isinstance(obj, dict):
        keys = sorted(obj.keys())
        return "{" + ",".join(json.dumps(k, ensure_ascii=False) + ":" + stable_stringify(obj[k]) for k in keys) + "}"
    return json.dumps(obj, ensure_ascii=False)

def fingerprint(inp, out):
    inp_str = stable_stringify(inp)
    out_str = stable_stringify(out)
    combined = inp_str + "|" + out_str
    h = hashlib.sha256(combined.encode()).hexdigest()
    n = int(h, 16)
    b36 = ""
    while n > 0:
        n, r = divmod(n, 36)
        b36 = "0123456789abcdefghijklmnopqrstuvwxyz"[r] + b36
    return b36[:7]

# For each input, compute hash of (input, output) pair
for inp in inputs:
    output = invoke_make(inp)
    if output is None:
        print("ERROR", end="")
        sys.exit(1)
    h = fingerprint(inp, output)
    print(h, end=" ")
' 2>&1
}

PASSED=0
FAILED=0
SKIPPED=0
UPDATED=0

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
  inputs_line_raw=""

  # Read meta section (before ---) and data section (after ---)
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
      # Meta section
      case "$line" in
        fingerprint:*) golden_hash="${line#fingerprint: }" ;;
        entry:*) entry="${line#entry: }" ;;
        file:*) mk_file="${line#file: }" ;;
        INPUTS\ *) has_inputs_line=true; inputs_line_raw="$line" ;;
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
  # #519: convert to Windows-friendly path for native GNU Make + Python.
  mk_path_make="$(tool_path "$mk_path")"

  # Re-invoke the function with the stored input
  first_input="$golden_input"

  if [[ "$multi_args" == "true" ]]; then
    call_args=$(echo "$first_input" | PYTHONIOENCODING=utf-8 python3 -c '
import json, sys
data = json.load(sys.stdin)
if isinstance(data, list):
    print(",".join(str(v) for v in data))
else:
    print(str(data))
')
  else
    call_args=$(echo "$first_input" | PYTHONIOENCODING=utf-8 python3 -c '
import json, sys
data = json.load(sys.stdin)
if isinstance(data, str):
    print(data)
else:
    print(json.dumps(data))
')
  fi

  # #519: use mk_path_make (cygpath-converted) so native Windows GNU Make
  # can resolve the include path.
  tmp_mk=$(mktemp)
  cat > "$tmp_mk" << EOF
include ${mk_path_make}
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

  # ─── Update mode ─────────────────────────────────────────────────────────
  if [[ -n "$UPDATE_TARGET" ]]; then
    if [[ "$current_hash" == "$golden_hash" ]]; then
      echo "↻ ${cluster_id}: already up to date (${current_hash})"
      continue
    fi

    # Compute new INPUTS line hashes if present
    new_inputs_line=""
    if [[ "$has_inputs_line" == "true" ]]; then
      new_inputs_hashes=$(MK_PATH="$mk_path_make" ENTRY="$entry" MULTI_ARGS="$multi_args" recompute_inputs_hashes "$MANIFEST_FULL" "$cluster_id" "$mk_path_make" "$entry" "$multi_args")
      if [[ "$new_inputs_hashes" == "ERROR" ]]; then
        echo "✗ ${cluster_id}: failed to recompute INPUTS hashes during update" >&2
        FAILED=$((FAILED + 1))
        continue
      fi
      new_inputs_line="INPUTS $(echo "$new_inputs_hashes" | tr -d '\n' | sed 's/ *$//')"
    fi

    # Build new .regret content
    timestamp=$(format_iso8601)
    new_content=$({
      echo "cluster: ${cluster_id}"
      echo "version: 1"
      echo "fingerprint: ${current_hash}"
      echo "captured: ${timestamp}"
      echo "entry: ${entry}"
      echo "stack: make"
      echo "file: ${mk_file}"
      if [[ -n "$new_inputs_line" ]]; then
        echo "$new_inputs_line"
      fi
      echo "---"
      echo "INPUT  ${first_input}"
      echo "OUTPUT ${output_json}"
      echo "HASH   ${current_hash}"
    })

    # Write new .regret
    echo "$new_content" > "$regret_path"

    # Append to audit.log
    audit_log="${REGRET_DIR}/audit.log"
    git_sha=$(get_git_sha)
    prev_chain=$(get_last_chain "$audit_log")

    # Sanitize reason: replace newlines with spaces
    safe_reason=$(echo "$UPDATE_REASON" | tr '\r\n' '  ')

    # Build entry content (must match what chain hash covers)
    entry_content=$({
      echo "${timestamp}  UPDATE  ${cluster_id}"
      echo "  old: ${golden_hash}"
      echo "  new: ${current_hash}"
      echo "  reason: ${safe_reason}"
      echo "  by: AI refactor session"
      if [[ -n "$git_sha" ]]; then
        echo "  gitSha: ${git_sha}"
      fi
    })

    chain_hash=$(compute_chain_hash "$prev_chain" "$entry_content")

    # Append entry + chain hash to audit.log
    {
      echo "${entry_content}"
      echo "  chain: ${chain_hash}"
      echo ""
    } >> "$audit_log"

    echo "↻ ${cluster_id}: UPDATED"
    echo "    old: ${golden_hash}"
    echo "    new: ${current_hash}"
    echo "    reason: ${safe_reason}"
    echo "    chain: ${chain_hash}"
    UPDATED=$((UPDATED + 1))
    continue
  fi

  # ─── Regular validate mode ───────────────────────────────────────────────
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
  if [[ -n "$UPDATE_TARGET" ]]; then
    echo "↻ ${UPDATED} cluster(s) updated"
  else
    echo "🔍 ${PASSED}/$((PASSED + FAILED + SKIPPED)) Make clusters passed"
  fi
fi

exit $([[ $FAILED -gt 0 ]] && echo 1 || echo 0)

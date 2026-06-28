#!/usr/bin/env bash
# fingerprint_jq.sh — shared fingerprint module for jq stack
#
# Sourced by capture_jq.sh and validate_jq.sh. Provides:
#   - stable_stringify(input_json) → canonical JSON string (sorted keys)
#   - fingerprint(input_json, output_json) → 7-char base36 hash
#   - read_manifest_field(field) → value from manifest.json
#
# The fingerprint algorithm is IDENTICAL to fingerprint.js (JS) /
# fingerprint.py (Python) / fingerprint_bash.sh / fingerprint_make.sh:
#   sha256(stableStringify(input) + "|" + stableStringify(output))
#   → BigInt → base36 → first 7 chars
#
# Cross-stack parity is a hard contract — a jq .regret file must produce
# the same 7-char hash as a JS .regret file for identical input/output.

set -euo pipefail

# ─── stable_stringify ────────────────────────────────────────────────────────
# Converts a JSON string to its canonical form (sorted keys recursively).
# Delegates to python3. Matches the stableStringify() in scripts/fingerprint.js
# exactly.
#
# #521: PYTHONIOENCODING=utf-8 — the snippet below uses
# `json.dumps(obj, ensure_ascii=False)` which can produce non-ASCII stdout
# (e.g., for unicode inputs). On Windows native Python (default cp1252
# stdout), this would crash with UnicodeEncodeError. The env var forces
# UTF-8 for stdin/stdout/stderr so the function is cross-platform.
stable_stringify() {
  local json="$1"
  PYTHONIOENCODING=utf-8 python3 -c '
import json, sys

def stable_stringify(obj):
    if obj is None:
        return "null"
    if obj is True:
        return "true"
    if obj is False:
        return "false"
    if isinstance(obj, int) and not isinstance(obj, bool):
        return str(obj)
    if isinstance(obj, float):
        if obj != obj:  # NaN
            return "\"__nan__\""
        if obj == float("inf"):
            return "\"__infinity__\""
        if obj == float("-inf"):
            return "\"__neg_infinity__\""
        if obj == int(obj) and abs(obj) < 1e15:
            return str(int(obj))
        return repr(obj)
    if isinstance(obj, str):
        return json.dumps(obj, ensure_ascii=False)
    if isinstance(obj, list):
        return "[" + ",".join(stable_stringify(v) for v in obj) + "]"
    if isinstance(obj, dict):
        keys = sorted(obj.keys())
        return "{" + ",".join(
            json.dumps(k, ensure_ascii=False) + ":" + stable_stringify(obj[k])
            for k in keys
        ) + "}"
    return json.dumps(obj, ensure_ascii=False)

data = json.loads(sys.stdin.read(), parse_float=lambda s: float(s))
sys.stdout.write(stable_stringify(data))
' <<< "$json"
}

# ─── fingerprint ─────────────────────────────────────────────────────────────
# Computes the 7-char base36 fingerprint for an (input, output) pair.
# Both arguments are JSON strings.
fingerprint() {
  local input_json="$1"
  local output_json="$2"
  local input_str output_str combined hash

  input_str=$(stable_stringify "$input_json")
  output_str=$(stable_stringify "$output_json")
  combined="${input_str}|${output_str}"

  hash=$(printf '%s' "$combined" | sha256sum | cut -d' ' -f1)

  # Convert full 256-bit hex hash to base36, take first 7 chars.
  # MUST match fingerprint.js: BigInt('0x' + hash).toString(36).slice(0, 7)
  python3 -c "
import sys
num = int('${hash}', 16)
b36 = ''
n = num
while n > 0:
    n, r = divmod(n, 36)
    b36 = '0123456789abcdefghijklmnopqrstuvwxyz'[r] + b36
sys.stdout.write(b36[:7])
"
}

# ─── read_manifest_field ────────────────────────────────────────────────────
read_manifest_field() {
  local manifest="$1"
  local field="$2"
  jq -r ".${field}" "$manifest"
}

# ─── read_cluster_field ─────────────────────────────────────────────────────
read_cluster_field() {
  local manifest="$1"
  local cluster_id="$2"
  local field="$3"
  jq -r ".clusters[] | select(.id == \"${cluster_id}\") | .${field}" "$manifest"
}

# ─── list_jq_clusters ───────────────────────────────────────────────────────
list_jq_clusters() {
  local manifest="$1"
  jq -r '.clusters[] | select(.stack == "jq") | .id' "$manifest"
}

# ─── get_cluster_inputs ────────────────────────────────────────────────────
get_cluster_inputs() {
  local manifest="$1"
  local cluster_id="$2"
  jq -c ".clusters[] | select(.id == \"${cluster_id}\") | .inputs" "$manifest"
}

# ─── format_iso8601 ─────────────────────────────────────────────────────────
format_iso8601() {
  python3 -c "
from datetime import datetime, timezone
print(datetime.now(timezone.utc).strftime('%Y-%m-%dT%H:%M:%S.%f+00:00'))
"
}

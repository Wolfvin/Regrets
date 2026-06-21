#!/usr/bin/env bash
# fingerprint_bash.sh — shared module for Bash stack fingerprinting
#
# Provides:
#   stable_stringify <value>           → JSON-compatible deterministic string
#   fingerprint <input_json> <output>  → 7-char base36 hash
#
# Paritas KONTRAK — output HARUS identik dengan:
#   - scripts/fingerprint.js (JS/TS/CSS)
#   - scripts/fingerprint.py (Python)
#   - scripts/fingerprint_perl.pl (Perl)
#   - scripts/fingerprint_rb.rb (Ruby)
#   - scripts/capture_go.sh (Go)
#
# Algorithm: sha256(stableStringify(input) + "|" + stableStringify(output))
#            → hex → BigInt → base36 → first 7 chars
#
# Bash cannot natively handle 256-bit integers, so we delegate the
# hash+base36 conversion to python3 (universally available wherever bash
# is used for CI/ops). The stable_stringify logic is implemented in pure
# bash for transparency and to minimize subprocess overhead.
#
# Source this file: source scripts/fingerprint_bash.sh

# ─── stable_stringify ────────────────────────────────────────────────────────
# Implements a subset of JS stableStringify() sufficient for Bash stack I/O:
#   - string  → JSON-escaped quoted string (matching JSON.stringify)
#   - number  → JSON number representation
#   - boolean → "true" / "false"
#   - null    → "null"
#   - array   → "[" + items joined by "," + "]"
#   - object  → "{" + sorted keys + "}"
#
# For Bash, we typically only need to stringify:
#   - Input: either a single string or an array of strings (multiArgs)
#   - Output: a string (function stdout)
#
# Input is passed as a typed JSON value via python3 helper to ensure
# type-correct stringification (we don't want "1" vs 1 to collide).
#
# Usage:
#   stable_stringify '"hello"'           # already-JSON string input
#   stable_stringify '["a","b"]'         # JSON array input
#   stable_stringify_raw 'raw string'    # wrap raw text as JSON string
#
stable_stringify() {
  local json_value="$1"
  # Delegate to python3 for type-aware stable stringification.
  # Python's json.dumps with sort_keys=True produces the same output as
  # JS stableStringify for the subset of types we support.
  python3 -c '
import json, sys, math

def stable(obj):
    if obj is None:
        return "null"
    if obj is True:
        return "true"
    if obj is False:
        return "false"
    if isinstance(obj, int):
        return str(obj)
    if isinstance(obj, float):
        if math.isnan(obj):
            return "\"__nan__\""
        if obj == math.inf:
            return "\"__infinity__\""
        if obj == -math.inf:
            return "\"__neg_infinity__\""
        # Use repr to preserve precision, but JSON convention for float
        if obj == int(obj):
            return json.dumps(int(obj))
        return json.dumps(obj)
    if isinstance(obj, str):
        return json.dumps(obj, ensure_ascii=False)
    if isinstance(obj, list):
        return "[" + ",".join(stable(x) for x in obj) + "]"
    if isinstance(obj, dict):
        keys = sorted(obj.keys())
        return "{" + ",".join(json.dumps(k, ensure_ascii=False) + ":" + stable(obj[k]) for k in keys) + "}"
    return json.dumps(obj, ensure_ascii=False)

value = json.loads(sys.argv[1], parse_constant=lambda x: x)
sys.stdout.write(stable(value))
' "$json_value" 2>/dev/null
}

# Wrap a raw bash string (function stdout) as a JSON string for stringification.
# Handles: quotes, backslashes, newlines, tabs, control chars.
# This is the "OUTPUT" path — function stdout is always a string.
stable_stringify_raw() {
  local raw="$1"
  python3 -c '
import json, sys
sys.stdout.write(json.dumps(sys.argv[1], ensure_ascii=False))
' "$raw" 2>/dev/null
}

# ─── fingerprint ─────────────────────────────────────────────────────────────
# Compute 7-char base36 fingerprint for (input, output) pair.
#
# Usage:
#   fingerprint "<input-json>" "<output-raw>"
#
# Returns: 7-char lowercase base36 string, identical to JS implementation.
#
fingerprint() {
  local input_json="$1"
  local output_raw="$2"

  local input_str output_str combined
  input_str=$(stable_stringify "$input_json")
  output_str=$(stable_stringify_raw "$output_raw")
  combined="${input_str}|${output_str}"

  # Compute sha256 hex, convert to BigInt, then to base36, take first 7 chars.
  # Uses python3 because bash cannot handle 256-bit integers natively.
  local hex_hash
  hex_hash=$(printf '%s' "$combined" | sha256sum | awk '{print $1}')

  python3 -c '
import sys
h = int(sys.argv[1], 16)
# Convert to base36 (lowercase) — equivalent to JS BigInt.toString(36)
if h == 0:
    s = "0"
else:
    chars = "0123456789abcdefghijklmnopqrstuvwxyz"
    parts = []
    while h:
        h, r = divmod(h, 36)
        parts.append(chars[r])
    s = "".join(reversed(parts))
sys.stdout.write(s[:7])
' "$hex_hash"
}

# ─── manifest helpers ────────────────────────────────────────────────────────
# Read a JSON value from manifest (e.g., inputs array element).
# Uses python3 for robust JSON parsing.
#
# Usage:
#   manifest_get_input '<manifest-path>' '<cluster-id>' '<input-index>' [multiArgs]
#
manifest_get_input() {
  local manifest_path="$1"
  local cluster_id="$2"
  local input_index="$3"
  local multi_args="${4:-false}"

  python3 -c '
import json, sys
with open(sys.argv[1]) as f:
    manifest = json.load(f)
cluster_id = sys.argv[2]
input_index = int(sys.argv[3])
multi_args = sys.argv[4] == "true"

cluster = next((c for c in manifest["clusters"] if c["id"] == cluster_id), None)
if not cluster:
    sys.stderr.write(f"Cluster not found: {cluster_id}\n")
    sys.exit(1)

inputs = cluster.get("inputs", [])
if input_index >= len(inputs):
    sys.stderr.write(f"Input index out of range: {input_index}\n")
    sys.exit(1)

value = inputs[input_index]
if multi_args and isinstance(value, list):
    # Return as JSON array
    print(json.dumps(value))
else:
    # Return as JSON scalar
    print(json.dumps(value))
' "$manifest_path" "$cluster_id" "$input_index" "$multi_args"
}

# Get cluster field from manifest
# Usage: manifest_get_cluster_field <manifest-path> <cluster-id> <field-name>
manifest_get_cluster_field() {
  local manifest_path="$1"
  local cluster_id="$2"
  local field="$3"

  python3 -c '
import json, sys
with open(sys.argv[1]) as f:
    manifest = json.load(f)
cluster_id = sys.argv[2]
field = sys.argv[3]
cluster = next((c for c in manifest["clusters"] if c["id"] == cluster_id), None)
if not cluster:
    sys.exit(1)
val = cluster.get(field, "")
if val is None:
    print("")
elif isinstance(val, bool):
    print("true" if val else "false")
elif isinstance(val, list):
    print(json.dumps(val))
else:
    print(val)
' "$manifest_path" "$cluster_id" "$field"
}

# List all bash clusters in manifest (one per line: <id>\t<entry>\t<file>)
# Usage: manifest_list_bash_clusters <manifest-path>
manifest_list_bash_clusters() {
  local manifest_path="$1"
  python3 -c '
import json, sys
with open(sys.argv[1]) as f:
    manifest = json.load(f)
for c in manifest.get("clusters", []):
    if c.get("stack") == "bash":
        cid = c.get("id", "")
        entry = c.get("entry", "")
        file_ = c.get("file", "")
        multi = "true" if c.get("multiArgs") else "false"
        inputs_count = len(c.get("inputs", []))
        # tab-separated: id, entry, file, multiArgs, inputs_count
        print("\t".join([cid, entry, file_, multi, str(inputs_count)]))
' "$manifest_path"
}

# Get ISO 8601 timestamp with timezone (matches JS new Date().toISOString())
# JS: 2026-06-13T16:26:21.297017+00:00
# Bash equivalent via python3:
iso_timestamp() {
  python3 -c '
from datetime import datetime, timezone
print(datetime.now(timezone.utc).isoformat(timespec="microseconds"))
'
}

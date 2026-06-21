#!/usr/bin/env bash
# capture_nim.sh — compile + run regret capture for Nim clusters
#
# Reads regrets/manifest.json, generates a Nim harness per cluster that
# `include`s the user's source file and invokes the entry proc with the
# first input, compiles the harness, runs it, and writes the .regret file
# in the standard format (cluster/version/fingerprint/captured/INPUT/OUTPUT/HASH).
#
# Usage:
#   bash scripts/capture_nim.sh                            # capture all Nim clusters
#   bash scripts/capture_nim.sh --cluster slugify          # capture one cluster
#   bash scripts/capture_nim.sh --manifest ./manifest.json
#
# Manifest schema (Nim-specific fields):
#   {
#     "clusters": [{
#       "id": "slugify",
#       "entry": "slugify",                # proc symbol name (top-level proc in user source)
#       "watches": ["slugify"],            # informational; Nim has no equivalent of JS Proxy
#       "file": "lib/slugify.nim",         # path relative to project root
#       "stack": "nim",
#       "fingerprintLevel": "entry",
#       "inputs": ["Hello, World!", "Café résumé", ...]
#     }]
#   }
#
# Compatibility:
#   .regret file format is byte-compatible with JS/PHP/Python/Ruby adapters.
#   Fingerprint hash for the same input/output pair is identical across stacks
#   (verified by proof/nim_slugify/PARITY.md).

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SKILL_DIR="$(dirname "$SCRIPT_DIR")"
PROJECT_DIR="$(pwd)"
MANIFEST="${PROJECT_DIR}/regrets/manifest.json"
REGRET_DIR="${PROJECT_DIR}/regrets"

mkdir -p "$REGRET_DIR"

# ─── Parse CLI args ───────────────────────────────────────────────────────────
CLUSTER_FILTER=""
MANIFEST_FLAG=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --cluster)
      CLUSTER_FILTER="$2"
      shift 2
      ;;
    --manifest)
      MANIFEST_FLAG="$2"
      shift 2
      ;;
    *)
      shift
      ;;
  esac
done

[[ -n "$MANIFEST_FLAG" ]] && MANIFEST="$MANIFEST_FLAG"

if [[ ! -f "$MANIFEST" ]]; then
  echo "❌ Could not read manifest: $MANIFEST" >&2
  echo "   Create regrets/manifest.json first. See SKILL.md for format." >&2
  exit 1
fi

# ─── Locate Nim compiler ──────────────────────────────────────────────────────
NIM="${NIM:-nim}"
if ! command -v "$NIM" >/dev/null 2>&1; then
  echo "❌ Nim compiler not found on PATH." >&2
  echo "   Install Nim (https://nim-lang.org/install.html) or set NIM=/path/to/nim" >&2
  exit 1
fi

# ─── Helper: read Nim clusters from manifest (uses node for JSON parsing) ─────
read_nim_clusters() {
  node -e "
    const m = JSON.parse(require('fs').readFileSync('$MANIFEST', 'utf8'));
    let clusters = (m.clusters || []).filter(c => (c.stack || '').toLowerCase() === 'nim');
    if ('$CLUSTER_FILTER') {
      clusters = clusters.filter(c => c.id === '$CLUSTER_FILTER');
    }
    console.log(JSON.stringify(clusters));
  "
}

# ─── Main: iterate clusters ───────────────────────────────────────────────────
CLUSTERS_JSON=$(read_nim_clusters)

CLUSTER_COUNT=$(echo "$CLUSTERS_JSON" | node -e "
  const cs = JSON.parse(require('fs').readFileSync('/dev/stdin','utf8'));
  console.log(cs.length);
")

if [[ "$CLUSTER_COUNT" -eq 0 ]]; then
  echo "No Nim clusters found in manifest."
  exit 0
fi

echo "📡 Capturing Nim clusters..."
echo

PASS=0
FAIL=0

# Iterate clusters one at a time
for ((i=0; i<CLUSTER_COUNT; i++)); do
  CLUSTER_JSON=$(echo "$CLUSTERS_JSON" | node -e "
    const cs = JSON.parse(require('fs').readFileSync('/dev/stdin','utf8'));
    console.log(JSON.stringify(cs[$i]));
  ")

  CLUSTER_ID=$(echo "$CLUSTER_JSON" | node -e "
    const c = JSON.parse(require('fs').readFileSync('/dev/stdin','utf8'));
    process.stdout.write(c.id);
  ")

  CLUSTER_FILE=$(echo "$CLUSTER_JSON" | node -e "
    const c = JSON.parse(require('fs').readFileSync('/dev/stdin','utf8'));
    process.stdout.write(c.file || '');
  ")

  CLUSTER_ENTRY=$(echo "$CLUSTER_JSON" | node -e "
    const c = JSON.parse(require('fs').readFileSync('/dev/stdin','utf8'));
    process.stdout.write(c.entry);
  ")

  echo "📡 Capturing: $CLUSTER_ID"
  echo "   File:    $CLUSTER_FILE"
  echo "   Entry:   $CLUSTER_ENTRY"

  # Sanitize cluster ID for use in file paths (replace non-identifier chars with _)
  CLUSTER_SAFE=$(echo "$CLUSTER_ID" | sed 's/[^A-Za-z0-9_]/_/g')

  # Generate harness
  HARNESS_FILE="/tmp/regret_harness_${CLUSTER_SAFE}_$$.nim"
  if ! node "$SCRIPT_DIR/_nim_harness_gen.cjs" "$CLUSTER_JSON" "$HARNESS_FILE" 2>&1; then
    echo "   ❌ Failed to generate harness"
    FAIL=$((FAIL + 1))
    continue
  fi

  # Compile harness (use scripts dir as Nim path so fingerprint_nim is importable)
  COMPILE_LOG="/tmp/regret_harness_${CLUSTER_SAFE}_$$.compile.log"
  if ! "$NIM" c -d:release --path:"$SCRIPT_DIR" \
                -o:"/tmp/regret_harness_${CLUSTER_SAFE}_$$" \
                "$HARNESS_FILE" > "$COMPILE_LOG" 2>&1; then
    echo "   ❌ Compile failed:"
    tail -10 "$COMPILE_LOG" | sed 's/^/      /'
    rm -f "$HARNESS_FILE" "$COMPILE_LOG"
    FAIL=$((FAIL + 1))
    continue
  fi

  # Run harness
  HARNESS_BIN="/tmp/regret_harness_${CLUSTER_SAFE}_$$"
  RUN_LOG="/tmp/regret_harness_${CLUSTER_SAFE}_$$.run.log"
  if ! "$HARNESS_BIN" > "$RUN_LOG" 2>&1; then
    echo "   ❌ Run failed:"
    tail -10 "$RUN_LOG" | sed 's/^/      /'
    rm -f "$HARNESS_FILE" "$HARNESS_BIN" "$COMPILE_LOG" "$RUN_LOG"
    FAIL=$((FAIL + 1))
    continue
  fi

  # Parse harness output
  INPUT_LINE=$(grep '^REGRET_INPUT ' "$RUN_LOG" || true)
  OUTPUT_LINE=$(grep '^REGRET_OUTPUT ' "$RUN_LOG" || true)
  HASH_LINE=$(grep '^REGRET_HASH ' "$RUN_LOG" || true)
  HASH_VAL="${HASH_LINE#REGRET_HASH }"

  if [[ -z "$INPUT_LINE" || -z "$OUTPUT_LINE" || -z "$HASH_VAL" ]]; then
    echo "   ❌ Harness output malformed:"
    cat "$RUN_LOG" | sed 's/^/      /'
    rm -f "$HARNESS_FILE" "$HARNESS_BIN" "$COMPILE_LOG" "$RUN_LOG"
    FAIL=$((FAIL + 1))
    continue
  fi

  # Write .regret file
  REGRET_PATH=$(node "$SCRIPT_DIR/_nim_regret_write.cjs" "$CLUSTER_JSON" "$INPUT_LINE" "$OUTPUT_LINE" "$HASH_VAL")
  REL_PATH="${REGRET_PATH#$PROJECT_DIR/}"

  echo "   ✅ Fingerprint: $HASH_VAL"
  echo "   📄 Saved: $REL_PATH"

  rm -f "$HARNESS_FILE" "$HARNESS_BIN" "$COMPILE_LOG" "$RUN_LOG"
  PASS=$((PASS + 1))
done

echo
echo "──────────────────────────────────────────────────────────"
echo "Capture complete: $PASS captured, $FAIL failed"

if [[ $FAIL -gt 0 ]]; then
  echo
  echo "⚠️  Fix failed captures before proceeding to PHASE 2."
  exit 1
fi

echo
echo "Next: bash scripts/validate_nim.sh"
echo "If all green → you are clear to refactor."

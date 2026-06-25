#!/usr/bin/env bash
# capture_julia.sh — capture regret contracts for Julia clusters.
#
# Reads regrets/manifest.json, filters clusters with `stack: "julia"`,
# generates a per-cluster Julia harness that `include`s the user's source
# file and invokes the entry function with the first input, runs the harness,
# and writes the .regret file in the standard format
# (cluster/version/fingerprint/captured/INPUT/OUTPUT/HASH).
#
# Usage:
#   bash scripts/capture_julia.sh                  # capture all Julia clusters
#   bash scripts/capture_julia.sh --cluster slugify
#   bash scripts/capture_julia.sh --manifest ./manifest.json
#
# Manifest schema (Julia-specific fields):
#   {
#     "clusters": [{
#       "id": "slugify",
#       "entry": "slugify",                # function name (top-level function in user source)
#       "watches": ["slugify"],            # informational; Julia has no equivalent of JS Proxy
#       "file": "lib/slugify.jl",          # path relative to project root
#       "stack": "julia",
#       "fingerprintLevel": "entry",
#       "inputs": ["Hello, World!", ...]
#     }]
#   }
#
# Compatibility:
#   .regret file format is byte-compatible with JS/Python/Ruby/PHP/Nim adapters.
#   Fingerprint hash for the same input/output pair is identical across stacks
#   (verified by proof/julia_slugify/verify-parity.mjs).

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SKILL_DIR="$(dirname "$SCRIPT_DIR")"
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
NODE_MANIFEST="$(node_path "$MANIFEST")"  # recompute after flag parsing (--manifest/--project may have changed MANIFEST)

[[ -n "$MANIFEST_FLAG" ]] && MANIFEST="$MANIFEST_FLAG"

if [[ ! -f "$MANIFEST" ]]; then
  echo "❌ Could not read manifest: $MANIFEST" >&2
  echo "   Create regrets/manifest.json first. See SKILL.md for format." >&2
  exit 1
fi

# ─── Locate Julia binary ──────────────────────────────────────────────────────
JULIA="${JULIA:-julia}"
if ! command -v "$JULIA" >/dev/null 2>&1; then
  echo "❌ Julia not found on PATH." >&2
  echo "   Install Julia (https://julialang.org/install/) or set JULIA=/path/to/julia" >&2
  exit 1
fi

# ─── Determine Julia project env (if any) ─────────────────────────────────────
# If the user has a Project.toml next to their source file (or at project root),
# Julia will pick it up automatically. For our stdlib-only fingerprint module,
# we need JSON available — Julia's JSON stdlib requires `Pkg.add("JSON")` once.
# We allow the caller to set JULIA_PROJECT to point at a pre-built env, or
# fall back to a known-good temp env.
JULIA_PROJECT_FLAG=""
if [[ -n "${JULIA_PROJECT:-}" ]]; then
  JULIA_PROJECT_FLAG="--project=${JULIA_PROJECT}"
elif [[ -z "${JULIA_NO_PROJECT:-}" ]]; then
  # Default: use a per-user stdlib env at ~/.julia/environments/regrets
  REGRETS_ENV="${HOME}/.julia/environments/regrets"
  if [[ ! -d "$REGRETS_ENV" ]]; then
    mkdir -p "$REGRETS_ENV"
    "$JULIA" --project="$REGRETS_ENV" -e 'using Pkg; Pkg.add("JSON"); Pkg.precompile()' >/dev/null 2>&1 || true
  fi
  JULIA_PROJECT_FLAG="--project=${REGRETS_ENV}"
fi

# ─── Helper: read Julia clusters from manifest (uses node for JSON parsing) ───
read_julia_clusters() {
  node -e "
    const m = JSON.parse(require('fs').readFileSync('$NODE_MANIFEST', 'utf8'));
    let clusters = (m.clusters || []).filter(c => (c.stack || '').toLowerCase() === 'julia');
    if ('$CLUSTER_FILTER') {
      clusters = clusters.filter(c => c.id === '$CLUSTER_FILTER');
    }
    console.log(JSON.stringify(clusters));
  "
}

# ─── Main: iterate clusters ───────────────────────────────────────────────────
CLUSTERS_JSON=$(read_julia_clusters)

CLUSTER_COUNT=$(echo "$CLUSTERS_JSON" | node -e "
  const cs = JSON.parse(require('fs').readFileSync(0,'utf8'));
  console.log(cs.length);
")

if [[ "$CLUSTER_COUNT" -eq 0 ]]; then
  echo "No Julia clusters found in manifest."
  exit 0
fi

echo "📡 Capturing Julia clusters..."
echo

PASS=0
FAIL=0

# Iterate clusters one at a time
for ((i=0; i<CLUSTER_COUNT; i++)); do
  CLUSTER_JSON=$(echo "$CLUSTERS_JSON" | node -e "
    const cs = JSON.parse(require('fs').readFileSync(0,'utf8'));
    console.log(JSON.stringify(cs[$i]));
  ")

  CLUSTER_ID=$(echo "$CLUSTER_JSON" | node -e "
    const c = JSON.parse(require('fs').readFileSync(0,'utf8'));
    process.stdout.write(c.id);
  ")

  CLUSTER_FILE=$(echo "$CLUSTER_JSON" | node -e "
    const c = JSON.parse(require('fs').readFileSync(0,'utf8'));
    process.stdout.write(c.file || '');
  ")

  CLUSTER_ENTRY=$(echo "$CLUSTER_JSON" | node -e "
    const c = JSON.parse(require('fs').readFileSync(0,'utf8'));
    process.stdout.write(c.entry);
  ")

  CLUSTER_WATCHES=$(echo "$CLUSTER_JSON" | node -e "
    const c = JSON.parse(require('fs').readFileSync(0,'utf8'));
    process.stdout.write(JSON.stringify(c.watches || []));
  ")

  echo "📡 Capturing: $CLUSTER_ID"
  echo "   File:    $CLUSTER_FILE"
  echo "   Entry:   $CLUSTER_ENTRY"

  # Sanitize cluster ID for use in file paths (replace non-identifier chars with _)
  CLUSTER_SAFE=$(echo "$CLUSTER_ID" | sed 's/[^A-Za-z0-9_]/_/g')

  # Generate harness
  HARNESS_FILE="/tmp/regret_harness_julia_${CLUSTER_SAFE}_$$.jl"
  if ! node "$SCRIPT_DIR/_julia_harness_gen.cjs" "$CLUSTER_JSON" "$HARNESS_FILE" "$SCRIPT_DIR" 2>&1; then
    echo "   ❌ Failed to generate harness"
    FAIL=$((FAIL + 1))
    continue
  fi

  # Run harness
  RUN_LOG="/tmp/regret_harness_julia_${CLUSTER_SAFE}_$$.run.log"
  if ! "$JULIA" $JULIA_PROJECT_FLAG "$HARNESS_FILE" > "$RUN_LOG" 2>&1; then
    echo "   ❌ Run failed:"
    tail -10 "$RUN_LOG" | sed 's/^/      /'
    rm -f "$HARNESS_FILE" "$RUN_LOG"
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
    rm -f "$HARNESS_FILE" "$RUN_LOG"
    FAIL=$((FAIL + 1))
    continue
  fi

  INPUT_VAL="${INPUT_LINE#REGRET_INPUT }"
  OUTPUT_VAL="${OUTPUT_LINE#REGRET_OUTPUT }"

  # Trivial-input guard — skip null/undefined outputs (matches other stacks)
  if [[ "$OUTPUT_VAL" == "null" || "$OUTPUT_VAL" == "undefined" || -z "$OUTPUT_VAL" ]]; then
    echo "   ⚠️  Skipping: trivial output ($OUTPUT_VAL)"
    rm -f "$HARNESS_FILE" "$RUN_LOG"
    continue
  fi

  # Write .regret file
  REGRET_FILE="$REGRET_DIR/${CLUSTER_ID}.regret"
  CAPTURED_AT=$(date -u +"%Y-%m-%dT%H:%M:%S.%3NZ")

  cat > "$REGRET_FILE" <<EOF
cluster: $CLUSTER_ID
version: 1
fingerprint: $HASH_VAL
captured: $CAPTURED_AT
watches: $CLUSTER_WATCHES
entry: $CLUSTER_ENTRY
stack: julia
fingerprintLevel: entry
file: $CLUSTER_FILE
---
INPUT  $INPUT_VAL
OUTPUT $OUTPUT_VAL
HASH   $HASH_VAL
EOF

  echo "   ✅ Fingerprint: $HASH_VAL"
  echo "   📄 Saved: $REGRET_FILE"

  PASS=$((PASS + 1))
  rm -f "$HARNESS_FILE" "$RUN_LOG"
done

echo
echo "──────────────────────────────────────────────────────────"
echo "Capture complete: $PASS captured, $FAIL failed"

if [[ "$FAIL" -gt 0 ]]; then
  exit 1
fi

echo
echo "Next: bash scripts/validate_julia.sh"
echo "If all green → you are clear to refactor."

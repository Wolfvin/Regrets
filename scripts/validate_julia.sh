#!/usr/bin/env bash
# validate_julia.sh — regression validator for Julia clusters.
#
# Reads .regret files, regenerates a Julia harness per cluster that re-invokes
# the entry function with the .regret's INPUT, computes a new hash, and compares
# it with the golden HASH. Reports PASS/FAIL.
#
# Usage:
#   bash scripts/validate_julia.sh
#   bash scripts/validate_julia.sh --cluster slugify
#   bash scripts/validate_julia.sh --manifest ./manifest.json
#   bash scripts/validate_julia.sh --fail-fast          # stop on first FAIL
#
# Exit code: 0 if all clusters PASS, 1 if any FAIL.

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SKILL_DIR="$(dirname "$SCRIPT_DIR")"
PROJECT_DIR="$(pwd)"
MANIFEST="${PROJECT_DIR}/regrets/manifest.json"
REGRET_DIR="${PROJECT_DIR}/regrets"

# ─── Parse CLI args ───────────────────────────────────────────────────────────
CLUSTER_FILTER=""
MANIFEST_FLAG=""
FAIL_FAST=0

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
    --fail-fast)
      FAIL_FAST=1
      shift
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

# ─── Locate Julia binary ──────────────────────────────────────────────────────
JULIA="${JULIA:-julia}"
if ! command -v "$JULIA" >/dev/null 2>&1; then
  echo "❌ Julia not found on PATH." >&2
  echo "   Install Julia (https://julialang.org/install/) or set JULIA=/path/to/julia" >&2
  exit 1
fi

# ─── Determine Julia project env (same logic as capture_julia.sh) ─────────────
JULIA_PROJECT_FLAG=""
if [[ -n "${JULIA_PROJECT:-}" ]]; then
  JULIA_PROJECT_FLAG="--project=${JULIA_PROJECT}"
elif [[ -z "${JULIA_NO_PROJECT:-}" ]]; then
  REGRETS_ENV="${HOME}/.julia/environments/regrets"
  if [[ ! -d "$REGRETS_ENV" ]]; then
    mkdir -p "$REGRETS_ENV"
    "$JULIA" --project="$REGRETS_ENV" -e 'using Pkg; Pkg.add("JSON"); Pkg.precompile()' >/dev/null 2>&1 || true
  fi
  JULIA_PROJECT_FLAG="--project=${REGRETS_ENV}"
fi

# ─── Helper: read Julia clusters from manifest ────────────────────────────────
read_julia_clusters() {
  node -e "
    const m = JSON.parse(require('fs').readFileSync('$MANIFEST', 'utf8'));
    let clusters = (m.clusters || []).filter(c => (c.stack || '').toLowerCase() === 'julia');
    if ('$CLUSTER_FILTER') {
      clusters = clusters.filter(c => c.id === '$CLUSTER_FILTER');
    }
    console.log(JSON.stringify(clusters));
  "
}

CLUSTERS_JSON=$(read_julia_clusters)
CLUSTER_COUNT=$(echo "$CLUSTERS_JSON" | node -e "
  const cs = JSON.parse(require('fs').readFileSync('/dev/stdin','utf8'));
  console.log(cs.length);
")

if [[ "$CLUSTER_COUNT" -eq 0 ]]; then
  echo "No Julia clusters found in manifest."
  exit 0
fi

echo
echo "🔍 Validating $CLUSTER_COUNT Julia cluster(s)..."
echo

PASS=0
FAIL=0
FAILED_CLUSTERS=()

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

  REGRET_FILE="$REGRET_DIR/${CLUSTER_ID}.regret"

  if [[ ! -f "$REGRET_FILE" ]]; then
    echo "  ❌ $CLUSTER_ID  MISSING .regret file: $REGRET_FILE"
    FAIL=$((FAIL + 1))
    FAILED_CLUSTERS+=("$CLUSTER_ID")
    if [[ "$FAIL_FAST" -eq 1 ]]; then
      break
    fi
    continue
  fi

  # Read golden hash from .regret file
  GOLDEN_HASH=$(grep '^HASH ' "$REGRET_FILE" | awk '{print $2}')

  # Sanitize cluster ID for use in file paths
  CLUSTER_SAFE=$(echo "$CLUSTER_ID" | sed 's/[^A-Za-z0-9_]/_/g')

  # Generate harness (same as capture)
  HARNESS_FILE="/tmp/regret_validate_julia_${CLUSTER_SAFE}_$$.jl"
  if ! node "$SCRIPT_DIR/_julia_harness_gen.cjs" "$CLUSTER_JSON" "$HARNESS_FILE" "$SCRIPT_DIR" 2>&1; then
    echo "  ❌ $CLUSTER_ID  Failed to generate harness"
    FAIL=$((FAIL + 1))
    FAILED_CLUSTERS+=("$CLUSTER_ID")
    if [[ "$FAIL_FAST" -eq 1 ]]; then
      break
    fi
    continue
  fi

  # Run harness
  RUN_LOG="/tmp/regret_validate_julia_${CLUSTER_SAFE}_$$.run.log"
  if ! "$JULIA" $JULIA_PROJECT_FLAG "$HARNESS_FILE" > "$RUN_LOG" 2>&1; then
    echo "  ❌ $CLUSTER_ID  Run failed:"
    tail -5 "$RUN_LOG" | sed 's/^/      /'
    FAIL=$((FAIL + 1))
    FAILED_CLUSTERS+=("$CLUSTER_ID")
    rm -f "$HARNESS_FILE" "$RUN_LOG"
    if [[ "$FAIL_FAST" -eq 1 ]]; then
      break
    fi
    continue
  fi

  # Parse harness output
  LIVE_HASH=$(grep '^REGRET_HASH ' "$RUN_LOG" | awk '{print $2}')

  rm -f "$HARNESS_FILE" "$RUN_LOG"

  if [[ -z "$LIVE_HASH" ]]; then
    echo "  ❌ $CLUSTER_ID  No hash produced by harness"
    FAIL=$((FAIL + 1))
    FAILED_CLUSTERS+=("$CLUSTER_ID")
    if [[ "$FAIL_FAST" -eq 1 ]]; then
      break
    fi
    continue
  fi

  if [[ "$LIVE_HASH" == "$GOLDEN_HASH" ]]; then
    printf "  ✅ %-35s %s  PASS\n" "$CLUSTER_ID" "$LIVE_HASH"
    PASS=$((PASS + 1))
  else
    printf "  ❌ %-35s %s → %s  FAIL\n" "$CLUSTER_ID" "$GOLDEN_HASH" "$LIVE_HASH"
    FAIL=$((FAIL + 1))
    FAILED_CLUSTERS+=("$CLUSTER_ID")
    if [[ "$FAIL_FAST" -eq 1 ]]; then
      break
    fi
  fi
done

echo
echo "────────────────────────────────────────────────────────────────"
if [[ "$FAIL" -eq 0 ]]; then
  echo "✅ All $PASS tests passed. Refactor is safe."
  exit 0
else
  echo "❌ $FAIL/$((PASS + FAIL)) FAILED."
  echo
  for c in "${FAILED_CLUSTERS[@]}"; do
    echo "  • $c"
  done
  echo
  echo "Fix the CODE — do not edit .regret files."
  echo "Re-run: bash scripts/validate_julia.sh"
  exit 1
fi

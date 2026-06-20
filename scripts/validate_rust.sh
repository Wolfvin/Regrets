#!/usr/bin/env bash
# validate_rust.sh — validate Rust clusters against stored .regret files
#
# Reads manifest.json to find Rust clusters, reads corresponding .regret files,
# re-invokes the target functions, recomputes fingerprints, and reports PASS/FAIL.
#
# This script generates a temporary Rust integration test from manifest + .regret
# data, then runs `cargo test` to execute validation.
#
# Usage:
#   bash scripts/validate_rust.sh                          # validate all Rust clusters
#   bash scripts/validate_rust.sh --cluster rust-add       # validate specific cluster
#   bash scripts/validate_rust.sh --verbose                # show detailed output
#   bash scripts/validate_rust.sh --project ./references/rust  # specify project dir
#
# Prerequisites:
#   - Rust toolchain (cargo, rustc) installed
#   - .regret files exist (run capture first)
#   - The target Rust crate has a test that implements function dispatch
#
# .regret file format (must be compatible with JS/Python stacks):
#   cluster: <id>
#   version: 1
#   fingerprint: <7-char hash>
#   captured: <ISO timestamp>
#   watches: [<watch1>, <watch2>]
#   entry: <function name>
#   stack: rust
#   fingerprintLevel: entry
#   ---
#   INPUT  <json>
#   OUTPUT <json>
#   HASH   <7-char hash>

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SKILL_DIR="$(dirname "$SCRIPT_DIR")"
PROJECT_DIR="$(pwd)"
MANIFEST="${PROJECT_DIR}/regrets/manifest.json"
REGRET_DIR="${PROJECT_DIR}/regrets"

# Parse CLI flags
CLUSTER_FILTER=""
VERBOSE=false
PROJECT_PATH=""

for arg in "$@"; do
  case "$arg" in
    --cluster)
      shift
      CLUSTER_FILTER="$1"
      ;;
    --verbose)
      VERBOSE=true
      ;;
    --project)
      shift
      PROJECT_PATH="$1"
      ;;
    --help|-h)
      echo "Usage: bash scripts/validate_rust.sh [OPTIONS]"
      echo ""
      echo "Options:"
      echo "  --cluster <id>   Validate only the specified cluster"
      echo "  --verbose        Show detailed output"
      echo "  --project <dir>  Path to Rust project directory (default: current dir)"
      echo "  --help           Show this help message"
      exit 0
      ;;
  esac
done

# If --project specified, change to that directory
if [[ -n "$PROJECT_PATH" ]]; then
  PROJECT_DIR="$(cd "$PROJECT_PATH" && pwd)"
  MANIFEST="${PROJECT_DIR}/regrets/manifest.json"
  REGRET_DIR="${PROJECT_DIR}/regrets"
fi

# Check prerequisites
if ! command -v cargo &> /dev/null; then
  echo "❌ Cargo is not installed. Install Rust toolchain to use the Rust stack."
  echo "   See: https://rustup.rs/"
  exit 1
fi

if [[ ! -f "$MANIFEST" ]]; then
  echo "❌ regrets/manifest.json not found at ${MANIFEST}"
  echo "   Run this script from the project root, or use --project <dir>."
  exit 1
fi

# ─── Read Rust clusters from manifest ────────────────────────────────────────

CLUSTERS_JSON=$(node -e "
  const m = JSON.parse(require('fs').readFileSync('${MANIFEST}', 'utf8'));
  let clusters = m.clusters.filter(c => c.stack === 'rust');
  if ('${CLUSTER_FILTER}') {
    clusters = clusters.filter(c => c.id === '${CLUSTER_FILTER}');
  }
  if (clusters.length === 0) {
    console.error('No Rust clusters found in manifest.');
    process.exit(1);
  }
  console.log(JSON.stringify(clusters, null, 2));
")

if [[ "$VERBOSE" == "true" ]]; then
  echo "📋 Rust clusters found:"
  echo "$CLUSTERS_JSON" | node -e "
    const clusters = JSON.parse(require('fs').readFileSync('/dev/stdin', 'utf8'));
    clusters.forEach(c => console.log('  - ' + c.id + ' (' + c.entry + ')'));
  "
fi

# ─── Check .regret files exist ───────────────────────────────────────────────

MISSING=0
CLUSTER_IDS=$(echo "$CLUSTERS_JSON" | node -e "
  const clusters = JSON.parse(require('fs').readFileSync('/dev/stdin', 'utf8'));
  clusters.forEach(c => console.log(c.id));
")

for id in $CLUSTER_IDS; do
  REGRET_FILE="${REGRET_DIR}/${id}.regret"
  if [[ ! -f "$REGRET_FILE" ]]; then
    echo "⚠️  Missing .regret file for cluster '${id}': ${REGRET_FILE}"
    echo "   Run capture first: cargo test --test regret_runner -- capture"
    MISSING=$((MISSING + 1))
  fi
done

if [[ $MISSING -gt 0 ]]; then
  echo "❌ ${MISSING} cluster(s) missing .regret files. Run capture first."
  exit 1
fi

# ─── Run validation ──────────────────────────────────────────────────────────
# The validation is done by the Rust integration test (regret_runner.rs) which:
# 1. Reads manifest.json to find Rust clusters
# 2. Reads .regret files for each cluster
# 3. Re-invokes the function with stored input
# 4. Recomputes fingerprint
# 5. Compares with stored fingerprint → PASS/FAIL

echo "🔍 Validating Rust clusters..."

cd "$PROJECT_DIR"

# Run the validate test
if [[ "$VERBOSE" == "true" ]]; then
  cargo test --test regret_runner -- validate --nocapture 2>&1
else
  cargo test --test regret_runner -- validate --nocapture 2>&1 | grep -E '(PASS|FAIL|SKIP|complete|error)'
fi

EXIT_CODE=$?

if [[ $EXIT_CODE -eq 0 ]]; then
  echo "✅ All Rust clusters validated successfully."
else
  echo "❌ Validation failed. Check output above for details."
fi

exit $EXIT_CODE

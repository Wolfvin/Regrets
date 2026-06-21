#!/usr/bin/env bash
# capture_rust.sh — compile + run regret capture for Rust clusters
#
# Reads manifest.json to find Rust clusters, invokes the target functions with
# the specified inputs, computes fingerprints, and writes .regret files.
#
# This script delegates to the Rust integration test runner (regret_runner.rs)
# which handles the actual function invocation and .regret file generation.
#
# Usage:
#   bash scripts/capture_rust.sh                          # capture all Rust clusters
#   bash scripts/capture_rust.sh --cluster rust-add       # capture specific cluster
#   bash scripts/capture_rust.sh --project ./references/rust  # specify project dir
#   bash scripts/capture_rust.sh --verbose                # show detailed output
#
# Prerequisites:
#   - Rust toolchain (cargo, rustc) installed
#   - Target crate has a test/regret_runner.rs with function dispatch
#   - regrets/manifest.json exists with stack=rust clusters
#
# .regret file format (compatible with JS/Python stacks):
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

# Use while+shift (NOT for arg in "$@") so flag-value pairs parse correctly
# regardless of order. The for-loop pattern with shift is buggy when multiple
# value-taking flags are present (e.g. `--project X --cluster Y` mis-assigns
# CLUSTER_FILTER=--cluster).
while [[ $# -gt 0 ]]; do
  case "$1" in
    --cluster)
      CLUSTER_FILTER="$2"
      shift 2
      ;;
    --verbose)
      VERBOSE=true
      shift
      ;;
    --project)
      PROJECT_PATH="$2"
      shift 2
      ;;
    --help|-h)
      echo "Usage: bash scripts/capture_rust.sh [OPTIONS]"
      echo ""
      echo "Options:"
      echo "  --cluster <id>   Capture only the specified cluster"
      echo "  --verbose        Show detailed output"
      echo "  --project <dir>  Path to Rust project directory (default: current dir)"
      echo "  --help           Show this help message"
      exit 0
      ;;
    *)
      echo "Unknown flag: $1" >&2
      exit 2
      ;;
  esac
done

# If --project specified, change to that directory
if [[ -n "$PROJECT_PATH" ]]; then
  PROJECT_DIR="$(cd "$PROJECT_PATH" && pwd)"
  MANIFEST="${PROJECT_DIR}/regrets/manifest.json"
  REGRET_DIR="${PROJECT_DIR}/regrets"
fi

# If a cluster filter was set, export it so the Rust test runner honors it
# (the bash-side manifest filter alone doesn't affect what cargo test runs).
if [[ -n "$CLUSTER_FILTER" ]]; then
  export REGRET_CLUSTER_FILTER="$CLUSTER_FILTER"
fi

# Ensure regrets directory exists
mkdir -p "$REGRET_DIR"

# Check prerequisites
if ! command -v cargo &> /dev/null; then
  echo "⚠️  Cargo is not installed. Install Rust toolchain to use the Rust stack."
  echo "   See: https://rustup.rs/"
  echo ""
  echo "   Alternatively, use the JS capture script for manifest processing:"
  echo "   node ${SKILL_DIR}/scripts/capture.js ${CLUSTER_FLAG:-}"
  exit 0
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

echo "📡 Capturing Rust clusters..."

if [[ "$VERBOSE" == "true" ]]; then
  echo "📋 Rust clusters found:"
  echo "$CLUSTERS_JSON" | node -e "
    const clusters = JSON.parse(require('fs').readFileSync('/dev/stdin', 'utf8'));
    clusters.forEach(c => console.log('  - ' + c.id + ' (' + c.entry + ')'));
  "
fi

# ─── Run capture ─────────────────────────────────────────────────────────────
# The capture is done by the Rust integration test (regret_runner.rs) which:
# 1. Reads manifest.json to find Rust clusters
# 2. For each cluster, calls the entry function with each input
# 3. Computes fingerprint (SHA-256 → base36 → 7 chars)
# 4. Writes .regret files with the standard format

cd "$PROJECT_DIR"

# Build first to ensure modules are compiled
if [[ "$VERBOSE" == "true" ]]; then
  cargo build 2>&1 || true
else
  cargo build 2>/dev/null || true
fi

# Run capture test
if [[ "$VERBOSE" == "true" ]]; then
  cargo test --test regret_runner -- capture --nocapture 2>&1
else
  cargo test --test regret_runner -- capture --nocapture 2>&1 | grep -E '(Capturing|Cluster|Fingerprint|Written|complete|error)'
fi

EXIT_CODE=$?

if [[ $EXIT_CODE -eq 0 ]]; then
  echo "✅ Capture complete. .regret files written to ${REGRET_DIR}/"
else
  echo "⚠️  Capture test failed. Possible causes:"
  echo "   - No tests/regret_runner.rs with capture function dispatch"
  echo "   - Target functions not found or signature mismatch"
  echo ""
  echo "   For a working example, see references/rust/"
fi

exit $EXIT_CODE

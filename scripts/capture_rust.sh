#!/usr/bin/env bash
# capture_rust.sh — compile + run regret capture for Rust clusters
# ⚠️  EXPERIMENTAL — This script is a proof-of-concept. The test runner
#     (regret_capture.rs) must be generated manually from manifest.json.
#     There is no auto-generator yet. Fallback to JS capture for manifest
#     processing if Rust test files don't exist.
#
# Usage:
#   bash scripts/capture_rust.sh               # capture all Rust clusters
#   bash scripts/capture_rust.sh validate       # validate all Rust clusters
#   bash scripts/capture_rust.sh health         # health report
#   bash scripts/capture_rust.sh --cluster rust-format-period

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SKILL_DIR="$(dirname "$SCRIPT_DIR")"
PROJECT_DIR="$(pwd)"
MANIFEST="${PROJECT_DIR}/regrets/manifest.json"
REGRET_DIR="${PROJECT_DIR}/regrets"

# Ensure regrets directory exists
mkdir -p "$REGRET_DIR"

MODE="${1:-capture}"
CLUSTER_FLAG=""

# Parse --cluster flag
for arg in "$@"; do
  if [[ "$arg" == "--cluster" ]]; then
    shift
    CLUSTER_FLAG="--cluster $1"
    break
  fi
done

# Generate the test runner from manifest
# This creates a temporary Rust test file that:
# 1. Reads manifest.json
# 2. For each cluster with stack=rust:
#    - Imports the target module
#    - Wraps watched functions with GhostRecorder
#    - Calls entry function with provided inputs
#    - Computes fingerprint
#    - Writes .regret file

case "$MODE" in
  capture)
    echo "📡 Capturing Rust clusters..."
    # Build first to ensure modules are compiled
    cargo build 2>/dev/null || true
    # Run capture test — outputs to stdout, we parse and write .regret files
    cargo test --test regret_capture -- --nocapture 2>/dev/null || {
      echo "⚠️  No regret_capture test found. Run: cargo regret init"
      echo "   This generates tests/regret_capture.rs from your manifest.json"
      echo ""
      echo "   Alternatively, use the JS capture script for manifest processing:"
      echo "   node ${SKILL_DIR}/scripts/capture.js ${CLUSTER_FLAG}"
    }
    ;;
  validate)
    echo "🔍 Validating Rust clusters..."
    cargo test --test regret_validate -- --nocapture 2>/dev/null || {
      echo "⚠️  No regret_validate test found."
      echo "   Using JS validator as fallback:"
      echo "   node ${SKILL_DIR}/scripts/validate.js ${CLUSTER_FLAG}"
    }
    ;;
  health)
    node "$SKILL_DIR/scripts/health.js"
    ;;
  *)
    echo "Usage: bash scripts/capture_rust.sh [capture|validate|health] [--cluster <id>]"
    exit 1
    ;;
esac

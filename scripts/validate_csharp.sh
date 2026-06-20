#!/usr/bin/env bash
# validate_csharp.sh — validate C# clusters against .regret files
# Reads .regret files, re-computes fingerprints, and reports PASS/FAIL.
#
# Usage:
#   bash scripts/validate_csharp.sh                                # validate all C# clusters (golden file check only)
#   bash scripts/validate_csharp.sh --cluster add                  # validate single cluster
#   bash scripts/validate_csharp.sh --pre-computed <file>          # re-invoke via pre-computed outputs (detect regressions)
#   bash scripts/validate_csharp.sh --fail-fast                    # exit on first FAIL
#
# Validation modes:
#   1. Default (no --pre-computed): reads each .regret file, re-computes
#      the fingerprint from the stored INPUT+OUTPUT, and verifies it matches
#      the stored HASH. This catches corrupted .regret files but NOT
#      regressions (it doesn't re-invoke the function).
#   2. --pre-computed <file>: additionally re-invokes each function (via
#      the pre-computed outputs) and compares the new fingerprint against
#      the golden hash. This detects regressions where the function's
#      behavior changed.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SKILL_DIR="$(dirname "$SCRIPT_DIR")"
PROJECT_DIR="$(pwd)"
MANIFEST="${PROJECT_DIR}/regrets/manifest.json"
REGRET_DIR="${PROJECT_DIR}/regrets"

# Parse CLI args
CLUSTER_FILTER=""
PRE_COMPUTED=""
FAIL_FAST=false
while [[ $# -gt 0 ]]; do
  case "$1" in
    --cluster) CLUSTER_FILTER="$2"; shift 2 ;;
    --pre-computed) PRE_COMPUTED="$2"; shift 2 ;;
    --fail-fast) FAIL_FAST=true; shift ;;
    *) shift ;;
  esac
done

if [ ! -f "$MANIFEST" ]; then
  echo "❌ regrets/manifest.json not found" >&2
  exit 1
fi

echo "🔍 Validating C# clusters..."

# Delegate to the Node.js helper for the actual validation logic.
# The helper uses the same fingerprint.js module as capture, ensuring
# cross-stack hash consistency.
node "$SCRIPT_DIR/validate_csharp_helper.mjs" \
  "$MANIFEST" \
  "$REGRET_DIR" \
  "$PRE_COMPUTED" \
  "$FAIL_FAST"

EXIT_CODE=$?
if [ $EXIT_CODE -eq 0 ]; then
  echo ""
  echo "✅ All C# clusters validated."
else
  echo ""
  echo "❌ Some C# clusters FAILED validation."
fi
exit $EXIT_CODE

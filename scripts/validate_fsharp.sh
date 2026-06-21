#!/usr/bin/env bash
# validate_fsharp.sh — invoke validate via F# harness project
#
# Reads .regret files for F# clusters, re-invokes the entry function,
# compares hash to stored HASH, reports PASS/FAIL.
#
# Usage:
#   bash scripts/validate_fsharp.sh
#   bash scripts/validate_fsharp.sh --cluster my-cluster
#   bash scripts/validate_fsharp.sh --fail-fast

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(pwd)"

if ! command -v dotnet >/dev/null 2>&1; then
  echo "❌ 'dotnet' command not found on PATH."
  exit 1
fi

HARNESS_DIR="$SCRIPT_DIR/fsharp_validate_harness"

if [ ! -d "$HARNESS_DIR" ]; then
  echo "❌ F# validate harness not found at $HARNESS_DIR"
  exit 1
fi

cd "$PROJECT_DIR"
dotnet run --project "$HARNESS_DIR" -- "$@"

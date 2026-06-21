#!/usr/bin/env bash
# capture_fsharp.sh — invoke capture via F# harness project
#
# Reads regrets/manifest.json, filters clusters with stack: "fsharp",
# invokes the entry function with each declared inputs[] value via a
# temporary F# harness project that references the target .fs file,
# computes the fingerprint, and writes a .regret file.
#
# Usage:
#   bash scripts/capture_fsharp.sh
#   bash scripts/capture_fsharp.sh --cluster my-cluster
#   bash scripts/capture_fsharp.sh --manifest ./regrets/manifest.json
#
# Requires: .NET SDK 8.0+ on PATH (dotnet command).

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SKILL_DIR="$(dirname "$SCRIPT_DIR")"
PROJECT_DIR="$(pwd)"

if ! command -v dotnet >/dev/null 2>&1; then
  echo "❌ 'dotnet' command not found on PATH."
  echo "   Install .NET SDK 8.0+ from https://dotnet.microsoft.com/download"
  echo "   Or: curl -sSL https://dot.net/v1/dotnet-install.sh -o /tmp/dotnet-install.sh && chmod +x /tmp/dotnet-install.sh && /tmp/dotnet-install.sh --channel 8.0 --install-dir /tmp/dotnet && export PATH=/tmp/dotnet:\$PATH"
  exit 1
fi

# The capture harness is a self-contained F# project at scripts/fsharp_capture_harness/
# that imports fingerprint_fsharp.fs + generates a per-cluster invocation program.
HARNESS_DIR="$SCRIPT_DIR/fsharp_capture_harness"

if [ ! -d "$HARNESS_DIR" ]; then
  echo "❌ F# capture harness not found at $HARNESS_DIR"
  exit 1
fi

cd "$PROJECT_DIR"
dotnet run --project "$HARNESS_DIR" -- "$@"

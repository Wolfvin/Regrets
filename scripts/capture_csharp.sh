#!/usr/bin/env bash
# capture_csharp.sh — run regret capture for C# clusters
#
# Wrapper that invokes the dotnet-based RegretRunner with mode=capture.
# This script is called by scripts/regret.js when stack=csharp is detected
# in regrets/manifest.json.
#
# Usage:
#   bash scripts/capture_csharp.sh                          # capture all C# clusters
#   bash scripts/capture_csharp.sh --cluster morse-encode   # capture one cluster
#   bash scripts/capture_csharp.sh validate                 # validate instead of capture
#   bash scripts/capture_csharp.sh update --cluster X --reason "..."
#
# Required: .NET 8+ SDK installed (`dotnet` on PATH).

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="${SCRIPT_DIR}/regret_csharp"
CWD="$(pwd)"

# ─── Pre-flight: check dotnet ─────────────────────────────────────────────────

if ! command -v dotnet &> /dev/null; then
  echo "❌ .NET SDK not found on PATH."
  echo "   Install .NET 8+ from: https://dot.net"
  echo "   Or set DOTNET_PATH=/path/to/dotnet before running."
  exit 127
fi

# ─── Mode detection ───────────────────────────────────────────────────────────
# First positional arg can be: capture (default), validate, update, list.
# Other args are passed through to RegretRunner.

MODE="capture"
if [[ $# -gt 0 ]]; then
  case "$1" in
    capture|validate|update|list)
      MODE="$1"
      shift
      ;;
    --cluster|--reason|--help|-h)
      # Pass through — caller invoked without explicit mode
      ;;
    *)
      echo "Unknown command: $1"
      echo "Usage: bash scripts/capture_csharp.sh [capture|validate|update|list] [--cluster <id>] [--reason \"...\"]"
      exit 1
      ;;
  esac
fi

# ─── Run ──────────────────────────────────────────────────────────────────────

# dotnet run will rebuild the project if source has changed.
# --project points to the .csproj file.
# We pass "$MODE" + remaining args after `--` (the args separator for dotnet run).
#
# IMPORTANT: dotnet run changes cwd to the project directory. We need to pass
# the user's original cwd via --workload so the runner can find regrets/manifest.json.
# As of .NET 8, `dotnet run` doesn't have a --cwd flag for the launched process,
# so we use the environment variable REGRET_PROJECT_ROOT instead, and the runner
# reads it as a fallback when regrets/manifest.json is not in the current dir.

export REGRET_PROJECT_ROOT="${CWD}"

cd "$PROJECT_DIR"
exec dotnet run --project "$PROJECT_DIR" --no-launch-profile -- "$MODE" "$@"

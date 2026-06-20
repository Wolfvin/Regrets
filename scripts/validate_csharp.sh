#!/usr/bin/env bash
# validate_csharp.sh — run regret validate for C# clusters
#
# Thin wrapper over capture_csharp.sh with mode=validate.
# Kept as a separate file to match the convention of other stacks
# (capture_<stack>.sh + validate_<stack>.sh), even though the underlying
# dotnet runner is shared.
#
# Usage:
#   bash scripts/validate_csharp.sh                          # validate all C# clusters
#   bash scripts/validate_csharp.sh --cluster morse-encode   # validate one cluster
#
# Required: .NET 8+ SDK installed (`dotnet` on PATH).

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Delegate to capture_csharp.sh with mode=validate.
# Pass all args through.
exec bash "${SCRIPT_DIR}/capture_csharp.sh" validate "$@"

#!/usr/bin/env bash
# validate_scala.sh — convenience wrapper that dispatches to capture_scala.sh
# with the "validate" mode. Kept as a separate script so the file naming pattern
# matches capture_<stack>/validate_<stack> used by other stacks (PHP, Perl).
#
# Usage:
#   bash scripts/validate_scala.sh
#   bash scripts/validate_scala.sh --cluster <id>
#   bash scripts/validate_scala.sh --fail-fast

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
exec bash "$SCRIPT_DIR/capture_scala.sh" validate "$@"

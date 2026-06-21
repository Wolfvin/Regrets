#!/usr/bin/env bash
# validate_dart.sh — invoke validate_dart.dart via `dart run`
#
# Reads .regret files for Dart clusters, re-invokes the entry function,
# compares hash to stored HASH, reports PASS/FAIL.
#
# Usage:
#   bash scripts/validate_dart.sh
#   bash scripts/validate_dart.sh --cluster my-cluster
#   bash scripts/validate_dart.sh --fail-fast
#   bash scripts/validate_dart.sh --update my-cluster --reason "..."

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SKILL_DIR="$(dirname "$SCRIPT_DIR")"
PROJECT_DIR="$(pwd)"

if ! command -v dart >/dev/null 2>&1; then
  echo "❌ 'dart' command not found on PATH."
  echo "   Install Dart SDK 3.0+ from https://dart.dev/get-dart"
  exit 1
fi

VALIDATE_SCRIPT="$SCRIPT_DIR/validate_dart.dart"

if [ ! -f "$VALIDATE_SCRIPT" ]; then
  echo "❌ validate_dart.dart not found at $VALIDATE_SCRIPT"
  exit 1
fi

cd "$PROJECT_DIR"
dart run --enable-asserts "$VALIDATE_SCRIPT" "$@"

#!/usr/bin/env bash
# capture_dart.sh — invoke capture_dart.dart via `dart run`
#
# Reads regrets/manifest.json, invokes entry function for each Dart cluster,
# writes .regret files with the standard format.
#
# Usage:
#   bash scripts/capture_dart.sh
#   bash scripts/capture_dart.sh --cluster my-cluster
#   bash scripts/capture_dart.sh --manifest ./regrets/manifest.json
#
# Requires: Dart SDK 3.0+ on PATH (dart command). The capture_dart.dart
# script imports from package:crypto — make sure that dependency is
# declared in pubspec.yaml at the repo root (or examples/dart/pubspec.yaml
# if running from there).

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SKILL_DIR="$(dirname "$SCRIPT_DIR")"
PROJECT_DIR="$(pwd)"

# Check dart is on PATH
if ! command -v dart >/dev/null 2>&1; then
  echo "❌ 'dart' command not found on PATH."
  echo "   Install Dart SDK 3.0+ from https://dart.dev/get-dart"
  echo "   Or: curl -sL https://storage.googleapis.com/dart-archive/channels/stable/release/latest/sdk/dartsdk-linux-x64-release.zip -o /tmp/dart-sdk.zip"
  echo "       unzip -q /tmp/dart-sdk.zip -d /tmp && export PATH=/tmp/dart-sdk/bin:\$PATH"
  exit 1
fi

# Resolve the script path (capture_dart.dart sits alongside this .sh)
CAPTURE_SCRIPT="$SCRIPT_DIR/capture_dart.dart"

if [ ! -f "$CAPTURE_SCRIPT" ]; then
  echo "❌ capture_dart.dart not found at $CAPTURE_SCRIPT"
  exit 1
  fi

# Run capture_dart.dart — pass through all CLI args
# We cd to PROJECT_DIR first so relative paths in manifest resolve correctly.
cd "$PROJECT_DIR"
dart run --enable-asserts "$CAPTURE_SCRIPT" "$@"

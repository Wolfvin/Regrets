#!/usr/bin/env bash
# capture_java.sh — capture regret contracts for Java clusters.
#
# Reads regrets/manifest.json, filters clusters with `stack: "java"`,
# invokes the target static method via reflection, computes the
# 7-char base36 fingerprint, and writes `.regret` files in the same
# format as capture.js / capture.py.
#
# Usage:
#   bash scripts/capture_java.sh                # capture all Java clusters
#   bash scripts/capture_java.sh --cluster <id>
#   bash scripts/capture_java.sh --manifest <path>
#
# Requirements: JDK 16+ (single-file source mode).

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
JAVA_FILE="${SCRIPT_DIR}/regret_java/RegretJava.java"

if ! command -v java &> /dev/null; then
  echo "❌ java not found on PATH. Install JDK 16+ to use the Java stack."
  exit 1
fi

exec java "${JAVA_FILE}" capture "$@"

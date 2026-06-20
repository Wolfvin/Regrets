#!/usr/bin/env bash
# validate_java.sh — validate regret contracts for Java clusters.
#
# Reads regrets/manifest.json, filters clusters with `stack: "java"`,
# re-invokes each target static method with the INPUT stored in the
# `.regret` file, compares the recomputed hash against the golden HASH,
# and reports PASS/FAIL per cluster.
#
# Usage:
#   bash scripts/validate_java.sh                # validate all Java clusters
#   bash scripts/validate_java.sh --cluster <id>
#   bash scripts/validate_java.sh --manifest <path>
#
# Requirements: JDK 16+ (single-file source mode).

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
JAVA_FILE="${SCRIPT_DIR}/regret_java/RegretJava.java"

if ! command -v java &> /dev/null; then
  echo "❌ java not found on PATH. Install JDK 16+ to use the Java stack."
  exit 1
fi

exec java "${JAVA_FILE}" validate "$@"

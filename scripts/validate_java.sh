#!/usr/bin/env bash
# validate_java.sh — validate Java clusters against existing .regret files
#
# Re-runs each Java cluster's entry function with the input stored in its
# .regret file, computes the live fingerprint, and compares against the
# golden HASH. Prints PASS / FAIL per cluster.
#
# Usage:
#   bash scripts/validate_java.sh
#   bash scripts/validate_java.sh --cluster my-cluster
#   bash scripts/validate_java.sh --manifest ./regrets/manifest.json
#
# Environment:
#   JAVA_SRC        : colon-separated paths to add to classpath (default: src)
#   JAVA_CLASSPATH  : additional classpath entries (default: empty)
#
# Exit codes:
#   0 = all clusters PASS
#   1 = one or more clusters FAILED
#   2 = usage error / manifest unreadable

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SKILL_DIR="$(dirname "$SCRIPT_DIR")"
PROJECT_DIR="$(pwd)"

# ─── Verify java + javac are available ────────────────────────────────────────
if ! command -v javac &> /dev/null; then
  echo "❌ javac is not installed. Install a JDK (e.g. OpenJDK 21) to use the Java stack."
  exit 2
fi
if ! command -v java &> /dev/null; then
  echo "❌ java is not installed. Install a JDK to use the Java stack."
  exit 2
fi

# ─── Compile RegretJava.java + RegretRunner.java ─────────────────────────────
CLASSES_DIR="${PROJECT_DIR}/.regret-java-classes"
mkdir -p "$CLASSES_DIR"

if ! javac -proc:none -d "$CLASSES_DIR" \
    "${SCRIPT_DIR}/java/RegretJava.java" \
    "${SCRIPT_DIR}/java/RegretRunner.java" 2> "${CLASSES_DIR}/compile.log"; then
  echo "❌ Compilation of RegretJava.java / RegretRunner.java failed:"
  cat "${CLASSES_DIR}/compile.log"
  exit 2
fi

# ─── Build the user classpath ────────────────────────────────────────────────
USER_CP="${JAVA_SRC:-src}"
if [ -n "${JAVA_CLASSPATH:-}" ]; then
  USER_CP="${USER_CP}:${JAVA_CLASSPATH}"
fi
FULL_CP="${USER_CP}:${CLASSES_DIR}"

# ─── Dispatch to RegretRunner ────────────────────────────────────────────────
java -cp "$FULL_CP" io.github.wolfvin.regret.RegretRunner validate "$@"

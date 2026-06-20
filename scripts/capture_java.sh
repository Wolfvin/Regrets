#!/usr/bin/env bash
# capture_java.sh — capture regret fingerprints for Java clusters
#
# Compiles scripts/java/*.java into a temporary classes directory, then runs
# RegretRunner in capture mode with the user's classpath prepended. Reads
# regrets/manifest.json, finds stack=java clusters, invokes each entry
# function with its declared inputs, computes the fingerprint, and writes
# regrets/<cluster-id>.regret.
#
# Usage:
#   bash scripts/capture_java.sh
#   bash scripts/capture_java.sh --cluster my-cluster
#   bash scripts/capture_java.sh --manifest ./regrets/manifest.json
#
# Environment:
#   JAVA_SRC        : colon-separated paths to add to classpath (default: src)
#   JAVA_CLASSPATH  : additional classpath entries (default: empty)
#
# Exit codes:
#   0 = all captures succeeded
#   1 = one or more captures failed
#   2 = usage error / manifest unreadable

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SKILL_DIR="$(dirname "$SCRIPT_DIR")"
PROJECT_DIR="$(pwd)"
REGRET_DIR="${PROJECT_DIR}/regrets"

mkdir -p "$REGRET_DIR"

# ─── Verify java + javac are available ────────────────────────────────────────
if ! command -v javac &> /dev/null; then
  echo "❌ javac is not installed. Install a JDK (e.g. OpenJDK 21) to use the Java stack."
  echo "   The JRE alone is insufficient — RegretRunner must be compiled from source."
  exit 2
fi
if ! command -v java &> /dev/null; then
  echo "❌ java is not installed. Install a JDK to use the Java stack."
  exit 2
fi

# ─── Compile RegretJava.java + RegretRunner.java ─────────────────────────────
CLASSES_DIR="${PROJECT_DIR}/.regret-java-classes"
mkdir -p "$CLASSES_DIR"

# Always recompile — these files are tiny and it avoids stale-class bugs.
# Quiet mode: -proc:none disables annotation processing (faster, no warnings).
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

# Final classpath: user code first (so user classes take precedence), then
# the regret infra classes.
FULL_CP="${USER_CP}:${CLASSES_DIR}"

# ─── Dispatch to RegretRunner ────────────────────────────────────────────────
java -cp "$FULL_CP" io.github.wolfvin.regret.RegretRunner capture "$@"

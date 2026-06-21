#!/usr/bin/env bash
# validate_c.sh — validate regret contracts for C clusters.
#
# Reads regrets/manifest.json, filters clusters with `stack: "c"`,
# re-invokes each cluster's `entry` symbol with the INPUT stored in the
# `.regret` file, compares the recomputed hash against the golden HASH,
# and reports PASS/FAIL per cluster. Non-zero exit on any failure.
#
# Usage:
#   bash scripts/validate_c.sh                  # validate all C clusters
#   bash scripts/validate_c.sh --cluster <id>
#   bash scripts/validate_c.sh --manifest <path>
#
# Environment: same as capture_c.sh (C_SOURCES, C_INCLUDE, C_LIBS, CC).

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HARNESS_SRC="${SCRIPT_DIR}/regret_c/regret_harness.c"
HARNESS_HDR="${SCRIPT_DIR}/regret_c/regret.h"
PROJECT_DIR="$(pwd)"
BUILD_DIR="${PROJECT_DIR}/.regret-c-build"
RUNNER="${BUILD_DIR}/regret_runner"

if ! command -v "${CC:-gcc}" &> /dev/null; then
  echo "❌ C compiler (${CC:-gcc}) not found on PATH."
  echo "   Install gcc (or any C99 compiler) to use the C stack."
  exit 1
fi

ARGS=()
for arg in "$@"; do
  ARGS+=("$arg")
done

EXTRA_SOURCES=()
if [ -n "${C_SOURCES:-}" ]; then
  IFS=':' read -ra SRC_ARRAY <<< "$C_SOURCES"
  for s in "${SRC_ARRAY[@]}"; do
    [ -n "$s" ] && EXTRA_SOURCES+=("$s")
  done
fi

for candidate in "regret_adapter.c" "adapter.c" "src/regret_adapter.c"; do
  if [ -f "${PROJECT_DIR}/${candidate}" ]; then
    abs="${PROJECT_DIR}/${candidate}"
    already=0
    for s in "${EXTRA_SOURCES[@]}"; do
      case "$s" in
        /*) s_abs="$s" ;;
        *)  s_abs="${PROJECT_DIR}/${s}" ;;
      esac
      if [ "$s_abs" = "$abs" ]; then already=1; break; fi
    done
    if [ "$already" -eq 0 ]; then
      EXTRA_SOURCES+=("$abs")
    fi
  fi
done

mkdir -p "$BUILD_DIR"

INCLUDE_FLAGS=()
if [ -n "${C_INCLUDE:-}" ]; then
  IFS=':' read -ra INC_ARRAY <<< "$C_INCLUDE"
  for inc in "${INC_ARRAY[@]}"; do
    [ -n "$inc" ] && INCLUDE_FLAGS+=("-I${inc}")
  done
fi
INCLUDE_FLAGS+=("-I${SCRIPT_DIR}/regret_c")

EXTRA_LIBS=()
if [ -n "${C_LIBS:-}" ]; then
  IFS=':' read -ra LIB_ARRAY <<< "$C_LIBS"
  for lib in "${LIB_ARRAY[@]}"; do
    [ -n "$lib" ] && EXTRA_LIBS+=("-l${lib}")
  done
fi

echo "🔧 Compiling regret runner..."
set +e
"${CC:-gcc}" -std=c11 -O2 -Wall -Wno-unused-parameter \
  -rdynamic \
  "${HARNESS_SRC}" "${EXTRA_SOURCES[@]}" \
  "${INCLUDE_FLAGS[@]}" \
  -o "$RUNNER" \
  -lcrypto -ljson-c -ldl -lm \
  "${EXTRA_LIBS[@]}" \
  2>&1
COMPILE_RC=$?
set -e
if [ "$COMPILE_RC" -ne 0 ]; then
  echo "❌ Compilation failed (exit $COMPILE_RC)"
  exit 1
fi

exec "$RUNNER" validate "${ARGS[@]}"

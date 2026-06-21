#!/usr/bin/env bash
# capture_c.sh — capture regret contracts for C clusters.
#
# Reads regrets/manifest.json, filters clusters with `stack: "c"`,
# invokes each cluster's `entry` symbol via dlsym with the cluster's
# INPUT (JSON), receives the OUTPUT (JSON), computes the 7-char base36
# fingerprint (identical to fingerprint.js), and writes `.regret` files
# in the standard format.
#
# Usage:
#   bash scripts/capture_c.sh                  # capture all C clusters
#   bash scripts/capture_c.sh --cluster <id>
#   bash scripts/capture_c.sh --manifest <path>
#
# Environment:
#   C_SOURCES   : extra .c/.o files to compile into the runner (default: empty)
#   C_INCLUDE   : extra -I include paths (default: empty)
#   C_LIBS      : extra -l libraries (default: empty)
#   CC          : C compiler (default: gcc)
#
# Requirements: gcc (or any C99 compiler), libcrypto (OpenSSL), libjson-c,
# libdl (glibc).

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

# ─── Parse args ────────────────────────────────────────────────────────────
ARGS=()
for arg in "$@"; do
  ARGS+=("$arg")
done

# ─── Determine sources to compile ──────────────────────────────────────────
# Default: scan project root for adapter files (regret_adapter.c) + user sources.
# User can override via C_SOURCES env var (colon-separated, like PATH).
EXTRA_SOURCES=()
if [ -n "${C_SOURCES:-}" ]; then
  IFS=':' read -ra SRC_ARRAY <<< "$C_SOURCES"
  for s in "${SRC_ARRAY[@]}"; do
    [ -n "$s" ] && EXTRA_SOURCES+=("$s")
  done
fi

# Auto-discover common adapter file names in the project (only those NOT
# already passed via C_SOURCES, comparing absolute paths).
for candidate in "regret_adapter.c" "adapter.c" "src/regret_adapter.c"; do
  if [ -f "${PROJECT_DIR}/${candidate}" ]; then
    abs="${PROJECT_DIR}/${candidate}"
    already=0
    for s in "${EXTRA_SOURCES[@]}"; do
      # Normalize relative paths to absolute for comparison
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

# ─── Build the runner ──────────────────────────────────────────────────────
mkdir -p "$BUILD_DIR"

INCLUDE_FLAGS=()
if [ -n "${C_INCLUDE:-}" ]; then
  IFS=':' read -ra INC_ARRAY <<< "$C_INCLUDE"
  for inc in "${INC_ARRAY[@]}"; do
    [ -n "$inc" ] && INCLUDE_FLAGS+=("-I${inc}")
  done
fi
# Always include the regret.h directory
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
  echo "   Sources: ${HARNESS_SRC} ${EXTRA_SOURCES[*]}"
  echo "   Includes: ${INCLUDE_FLAGS[*]}"
  echo "   Libs: -lcrypto -ljson-c -ldl -lm ${EXTRA_LIBS[*]}"
  exit 1
fi

# ─── Run the runner in capture mode ────────────────────────────────────────
exec "$RUNNER" capture "${ARGS[@]}"

#!/usr/bin/env bash
# validate_cpp.sh — validate (or update) regret contracts for C++ clusters.
#
# Reads regrets/manifest.json, filters clusters with `stack: "cpp"`,
# re-invokes each cluster's `entry` symbol with the INPUT stored in the
# `.regret` file, compares the recomputed hash against the golden HASH,
# and reports PASS/FAIL per cluster. Non-zero exit on any failure.
#
# Usage:
#   bash scripts/validate_cpp.sh                              # validate all C++ clusters
#   bash scripts/validate_cpp.sh --cluster <id>
#   bash scripts/validate_cpp.sh --manifest <path>
#   bash scripts/validate_cpp.sh update --cluster <id> --reason "..."  # update mode (parity with JS/Python/Bash/Perl)
#
# Mode (optional first positional arg):
#   validate (default) — re-run + compare to golden, report PASS/FAIL
#   update              — re-run + rewrite .regret with new hash + append audit.log entry
#                        (requires --cluster <id> --reason "<≥4 words>")
#
# Environment: same as capture_cpp.sh (CPP_SOURCES, CPP_INCLUDE, CPP_LIBS, CXX).

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HARNESS_SRC="${SCRIPT_DIR}/regret_cpp/regret_harness.cpp"
HARNESS_HDR="${SCRIPT_DIR}/regret_cpp/regret.hpp"
PROJECT_DIR="$(pwd)"
BUILD_DIR="${PROJECT_DIR}/.regret-cpp-build"
RUNNER="${BUILD_DIR}/regret_runner"

if ! command -v "${CXX:-g++}" &> /dev/null; then
  echo "❌ C++ compiler (${CXX:-g++}) not found on PATH."
  echo "   Install g++ (or any C++17 compiler) to use the C++ stack."
  exit 1
fi

# Detect optional mode word as first positional arg (default: validate).
# Known modes: validate, update. (capture is handled by capture_cpp.sh.)
MODE="validate"
if [ $# -ge 1 ]; then
  case "$1" in
    validate|update) MODE="$1"; shift ;;
  esac
fi

ARGS=()
for arg in "$@"; do
  ARGS+=("$arg")
done

EXTRA_SOURCES=()
if [ -n "${CPP_SOURCES:-}" ]; then
  IFS=':' read -ra SRC_ARRAY <<< "$CPP_SOURCES"
  for s in "${SRC_ARRAY[@]}"; do
    [ -n "$s" ] && EXTRA_SOURCES+=("$s")
  done
fi

for candidate in "regret_adapter.cpp" "regret_adapter.cc" "adapter.cpp" \
                 "src/regret_adapter.cpp" "src/regret_adapter.cc"; do
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
if [ -n "${CPP_INCLUDE:-}" ]; then
  IFS=':' read -ra INC_ARRAY <<< "$CPP_INCLUDE"
  for inc in "${INC_ARRAY[@]}"; do
    [ -n "$inc" ] && INCLUDE_FLAGS+=("-I${inc}")
  done
fi
INCLUDE_FLAGS+=("-I${SCRIPT_DIR}/regret_cpp")

EXTRA_LIBS=()
if [ -n "${CPP_LIBS:-}" ]; then
  IFS=':' read -ra LIB_ARRAY <<< "$CPP_LIBS"
  for lib in "${LIB_ARRAY[@]}"; do
    [ -n "$lib" ] && EXTRA_LIBS+=("-l${lib}")
  done
fi

echo "🔧 Compiling regret runner (C++)..."
set +e
"${CXX:-g++}" -std=c++17 -O2 -Wall -Wno-unused-parameter \
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

exec "$RUNNER" "${MODE}" "${ARGS[@]}"

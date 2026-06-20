#!/usr/bin/env bash
# validate_rust.sh — validate Rust clusters against captured .regret files
#
# This is the proper Rust validator — counterpart to capture_rust.sh.
# capture_rust.sh delegates to `cargo test --test regret_capture` (which the
# user must generate manually per references/rust.md). validate_rust.sh takes
# a different approach: it invokes a Node-based runner that:
#   1. Reads regrets/manifest.json, filters to stack=rust clusters
#   2. For each cluster, reads the existing .regret file (INPUT/OUTPUT/HASH)
#   3. Invokes the user's Rust binary (cargoBin or a custom runner) with the
#      INPUT as JSON on stdin, expects JSON output on stdout
#   4. Recomputes the fingerprint using scripts/fingerprint.js (identical
#      algorithm to JS/Python/Go — cross-stack parity verified)
#   5. Reports PASS/FAIL with diff if hashes diverge
#
# Why a Node runner instead of `cargo test --test regret_validate`?
#   - fingerprint.js is already proven to produce identical hashes across
#     JS/Python/Go stacks; we reuse it for Rust too (no reimplementation).
#   - Node is already a hard dependency for Regrets (capture.js, validate.js).
#   - The user's Rust project only needs to expose ONE small CLI binary that
#     accepts JSON stdin → emits JSON stdout. This is far less invasive than
#     generating per-cluster tests/regret_validate.rs files.
#   - The CLI binary contract is documented in references/rust.md and
#     proof/rust/README.md.
#
# Usage:
#   bash scripts/validate_rust.sh                       # validate all Rust clusters
#   bash scripts/validate_rust.sh --cluster <id>        # validate one cluster
#   bash scripts/validate_rust.sh --fail-fast           # stop on first FAIL
#   bash scripts/validate_rust.sh --quiet               # summary line only
#   bash scripts/validate_rust.sh --verbose             # extra detail
#   bash scripts/validate_rust.sh --bin <path>          # override cargoBin
#   bash scripts/validate_rust.sh --runner <path>       # override runner script
#   bash scripts/validate_rust.sh --manifest <path>     # override manifest path

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SKILL_DIR="$(dirname "$SCRIPT_DIR")"
PROJECT_DIR="$(pwd)"
MANIFEST="${PROJECT_DIR}/regrets/manifest.json"
REGRET_DIR="${PROJECT_DIR}/regrets"

# Defaults
CLUSTER_FILTER=""
FAIL_FAST=0
QUIET=0
VERBOSE=0
BIN_OVERRIDE=""
RUNNER_OVERRIDE=""
MANIFEST_OVERRIDE=""

# ─── Parse args ──────────────────────────────────────────────────────────────
while [[ $# -gt 0 ]]; do
  case "$1" in
    --cluster)
      CLUSTER_FILTER="$2"
      shift 2
      ;;
    --fail-fast)
      FAIL_FAST=1
      shift
      ;;
    --quiet)
      QUIET=1
      shift
      ;;
    --verbose)
      VERBOSE=1
      shift
      ;;
    --bin)
      BIN_OVERRIDE="$2"
      shift 2
      ;;
    --runner)
      RUNNER_OVERRIDE="$2"
      shift 2
      ;;
    --manifest)
      MANIFEST_OVERRIDE="$2"
      MANIFEST="${MANIFEST_OVERRIDE}"
      shift 2
      ;;
    -h|--help)
      sed -n '2,/^$/p' "$0" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *)
      echo "❌ Unknown argument: $1" >&2
      echo "   Run with --help for usage." >&2
      exit 1
      ;;
  esac
done

if [[ ! -f "$MANIFEST" ]]; then
  echo "❌ Manifest not found: $MANIFEST" >&2
  echo "   Create regrets/manifest.json first. See SKILL.md for format." >&2
  exit 1
fi

# Ensure regrets directory exists
mkdir -p "$REGRET_DIR"

# ─── Pick the runner ─────────────────────────────────────────────────────────
# Default: Node-based runner that ships with Regrets.
# Override: user can pass --runner <path> to use a custom runner (any executable
# that accepts the same arg contract: --manifest <path> [--cluster <id>]
# [--fail-fast] [--quiet] [--verbose] [--bin <path>]).

if [[ -n "$RUNNER_OVERRIDE" ]]; then
  RUNNER="$RUNNER_OVERRIDE"
elif [[ -f "${SKILL_DIR}/scripts/validate_rust_runner.mjs" ]]; then
  RUNNER="node ${SKILL_DIR}/scripts/validate_rust_runner.mjs"
else
  echo "❌ validate_rust_runner.mjs not found at ${SKILL_DIR}/scripts/" >&2
  echo "   This file ships with Regrets — your install may be incomplete." >&2
  exit 1
fi

# ─── Build runner args ───────────────────────────────────────────────────────
RUNNER_ARGS=("--manifest" "$MANIFEST")
[[ -n "$CLUSTER_FILTER" ]] && RUNNER_ARGS+=("--cluster" "$CLUSTER_FILTER")
[[ "$FAIL_FAST" -eq 1 ]]   && RUNNER_ARGS+=("--fail-fast")
[[ "$QUIET" -eq 1 ]]       && RUNNER_ARGS+=("--quiet")
[[ "$VERBOSE" -eq 1 ]]    && RUNNER_ARGS+=("--verbose")
[[ -n "$BIN_OVERRIDE" ]]  && RUNNER_ARGS+=("--bin" "$BIN_OVERRIDE")

# ─── Run ─────────────────────────────────────────────────────────────────────
# We don't use `exec` because we want set -e to honor the runner's exit code
# while still allowing the runner's stderr/stdout to flow through.
$RUNNER "${RUNNER_ARGS[@]}"

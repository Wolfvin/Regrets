#!/usr/bin/env bash
# validate_crystal.sh — thin wrapper around capture_crystal.sh for the
# validate subcommand. Kept as a separate script so it's discoverable
# (matches the pattern of capture.lua / validate.lua in the Lua stack).
#
# Usage:
#   bash scripts/validate_crystal.sh
#   bash scripts/validate_crystal.sh --cluster <id>
#   bash scripts/validate_crystal.sh --fail-fast
#   bash scripts/validate_crystal.sh --update <id> --reason "..."
#   bash scripts/validate_crystal.sh --runs 5   # drift detection (basic)

set -euo pipefail

# If --runs is provided, do a basic drift detection: run validate N times
# and report any hash variation across runs.
RUNS=1
PASS_ARGS=()
for arg in "$@"; do
  if [[ "$arg" == "--runs" ]]; then
    : # handled in next iteration via $1
  fi
done

# Extract --runs value if present
i=0
args=("$@")
while [[ $i -lt ${#args[@]} ]]; do
  if [[ "${args[$i]}" == "--runs" ]] && [[ $((i + 1)) -lt ${#args[@]} ]]; then
    RUNS=${args[$((i + 1))]}
    # Remove --runs and its value from args
    unset 'args[i]'
    unset 'args[i+1]'
    # Re-index array
    args=("${args[@]}")
  fi
  i=$((i + 1))
done

if [[ $RUNS -gt 1 ]]; then
  echo "🔍 Drift detection — $RUNS runs per cluster..."
  echo
  drift_found=0
  for ((r=1; r<=RUNS; r++)); do
    echo "── Run $r/$RUNS ─────────────────────────────────────────"
    set +e
    bash "$(dirname "${BASH_SOURCE[0]}")/capture_crystal.sh" validate "${args[@]}"
    rc=$?
    set -e
    if [[ $rc -ne 0 ]]; then
      drift_found=1
    fi
    echo
  done
  if [[ $drift_found -eq 0 ]]; then
    echo "✅ No drift detected across $RUNS runs."
    exit 0
  else
    echo "❌ Drift detected (or validation failed) in at least one run."
    exit 1
  fi
else
  exec bash "$(dirname "${BASH_SOURCE[0]}")/capture_crystal.sh" validate "$@"
fi

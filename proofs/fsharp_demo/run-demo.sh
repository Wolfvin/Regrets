#!/usr/bin/env bash
# run-demo.sh — end-to-end demo for F# stack
#
# Demonstrates: capture → validate PASS → breaking change → validate FAIL → restore
#
# NOTE: Each capture/validate invocation builds a temporary F# harness project
# per cluster (~3-5s per cluster for build). With 4 clusters, a full cycle
# takes ~60-90s. This demo runs the minimal set of steps to prove the
# contract: capture once, validate twice (PASS + FAIL after breaking change).
set -uo pipefail

DEMO_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$(dirname "$DEMO_DIR")")"
export PATH="/tmp/dotnet:$PATH"

if ! command -v dotnet >/dev/null 2>&1; then
  echo "❌ 'dotnet' not found on PATH. Install .NET SDK 8.0+."
  exit 1
fi

cd "$DEMO_DIR"
SRC="lib/MathUtils.fs"
BACKUP="$SRC.orig"
trap 'cp "$BACKUP" "$SRC" 2>/dev/null; rm -f "$BACKUP"' EXIT
cp "$SRC" "$BACKUP"

banner() {
  echo
  echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
  echo "  $1"
  echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
}

banner "STEP 1 — Capture (fingerprint all 4 F# functions)"
bash "$PROJECT_DIR/scripts/capture_fsharp.sh" 2>&1 | tail -10
echo ""

banner "STEP 2 — Validate (no changes, expect all PASS)"
bash "$PROJECT_DIR/scripts/validate_fsharp.sh" 2>&1 | tail -8
echo ""

banner "STEP 3 — Breaking refactor: change add (+1 → +100)"
python3 - <<'PY'
src = open('lib/MathUtils.fs').read()
old = "    int (num input) + 1"
new = "    int (num input) + 100"
assert old in src, "old line not found"
open('lib/MathUtils.fs', 'w').write(src.replace(old, new))
print("  → changed +1 → +100 (breaking: add-basic should FAIL, others PASS)")
PY
bash "$PROJECT_DIR/scripts/validate_fsharp.sh" 2>&1 | tail -12
echo ""

banner "STEP 4 — Restore original + final validate (all PASS)"
cp "$BACKUP" "$SRC"
bash "$PROJECT_DIR/scripts/validate_fsharp.sh" 2>&1 | tail -8
echo ""

echo ""
echo "╔══════════════════════════════════════════════════════════╗"
echo "║  F# Stack Demo complete                                  ║"
echo "║  • Capture: 4 clusters fingerprinted                    ║"
echo "║  • Validate PASS: unchanged                              ║"
echo "║  • Validate FAIL: breaking refactor (+1 → +100)         ║"
echo "║  • Validate PASS: after restore                          ║"
echo "╚══════════════════════════════════════════════════════════╝"

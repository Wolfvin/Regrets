#!/usr/bin/env bash
# verify_demo.sh — end-to-end demonstration of C# Regrets capture + validate.
#
# This script runs THREE scenarios against the same .regret files:
#   1. Baseline (original Calculator.cs)            → all clusters PASS
#   2. Refactor (variants/Calculator_refactored.cs) → all clusters PASS
#      (different implementations, IDENTICAL behavior)
#   3. Breaking (variants/Calculator_broken.cs)     → clusters FAIL with diff
#
# The .regret files are NOT modified — they are the golden contracts.
# Only src/Calculator.cs is swapped between scenarios.
#
# Usage:
#   bash verify_demo.sh
#
# Prereqs:
#   - dotnet SDK 8+ on PATH (or set DOTNET_CMD=/path/to/dotnet)
#   - This script expects to be run from the proof/csharp-demo/ directory.

set -euo pipefail

DEMO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$DEMO_DIR"

REPO_ROOT="$(cd "$DEMO_DIR/../.." && pwd)"
CAPTURE="$REPO_ROOT/scripts/capture_csharp.sh"
VALIDATE="$REPO_ROOT/scripts/validate_csharp.sh"

ORIG="src/Calculator.cs"
REFACTORED="variants/Calculator_refactored.cs"
BROKEN="variants/Calculator_broken.cs"

banner() {
  echo
  echo "════════════════════════════════════════════════════════════════════════════"
  echo "  $1"
  echo "════════════════════════════════════════════════════════════════════════════"
}

# ─── Step 0: Pre-flight ──────────────────────────────────────────────────────
banner "Step 0: Verify all variant files exist"
for f in "$ORIG" "$REFACTORED" "$BROKEN"; do
  if [ ! -f "$f" ]; then
    echo "❌ Missing: $f" >&2
    exit 1
  fi
  echo "  ✓ $f"
done

# Make sure src/Calculator.cs is the original
cp "$ORIG" src/Calculator.cs.bak

# ─── Step 1: Capture (baseline) ──────────────────────────────────────────────
banner "Step 1: Capture baseline fingerprints (using original Calculator.cs)"
rm -f regrets/*.regret
bash "$CAPTURE"
echo
echo "  Generated .regret files:"
ls -1 regrets/*.regret | sed 's/^/    /'

# ─── Step 2: Validate baseline → should PASS ─────────────────────────────────
banner "Step 2: Validate baseline (original Calculator.cs, no code change)"
bash "$VALIDATE" || {
  echo "  ❌ Baseline validate FAILED — this is a bug in the demo, not the test."
  echo "     Restoring src/Calculator.cs and exiting."
  mv src/Calculator.cs.bak "$ORIG"
  exit 1
}

# ─── Step 3: Refactor — same behavior, different implementation ──────────────
banner "Step 3: Apply REFACTOR (behavior-preserving) — variants/Calculator_refactored.cs"
cp "$REFACTORED" "$ORIG"
echo "  Swapped src/Calculator.cs ← variants/Calculator_refactored.cs"
echo "  (Implementation changed; behavior identical. .regret files unchanged.)"
echo
echo "  Validate result (expect: ALL PASS):"
bash "$VALIDATE" || {
  echo
  echo "  ❌ Refactor validate FAILED — this means the refactor actually changed"
  echo "     behavior, OR the fingerprint algorithm is non-deterministic."
  echo "     Restoring original Calculator.cs and exiting."
  mv src/Calculator.cs.bak "$ORIG"
  exit 1
}

# ─── Step 4: Breaking change — different behavior ───────────────────────────
banner "Step 4: Apply BREAKING CHANGE — variants/Calculator_broken.cs"
cp "$BROKEN" "$ORIG"
echo "  Swapped src/Calculator.cs ← variants/Calculator_broken.cs"
echo "  (Behavior intentionally broken. .regret files unchanged.)"
echo
echo "  Validate result (expect: ALL FAIL with clear diff):"
set +e
bash "$VALIDATE"
RC=$?
set -e
echo
if [ $RC -eq 0 ]; then
  echo "  ⚠️  Breaking-change validate PASSED — this means the breaking changes"
  echo "     didn't actually change behavior, OR validate has a bug."
  echo "     Restoring original and exiting."
  mv src/Calculator.cs.bak "$ORIG"
  exit 1
else
  echo "  ✅ Breaking change correctly detected (validate exit code $RC)."
fi

# ─── Step 5: Restore original ────────────────────────────────────────────────
banner "Step 5: Restore original Calculator.cs and re-validate"
mv src/Calculator.cs.bak "$ORIG"
bash "$VALIDATE"

banner "Demo complete"
echo "  • Capture  → writes .regret files (golden contracts)"
echo "  • Validate → PASS when behavior unchanged (baseline + refactor)"
echo "  • Validate → FAIL with diff when behavior changed (breaking)"
echo "  • All scenarios behaved as expected ✅"

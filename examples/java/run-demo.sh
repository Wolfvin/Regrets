#!/usr/bin/env bash
# run-demo.sh — end-to-end demonstration of Java-stack regret capture/validate.
#
# Steps:
#   1. Compile Calculator.java (the user code) into a temp dir
#   2. Run capture_java.sh  → writes 6 .regret files into examples/java/regrets/
#   3. Run validate_java.sh → all 6 should PASS (code unchanged)
#   4. Swap in Calculator_breaking.java (refactor that changes output)
#   5. Run validate_java.sh again → clusters using the changed method should FAIL
#   6. Restore original Calculator.java and run validate one more time → PASS again
#
# This script is the manual verification referenced in the PR description.
# Run from the repo root:
#   bash examples/java/run-demo.sh

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
EXAMPLE_DIR="${REPO_ROOT}/examples/java"
WORK_DIR="${EXAMPLE_DIR}/_work"

cd "$REPO_ROOT"
echo "Repo root: $REPO_ROOT"
echo "Example dir: $EXAMPLE_DIR"
echo

# Clean slate
rm -rf "$WORK_DIR"
mkdir -p "$WORK_DIR/classes" "$WORK_DIR/breaking-classes" "$EXAMPLE_DIR/regrets"

# ─── Step 1: compile user code ───────────────────────────────────────────────
echo "━━━ Step 1: Compile Calculator.java ━━━"
javac -d "$WORK_DIR/classes" "$EXAMPLE_DIR/Calculator.java"
echo "✅ Compiled to $WORK_DIR/classes"
echo

# ─── Step 2: capture ─────────────────────────────────────────────────────────
echo "━━━ Step 2: Capture fingerprints (writes .regret files) ━━━"
JAVA_SRC="$WORK_DIR/classes" \
  bash scripts/capture_java.sh --manifest "$EXAMPLE_DIR/manifest.json" --regret-dir "$EXAMPLE_DIR/regrets"
echo
echo "Generated .regret files:"
ls -1 "$EXAMPLE_DIR/regrets"/*.regret 2>/dev/null || echo "  (none)"
echo

# Show one example .regret file
echo "Example .regret file (calculator-add.regret):"
cat "$EXAMPLE_DIR/regrets/calculator-add.regret"
echo
echo "Example .regret file (calculator-parsekv.regret) — note sorted keys in OUTPUT:"
cat "$EXAMPLE_DIR/regrets/calculator-parsekv.regret"
echo

# ─── Step 3: validate (should be all PASS) ───────────────────────────────────
echo "━━━ Step 3: Validate against unchanged code — expect ALL PASS ━━━"
JAVA_SRC="$WORK_DIR/classes" \
  bash scripts/validate_java.sh --manifest "$EXAMPLE_DIR/manifest.json" --regret-dir "$EXAMPLE_DIR/regrets"
echo

# ─── Step 4: simulate a breaking refactor ────────────────────────────────────
echo "━━━ Step 4: Swap in breaking refactor of Calculator ━━━"
# Calculator_breaking.java changes:
#   - add() now returns a+b+1  (off-by-one — silent breakage)
#   - toHex() uses lowercase   (format change — silent breakage)
#   - reverse() returns input unchanged (no-op — silent breakage)
# mul(), parseKv(), sumList() are unchanged.
javac -d "$WORK_DIR/breaking-classes" "$EXAMPLE_DIR/Calculator_breaking.java"

# Stash the original Calculator.class and substitute the broken one
cp "$WORK_DIR/classes/Calculator.class" "$WORK_DIR/classes/Calculator.class.orig"
cp "$WORK_DIR/breaking-classes/Calculator.class" "$WORK_DIR/classes/Calculator.class"
echo "Swapped Calculator.class with breaking version"
echo "   - add(a,b)   now returns a+b+1  (was a+b)"
echo "   - toHex(n)   now returns lowercase (was uppercase)"
echo "   - reverse(s) now returns s unchanged (was reversed)"
echo

# ─── Step 5: validate (should FAIL for changed methods, PASS for unchanged) ──
echo "━━━ Step 5: Validate against broken code — expect 3 FAIL + 3 PASS ━━━"
JAVA_SRC="$WORK_DIR/classes" \
  bash scripts/validate_java.sh --manifest "$EXAMPLE_DIR/manifest.json" --regret-dir "$EXAMPLE_DIR/regrets" || true
echo

# ─── Step 6: restore and validate again (should be PASS) ─────────────────────
echo "━━━ Step 6: Restore original Calculator.class ━━━"
cp "$WORK_DIR/classes/Calculator.class.orig" "$WORK_DIR/classes/Calculator.class"
echo "Restored"
echo
echo "━━━ Step 7: Final validate — expect ALL PASS ━━━"
JAVA_SRC="$WORK_DIR/classes" \
  bash scripts/validate_java.sh --manifest "$EXAMPLE_DIR/manifest.json" --regret-dir "$EXAMPLE_DIR/regrets"
echo

echo "━━━ Demo complete ━━━"
echo "All 6 clusters captured → validate PASS → 3 broke under refactor → restored → PASS again."

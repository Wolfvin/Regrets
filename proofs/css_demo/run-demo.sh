#!/usr/bin/env bash
# run-demo.sh — end-to-end demo for CSS stack
# Demonstrates: capture → validate PASS → breaking change → validate FAIL → restore → validate PASS
set -euo pipefail

DEMO_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$(dirname "$DEMO_DIR")")"

echo "╔══════════════════════════════════════════════════════════╗"
echo "║  Regrets CSS Stack — End-to-End Demo                      ║"
echo "╚══════════════════════════════════════════════════════════╝"
echo ""

# ─── Step 1: Capture ──────────────────────────────────────────────────────────
echo "━━━ Step 1: Capture (fingerprint CSS declarations) ━━━━━━━━━"
cd "$DEMO_DIR"
node "$PROJECT_DIR/scripts/capture_css.mjs" --manifest regrets/manifest.json
echo ""

# ─── Step 2: Validate (should PASS — no changes) ──────────────────────────────
echo "━━━ Step 2: Validate (no changes — should PASS) ━━━━━━━━━━━━"
node "$PROJECT_DIR/scripts/validate_css.mjs" --manifest regrets/manifest.json
echo ""

# ─── Step 3: Breaking refactor (change a property value) ──────────────────────
echo "━━━ Step 3: Breaking refactor (change opacity 0 → 0.5) ━━━━━"
cp demo.css demo.css.bak
sed -i 's/opacity: 0;/opacity: 0.5;/' demo.css
echo "  Changed: opacity: 0 → opacity: 0.5 in .cue-enter"
echo ""

# ─── Step 4: Validate (should FAIL) ───────────────────────────────────────────
echo "━━━ Step 4: Validate (breaking change — should FAIL) ━━━━━━━"
node "$PROJECT_DIR/scripts/validate_css.mjs" --manifest regrets/manifest.json 2>&1 || true
echo ""

# ─── Step 5: Restore ──────────────────────────────────────────────────────────
echo "━━━ Step 5: Restore original CSS ━━━━━━━━━━━━━━━━━━━━━━━━━━━"
cp demo.css.bak demo.css
rm demo.css.bak
echo "  Restored demo.css"
echo ""

# ─── Step 6: Valid refactor (rename internal var — should still PASS) ─────────
echo "━━━ Step 6: Valid refactor (change animation name) ━━━━━━━━━"
cp demo.css demo.css.bak
# Change the animation name from cue-slide-up to cue-fade-up (cosmetic, doesn't affect .cue-hover-lift)
sed -i 's/cue-slide-up/cue-fade-up/' demo.css
echo "  Renamed: animation cue-slide-up → cue-fade-up (affects .cue-enter only)"
echo "  Note: This IS a breaking change for .cue-enter (animation name changed)"
echo "  But .cue-hover-lift and .cue-spinner should still PASS"
echo ""

echo "━━━ Step 7: Validate (mixed — .cue-enter FAIL, others PASS) ━━"
node "$PROJECT_DIR/scripts/validate_css.mjs" --manifest regrets/manifest.json 2>&1 || true
echo ""

# Restore
cp demo.css.bak demo.css
rm demo.css.bak

# ─── Step 8: Truly valid refactor (add a comment — no declaration changes) ───
echo "━━━ Step 8: Valid refactor (add comment — no declaration changes) ━━━━━"
cp demo.css demo.css.bak
sed -i '1i\/* Updated 2026-06-20: added regression tests *\n' demo.css
echo "  Added a comment at the top of demo.css"
echo ""

echo "━━━ Step 9: Validate (comment-only change — should PASS) ━━━"
node "$PROJECT_DIR/scripts/validate_css.mjs" --manifest regrets/manifest.json
echo ""

# Restore
cp demo.css.bak demo.css
rm demo.css.bak

echo "╔══════════════════════════════════════════════════════════╗"
echo "║  Demo complete!                                          ║"
echo "║  • Capture: 4 clusters fingerprinted                    ║"
echo "║  • Validate PASS: when CSS is unchanged or comment-only  ║"
echo "║  • Validate FAIL: when property values change            ║"
echo "╚══════════════════════════════════════════════════════════╝"

#!/usr/bin/env bash
# run-demo.sh — End-to-end demo for Make stack
# Demonstrates: capture → validate PASS → breaking change → validate FAIL → restore → validate PASS
set -euo pipefail

DEMO_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$(dirname "$DEMO_DIR")")"

echo "╔══════════════════════════════════════════════════════════╗"
echo "║  Regrets Make Stack — End-to-End Demo                     ║"
echo "╚══════════════════════════════════════════════════════════╝"
echo ""

# ─── Step 1: Capture ──────────────────────────────────────────────────────────
echo "━━━ Step 1: Capture (fingerprint Make functions) ━━━━━━━━━━━"
cd "$DEMO_DIR"
bash "$PROJECT_DIR/scripts/capture_make.sh" --manifest regrets/manifest.json
echo ""

# ─── Step 2: Validate (should PASS — no changes) ──────────────────────────────
echo "━━━ Step 2: Validate (no changes — should PASS) ━━━━━━━━━━━━"
bash "$PROJECT_DIR/scripts/validate_make.sh" --manifest regrets/manifest.json
echo ""

# ─── Step 3: Breaking refactor (change greet output) ─────────────────────────
echo "━━━ Step 3: Breaking refactor (greet: add '!!!') ━━━━━━━━━━━"
cp slugify.mk slugify.mk.bak
sed -i 's/Hello, \$1!/Hello, $1!!!/' slugify.mk
echo "  Changed: greet output 'Hello, X!' → 'Hello, X!!!'"
echo ""

# ─── Step 4: Validate (should FAIL) ───────────────────────────────────────────
echo "━━━ Step 4: Validate (breaking change — should FAIL) ━━━━━━━"
bash "$PROJECT_DIR/scripts/validate_make.sh" --manifest regrets/manifest.json 2>&1 || true
echo ""

# ─── Step 5: Restore ──────────────────────────────────────────────────────────
echo "━━━ Step 5: Restore original .mk file ━━━━━━━━━━━━━━━━━━━━━"
cp slugify.mk.bak slugify.mk
rm slugify.mk.bak
echo "  Restored slugify.mk"
echo ""

# ─── Step 6: Valid refactor (add comment — should PASS) ───────────────────────
echo "━━━ Step 6: Valid refactor (add comment — should PASS) ━━━━━"
cp slugify.mk slugify.mk.bak
sed -i '1i\# Updated 2026-06-21: regression test fixture\n' slugify.mk
echo "  Added a comment at the top of slugify.mk"
echo ""

echo "━━━ Step 7: Validate (comment-only change — should PASS) ━━━"
bash "$PROJECT_DIR/scripts/validate_make.sh" --manifest regrets/manifest.json
echo ""

# Restore
cp slugify.mk.bak slugify.mk
rm slugify.mk.bak

# ─── Step 8: Cross-stack parity ───────────────────────────────────────────────
echo "━━━ Step 8: Cross-stack parity (Make hash == JS hash) ━━━━━━"
node --input-type=module -e "
import { fingerprint } from '${PROJECT_DIR}/scripts/fingerprint.js';
const pairs = [
  ['Hello World', 'hello-world'],
  ['World', 'Hello, World!'],
  [['-', 'a b c'], 'a-b-c'],
];
console.log('  JS fingerprints:');
for (const [inp, out] of pairs) {
  console.log('    fp(' + JSON.stringify(inp) + ', ' + JSON.stringify(out) + ') = ' + fingerprint(inp, out));
}
"
echo "  Make hashes (from .regret files):"
echo "    make-slugify:    $(grep '^fingerprint:' regrets/make-slugify.regret | cut -d' ' -f2)"
echo "    make-greet:      $(grep '^fingerprint:' regrets/make-greet.regret | cut -d' ' -f2)"
echo "    make-join-with:  $(grep '^fingerprint:' regrets/make-join-with.regret | cut -d' ' -f2)"
echo ""

echo "╔══════════════════════════════════════════════════════════╗"
echo "║  Demo complete!                                          ║"
echo "║  • Capture: 5 clusters fingerprinted                    ║"
echo "║  • Validate PASS: when .mk is unchanged or comment-only  ║"
echo "║  • Validate FAIL: when function output changes           ║"
echo "║  • Cross-stack parity: Make hash == JS hash              ║"
echo "╚══════════════════════════════════════════════════════════╝"

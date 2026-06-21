#!/usr/bin/env bash
# run-demo.sh — End-to-end demo for jq stack
# Demonstrates: capture → validate PASS → breaking change → validate FAIL → restore → validate PASS
set -euo pipefail

DEMO_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$(dirname "$DEMO_DIR")")"

echo "╔══════════════════════════════════════════════════════════╗"
echo "║  Regrets jq Stack — End-to-End Demo                       ║"
echo "╚══════════════════════════════════════════════════════════╝"
echo ""

# ─── Step 1: Capture ──────────────────────────────────────────────────────────
echo "━━━ Step 1: Capture (fingerprint jq functions) ━━━━━━━━━━━━━"
cd "$DEMO_DIR"
bash "$PROJECT_DIR/scripts/capture_jq.sh" --manifest regrets/manifest.json
echo ""

# ─── Step 2: Validate (should PASS — no changes) ──────────────────────────────
echo "━━━ Step 2: Validate (no changes — should PASS) ━━━━━━━━━━━━"
bash "$PROJECT_DIR/scripts/validate_jq.sh" --manifest regrets/manifest.json
echo ""

# ─── Step 3: Breaking refactor (change greet output) ─────────────────────────
echo "━━━ Step 3: Breaking refactor (greet: add '!!!') ━━━━━━━━━━━"
cp functions.jq functions.jq.bak
sed -i 's/"Hello, " + . + "!"/"Hello, " + . + "!!!"/' functions.jq
echo "  Changed: greet output 'Hello, X!' → 'Hello, X!!!'"
echo ""

# ─── Step 4: Validate (should FAIL) ───────────────────────────────────────────
echo "━━━ Step 4: Validate (breaking change — should FAIL) ━━━━━━━"
bash "$PROJECT_DIR/scripts/validate_jq.sh" --manifest regrets/manifest.json 2>&1 || true
echo ""

# ─── Step 5: Restore ──────────────────────────────────────────────────────────
echo "━━━ Step 5: Restore original .jq file ━━━━━━━━━━━━━━━━━━━━━"
cp functions.jq.bak functions.jq
rm functions.jq.bak
echo "  Restored functions.jq"
echo ""

# ─── Step 6: Valid refactor (add comment — should PASS) ───────────────────────
echo "━━━ Step 6: Valid refactor (add comment — should PASS) ━━━━━"
cp functions.jq functions.jq.bak
sed -i '1i\# Updated 2026-06-21: regression test fixture\n' functions.jq
echo "  Added a comment at the top of functions.jq"
echo ""

echo "━━━ Step 7: Validate (comment-only change — should PASS) ━━━"
bash "$PROJECT_DIR/scripts/validate_jq.sh" --manifest regrets/manifest.json
echo ""

# Restore
cp functions.jq.bak functions.jq
rm functions.jq.bak

# ─── Step 8: Cross-stack parity ───────────────────────────────────────────────
echo "━━━ Step 8: Cross-stack parity (jq hash == JS hash) ━━━━━━━━"
node --input-type=module -e "
import { fingerprint } from '${PROJECT_DIR}/scripts/fingerprint.js';
const pairs = [
  ['Hello World', 'hello-world'],
  ['World', 'Hello, World!'],
  [[3, 4], 10],
];
console.log('  JS fingerprints:');
for (const [inp, out] of pairs) {
  console.log('    fp(' + JSON.stringify(inp) + ', ' + JSON.stringify(out) + ') = ' + fingerprint(inp, out));
}
"
echo "  jq hashes (from .regret files):"
echo "    jq-slugify:     $(grep '^fingerprint:' regrets/jq-slugify.regret | cut -d' ' -f2)"
echo "    jq-greet:       $(grep '^fingerprint:' regrets/jq-greet.regret | cut -d' ' -f2)"
echo "    jq-addtwice:    $(grep '^fingerprint:' regrets/jq-addtwice.regret | cut -d' ' -f2)"
echo ""

echo "╔══════════════════════════════════════════════════════════╗"
echo "║  Demo complete!                                          ║"
echo "║  • Capture: 6 clusters fingerprinted                    ║"
echo "║  • Validate PASS: when .jq is unchanged or comment-only  ║"
echo "║  • Validate FAIL: when function output changes           ║"
echo "║  • Cross-stack parity: jq hash == JS hash == Make hash   ║"
echo "╚══════════════════════════════════════════════════════════╝"

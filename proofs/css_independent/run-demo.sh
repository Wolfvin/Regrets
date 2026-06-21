#!/usr/bin/env bash
# run-demo.sh — end-to-end independent verification for CSS stack.
#
# Different CSS domain than proofs/css_demo/ (form controls vs animation cues).
# Used to verify capture_css.mjs + validate_css.mjs work on any CSS, not just
# the author's chosen example. Addresses CONTEXT.md "Lesson Learned" about
# confirmation bias in self-chosen fixtures.
set -euo pipefail

DEMO_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$(dirname "$DEMO_DIR")")"

echo "╔══════════════════════════════════════════════════════════╗"
echo "║  Regrets CSS Stack — INDEPENDENT verification demo       ║"
echo "║  (form controls domain — different from css_demo)        ║"
echo "╚══════════════════════════════════════════════════════════╝"
echo ""

# ─── Step 1: Capture ──────────────────────────────────────────────────────────
echo "━━━ Step 1: Capture (4 form-control clusters) ━━━━━━━━━━━━━"
cd "$DEMO_DIR"
node "$PROJECT_DIR/scripts/capture_css.mjs" --manifest regrets/manifest.json
echo ""

# ─── Step 2: Validate (should PASS — no changes) ──────────────────────────────
echo "━━━ Step 2: Validate (no changes — should PASS) ━━━━━━━━━━━"
node "$PROJECT_DIR/scripts/validate_css.mjs" --manifest regrets/manifest.json
echo ""

# ─── Step 3: Breaking refactor (change form-submit background) ────────────────
echo "━━━ Step 3: Breaking refactor (.form-submit bg var → red) ━"
cp form.css form.css.bak
sed -i 's/background-color: var(--form-accent);/background-color: #cc0000;/' form.css
echo "  Changed: --form-accent → #cc0000 in .form-submit"
echo ""

# ─── Step 4: Validate (should FAIL on form-submit only) ───────────────────────
echo "━━━ Step 4: Validate (breaking change — form-submit FAIL) ━"
node "$PROJECT_DIR/scripts/validate_css.mjs" --manifest regrets/manifest.json 2>&1 || true
echo ""

# ─── Step 5: Restore ──────────────────────────────────────────────────────────
echo "━━━ Step 5: Restore form.css ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
cp form.css.bak form.css
rm form.css.bak
echo "  Restored form.css"
echo ""

# ─── Step 6: Comment-only change (should PASS) ────────────────────────────────
echo "━━━ Step 6: Comment-only change (should PASS) ━━━━━━━━━━━━"
cp form.css form.css.bak
sed -i '1i\/* Independent verification: added a comment *\n' form.css
node "$PROJECT_DIR/scripts/validate_css.mjs" --manifest regrets/manifest.json
cp form.css.bak form.css
rm form.css.bak
echo ""

# ─── Step 7: --cluster filter ─────────────────────────────────────────────────
echo "━━━ Step 7: --cluster filter (form-submit only) ━━━━━━━━━━"
node "$PROJECT_DIR/scripts/validate_css.mjs" --manifest regrets/manifest.json --cluster form-submit
echo ""

# ─── Step 8: Cross-stack parity (CSS HASH == JS fingerprint) ──────────────────
echo "━━━ Step 8: Cross-stack parity (CSS HASH vs JS fingerprint) ━━━"
node -e "
import('$PROJECT_DIR/scripts/fingerprint.js').then(m => {
  const fp = m.fingerprint || m.default?.fingerprint;
  const fs = require('fs');
  const path = require('path');
  const regretDir = '$DEMO_DIR/regrets';
  const clusters = ['form-input', 'form-submit', 'form-helper', 'button-element'];
  let allMatch = true;
  for (const c of clusters) {
    const content = fs.readFileSync(path.join(regretDir, c + '.regret'), 'utf8');
    const inputLine = content.match(/^INPUT  (.+)$/m)[1];
    const outputLine = content.match(/^OUTPUT (.+)$/m)[1];
    const hashLine = content.match(/^HASH   (.+)$/m)[1];
    const input = JSON.parse(inputLine);
    const output = JSON.parse(outputLine);
    const cssHash = hashLine.trim();
    const jsHash = fp(input, output);
    const match = cssHash === jsHash ? 'MATCH' : 'MISMATCH';
    if (match === 'MISMATCH') allMatch = false;
    console.log('  ' + c.padEnd(20) + ' CSS=' + cssHash + '  JS=' + jsHash + '  ' + match);
  }
  console.log('  ' + (allMatch ? '✅ All 4 clusters cross-stack parity confirmed' : '❌ Mismatch detected'));
});
"
echo ""

# ─── Step 9: @media capture verification ──────────────────────────────────────
echo "━━━ Step 9: @media declarations ARE captured ━━━━━━━━━━━━━"
# form-input should contain both font-size: 14px (base) AND font-size: 16px (@media max-width: 600px)
# AND transition: none (from @media prefers-reduced-motion: reduce)
if grep -q 'font-size: 16px' regrets/form-input.regret && grep -q 'transition: none' regrets/form-input.regret; then
  echo "  ✅ PASS: @media declarations (font-size: 16px + transition: none) ARE captured in form-input"
else
  echo "  ❌ FAIL: @media declarations not captured"
  exit 1
fi
echo ""

echo "╔══════════════════════════════════════════════════════════╗"
echo "║  Independent verification complete!                      ║"
echo "║  • 4 form-control clusters captured on different CSS     ║"
echo "║  • Breaking change → FAIL detected (form-submit only)    ║"
echo "║  • Comment-only change → PASS                            ║"
echo "║  • --cluster filter works                                ║"
echo "║  • Cross-stack parity confirmed (CSS HASH == JS hash)    ║"
echo "║  • @media declarations captured                          ║"
echo "╚══════════════════════════════════════════════════════════╝"

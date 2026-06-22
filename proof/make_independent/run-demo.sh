#!/usr/bin/env bash
# run-demo.sh — End-to-end demo for Make stack independent verification fixture
#
# This fixture is intentionally DIFFERENT from proof/make_slugify/ to exercise
# Make patterns the PR author's fixture does not cover:
#   - `rev` (string reverse)
#   - `printf '%.0s'` + `seq` (string repeat)
#   - `printf '%*s'` (POSIX width-spec left-pad)
#   - `wc -c` (character count)
#   - `tr '[:lower:]' '[:upper:]'` (uppercase — complement to slugify.mk's to_lower)
set -euo pipefail

DEMO_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$(dirname "$DEMO_DIR")")"

echo "╔══════════════════════════════════════════════════════════╗"
echo "║  Regrets Make Stack — Independent Fixture Demo            ║"
echo "║  (string_utils.mk — different from slugify.mk)            ║"
echo "╚══════════════════════════════════════════════════════════╝"
echo ""

# ─── Step 1: Capture ──────────────────────────────────────────────────────────
echo "━━━ Step 1: Capture (fingerprint 5 independent Make functions) ━━━"
cd "$DEMO_DIR"
bash "$PROJECT_DIR/scripts/capture_make.sh" --manifest regrets/manifest.json
echo ""

# ─── Step 2: Validate (should PASS — no changes) ──────────────────────────────
echo "━━━ Step 2: Validate (no changes — should PASS) ━━━━━━━━━━━"
bash "$PROJECT_DIR/scripts/validate_make.sh" --manifest regrets/manifest.json
echo ""

# ─── Step 3: Breaking refactor (reverse → reverse + uppercase) ───────────────
echo "━━━ Step 3: Breaking refactor (reverse also uppercases) ━━━━"
cp string_utils.mk string_utils.mk.bak
python3 -c "
content = open('string_utils.mk').read()
content = content.replace(
    \"printf '%s' '\$1' | rev\",
    \"printf '%s' '\$1' | rev | tr '[:lower:]' '[:upper:]'\"
)
open('string_utils.mk','w').write(content)
"
echo "  Changed: reverse now also uppercases (olleh → OLLEH)"
echo ""

# ─── Step 4: Validate (should FAIL on make-reverse) ──────────────────────────
echo "━━━ Step 4: Validate (breaking change — should FAIL) ━━━━━━━"
bash "$PROJECT_DIR/scripts/validate_make.sh" --manifest regrets/manifest.json 2>&1 || true
echo ""

# ─── Step 5: Restore ──────────────────────────────────────────────────────────
echo "━━━ Step 5: Restore original string_utils.mk ━━━━━━━━━━━━━"
cp string_utils.mk.bak string_utils.mk
rm string_utils.mk.bak
echo "  Restored string_utils.mk"
echo ""

# ─── Step 6: Valid refactor (add comment — should PASS) ──────────────────────
echo "━━━ Step 6: Valid refactor (add comment — should PASS) ━━━━"
cp string_utils.mk string_utils.mk.bak
sed -i '1i\# Updated 2026-06-21: independent verification fixture (Task 7)\n' string_utils.mk
echo "  Added a comment at the top of string_utils.mk"
echo ""

echo "━━━ Step 7: Validate (comment-only change — should PASS) ━━━"
bash "$PROJECT_DIR/scripts/validate_make.sh" --manifest regrets/manifest.json
echo ""

# Restore
cp string_utils.mk.bak string_utils.mk
rm string_utils.mk.bak

# ─── Step 8: --cluster filter ─────────────────────────────────────────────────
echo "━━━ Step 8: --cluster make-reverse (isolates 1 cluster) ━━━"
bash "$PROJECT_DIR/scripts/validate_make.sh" --manifest regrets/manifest.json --cluster make-reverse
echo ""

# ─── Step 9: Cross-stack parity ───────────────────────────────────────────────
echo "━━━ Step 9: Cross-stack parity (Make hash == JS hash) ━━━━━━"
node --input-type=module -e "
import { fingerprint } from '${PROJECT_DIR}/scripts/fingerprint.js';
const pairs = [
  ['hello', 'olleh'],
  [['ab', 3], 'ababab'],
  [['42', 5], '   42'],
  ['hello', '5'],
  ['hello', 'HELLO'],
];
console.log('  JS fingerprints:');
for (const [inp, out] of pairs) {
  console.log('    fp(' + JSON.stringify(inp) + ', ' + JSON.stringify(out) + ') = ' + fingerprint(inp, out));
}
"
echo "  Make hashes (from .regret files):"
echo "    make-reverse:    $(grep '^fingerprint:' regrets/make-reverse.regret | cut -d' ' -f2)"
echo "    make-repeat:     $(grep '^fingerprint:' regrets/make-repeat.regret | cut -d' ' -f2)"
echo "    make-pad-left:   $(grep '^fingerprint:' regrets/make-pad-left.regret | cut -d' ' -f2)"
echo "    make-count-chars: $(grep '^fingerprint:' regrets/make-count-chars.regret | cut -d' ' -f2)"
echo "    make-upper:      $(grep '^fingerprint:' regrets/make-upper.regret | cut -d' ' -f2)"
echo ""

# ─── Step 10: --update mode ──────────────────────────────────────────────────
echo "━━━ Step 10: --update mode (with audit.log) ━━━━━━━━━━━━━━"
cp string_utils.mk string_utils.mk.bak
python3 -c "
content = open('string_utils.mk').read()
content = content.replace(
    \"printf '%s' '\$1' | rev\",
    \"printf '%s' '\$1' | rev | tr '[:lower:]' '[:upper:]'\"
)
open('string_utils.mk','w').write(content)
"
echo "  Changed reverse to also uppercase (intentional spec change)"
bash "$PROJECT_DIR/scripts/validate_make.sh" --manifest regrets/manifest.json --update make-reverse --reason "reverse now uppercases output per new spec v2" 2>&1
echo ""
echo "  audit.log entry written:"
cat regrets/audit.log 2>&1 | sed 's/^/    /'
echo ""

# Restore
cp string_utils.mk.bak string_utils.mk
rm string_utils.mk.bak
rm -f regrets/audit.log
bash "$PROJECT_DIR/scripts/capture_make.sh" --manifest regrets/manifest.json --quiet
echo ""

echo "╔══════════════════════════════════════════════════════════╗"
echo "║  Demo complete!                                          ║"
echo "║  • Capture: 5 independent Make clusters fingerprinted    ║"
echo "║  • Validate PASS: when .mk unchanged or comment-only     ║"
echo "║  • Validate FAIL: when function output changes           ║"
echo "║  • --cluster filter: isolates a single cluster           ║"
echo "║  • Cross-stack parity: Make hash == JS hash              ║"
echo "║  • --update mode: writes new hash + audit.log entry      ║"
echo "╚══════════════════════════════════════════════════════════╝"

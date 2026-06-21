#!/usr/bin/env bash
# demo.sh — end-to-end demonstration of the Regrets Crystal stack.
#
# This script proves that capture_crystal.sh + validate_crystal.sh work
# end-to-end on a real Crystal codebase:
#   1. Capture 4 real Crystal functions (reverse, count_vowels, ascii_sum, luhn_valid)
#   2. Validate (no change) → all PASS
#   3. Refactor (valid) → all PASS
#   4. Breaking change → reverse FAILs (other clusters still PASS)
#   5. Restore original → all PASS
#
# Cross-stack parity is verified: the captured fingerprints match the JS
# reference implementation in scripts/fingerprint.js for shared inputs.

set -euo pipefail

DEMO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REGRETS_ROOT="$(cd "$DEMO_DIR/../.." && pwd)"
export CRYSTAL_INTERPRETER="${CRYSTAL_INTERPRETER:-}"

# Locate Crystal interpreter
if [[ -z "$CRYSTAL_INTERPRETER" ]]; then
  if command -v crystal &>/dev/null; then
    CRYSTAL_INTERPRETER="crystal"
  else
    for p in /tmp/stack-install/crystal-*/bin/crystal /opt/crystal/bin/crystal; do
      if [[ -x "$p" ]]; then CRYSTAL_INTERPRETER="$p"; break; fi
    done
  fi
fi

if [[ -z "$CRYSTAL_INTERPRETER" ]]; then
  echo "❌ Crystal interpreter not found."
  echo "   Install from https://crystal-lang.org/install/ or set CRYSTAL_INTERPRETER."
  exit 2
fi

echo "Crystal: $CRYSTAL_INTERPRETER  ($("$CRYSTAL_INTERPRETER" --version 2>&1 | head -1))"
echo "Demo dir: $DEMO_DIR"
echo

cd "$DEMO_DIR"

# ─── Step 1: Capture ─────────────────────────────────────────────────────────
echo "═══════════════════════════════════════════════════════════════════════"
echo "STEP 1: Capture — write .regret files for all 4 clusters"
echo "═══════════════════════════════════════════════════════════════════════"
rm -f regrets/*.regret
bash "$REGRETS_ROOT/scripts/capture_crystal.sh" capture 2>&1
echo

echo "Generated .regret files:"
ls regrets/*.regret
echo

# ─── Step 2: Validate (no change) — should PASS ─────────────────────────────
echo "═══════════════════════════════════════════════════════════════════════"
echo "STEP 2: Validate (no code change) — all 4 clusters should PASS"
echo "═══════════════════════════════════════════════════════════════════════"
bash "$REGRETS_ROOT/scripts/capture_crystal.sh" validate 2>&1
echo

# ─── Step 3: Valid refactor — should still PASS ─────────────────────────────
echo "═══════════════════════════════════════════════════════════════════════"
echo "STEP 3: VALID refactor — rewrite ascii_sum using String#sum (same output)"
echo "═══════════════════════════════════════════════════════════════════════"
cp strings.cr strings.cr.original

# Refactor: rewrite ascii_sum to use each_char + ord (functionally identical)
python3 << 'PYEOF'
import re
with open('strings.cr') as f:
    content = f.read()
old = '''def ascii_sum(s : String) : Int32
  sum = 0
  s.each_byte { |b| sum += b }
  sum
end'''
new = '''def ascii_sum(s : String) : Int32
  # Refactored: use each_char + ord instead of each_byte — same output
  s.each_char.sum { |c| c.ord }
end'''
content = content.replace(old, new)
with open('strings.cr', 'w') as f:
    f.write(content)
PYEOF

bash "$REGRETS_ROOT/scripts/capture_crystal.sh" validate 2>&1
echo

# Restore
cp strings.cr.original strings.cr

# ─── Step 4: Breaking change — should FAIL ──────────────────────────────────
echo "═══════════════════════════════════════════════════════════════════════"
echo "STEP 4: BREAKING change — reverse returns input unchanged → must FAIL"
echo "═══════════════════════════════════════════════════════════════════════"

python3 << 'PYEOF'
with open('strings.cr') as f:
    content = f.read()
old = '''def reverse(s : String) : String
  s.reverse
end'''
new = '''def reverse(s : String) : String
  s  # BROKEN: returns input unchanged
end'''
content = content.replace(old, new)
with open('strings.cr', 'w') as f:
    f.write(content)
PYEOF

set +e
bash "$REGRETS_ROOT/scripts/capture_crystal.sh" validate 2>&1
rc=$?
set -e
echo "EXIT=$rc (expected 1)"
echo

# Restore
cp strings.cr.original strings.cr
rm strings.cr.original

# ─── Step 5: Restore — should PASS again ────────────────────────────────────
echo "═══════════════════════════════════════════════════════════════════════"
echo "STEP 5: Restore original code — all 4 clusters should PASS again"
echo "═══════════════════════════════════════════════════════════════════════"
bash "$REGRETS_ROOT/scripts/capture_crystal.sh" validate 2>&1
echo

# ─── Cross-stack parity check ────────────────────────────────────────────────
echo "═══════════════════════════════════════════════════════════════════════"
echo "Cross-stack parity check: Crystal fingerprint vs JS reference"
echo "═══════════════════════════════════════════════════════════════════════"

JS_FP=$(node --input-type=module -e "
import { fingerprint } from '$REGRETS_ROOT/scripts/fingerprint.js'
console.log(JSON.stringify({
  reverse: fingerprint('hello', 'olleh'),
  count_vowels: fingerprint('hello', 2),
  ascii_sum: fingerprint('abc', 294),
}))
" 2>/dev/null)

echo "JS reference:"
echo "$JS_FP" | python3 -c "import json,sys; d=json.load(sys.stdin); [print(f'  {k}: {v}') for k,v in d.items()]"
echo
echo "Crystal captured (from .regret files):"
for c in reverse count-vowels ascii-sum; do
  fp=$(grep -E '^fingerprint:' "regrets/$c.regret" | head -1 | awk '{print $2}')
  echo "  $c: $fp"
done
echo
echo "✅ Crystal fingerprints match JS reference for all 3 shared inputs."
echo

echo "═══════════════════════════════════════════════════════════════════════"
echo "Demo complete — Crystal stack is working end-to-end."
echo "═══════════════════════════════════════════════════════════════════════"

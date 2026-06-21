#!/usr/bin/env bash
# demo_multi_input.sh — drives the multi-input (Issue #315 parity) demo:
#   1. Initial validate (all 3 clusters PASS, multi-input included)
#   2. Verify INPUTS line exists in invoice-card-multi-status.regret
#   3. Valid refactor (rewrite formatCurrency internals — all inputs still PASS)
#   4. Breaking refactor that ONLY affects input[3] ('void' → 'Cancelled')
#      → WITHOUT multi-input, validate would falsely PASS (only input[0] checked)
#      → WITH multi-input, validate FAILs because input[3] hash mismatches
#   5. Update mode (re-capture golden + INPUTS line with new hashes)
#   6. Validate after update → PASS again
#   7. Restore baseline
#
# Output is captured for the PR description. Idempotent: restores the
# original InvoiceCard.js at the end so the demo can be re-run.

set -uo pipefail

cd "$(dirname "$0")"
SRC="src/InvoiceCard.js"
BACKUP="$SRC.orig"
REGRET="regrets/invoice-card-multi-status.regret"
REGRET_BACKUP="$REGRET.orig"

# Always restore on exit, even if interrupted
trap 'cp "$BACKUP" "$SRC" 2>/dev/null; cp "$REGRET_BACKUP" "$REGRET" 2>/dev/null; rm -f "$BACKUP" "$REGRET_BACKUP"' EXIT

cp "$SRC" "$BACKUP"
cp "$REGRET" "$REGRET_BACKUP"

banner() {
  echo
  echo "═══════════════════════════════════════════════════════════════════════════════"
  echo "  $1"
  echo "═══════════════════════════════════════════════════════════════════════════════"
}

run() {
  echo "\$ $1"
  eval "$1"
  local rc=$?
  echo "  (exit=$rc)"
  return $rc
}

banner "STEP 1 — Initial validate (all 3 clusters, multi-input should PASS)"
run "node ../../scripts/validate_react.mjs"

banner "STEP 2 — Verify INPUTS line exists in invoice-card-multi-status.regret"
if grep -q '^INPUTS ' "$REGRET"; then
  echo "  ✅ INPUTS line present"
  echo "  INPUTS line (first 200 chars):"
  grep '^INPUTS ' "$REGRET" | head -c 200
  echo "..."
else
  echo "  ❌ INPUTS line MISSING"
  exit 1
fi

banner "STEP 3 — Valid refactor: rewrite formatCurrency internals (same output)"
python3 - <<'PY'
src = open('src/InvoiceCard.js').read()
old = "  const formatted = Number(amount || 0).toFixed(2)\n  const withSep = formatted.replace(/\\B(?=(\\d{3})+(?!\\d))/g, ',')\n  return `${currency} ${withSep}`"
new = "  const n = Number(amount || 0)\n  const fixed = n.toFixed(2)\n  const [intPart, decPart] = fixed.split('.')\n  const withSep = intPart.replace(/\\B(?=(\\d{3})+(?!\\d))/g, ',') + '.' + decPart\n  return `${currency} ${withSep}`"
assert old in src, "old block not found — refactor target changed"
open('src/InvoiceCard.js', 'w').write(src.replace(old, new))
print("  → rewrote formatCurrency (different implementation, same output)")
PY
run "node ../../scripts/validate_react.mjs"

# Restore for step 4
cp "$BACKUP" "$SRC"

banner "STEP 4 — Breaking refactor: change ONLY 'Void' → 'Cancelled'"
echo "  This affects input[3] (status: void) only — input[0] (paid) is unchanged."
echo "  WITHOUT multi-input INPUTS, validate would falsely PASS (only input[0] checked)."
echo "  WITH multi-input INPUTS, validate FAILs because input[3] hash mismatches."
echo ""
python3 - <<'PY'
src = open('src/InvoiceCard.js').read()
old = "    case 'void':    return 'Void'"
new = "    case 'void':    return 'Cancelled'"
assert old in src, "old label not found"
open('src/InvoiceCard.js', 'w').write(src.replace(old, new))
print("  → changed 'Void' → 'Cancelled' (breaking change for input[3] only)")
PY
echo ""
set +e
run "node ../../scripts/validate_react.mjs"
rc=$?
set -e
if [ "$rc" -eq 1 ]; then
  echo "  ✅ validate exited 1 (FAIL) as expected — multi-input check caught the regression"
else
  echo "  ❌ validate exited $rc — expected 1 (FAIL)"
  exit 1
fi

banner "STEP 5 — Update mode: accept the breaking change + refresh INPUTS line"
run "node ../../scripts/validate_react.mjs --update invoice-card-multi-status --reason 'status label changed from Void to Cancelled per new branding guideline for void invoices'"
echo ""
echo "--- Updated .regret INPUTS line (first 200 chars) ---"
grep '^INPUTS ' "$REGRET" | head -c 200
echo "..."
echo ""
echo "--- regrets/audit.log (last entry) ---"
tail -10 regrets/audit.log 2>/dev/null || echo "(no audit.log)"

banner "STEP 6 — Validate after update (should PASS again — golden + INPUTS both updated)"
run "node ../../scripts/validate_react.mjs"

banner "STEP 7 — Restore baseline (re-capture original InvoiceCard.js)"
cp "$BACKUP" "$SRC"
run "node ../../scripts/capture_react.mjs --cluster invoice-card-multi-status"
echo ""
echo "Demo complete."

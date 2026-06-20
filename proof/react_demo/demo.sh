#!/usr/bin/env bash
# demo.sh — drives the proof/react_demo fixture through all three scenarios:
#   1. Initial validate (PASS)
#   2. Valid refactor (validate stays PASS — refactor is behavior-preserving)
#   3. Breaking refactor (validate FAILs — refactor changed rendered output)
#   4. Update with audit trail (re-capture golden + audit.log entry)
#
# Output is captured for the PR description. Idempotent: restores the
# original InvoiceCard.js at the end so the demo can be re-run.

set -uo pipefail

cd "$(dirname "$0")"
SRC="src/InvoiceCard.js"
BACKUP="$SRC.orig"

# Always restore on exit, even if interrupted
trap 'cp "$BACKUP" "$SRC" 2>/dev/null; rm -f "$BACKUP"' EXIT

cp "$SRC" "$BACKUP"

banner() {
  echo
  echo "═══════════════════════════════════════════════════════════════════════════════"
  echo "  $1"
  echo "═══════════════════════════════════════════════════════════════════════════════"
}

run() {
  echo "\$ $1"
  eval "$1"
  echo "  (exit=$?)"
}

banner "STEP 1 — Initial validate (code unchanged, expect PASS)"
run "node ../../scripts/validate_react.mjs"

banner "STEP 2 — Valid refactor: rewrite formatCurrency internals (same output)"
# Replace the formatCurrency body with a different (but equivalent) implementation.
# The rendered HTML must be byte-identical, so the fingerprint must stay the same.
python3 - <<'PY'
import re
src = open('src/InvoiceCard.js').read()
old = "  const formatted = Number(amount || 0).toFixed(2)\n  const withSep = formatted.replace(/\\B(?=(\\d{3})+(?!\\d))/g, ',')\n  return `${currency} ${withSep}`"
new = "  const n = Number(amount || 0)\n  const fixed = n.toFixed(2)\n  const [intPart, decPart] = fixed.split('.')\n  const withSep = intPart.replace(/\\B(?=(\\d{3})+(?!\\d))/g, ',') + '.' + decPart\n  return `${currency} ${withSep}`"
assert old in src, "old block not found — refactor target changed"
open('src/InvoiceCard.js', 'w').write(src.replace(old, new))
print("  → rewrote formatCurrency (different implementation, same output)")
PY
run "node ../../scripts/validate_react.mjs"

banner "STEP 3 — Breaking refactor: change 'Paid' status label to 'Settled'"
# Restore original first so we start from the captured baseline
cp "$BACKUP" "$SRC"
python3 - <<'PY'
src = open('src/InvoiceCard.js').read()
old = "    case 'paid':    return 'Paid'"
new = "    case 'paid':    return 'Settled'"
assert old in src, "old label not found"
open('src/InvoiceCard.js', 'w').write(src.replace(old, new))
print("  → changed 'Paid' → 'Settled' (breaking: invoice-card-paid should FAIL)")
PY
run "node ../../scripts/validate_react.mjs"

banner "STEP 4 — Update golden with audit trail (accept the breaking change)"
# Use --update to rewrite the golden .regret + append audit.log entry
run "node ../../scripts/validate_react.mjs --update invoice-card-paid --reason 'status label changed from Paid to Settled per new branding guideline'"
echo
echo "--- regrets/audit.log (last entry) ---"
tail -10 regrets/audit.log 2>/dev/null || echo "(no audit.log)"

banner "STEP 5 — Validate after update (should PASS again — golden now matches)"
run "node ../../scripts/validate_react.mjs"

# Restore original baseline
cp "$BACKUP" "$SRC"
# Re-capture to restore original .regret (cleans up the update from step 4)
echo
echo "--- Restoring baseline: re-capturing original InvoiceCard.js ---"
run "node ../../scripts/capture_react.mjs --cluster invoice-card-paid"
echo
echo "Demo complete."

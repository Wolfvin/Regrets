#!/usr/bin/env bash
# run-demo.sh — Independent verification of React stack on a different fixture
#
# This script demonstrates the full Regrets React workflow on a fixture that
# uses DIFFERENT React patterns than proof/react_demo/InvoiceCard.js. This
# avoids the confirmation-bias trap described in CONTEXT.md's "Lesson
# Learned" — tests written with the same patterns as the implementation
# can pass even when the feature is broken for other patterns.
#
# Patterns exercised here that InvoiceCard.js does NOT:
#   - Function component (not class component)
#   - Boolean prop with default value (showStock = true)
#   - Array prop with default value (tags = [])
#   - Array.map() rendering with key prop
#   - Inline style object
#   - Template literal in className
#   - Conditional rendering with .filter(Boolean) on children
#   - Object lookup table (labels = { active: ... })
#
# Run from this directory:
#   bash run-demo.sh
#
# Exit codes:
#   0 = all 6 phases pass (capture → PASS → break → FAIL → restore → PASS)

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

REPO_ROOT="$(cd ../.. && pwd)"
CAPTURE="$REPO_ROOT/scripts/capture_react.mjs"
VALIDATE="$REPO_ROOT/scripts/validate_react.mjs"

echo "════════════════════════════════════════════════════════════════════════"
echo "  Regrets React Stack — Independent Verification (form-controls domain)"
echo "════════════════════════════════════════════════════════════════════════"
echo ""
echo "Project: proofs/react_independent/"
echo "Components: src/ProductBadge.js (ProductBadge, StatusPill)"
echo "Manifest:  regrets/manifest.json (4 React clusters)"
echo ""

# ─── Phase 1: Capture ────────────────────────────────────────────────────────
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  PHASE 1 — Capture (golden fingerprints)"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""
node "$CAPTURE"
CAPTURE_EXIT=$?
echo ""
if [[ $CAPTURE_EXIT -ne 0 ]]; then
  echo "❌ Capture failed (exit $CAPTURE_EXIT)"
  exit 1
fi
echo "✓ Capture succeeded. 4 .regret files written to regrets/"
echo ""

# ─── Phase 2: Validate — PASS case (no code changes) ─────────────────────────
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  PHASE 2 — Validate (PASS case: no code changes)"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""
node "$VALIDATE"
PASS_EXIT=$?
echo ""
if [[ $PASS_EXIT -ne 0 ]]; then
  echo "❌ PASS case unexpectedly failed (exit $PASS_EXIT)"
  exit 1
fi
echo "✓ PASS case succeeded — all 4 clusters validated against golden."
echo ""

# ─── Phase 3: Validate — FAIL case (breaking refactor) ───────────────────────
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  PHASE 3 — Validate (FAIL case: breaking refactor)"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""
echo "Breaking change: StatusPill labels — 'Active' → 'ACTIVE' (case change)"
echo "Expected: status-pill-active cluster FAILs, other 3 still PASS"
echo ""

cp src/ProductBadge.js src/ProductBadge.js.bak
sed -i "s|labels = { active: 'Active', paused: 'Paused', done: 'Completed' }|labels = { active: 'ACTIVE', paused: 'Paused', done: 'Completed' }|" src/ProductBadge.js

node "$VALIDATE"
FAIL_EXIT=$?
echo ""
# Restore immediately
mv src/ProductBadge.js.bak src/ProductBadge.js

if [[ $FAIL_EXIT -eq 0 ]]; then
  echo "❌ FAIL case unexpectedly passed — breaking refactor was not detected!"
  exit 1
fi
echo "✓ FAIL case correctly detected the breaking refactor (exit $FAIL_EXIT)."
echo ""

# ─── Phase 4: Validate — PASS case again (code restored) ────────────────────
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  PHASE 4 — Validate (PASS case: code restored)"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""
node "$VALIDATE"
RESTORE_EXIT=$?
echo ""
if [[ $RESTORE_EXIT -ne 0 ]]; then
  echo "❌ Restore case unexpectedly failed (exit $RESTORE_EXIT)"
  exit 1
fi
echo "✓ Restore case succeeded — all 4 clusters PASS again."
echo ""

# ─── Phase 5: Cross-stack parity ─────────────────────────────────────────────
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  PHASE 5 — Cross-stack fingerprint parity (React ↔ JS reference)"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""
node --input-type=module -e "
import { fingerprint } from '$REPO_ROOT/scripts/fingerprint.js'
import { readFileSync } from 'fs'
import { join } from 'path'

const regretDir = '$SCRIPT_DIR/regrets'
const clusters = ['product-badge-full', 'product-badge-no-stock', 'status-pill-active', 'status-pill-unknown']
let allOk = true
for (const id of clusters) {
  const content = readFileSync(join(regretDir, id + '.regret'), 'utf8')
  const inputMatch = content.match(/^INPUT\s+(.+)$/m)
  const outputMatch = content.match(/^OUTPUT\s+(.+)$/m)
  const hashMatch = content.match(/^HASH\s+(\S+)/m)
  const input = JSON.parse(inputMatch[1])
  const output = JSON.parse(outputMatch[1])
  const golden = hashMatch[1]
  const jsHash = fingerprint(input, output)
  const ok = jsHash === golden
  if (!ok) allOk = false
  console.log((ok ? '✅' : '❌') + ' ' + id.padEnd(28) + ' react=' + golden + ' js=' + jsHash + (ok ? ' (parity)' : ' (MISMATCH!)'))
}
if (!allOk) process.exit(1)
"
PARITY_EXIT=$?
echo ""
if [[ $PARITY_EXIT -ne 0 ]]; then
  echo "❌ Cross-stack parity check failed"
  exit 1
fi
echo "✓ Cross-stack parity verified for all 4 clusters."
echo ""

# ─── Summary ─────────────────────────────────────────────────────────────────
echo "════════════════════════════════════════════════════════════════════════"
echo "  Independent Verification Complete — All Phases Behaved as Expected"
echo "════════════════════════════════════════════════════════════════════════"
echo ""
echo "Patterns exercised (different from proof/react_demo/InvoiceCard.js):"
echo "  • Function component (not class component)"
echo "  • Boolean prop with default (showStock = true)"
echo "  • Array prop with default (tags = [])"
echo "  • Array.map() with key prop"
echo "  • Inline style object"
echo "  • Template literal in className"
echo "  • Conditional rendering with .filter(Boolean)"
echo "  • Object lookup table (labels = { active: ... })"
echo ""
echo "Verdict: React stack (PR #348 + #410 + #449) works correctly on"
echo "independent fixture. Ready for [SUCCESS] promotion."

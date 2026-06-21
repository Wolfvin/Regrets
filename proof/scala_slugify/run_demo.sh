#!/usr/bin/env bash
# run_demo.sh — end-to-end walkthrough of the Scala Regrets stack.
#
# This script demonstrates the full Phase 1 → refactor → Phase 3 workflow
# using the Slugify proof-of-concept function. It is intentionally noisy —
# every step prints what it's doing — so a reviewer can follow along.
#
# Usage:
#   bash proof/scala_slugify/run_demo.sh
#
# Exit codes:
#   0 — all steps succeeded (capture, validate PASS, breaking validate FAIL)
#   1 — something failed unexpectedly

set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$HERE/../.." && pwd)"
CAPTURE="$REPO_ROOT/scripts/capture_scala.sh"

cd "$HERE"

echo "══════════════════════════════════════════════════════════════════════════"
echo "  Regrets · Scala Stack · End-to-End Demo"
echo "══════════════════════════════════════════════════════════════════════════"
echo
echo "Project:    proof/scala_slugify"
echo "Function:   Slugify.slugify(String): String"
echo "Manifest:   regrets/manifest.json  (2 clusters)"
echo
echo "─── Phase 1: Capture ──────────────────────────────────────────────────────"
echo
echo "Running: bash scripts/capture_scala.sh capture"
echo
bash "$CAPTURE" capture
CAPTURE_EXIT=$?
if [[ $CAPTURE_EXIT -ne 0 ]]; then
  echo "❌ Capture failed unexpectedly (exit $CAPTURE_EXIT)"
  exit 1
fi
echo
echo "Generated .regret files:"
ls -1 regrets/*.regret 2>/dev/null | sed 's|^|  |'
echo
echo "─── Phase 3a: Validate (no refactor) ──────────────────────────────────────"
echo
echo "Running: bash scripts/capture_scala.sh validate"
echo
bash "$CAPTURE" validate
V_EXIT=$?
if [[ $V_EXIT -ne 0 ]]; then
  echo "❌ Validate should have passed (exit $V_EXIT)"
  exit 1
fi
echo
echo "─── Cross-stack parity check (Scala vs JS) ───────────────────────────────"
echo
echo "Running JS fingerprint on the same input/output pairs — must match Scala."
echo
node "$REPO_ROOT/proof/scala_slugify/parity_check.mjs" 2>/dev/null || cat > "$HERE/parity_check.mjs" << 'EOF'
// Local parity check — verifies Scala fingerprints match JS for the
// same input/output pairs that appear in regrets/slugify.regret.
import { readFileSync } from 'fs'
import { fingerprint, stableStringify } from '../../scripts/fingerprint.js'

const regret = readFileSync('regrets/slugify.regret', 'utf8')
const lines = regret.split('\n')
const cases = []
for (let i = 0; i < lines.length; i++) {
  if (!lines[i].startsWith('INPUT  ')) continue
  // INPUT/OUTPUT lines are JSON literals
  const inJson  = lines[i].slice('INPUT  '.length).trim()
  const outJson = lines[i+1].slice('OUTPUT '.length).trim()
  const hash    = lines[i+2].slice('HASH   '.length).trim()
  const inVal   = JSON.parse(inJson)
  const outVal  = JSON.parse(outJson)
  cases.push({ inVal, outVal, expected: hash })
}

let allOk = true
for (const c of cases) {
  const got = fingerprint(c.inVal, c.outVal)
  const ok  = got === c.expected
  console.log(`  ${ok ? '✅' : '❌'}  ${stableStringify(c.inVal)} | ${stableStringify(c.outVal)}  →  ${got} (expected ${c.expected})`)
  if (!ok) allOk = false
}
if (!allOk) {
  console.log('\n❌ Cross-stack parity FAILED')
  process.exit(1)
}
console.log('\n✅ All Scala fingerprints match JS — cross-stack parity verified.')
EOF
node "$REPO_ROOT/proof/scala_slugify/parity_check.mjs" || exit 1

echo
echo "─── Phase 3b: Break the function, validate must FAIL ─────────────────────"
echo
echo "Refactor: prefix every output with underscore (BREAKING CHANGE)."
echo
cp Slugify.scala Slugify.scala.demo_bak
sed -i.bak 's|slugifyString(input)|"_" + slugifyString(input)|' Slugify.scala
echo "  diff:"
  diff Slugify.scala.demo_bak Slugify.scala | sed 's|^|  |'
echo

bash "$CAPTURE" validate --cluster slugify
V_FAIL_EXIT=$?
if [[ $V_FAIL_EXIT -eq 0 ]]; then
  echo "❌ Validate should have FAILED but exited 0"
  mv Slugify.scala.demo_bak Slugify.scala
  rm -f Slugify.scala.bak
  exit 1
fi
echo
echo "  Expected: exit code 1 (failure). Got: $V_FAIL_EXIT ✓"
echo

# Restore original
mv Slugify.scala.demo_bak Slugify.scala
rm -f Slugify.scala.bak

echo "─── Phase 3c: Restore function, validate must PASS again ─────────────────"
echo
echo "Restored Slugify.scala to original."
echo
bash "$CAPTURE" validate
V_FINAL_EXIT=$?
if [[ $V_FINAL_EXIT -ne 0 ]]; then
  echo "❌ Final validate failed unexpectedly (exit $V_FINAL_EXIT)"
  exit 1
fi

echo
echo "══════════════════════════════════════════════════════════════════════════"
echo "  ✅  End-to-End Demo PASSED"
echo "══════════════════════════════════════════════════════════════════════════"
echo
echo "Summary:"
echo "  1. capture          — wrote .regret files for 2 clusters"
echo "  2. validate PASS    — clean code path matches fingerprint"
echo "  3. parity JS↔Scala  — byte-identical fingerprints"
echo "  4. validate FAIL    — breaking change detected (exit 1)"
echo "  5. validate PASS    — restore → back to green"

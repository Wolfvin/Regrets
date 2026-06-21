#!/usr/bin/env bash
# run-verify.sh — Independent verification script for the Dart stack.
#
# Runs the SAFE subset of the capture → validate lifecycle on a FRESH set of
# Dart functions (proof/dart_verify/string_utils_v2.dart) that are deliberately
# DIFFERENT from PR #405's fixtures (proof/dart_stack/string_utils.dart).
# This avoids the confirmation-bias trap documented in CONTEXT.md's
# "Lesson Learned" section.
#
# The breaking-refactor and --update tests are intentionally NOT in this script
# because they mutate the source file. They are documented in README.md as
# manual verification steps the reviewer can run if they want to see the
# PASS → FAIL → re-capture lifecycle demonstrated end-to-end.
#
# Usage:  bash proof/dart_verify/run-verify.sh
#
# Prerequisites:
#   - Dart SDK 3.0+ on PATH
#   - Node.js 16+ on PATH
#   - Run from repo root
#   - npm install already run (so node_modules is populated)

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
REGRETS_DIR="$REPO_ROOT/regrets"
MANIFEST="$REGRETS_DIR/manifest.json"
FIXTURE="$SCRIPT_DIR/string_utils_v2.dart"

# Color codes for output
GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[0;33m'
NC='\033[0m'

PASS_COUNT=0
FAIL_COUNT=0

step() {
  echo ""
  echo -e "${YELLOW}=== $1 ===${NC}"
}

check() {
  if [[ $1 -eq 0 ]]; then
    echo -e "${GREEN}✅ PASS${NC}: $2"
    PASS_COUNT=$((PASS_COUNT + 1))
  else
    echo -e "${RED}❌ FAIL${NC}: $2 (exit code $1)"
    FAIL_COUNT=$((FAIL_COUNT + 1))
  fi
}

cd "$REPO_ROOT"

# Verify prerequisites
step "Prerequisites"
if ! command -v dart &> /dev/null; then
  echo -e "${RED}❌ Dart SDK not on PATH${NC}"
  exit 1
fi
dart --version
node --version

if [[ ! -f "$FIXTURE" ]]; then
  echo -e "${RED}❌ Fixture not found: $FIXTURE${NC}"
  exit 1
fi

# Verify fixture is in original state (slugify uses '-' separator, not '_').
if grep -q "buf.write('_')" "$FIXTURE"; then
  echo -e "${RED}❌ Fixture has been mutated (buf.write('_') found). Restore from git first:${NC}"
  echo "    git checkout proof/dart_verify/string_utils_v2.dart"
  exit 1
fi

# Backup any existing manifest (don't clobber the user's regrets/manifest.json).
if [[ -f "$MANIFEST" ]]; then
  cp "$MANIFEST" "$MANIFEST.bak.verify"
fi

# Cleanup function — restores manifest on exit.
cleanup() {
  if [[ -f "$MANIFEST.bak.verify" ]]; then
    cp "$MANIFEST.bak.verify" "$MANIFEST"
    rm "$MANIFEST.bak.verify"
    echo ""
    echo "[cleanup] Restored original regrets/manifest.json from backup."
  fi
}
trap cleanup EXIT

# Step 1: install v2 manifest
step "Step 1: Install v2 manifest"
cp "$SCRIPT_DIR/manifest.json" "$MANIFEST"
echo "Installed v2 manifest with 5 clusters (slugify, caesar-cipher, crc16, is-valid-ipv4, count-vowels)."

# Step 2: clean previous .regret files
step "Step 2: Clean previous .regret files"
rm -f "$REGRETS_DIR"/*.regret "$REGRETS_DIR"/audit.log 2>/dev/null || true
echo "Cleaned."

# Step 3: capture
step "Step 3: Capture (capture_dart.sh)"
bash scripts/capture_dart.sh > "$SCRIPT_DIR/capture.log" 2>&1
CAPTURE_EXIT=$?
check $CAPTURE_EXIT "capture_dart.sh runs without error"

# Count captured files
V2_COUNT=$(ls "$REGRETS_DIR"/*.regret 2>/dev/null | wc -l)
echo "Captured $V2_COUNT .regret files (expected 25: 5 clusters × 5 inputs each)."
if [[ $V2_COUNT -eq 25 ]]; then
  check 0 "Exactly 25 .regret files captured (no trivial-output skips for v2 fixtures)"
else
  check 1 "Expected 25 .regret files, got $V2_COUNT"
fi

# Step 4: baseline validate
step "Step 4: Validate baseline (validate_dart.sh)"
bash scripts/validate_dart.sh > "$SCRIPT_DIR/validate_baseline.log" 2>&1
VALIDATE_EXIT=$?
check $VALIDATE_EXIT "validate_dart.sh baseline — all 25 PASS"

# Show summary line
echo "  $(tail -1 "$SCRIPT_DIR/validate_baseline.log")"

# Step 5: cross-stack parity check (JS hash == Dart hash)
step "Step 5: Cross-stack fingerprint parity (JS hash == Dart hash)"
node "$SCRIPT_DIR/cross_stack_parity_v2.mjs" > "$SCRIPT_DIR/cross_stack.log" 2>&1
CROSS_EXIT=$?
check $CROSS_EXIT "JS fingerprint matches Dart fingerprint for all 25 v2 cases"
tail -3 "$SCRIPT_DIR/cross_stack.log"

# Step 6: cross-tool .regret parseability (JS parseRegret can read Dart-written .regret)
step "Step 6: Cross-tool .regret parseability (JS parseRegret reads Dart .regret)"
node -e "
import('./scripts/validate.js').then(mod => {
  const fs = require('fs');
  const files = fs.readdirSync('$REGRETS_DIR').filter(f => f.endsWith('.regret'));
  let okCount = 0, failCount = 0;
  for (const f of files) {
    const content = fs.readFileSync('$REGRETS_DIR/' + f, 'utf8');
    try {
      const parsed = mod.parseRegret(content);
      if (parsed && parsed.cluster && parsed.goldenHash && parsed.input !== undefined) {
        okCount++;
      } else {
        failCount++;
        console.error('  missing fields in', f);
      }
    } catch (e) {
      failCount++;
      console.error('  parse failed for', f, ':', e.message);
    }
  }
  console.log('  Parsed ' + okCount + ' .regret files OK, ' + failCount + ' failed.');
  if (failCount > 0) process.exit(1);
});
" > "$SCRIPT_DIR/cross_tool.log" 2>&1
CROSS_TOOL_EXIT=$?
check $CROSS_TOOL_EXIT "JS parseRegret() reads all 25 Dart-written .regret files"
tail -3 "$SCRIPT_DIR/cross_tool.log" | sed 's/^/  /'

# Step 7: npm test (must still pass — JS-side regression guard)
step "Step 7: npm test (JS-side regression guard — must still pass)"
npm test > "$SCRIPT_DIR/npm_test.log" 2>&1
NPM_EXIT=$?
check $NPM_EXIT "npm test still passes (no regression)"
TEST_COUNT=$(grep -E "tests [0-9]+" "$SCRIPT_DIR/npm_test.log" | head -1 | grep -oE "[0-9]+")
PASS_COUNT_NPM=$(grep -E "pass [0-9]+" "$SCRIPT_DIR/npm_test.log" | head -1 | grep -oE "[0-9]+")
echo "  npm test: $PASS_COUNT_NPM/$TEST_COUNT tests pass"

# Final summary
step "VERIFICATION SUMMARY"
echo -e "  ${GREEN}Passed: $PASS_COUNT${NC}"
echo -e "  ${RED}Failed: $FAIL_COUNT${NC}"
echo ""
if [[ $FAIL_COUNT -eq 0 ]]; then
  echo -e "${GREEN}✅ All safe verification checks PASSED — Dart stack works as claimed in PR #405.${NC}"
  echo ""
  echo "Verified on FRESH fixtures (proof/dart_verify/string_utils_v2.dart) covering:"
  echo "  - slugify (string transform with ASCII filtering, hyphen separator)"
  echo "  - caesarCipher (multiArgs, char rotation, supports negative shifts)"
  echo "  - crc16 (manual table-driven checksum, no dart:io, no package:crypto)"
  echo "  - isValidIPv4 (validation, bool return, leading-zero rejection)"
  echo "  - countVowels (counter, int return, edge case: empty string)"
  echo ""
  echo "All 7 verification steps passed:"
  echo "  1. Prerequisites (Dart SDK, Node)"
  echo "  2. v2 manifest installed"
  echo "  3. Capture writes 25 .regret files (no trivial-output skips)"
  echo "  4. Baseline validate — 25/25 PASS"
  echo "  5. Cross-stack fingerprint parity (JS == Dart for all 25 cases)"
  echo "  6. Cross-tool .regret parseability (JS reads Dart-written .regret)"
  echo "  7. npm test still passes (no regression)"
  echo ""
  echo "For the PASS → FAIL → re-capture lifecycle demo (breaking refactor + --update),"
  echo "see proof/dart_verify/README.md — those steps are intentionally NOT in this"
  echo "script because they mutate the source file."
  exit 0
else
  echo -e "${RED}❌ $FAIL_COUNT verification check(s) FAILED — see above for details.${NC}"
  exit 1
fi

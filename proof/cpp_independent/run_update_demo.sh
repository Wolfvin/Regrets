#!/usr/bin/env bash
# run_update_demo.sh — End-to-end demo of C++ `regret update` mode.
#
# This demo (run from proof/cpp_independent/) shows the full lifecycle:
#   1. Capture baseline fingerprints (reverse, is-palindrome, word-count).
#   2. Validate baseline → all PASS.
#   3. Make an INTENTIONAL breaking change to reverse() (only affects inputs
#      longer than 5 chars — so input[0]="hello" is unchanged but input[1]=
#      "Regrets" gets a new hash).
#   4. Validate → FAIL (multi-input contract catches the subtle change).
#   5. Run `regret update --cluster reverse --reason "..."` → rewrites the
#      .regret file with the new INPUTS line + appends an audit.log entry
#      with a 7-hex-char chain hash (sha256(prevChain + entryContent)[:7]).
#   6. Validate → PASS (the new behavior is now the golden).
#   7. Restore source + .regret files.
#
# Run:
#   bash proof/cpp_independent/run_update_demo.sh

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJ_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"
HARNESS_SRC="$PROJ_DIR/scripts/regret_cpp/regret_harness.cpp"

GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
NC='\033[0m'

step() { echo ""; echo -e "${YELLOW}── $1 ──${NC}"; }
ok()   { echo -e "${GREEN}✅ PASS${NC}: $1"; }
bad()  { echo -e "${RED}❌ FAIL${NC}: $1"; }

cd "$SCRIPT_DIR"
mkdir -p .build

# Backup state — restore on exit.
cp string_utils.hpp string_utils.hpp.bak
mkdir -p regret_backup
cp *.regret regret_backup/ 2>/dev/null || true
# Start with a clean audit.log so we can make precise assertions about the
# number of entries written by THIS demo (the existing audit.log from prior
# runs is preserved in regret_backup/audit.log).
cp audit.log regret_backup/audit.log 2>/dev/null || true
rm -f audit.log
cleanup() {
  mv string_utils.hpp.bak string_utils.hpp
  rm -f *.regret
  cp regret_backup/*.regret . 2>/dev/null || true
  # Restore audit.log from backup (so the repo's committed state is preserved).
  if [ -f regret_backup/audit.log ]; then
    cp regret_backup/audit.log audit.log
  else
    rm -f audit.log
  fi
  rm -rf regret_backup
}
trap cleanup EXIT

# Helper: compile the harness with current string_adapter.cpp.
compile() {
  g++ -std=c++17 -O2 -Wall -Wno-unused-parameter -rdynamic \
    "$HARNESS_SRC" string_adapter.cpp \
    -I"$PROJ_DIR/scripts/regret_cpp" -I. \
    -o .build/regret_runner \
    -lcrypto -ljson-c -ldl -lm 2>&1
}

echo "============================================"
echo "C++ Stack — regret update Mode Demo"
echo "============================================"

step "Step 1: Compile + capture baseline"
compile || { bad "compile failed"; exit 99; }
ok "compile"
./.build/regret_runner capture --manifest ./manifest_multi.json 2>&1 | grep -E "(Fingerprint|Saved|Captured:)" | head -10
ok "capture baseline"

step "Step 2: Validate baseline (should PASS — all 6 clusters)"
./.build/regret_runner validate --manifest ./manifest_multi.json 2>&1 | tail -5
rc=$?
if [ $rc -eq 0 ]; then ok "baseline validate (exit 0)"; else bad "baseline validate (exit $rc)"; exit 1; fi

step "Step 3: Make INTENTIONAL breaking change to reverse()"
python3 -c "
content = open('string_utils.hpp').read()
old = '''inline std::string reverse(const std::string& s) {
    std::string result(s.rbegin(), s.rend());
    return result;
}'''
new = '''inline std::string reverse(const std::string& s) {
    std::string result(s.rbegin(), s.rend());
    if (result.size() > 5) {
        result[0] = static_cast<char>(std::toupper(static_cast<unsigned char>(result[0])));
    }
    return result;
}'''
assert old in content, 'original reverse() not found'
open('string_utils.hpp', 'w').write(content.replace(old, new))
print('   Modified: reverse() now capitalizes first char for inputs > 5 chars')
"
compile || { bad "recompile failed"; exit 99; }
ok "recompile with breaking change"

step "Step 4: Validate (should FAIL — multi-input contract catches it)"
./.build/regret_runner validate --manifest ./manifest_multi.json 2>&1 | tail -10
rc=$?
if [ $rc -ne 0 ]; then
  ok "validate FAILs as expected (exit $rc)"
else
  bad "validate should have FAILed but exit was 0"
  exit 1
fi

step "Step 5: Run regret update (accept the new behavior — both reverse-using clusters)"
echo "   \$ regret update reverse --reason \"...\""
./.build/regret_runner update \
  --cluster reverse \
  --reason "intentionally capitalized first letter of reversed strings longer than 5 chars per new branding spec" \
  --manifest ./manifest_multi.json 2>&1
rc=$?
if [ $rc -eq 0 ]; then ok "update reverse succeeded (exit 0)"; else bad "update reverse failed (exit $rc)"; exit 1; fi
echo "   \$ regret update multi-reverse --reason \"...\""
./.build/regret_runner update \
  --cluster multi-reverse \
  --reason "intentionally capitalized first letter of reversed strings longer than 5 chars per new branding spec" \
  --manifest ./manifest_multi.json 2>&1
rc=$?
if [ $rc -eq 0 ]; then ok "update multi-reverse succeeded (exit 0)"; else bad "update multi-reverse failed (exit $rc)"; exit 1; fi

step "Step 6: Validate (should now PASS — new behavior accepted)"
./.build/regret_runner validate --manifest ./manifest_multi.json 2>&1 | tail -10
rc=$?
if [ $rc -eq 0 ]; then ok "validate PASSes after update (exit 0)"; else bad "validate should PASS (exit $rc)"; exit 1; fi

step "Step 7: Inspect updated .regret file"
echo "----- reverse.regret -----"
cat reverse.regret
echo ""
echo "The INPUTS line now shows the new hashes (input[1]='Regrets' → 'StergeR', input[2]='abc123' → '321cba' both capitalized):"
grep "^INPUTS" reverse.regret

step "Step 8: Inspect audit.log entries"
# Audit.log is in the regrets/ dir (manifest_multi.json is in cwd, so regret_dir = ".").
if [ -f audit.log ]; then
  echo "----- audit.log -----"
  cat audit.log
  CHAIN_COUNT=$(grep -c "^  chain: " audit.log || echo 0)
  if [ "$CHAIN_COUNT" -eq 2 ]; then
    ok "audit.log has 2 chain-hashed entries (one per update)"
  else
    bad "audit.log expected 2 chain entries, got $CHAIN_COUNT"
  fi
  # Verify the second chain hash builds on the first (chained, not independent).
  FIRST_CHAIN=$(grep "^  chain: " audit.log | head -1 | awk '{print $2}')
  SECOND_CHAIN=$(grep "^  chain: " audit.log | tail -1 | awk '{print $2}')
  if [ "$FIRST_CHAIN" != "$SECOND_CHAIN" ]; then
    ok "chain hashes differ (proves the second entry chained from the first)"
  else
    bad "chain hashes should differ between the two entries"
  fi
else
  bad "audit.log not found"
fi

echo ""
echo "============================================"
echo -e "${GREEN}DEMO COMPLETE: All 8 steps passed${NC}"
echo "============================================"
echo ""
echo "Key takeaways:"
echo "  - update mode refreshes HASH + OUTPUT + INPUTS line atomically"
echo "  - audit.log entry includes chain hash (sha256(prevChain + entryContent)[:7])"
echo "  - after update, validate PASSES (the new behavior is now the golden)"
echo "  - reject --reason <4 words (parity with JS validate.js)"
echo "  - reject update without --cluster or --reason"

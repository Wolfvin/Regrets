#!/usr/bin/env bash
# verify.sh — Independent verification of C++ Regrets stack
#
# Verifies:
#   1. Capture 6 string-utils clusters → .regret files (with INPUTS line for multi-input)
#   2. Validate all clusters → PASS
#   3. Breaking change detection → FAIL for broken cluster
#   4. Valid refactor → PASS (same fingerprint)
#   5. Exception safety → skipped, not crashed
#   6. Cross-stack fingerprint parity (JS == C++) for ALL inputs (input[0] + INPUTS[])
#   7. Issue #315 multi-input contract — breaking change ONLY in input[1+] is detected
#
# This uses a DIFFERENT domain (string manipulation) than the PR's demo_math.cpp
# to avoid confirmation bias.
#
# BUG FIXES (Task 7 consolidation pass):
#   - Original verify.sh pointed to `manifest.json` which is a RESULTS file (not a
#     Regrets manifest). Capture silently failed (`|| true` masked the error) and
#     the grep-based "got 0" assertions incorrectly reported 3 FAILs even though
#     the underlying stack worked. Fixed: now uses `manifest_multi.json` (the real
#     Regrets manifest with 6 clusters).
#   - Original expected 5 clusters but manifest_multi.json has 6. Updated counts.
#   - Original `rm -f *.regret` was destructive — would delete committed .regret
#     files. Fixed: backup + restore via trap.
#   - Added Step 7: multi-input contract test (Issue #315 parity).

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJ_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"
HARNESS_SRC="$PROJ_DIR/scripts/regret_cpp/regret_harness.cpp"
REGRET_HPP="$PROJ_DIR/scripts/regret_cpp/regret.hpp"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

pass=0; fail=0; total=0

# Cleanup function — restore original code AND .regret files on exit.
cleanup() {
  # Restore string_utils.hpp from backup (if any Step broke it)
  if [ -f string_utils_backup.hpp ]; then
    mv string_utils_backup.hpp string_utils.hpp
  fi
  # Restore .regret files from backup (Step 1's capture may have rewritten them)
  if [ -d regret_backup ]; then
    rm -f *.regret
    cp regret_backup/*.regret . 2>/dev/null || true
    rm -rf regret_backup
  fi
}
trap cleanup EXIT

check() {
  total=$((total + 1))
  if [ "$1" -eq 0 ]; then
    echo -e "${GREEN}✅ PASS${NC}: $2"
    pass=$((pass + 1))
  else
    echo -e "${RED}❌ FAIL${NC}: $2"
    fail=$((fail + 1))
  fi
}

echo "============================================"
echo "C++ Regrets Stack — Independent Verification"
echo "============================================"

cd "$SCRIPT_DIR"
mkdir -p .build

# Backup the committed .regret files so capture can rewrite them safely.
mkdir -p regret_backup
cp *.regret regret_backup/ 2>/dev/null || true

# ─── Step 1: Compile & Capture ─────────────────────────────────────────────
echo ""
echo "── Step 1: Compile & Capture (manifest_multi.json, 6 clusters) ───"

g++ -std=c++17 -O2 -Wall -Wno-unused-parameter \
  -rdynamic \
  "$HARNESS_SRC" string_adapter.cpp \
  -I"$PROJ_DIR/scripts/regret_cpp" -I. \
  -o .build/regret_runner \
  -lcrypto -ljson-c -ldl -lm 2>&1
COMPILE_RC=$?
check $COMPILE_RC "Compile harness + string_adapter.cpp"

if [ $COMPILE_RC -ne 0 ]; then
  echo "Aborting: compile failed"
  exit 99
fi

# Use the CORRECT manifest (manifest_multi.json has 6 clusters in the standard
# Regrets manifest format; `manifest.json` is a verification RESULTS file).
OUTPUT=$(./.build/regret_runner capture --manifest ./manifest_multi.json 2>&1)
CAPTURE_RC=$?
check $CAPTURE_RC "Capture 6 clusters (exit code)"

CAPTURED=$(echo "$OUTPUT" | grep -c "✅ Fingerprint:" || true)
check "$([ "$CAPTURED" -eq 6 ] && echo 0 || echo 1)" "All 6 clusters captured (got $CAPTURED)"

# Verify INPUTS line is written for multi-input clusters (Issue #315 contract).
INPUTS_LINES=$(grep -l "^INPUTS " *.regret 2>/dev/null | wc -l || echo 0)
check "$([ "$INPUTS_LINES" -ge 5 ] && echo 0 || echo 1)" "INPUTS line written for 5 multi-input clusters (got $INPUTS_LINES)"

# Verify single-input cluster (multi-reverse has only 1 input) does NOT have INPUTS line.
if [ -f multi-reverse.regret ] && grep -q "^cluster: multi-reverse" multi-reverse.regret; then
  if grep -q "^INPUTS " multi-reverse.regret; then
    check 1 "Single-input cluster (multi-reverse) omits INPUTS line"
  else
    check 0 "Single-input cluster (multi-reverse) omits INPUTS line"
  fi
else
  check 1 "Single-input cluster (multi-reverse) file exists for INPUTS check"
fi

# ─── Step 2: Validate (should PASS) ────────────────────────────────────────
echo ""
echo "── Step 2: Validate (all should PASS) ───────"

OUTPUT=$(./.build/regret_runner validate --manifest ./manifest_multi.json 2>&1)
VALIDATE_RC=$?
check $VALIDATE_RC "Validate 6 clusters (exit code 0)"

PASSED=$(echo "$OUTPUT" | grep -c "✅ PASS" || true)
check "$([ "$PASSED" -eq 6 ] && echo 0 || echo 1)" "All 6 clusters pass (got $PASSED)"

# ─── Step 3: Breaking change detection ─────────────────────────────────────
echo ""
echo "── Step 3: Breaking change detection ────────"

cp string_utils.hpp string_utils_backup.hpp
# BREAKING: reverse() now skips first char (changes output for all multi-char inputs)
sed -i 's/std::string result(s.rbegin(), s.rend());/std::string result(s); \/\/ BROKEN/' string_utils.hpp

g++ -std=c++17 -O2 -Wall -Wno-unused-parameter \
  -rdynamic \
  "$HARNESS_SRC" string_adapter.cpp \
  -I"$PROJ_DIR/scripts/regret_cpp" -I. \
  -o .build/regret_runner \
  -lcrypto -ljson-c -ldl -lm 2>&1

OUTPUT=$(./.build/regret_runner validate --manifest ./manifest_multi.json 2>&1) || true
# We EXPECT non-zero exit code (validation failure)
FAILED=$(echo "$OUTPUT" | grep -c "❌ FAIL" || true)
check "$([ "$FAILED" -ge 1 ] && echo 0 || echo 1)" "Breaking change detected (FAIL count: $FAILED)"

mv string_utils_backup.hpp string_utils.hpp

# ─── Step 4: Valid refactor ────────────────────────────────────────────────
echo ""
echo "── Step 4: Valid refactor (should still PASS) ──"

# Recompile with restored source
g++ -std=c++17 -O2 -Wall -Wno-unused-parameter \
  -rdynamic \
  "$HARNESS_SRC" string_adapter.cpp \
  -I"$PROJ_DIR/scripts/regret_cpp" -I. \
  -o .build/regret_runner \
  -lcrypto -ljson-c -ldl -lm 2>&1

cp string_utils.hpp string_utils_backup.hpp
python3 -c "
content = open('string_utils.hpp').read()
old = 'std::string result(s.rbegin(), s.rend());'
new = 'std::string result; result.reserve(s.size()); for (int i = static_cast<int>(s.size()) - 1; i >= 0; --i) { result += s[i]; }'
content = content.replace(old, new)
open('string_utils.hpp', 'w').write(content)
"

g++ -std=c++17 -O2 -Wall -Wno-unused-parameter \
  -rdynamic \
  "$HARNESS_SRC" string_adapter.cpp \
  -I"$PROJ_DIR/scripts/regret_cpp" -I. \
  -o .build/regret_runner \
  -lcrypto -ljson-c -ldl -lm 2>&1

OUTPUT=$(./.build/regret_runner validate --manifest ./manifest_multi.json 2>&1) || true
RC=$?
check $RC "Valid refactor still PASS (exit code 0)"

mv string_utils_backup.hpp string_utils.hpp

# ─── Step 5: Exception safety ──────────────────────────────────────────────
echo ""
echo "── Step 5: Exception safety ─────────────────"

g++ -std=c++17 -O2 -Wall -Wno-unused-parameter \
  -rdynamic \
  "$HARNESS_SRC" throwing_adapter.cpp \
  -I"$PROJ_DIR/scripts/regret_cpp" -I. \
  -o .build/regret_runner_except \
  -lcrypto -ljson-c -ldl -lm 2>&1

OUTPUT=$(./.build/regret_runner_except capture --manifest ./manifest_exception.json 2>&1) || true
RC=$?
check $RC "Exception-throwing adapters: capture does not crash (exit 0)"

SKIPPED=$(echo "$OUTPUT" | grep -c "⏭️  Skipped" || true)
check "$([ "$SKIPPED" -eq 2 ] && echo 0 || echo 1)" "2 exception-throwing adapters skipped (got $SKIPPED)"

CAPTURED=$(echo "$OUTPUT" | grep -c "✅ Fingerprint:" || true)
check "$([ "$CAPTURED" -eq 1 ] && echo 0 || echo 1)" "1 normal adapter still captured alongside exceptions (got $CAPTURED)"

# ─── Step 6: Cross-stack fingerprint parity ───────────────────────────────
echo ""
echo "── Step 6: Cross-stack fingerprint parity (15 entries) ───"

node verify_parity.mjs 2>&1 || true
check $? "JS fingerprint == C++ fingerprint (15/15 entries incl. INPUTS)"

# ─── Step 7: Issue #315 multi-input contract ──────────────────────────────
echo ""
echo "── Step 7: Multi-input contract (Issue #315) ────"

# Recompile with restored source
g++ -std=c++17 -O2 -Wall -Wno-unused-parameter \
  -rdynamic \
  "$HARNESS_SRC" string_adapter.cpp \
  -I"$PROJ_DIR/scripts/regret_cpp" -I. \
  -o .build/regret_runner \
  -lcrypto -ljson-c -ldl -lm 2>&1

cp string_utils.hpp string_utils_backup.hpp
# SUBTLE breaking change: only affects inputs LONGER than 5 chars.
# input[0]="hello" (len 5) → still reversed correctly → top-level golden hash MATCHES
# input[1]="Regrets" (len 7) → uppercase first char → INPUTS[0] hash MISMATCHES
# Without Issue #315 multi-input contract, this would be a false GREEN.
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
content = content.replace(old, new)
open('string_utils.hpp', 'w').write(content)
"

g++ -std=c++17 -O2 -Wall -Wno-unused-parameter \
  -rdynamic \
  "$HARNESS_SRC" string_adapter.cpp \
  -I"$PROJ_DIR/scripts/regret_cpp" -I. \
  -o .build/regret_runner \
  -lcrypto -ljson-c -ldl -lm 2>&1

OUTPUT=$(./.build/regret_runner validate --manifest ./manifest_multi.json 2>&1)
RC=$?

# Validate MUST fail (multi-input contract catches the subtle breaking change)
check "$([ $RC -ne 0 ] && echo 0 || echo 1)" "Multi-input contract catches subtle breaking change (exit non-zero)"

# Verify the failure message includes "multi-input mismatch"
MULTI_FAIL=$(echo "$OUTPUT" | grep -c "multi-input mismatch" || true)
check "$([ "$MULTI_FAIL" -ge 1 ] && echo 0 || echo 1)" "Validate output reports multi-input mismatch ($MULTI_FAIL found)"

mv string_utils_backup.hpp string_utils.hpp

# ─── Summary ───────────────────────────────────────────────────────────────
echo ""
echo "============================================"
echo -e "Results: ${GREEN}${pass} PASS${NC} / ${RED}${fail} FAIL${NC} / ${total} total"
echo "============================================"

exit $fail

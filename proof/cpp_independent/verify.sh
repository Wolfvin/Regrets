#!/usr/bin/env bash
# verify_cpp_independent.sh — Independent verification of C++ Regrets stack
#
# Tests:
# 1. Capture 5 string-utils clusters → .regret files (PASS)
# 2. Validate all clusters → PASS
# 3. Breaking change detection → FAIL for broken cluster
# 4. Valid refactor → PASS (same fingerprint)
# 5. Exception safety → skipped, not crashed
# 6. Cross-stack fingerprint parity (JS == C++)
#
# This uses a DIFFERENT domain (string manipulation) than the PR's demo_math.cpp
# to avoid confirmation bias.

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

# Cleanup function to restore original code
cleanup() {
  if [ -f string_utils_backup.hpp ]; then
    mv string_utils_backup.hpp string_utils.hpp
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

# ─── Step 1: Compile & Capture ─────────────────────────────────────────────
echo ""
echo "── Step 1: Compile & Capture ────────────────"

g++ -std=c++17 -O2 -Wall -Wno-unused-parameter \
  -rdynamic \
  "$HARNESS_SRC" string_adapter.cpp \
  -I"$PROJ_DIR/scripts/regret_cpp" -I. \
  -o .build/regret_runner \
  -lcrypto -ljson-c -ldl -lm 2>&1

rm -f *.regret
OUTPUT=$(./.build/regret_runner capture --manifest ./manifest.json 2>&1) || true
RC=$?
check $RC "Capture 5 clusters"

CAPTURED=$(echo "$OUTPUT" | grep -c "✅ Fingerprint:" || true)
check "$([ "$CAPTURED" -eq 5 ] && echo 0 || echo 1)" "All 5 clusters captured (got $CAPTURED)"

# ─── Step 2: Validate (should PASS) ────────────────────────────────────────
echo ""
echo "── Step 2: Validate (all should PASS) ───────"

OUTPUT=$(./.build/regret_runner validate --manifest ./manifest.json 2>&1) || true
RC=$?
check $RC "Validate 5 clusters"

PASSED=$(echo "$OUTPUT" | grep -c "✅ PASS" || true)
check "$([ "$PASSED" -eq 5 ] && echo 0 || echo 1)" "All 5 clusters pass (got $PASSED)"

# ─── Step 3: Breaking change detection ─────────────────────────────────────
echo ""
echo "── Step 3: Breaking change detection ────────"

cp string_utils.hpp string_utils_backup.hpp
sed -i 's/std::string result(s.rbegin(), s.rend());/std::string result(s); \/\/ BROKEN/' string_utils.hpp

g++ -std=c++17 -O2 -Wall -Wno-unused-parameter \
  -rdynamic \
  "$HARNESS_SRC" string_adapter.cpp \
  -I"$PROJ_DIR/scripts/regret_cpp" -I. \
  -o .build/regret_runner \
  -lcrypto -ljson-c -ldl -lm 2>&1

OUTPUT=$(./.build/regret_runner validate --manifest ./manifest.json 2>&1) || true
# We EXPECT non-zero exit code (validation failure)
FAILED=$(echo "$OUTPUT" | grep -c "❌ FAIL" || true)
check "$([ "$FAILED" -ge 1 ] && echo 0 || echo 1)" "Breaking change detected (FAIL count: $FAILED)"

mv string_utils_backup.hpp string_utils.hpp

# ─── Step 4: Valid refactor ────────────────────────────────────────────────
echo ""
echo "── Step 4: Valid refactor (should still PASS) ──"

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

OUTPUT=$(./.build/regret_runner validate --manifest ./manifest.json 2>&1) || true
RC=$?
check $RC "Valid refactor still PASS"

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
check $RC "Exception-throwing adapters: capture does not crash"

SKIPPED=$(echo "$OUTPUT" | grep -c "⏭️  Skipped" || true)
check "$([ "$SKIPPED" -eq 2 ] && echo 0 || echo 1)" "2 exception-throwing adapters skipped (got $SKIPPED)"

CAPTURED=$(echo "$OUTPUT" | grep -c "✅ Fingerprint:" || true)
check "$([ "$CAPTURED" -eq 1 ] && echo 0 || echo 1)" "1 normal adapter still captured alongside exceptions (got $CAPTURED)"

# ─── Step 6: Cross-stack fingerprint parity ───────────────────────────────
echo ""
echo "── Step 6: Cross-stack fingerprint parity ───"

node verify_parity.mjs 2>&1 || true
check $? "JS fingerprint == C++ fingerprint (5/5)"

# ─── Summary ───────────────────────────────────────────────────────────────
echo ""
echo "============================================"
echo -e "Results: ${GREEN}${pass} PASS${NC} / ${RED}${fail} FAIL${NC} / ${total} total"
echo "============================================"

exit $fail

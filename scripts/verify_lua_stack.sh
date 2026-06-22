#!/usr/bin/env bash
# verify_lua_stack.sh — one-command end-to-end verifier for the Lua stack.
#
# Runs the full capture → validate cycle against the bundled fixture
# (tests/fixtures/lua-example) and asserts:
#   1. capture writes .regret files for both clusters
#   2. validate (no code change) exits 0, prints PASS
#   3. validate (breaking change) exits non-zero, prints FAIL
#   4. validate (valid refactor — same output) exits 0, prints PASS
#   5. cross-stack parity: Lua HASH === JS fingerprint() for the same I/O
#
# Self-contained — no setup needed. Skips with a clear message if `lua` is
# not on PATH (CI environments without Lua).
#
# Usage:
#   bash scripts/verify_lua_stack.sh
#   bash scripts/verify_lua_stack.sh --quiet    # only print final summary
#
# Exits 0 if all checks pass, non-zero otherwise.

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SKILL_DIR="$(dirname "$SCRIPT_DIR")"
FIXTURE="$SKILL_DIR/tests/fixtures/lua-example"

QUIET=0
if [[ "${1:-}" == "--quiet" ]]; then
  QUIET=1
fi

log() {
  if [[ "$QUIET" -eq 0 ]]; then
    echo "$@"
  fi
}

# ─── Preflight: lua must be on PATH ──────────────────────────────────────────
if ! command -v lua &>/dev/null; then
  echo "⚠️  lua is not installed. Install Lua 5.3+ to verify the Lua stack."
  echo "   Debian/Ubuntu: sudo apt-get install lua5.3"
  echo "   macOS: brew install lua"
  echo "   Skipping verify_lua_stack.sh."
  exit 77  # standard "skip" exit code (used by CI)
fi

LUA_VERSION=$(lua -v 2>&1 | head -1)
log "ℹ️  Using: $LUA_VERSION"
log ""

# ─── Helpers ─────────────────────────────────────────────────────────────────
PASS_COUNT=0
FAIL_COUNT=0

step() {
  log ""
  log "─── $1 ───"
}

check_pass() {
  log "  ✅ PASS: $1"
  PASS_COUNT=$((PASS_COUNT + 1))
}

check_fail() {
  echo "  ❌ FAIL: $1" >&2
  FAIL_COUNT=$((FAIL_COUNT + 1))
}

assert_exit_zero() {
  local label="$1"
  shift
  local output
  output=$("$@" 2>&1)
  local rc=$?
  if [[ "$rc" -eq 0 ]]; then
    check_pass "$label (exit 0)"
  else
    check_fail "$label (expected exit 0, got $rc)"
    echo "$output" | sed 's/^/      /' >&2
  fi
}

assert_exit_nonzero() {
  local label="$1"
  shift
  local output
  output=$("$@" 2>&1)
  local rc=$?
  if [[ "$rc" -ne 0 ]]; then
    check_pass "$label (exit non-zero)"
  else
    check_fail "$label (expected non-zero exit, got 0)"
    echo "$output" | sed 's/^/      /' >&2
  fi
}

# ─── Setup: clean fixture .regret files ──────────────────────────────────────
rm -f "$FIXTURE/regrets/reverse.regret" "$FIXTURE/regrets/count-vowels.regret"

# ─── 1. Capture: should write both .regret files ─────────────────────────────
step "1. capture — write .regret files for both Lua clusters"
( cd "$FIXTURE" && lua "$SCRIPT_DIR/capture_lua.lua" > /tmp/verify_lua_capture.txt 2>&1 )
if [[ -f "$FIXTURE/regrets/reverse.regret" && -f "$FIXTURE/regrets/count-vowels.regret" ]]; then
  check_pass "both .regret files written"
else
  check_fail ".regret files missing"
  cat /tmp/verify_lua_capture.txt | sed 's/^/      /' >&2
fi

# Verify required fields exist in both .regret files
for f in reverse count-vowels; do
  for field in cluster version fingerprint captured watches entry stack fingerprintLevel file INPUT OUTPUT HASH; do
    if ! grep -q "^$field" "$FIXTURE/regrets/$f.regret"; then
      check_fail "$f.regret missing field: $field"
    fi
  done
done
check_pass "all required fields present in both .regret files"

# ─── 2. Validate (no change): exit 0, PASS ───────────────────────────────────
step "2. validate (no code change) — exit 0, PASS"
( cd "$FIXTURE" && lua "$SCRIPT_DIR/validate_lua.lua" > /tmp/verify_lua_validate1.txt 2>&1 )
rc=$?
if [[ "$rc" -eq 0 ]] && grep -q "PASS reverse" /tmp/verify_lua_validate1.txt && grep -q "PASS count-vowels" /tmp/verify_lua_validate1.txt; then
  check_pass "validate (no change) prints PASS for both clusters, exit 0"
else
  check_fail "validate (no change) expected PASS for both clusters, exit 0"
  cat /tmp/verify_lua_validate1.txt | sed 's/^/      /' >&2
fi

# ─── 3. Breaking change: validate exits non-zero, FAIL ───────────────────────
step "3. breaking change — validate exit non-zero, FAIL"
cp "$FIXTURE/strings.lua" "$FIXTURE/strings.lua.bak"
# Replace reverse() to return input unchanged — output changes for all inputs
sed -i 's/return string.reverse(s)/return s  -- BUG: returns input unchanged/' "$FIXTURE/strings.lua"
( cd "$FIXTURE" && lua "$SCRIPT_DIR/validate_lua.lua" > /tmp/verify_lua_validate2.txt 2>&1 )
rc=$?
if [[ "$rc" -ne 0 ]] && grep -q "FAIL reverse" /tmp/verify_lua_validate2.txt; then
  check_pass "breaking change detected (FAIL reverse, exit non-zero)"
else
  check_fail "breaking change NOT detected"
  cat /tmp/verify_lua_validate2.txt | sed 's/^/      /' >&2
fi
# Restore
mv "$FIXTURE/strings.lua.bak" "$FIXTURE/strings.lua"

# ─── 4. Valid refactor (same output): validate exit 0, PASS ──────────────────
step "4. valid refactor (same output) — validate exit 0, PASS"
cp "$FIXTURE/strings.lua" "$FIXTURE/strings.lua.bak"
# Refactor reverse() to use a manual loop — output identical, fingerprint unchanged
python3 -c "
import re
with open('$FIXTURE/strings.lua') as f: src = f.read()
new = re.sub(
    r'function M\.reverse\(s\)\n    return string\.reverse\(s\)\nend',
    'function M.reverse(s)\n    -- Refactored: manual loop (same output)\n    local t = {}\n    for i = #s, 1, -1 do t[#t + 1] = s:sub(i, i) end\n    return table.concat(t)\nend',
    src,
)
assert new != src, 'refactor pattern did not match'
with open('$FIXTURE/strings.lua', 'w') as f: f.write(new)
"
( cd "$FIXTURE" && lua "$SCRIPT_DIR/validate_lua.lua" > /tmp/verify_lua_validate3.txt 2>&1 )
rc=$?
if [[ "$rc" -eq 0 ]] && grep -q "PASS reverse" /tmp/verify_lua_validate3.txt; then
  check_pass "valid refactor accepted (PASS, exit 0)"
else
  check_fail "valid refactor rejected (should have PASSED)"
  cat /tmp/verify_lua_validate3.txt | sed 's/^/      /' >&2
fi
# Restore
mv "$FIXTURE/strings.lua.bak" "$FIXTURE/strings.lua"

# ─── 5. Cross-stack parity: Lua HASH === JS fingerprint() ────────────────────
step "5. cross-stack parity — Lua HASH matches JS fingerprint()"
node -e "
const fs = require('fs');
const { fingerprint } = require('$SCRIPT_DIR/fingerprint.js');
const fixtures = [
  { file: '$FIXTURE/regrets/reverse.regret' },
  { file: '$FIXTURE/regrets/count-vowels.regret' },
];
let ok = true;
for (const { file } of fixtures) {
  const content = fs.readFileSync(file, 'utf8');
  const inputLine = content.match(/^INPUT\s+(.*)\$/m);
  const outputLine = content.match(/^OUTPUT\s+(.*)\$/m);
  const hashLine = content.match(/^HASH\s+(\S+)/m);
  if (!inputLine || !outputLine || !hashLine) {
    console.error('  malformed .regret: ' + file);
    ok = false;
    continue;
  }
  const input = JSON.parse(inputLine[1]);
  const output = JSON.parse(outputLine[1]);
  const luaHash = hashLine[1];
  const jsHash = fingerprint(input, output);
  if (luaHash !== jsHash) {
    console.error('  PARITY MISMATCH for ' + file + ': Lua=' + luaHash + ' JS=' + jsHash);
    ok = false;
  } else {
    console.log('  ' + file.split('/').pop() + ': Lua=' + luaHash + ' === JS=' + jsHash + ' ✅');
  }
}
process.exit(ok ? 0 : 1);
"
rc=$?
if [[ "$rc" -eq 0 ]]; then
  check_pass "Lua HASH === JS fingerprint() for both clusters"
else
  check_fail "cross-stack parity mismatch"
fi

# ─── 6. --update mode: re-capture + audit.log + chain hash ────────────────────
step "6. --update mode — rewrites .regret + appends audit.log entry"
# Clean audit.log to make verification deterministic
rm -f "$FIXTURE/regrets/audit.log"
BEFORE_CAPTURED=$(grep "^captured:" "$FIXTURE/regrets/reverse.regret" | awk '{print $2}')
BEFORE_HASH=$(grep "^HASH" "$FIXTURE/regrets/reverse.regret" | awk '{print $2}')
# Sleep 1.1s so the new captured timestamp is guaranteed to differ
sleep 1.1
( cd "$FIXTURE" && lua "$SCRIPT_DIR/validate_lua.lua" \
    --update reverse \
    --reason "no behavior change just verifying update flow" \
    > /tmp/verify_lua_update.txt 2>&1 )
rc=$?
AFTER_CAPTURED=$(grep "^captured:" "$FIXTURE/regrets/reverse.regret" | awk '{print $2}')
AFTER_HASH=$(grep "^HASH" "$FIXTURE/regrets/reverse.regret" | awk '{print $2}')
UPDATE_LINE_OK=$(grep -c "^UPDATE reverse:" /tmp/verify_lua_update.txt)
AUDIT_EXISTS=0; [[ -f "$FIXTURE/regrets/audit.log" ]] && AUDIT_EXISTS=1
AUDIT_HAS_UPDATE=$(grep -c "UPDATE  reverse" "$FIXTURE/regrets/audit.log" 2>/dev/null || echo 0)
AUDIT_HAS_CHAIN=$(grep -c "^  chain:" "$FIXTURE/regrets/audit.log" 2>/dev/null || echo 0)
INPUTS_LINE_OK=0; grep -q "^INPUTS " "$FIXTURE/regrets/reverse.regret" && INPUTS_LINE_OK=1

if [[ "$rc" -eq 0 \
   && "$BEFORE_CAPTURED" != "$AFTER_CAPTURED" \
   && "$BEFORE_HASH" == "$AFTER_HASH" \
   && "$UPDATE_LINE_OK" -ge 1 \
   && "$AUDIT_EXISTS" -eq 1 \
   && "$AUDIT_HAS_UPDATE" -ge 1 \
   && "$AUDIT_HAS_CHAIN" -ge 1 \
   && "$INPUTS_LINE_OK" -eq 1 ]]; then
  check_pass "--update refreshed captured, preserved INPUTS, wrote audit.log with chain hash"
else
  check_fail "--update mode did not meet all checks"
  echo "      rc=$rc" >&2
  echo "      before captured: $BEFORE_CAPTURED / after: $AFTER_CAPTURED" >&2
  echo "      before hash: $BEFORE_HASH / after: $AFTER_HASH" >&2
  echo "      UPDATE line: $UPDATE_LINE_OK, audit.log exists: $AUDIT_EXISTS" >&2
  echo "      audit UPDATE entries: $AUDIT_HAS_UPDATE, audit chain entries: $AUDIT_HAS_CHAIN" >&2
  echo "      INPUTS line preserved: $INPUTS_LINE_OK" >&2
  cat /tmp/verify_lua_update.txt | sed 's/^/      /' >&2
fi
# Clean up audit.log so it doesn't get committed
rm -f "$FIXTURE/regrets/audit.log"

# ─── Summary ─────────────────────────────────────────────────────────────────
log ""
log "═══════════════════════════════════════════════════════════════"
log "  Lua stack verification: $PASS_COUNT passed, $FAIL_COUNT failed"
log "═══════════════════════════════════════════════════════════════"

if [[ "$FAIL_COUNT" -gt 0 ]]; then
  exit 1
fi
exit 0

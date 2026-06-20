#!/usr/bin/env bash
# verify_lua_stack.sh — end-to-end verification for Lua stack support
#
# Creates a temporary Lua project, runs capture + validate (PASS for no-change
# and valid-refactor, FAIL for breaking change), and prints the results.
#
# Run from anywhere (the script creates its own temp project):
#   bash scripts/verify_lua_stack.sh
#
# Exit codes:
#   0 — all checks passed
#   1 — Lua not installed, or a check failed

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CAPTURE_LUA="$SCRIPT_DIR/capture_lua.sh"

# Check Lua is available (either on PATH, or built from source at /tmp/lua-5.4.7)
LUA_BIN="${LUA_INTERPRETER:-}"
if [ -z "$LUA_BIN" ]; then
  if command -v lua &> /dev/null; then
    LUA_BIN="lua"
  elif command -v lua5.4 &> /dev/null; then
    LUA_BIN="lua5.4"
  elif [ -x "/tmp/lua-5.4.7/src/lua" ]; then
    LUA_BIN="/tmp/lua-5.4.7/src/lua"
  else
    echo "❌ Lua interpreter not found."
    echo "   Install Lua (e.g. 'apt install lua5.4' or build from source: https://www.lua.org/ftp/lua-5.4.7.tar.gz)"
    echo "   Or set LUA_INTERPRETER=/path/to/lua"
    exit 1
  fi
fi
export LUA_INTERPRETER="$LUA_BIN"

# Create a temporary project
TMP_DIR=$(mktemp -d)
trap "rm -rf $TMP_DIR" EXIT

cd "$TMP_DIR"
mkdir -p regrets

# ─── Set up Lua module + manifest ─────────────────────────────────────────────
cat > math.lua << 'LUASRC'
-- math.lua — pure functions for regret testing
local M = {}

--- Add returns the sum of two numbers (pure function).
function M.add(a, b)
  return a + b
end

--- Reverse returns the reversed string (pure function).
function M.reverse(s)
  return s:reverse()
end

return M
LUASRC

cat > regrets/manifest.json << 'MANIFEST'
{
  "clusters": [
    {
      "id": "add",
      "entry": "add",
      "file": "math.lua",
      "stack": "lua",
      "fingerprintLevel": "entry",
      "multiArgs": true,
      "inputs": [
        [1, 2],
        [10, 20],
        [-5, 5]
      ]
    },
    {
      "id": "reverse",
      "entry": "reverse",
      "file": "math.lua",
      "stack": "lua",
      "fingerprintLevel": "entry",
      "inputs": [
        "hello",
        "regrets",
        ""
      ]
    }
  ]
}
MANIFEST

echo "╔══════════════════════════════════════════════════════════════════════╗"
echo "║  Lua Stack Verification — capture + validate end-to-end             ║"
echo "╚══════════════════════════════════════════════════════════════════════╝"
echo ""
echo "Project: $TMP_DIR"
echo "Lua:     $($LUA_BIN -v 2>&1)"
echo ""

# ─── Step 1: Capture ──────────────────────────────────────────────────────────
echo "━━━ Step 1: Capture ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
bash "$CAPTURE_LUA" capture 2>&1 | grep -E "✅|📄|Found" | sed 's/^/  /'
echo ""

# Verify .regret files were written
if [ ! -f regrets/add.regret ] || [ ! -f regrets/reverse.regret ]; then
  echo "❌ FAIL: .regret files not written"
  exit 1
fi

echo "  .regret files written:"
echo "    $(head -3 regrets/add.regret | tr '\n' ' ')"
echo "    $(head -3 regrets/reverse.regret | tr '\n' ' ')"
echo ""

# ─── Step 2: Validate (no change — should PASS) ───────────────────────────────
echo "━━━ Step 2: Validate (no code change — expect PASS) ━━━━━━━━━━━━━━━"
VALIDATE_OUTPUT=$(bash "$CAPTURE_LUA" validate 2>&1 || true)
echo "$VALIDATE_OUTPUT" | grep -E "✅|❌" | sed 's/^/  /'
echo ""

if echo "$VALIDATE_OUTPUT" | grep -q "All 2 Lua cluster(s) PASS"; then
  echo "  ✅ Step 2 passed — no-change validate is GREEN"
else
  echo "❌ FAIL: validate did not report 'All 2 Lua cluster(s) PASS'"
  exit 1
fi
echo ""

# ─── Step 3: Breaking change (add subtracts) — should FAIL ────────────────────
echo "━━━ Step 3: Breaking change (add now subtracts) — expect FAIL ━━━━━"
cat > math.lua << 'LUASRC_BREAKING'
local M = {}
function M.add(a, b) return a - b end  -- BREAKING: was a + b
function M.reverse(s) return s:reverse() end
return M
LUASRC_BREAKING

VALIDATE_OUTPUT=$(bash "$CAPTURE_LUA" validate 2>&1 || true)
echo "$VALIDATE_OUTPUT" | grep -E "✅|❌" | sed 's/^/  /'
echo ""

if echo "$VALIDATE_OUTPUT" | grep -q "add.*FAIL"; then
  echo "  ✅ Step 3 passed — breaking change detected (add FAIL)"
else
  echo "❌ FAIL: breaking change not detected (add should have FAILED)"
  exit 1
fi

if echo "$VALIDATE_OUTPUT" | grep -q "reverse.*PASS"; then
  echo "  ✅ Step 3 passed — unaffected cluster still PASSes (reverse)"
else
  echo "❌ FAIL: reverse should still PASS (it wasn't changed)"
  exit 1
fi
echo ""

# ─── Step 4: Valid refactor (loop-based, same output) — should PASS ───────────
echo "━━━ Step 4: Valid refactor (loop-based add, same output) — expect PASS ━━"
cat > math.lua << 'LUASRC_REFACTOR'
local M = {}
-- Add — refactored to use a loop (same output for all inputs).
function M.add(a, b)
  local result = a
  for i = 1, math.abs(b) do
    if b > 0 then result = result + 1 else result = result - 1 end
  end
  return result
end
-- Reverse — refactored to use a manual loop (same output).
function M.reverse(s)
  local result = {}
  for i = #s, 1, -1 do
    result[#result + 1] = s:sub(i, i)
  end
  return table.concat(result)
end
return M
LUASRC_REFACTOR

VALIDATE_OUTPUT=$(bash "$CAPTURE_LUA" validate 2>&1 || true)
echo "$VALIDATE_OUTPUT" | grep -E "✅|❌" | sed 's/^/  /'
echo ""

if echo "$VALIDATE_OUTPUT" | grep -q "All 2 Lua cluster(s) PASS"; then
  echo "  ✅ Step 4 passed — valid refactor is GREEN"
else
  echo "❌ FAIL: valid refactor should PASS but didn't"
  exit 1
fi
echo ""

# ─── Step 5: Cross-stack fingerprint parity check ─────────────────────────────
echo "━━━ Step 5: Cross-stack fingerprint parity (Lua vs JS) ━━━━━━━━━━━━━━"
# Compute Lua fingerprint for add([1,2])→3 from the .regret file
LUA_HASH=$(grep "^HASH" regrets/add.regret | awk '{print $2}')
# Compute JS fingerprint for the same input/output
JS_HASH=$(node -e "
import('${SCRIPT_DIR}/fingerprint.js').then(fp => {
  console.log(fp.fingerprint([1,2], 3))
})
" 2>/dev/null)
echo "  Lua fingerprint for add([1,2])→3:  $LUA_HASH"
echo "  JS fingerprint for add([1,2])→3:   $JS_HASH"
if [ "$LUA_HASH" = "$JS_HASH" ]; then
  echo "  ✅ Step 5 passed — fingerprints match (cross-stack parity confirmed)"
else
  echo "❌ FAIL: fingerprints differ — cross-stack parity broken"
  exit 1
fi
echo ""

# ─── Step 6: Module-based capture (using 'module' field instead of 'file') ───
echo "━━━ Step 6: Module-based capture (require()) ━━━━━━━━━━━━━━━━━━━━━━"
cat > mymodule.lua << 'LUAMOD'
local M = {}
function M.greet(name) return "Hello, " .. name .. "!" end
return M
LUAMOD
cat > regrets/manifest.json << 'MANIFEST2'
{
  "clusters": [{
    "id": "greet",
    "entry": "greet",
    "module": "mymodule",
    "stack": "lua",
    "fingerprintLevel": "entry",
    "inputs": ["world", "Lua"]
  }]
}
MANIFEST2
rm -f regrets/add.regret regrets/reverse.regret
MODULE_OUTPUT=$(bash "$CAPTURE_LUA" capture 2>&1 || true)
echo "$MODULE_OUTPUT" | grep -E "✅|📄" | sed 's/^/  /'
echo ""
MODULE_VALIDATE=$(bash "$CAPTURE_LUA" validate 2>&1 || true)
echo "$MODULE_VALIDATE" | grep -E "✅|❌" | sed 's/^/  /'
echo ""
if echo "$MODULE_VALIDATE" | grep -q "All 1 Lua cluster(s) PASS"; then
  echo "  ✅ Step 6 passed — module-based capture+validate works"
else
  echo "❌ FAIL: module-based capture+validate failed"
  exit 1
fi
echo ""

echo "╔══════════════════════════════════════════════════════════════════════╗"
echo "║  ✅ All verification steps passed — Lua stack is working            ║"
echo "╚══════════════════════════════════════════════════════════════════════╝"

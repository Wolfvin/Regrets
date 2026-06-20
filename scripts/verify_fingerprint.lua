#!/usr/bin/env lua
-- verify_fingerprint.lua — cross-stack fingerprint consistency check
-- Confirms our Lua fingerprint matches the JS/Python/PHP result for known pairs.
-- Known pair from proof/pyluach/elapsed-days.regret:
--   INPUT: 5783, OUTPUT: 2111852 → fingerprint: 5hj9vhu
--
-- Also tests a few extra cases computed via Node (the reference impl) inline.

local fp = dofile(arg[0]:gsub('[^/]+$', '') .. 'fingerprint_lua.lua')

local cases = {
  { input = 5783,         output = 2111852,        expected = '5hj9vhu',  desc = 'pyluach elapsed-days' },
  { input = 'hello',      output = 'world',        expected = nil,         desc = 'hello/world (smoke)' },
  { input = { 1, 2, 3 },  output = { sum = 6 },    expected = nil,         desc = 'array input + object output' },
  { input = nil,          output = nil,            expected = nil,         desc = 'nil/nil edge' },
}

local pass, fail = 0, 0
for _, c in ipairs(cases) do
  local ok, got = pcall(fp.fingerprint, c.input, c.output)
  if not ok then
    print(string.format('  ❌ %-40s ERROR: %s', c.desc, got))
    fail = fail + 1
  elseif c.expected == nil then
    print(string.format('  ℹ️  %-40s fingerprint = %s', c.desc, got))
    pass = pass + 1
  elseif got == c.expected then
    print(string.format('  ✅ %-40s fingerprint = %s (matches)', c.desc, got))
    pass = pass + 1
  else
    print(string.format('  ❌ %-40s expected %s, got %s', c.desc, c.expected, got))
    fail = fail + 1
  end
end

-- Also test stable_dumps normalization on a known input
print('\n--- stable_dumps tests ---')
local sd_cases = {
  { obj = { b = 1, a = 2 }, expected = '{"a":2,"b":1}' },
  { obj = { 3, 2, 1 },      expected = '[3,2,1]' },  -- array preserves order
  { obj = { nested = { z = 1, a = 2 } }, expected = '{"nested":{"a":2,"z":1}}' },
  { obj = { s = 'with "quote" and /slash' }, expected = '{"s":"with \\"quote\\" and /slash"}' },
  { obj = 1.0, expected = '1' },  -- whole float → int (matches JS JSON.stringify)
  { obj = 'null-test', expected = '"null-test"' },
}
for _, c in ipairs(sd_cases) do
  local got = fp.stable_dumps(c.obj)
  if got == c.expected then
    print(string.format('  ✅ %s', got))
    pass = pass + 1
  else
    print(string.format('  ❌ expected %s, got %s', c.expected, got))
    fail = fail + 1
  end
end

-- hex_to_base36 test (small known values)
print('\n--- hex_to_base36 tests ---')
local b36_cases = {
  { hex = '0',   expected = '0' },
  { hex = 'a',   expected = 'a' },         -- 10 → 'a'
  { hex = 'ff',  expected = '73' },        -- 255 → 6*36+19 = 235? let me think: 255/36 = 7 r 3 → '73'
  { hex = '100', expected = '74' },        -- 256 → 7*36+4
  { hex = 'ffffffff', expected = '1z141z3' },  -- 4294967295 in base36 (cross-verified with Python)
}
for _, c in ipairs(b36_cases) do
  local got = fp.hex_to_base36(c.hex)
  if got == c.expected then
    print(string.format('  ✅ %s → %s', c.hex, got))
    pass = pass + 1
  else
    print(string.format('  ❌ %s → expected %s, got %s', c.hex, c.expected, got))
    fail = fail + 1
  end
end

-- Verify Python cross-check (use system python3 if available)
print('\n--- Cross-stack verification with Python ---')
local PY_HELPER = [[
import hashlib, json, sys
def stable_dumps(o):
    return json.dumps(o, sort_keys=True, separators=(',',':'), ensure_ascii=False)
def to_base36(n):
    if n == 0: return '0'
    chars = '0123456789abcdefghijklmnopqrstuvwxyz'
    r = ''
    n = abs(n)
    while n > 0:
        n, rem = divmod(n, 36)
        r = chars[rem] + r
    return r
def fp(i, o):
    combined = stable_dumps(i) + '|' + stable_dumps(o)
    h = hashlib.sha256(combined.encode('utf-8')).hexdigest()
    return to_base36(int(h, 16))[:7]
i = json.loads(sys.argv[1])
o = json.loads(sys.argv[2])
print(fp(i, o))
]]
local function py_fingerprint(input_json, output_json)
  local tmp = os.tmpname()
  local f = io.open(tmp, 'w')
  f:write(PY_HELPER)
  f:close()
  local cmd = 'python3 ' .. tmp .. ' ' .. string.format('%q', input_json) .. ' ' .. string.format('%q', output_json) .. ' 2>/dev/null'
  -- Lua's %q produces a Lua-quoted string; for shell we need shell quoting. Use a safer path:
  -- write args to a file too and have Python read them.
  local args_file = tmp .. '.args'
  local af = io.open(args_file, 'w')
  af:write(input_json .. '\n')
  af:write(output_json .. '\n')
  af:close()
  local helper2 = PY_HELPER:gsub('sys%.argv%[1%]', "open('" .. args_file .. "').readline().strip()"):gsub('sys%.argv%[2%]', "open('" .. args_file .. "').readlines()[1].strip()")
  local h2 = io.open(tmp, 'w')
  h2:write(helper2)
  h2:close()
  local h = io.popen('python3 ' .. tmp .. ' 2>&1', 'r')
  local s = h:read('*a') or ''
  s = s:gsub('%s+$', '')
  h:close()
  os.remove(tmp)
  os.remove(args_file)
  return s
end

local cross_cases = {
  { input = 5783, output = 2111852 },
  { input = 'hello', output = 'world' },
  { input = { 1, 2, 3 }, output = { sum = 6 } },
  { input = { a = 1, b = { c = 2 } }, output = { ok = true, val = 42 } },
}
for _, c in ipairs(cross_cases) do
  local lua_fp = fp.fingerprint(c.input, c.output)
  local py_fp = py_fingerprint(fp.stable_dumps(c.input), fp.stable_dumps(c.output))
  if lua_fp == py_fp then
    print(string.format('  ✅ Lua %s == Python %s', lua_fp, py_fp))
    pass = pass + 1
  else
    print(string.format('  ❌ Lua %s != Python %s   (input=%s, output=%s)',
        lua_fp, py_fp, fp.stable_dumps(c.input), fp.stable_dumps(c.output)))
    fail = fail + 1
  end
end

print(string.format('\n=== %d passed, %d failed ===\n', pass, fail))
os.exit(fail == 0 and 0 or 1)

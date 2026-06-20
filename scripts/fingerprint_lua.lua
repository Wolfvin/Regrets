-- fingerprint_lua.lua — deterministic hash for regression contracts
-- IDENTICAL algorithm to fingerprint.js / fingerprint.py / fingerprint_php.php.
-- Same input must produce the same 7-char hash across all stacks.
--
-- Algorithm:
--   combined = stableStringify(input) .. '|' .. stableStringify(output)
--   hash_hex = sha256(combined)
--   base36 = hex_to_base36(hash_hex)
--   return base36:sub(1, 7)
--
-- Shared module — required by capture_lua.lua and validate_lua.lua via dofile().
-- Returns a table of functions.

local M = {}

-- ─── stable_dumps: deterministic JSON with recursively sorted keys ────────────
-- Mirrors JS stableStringify() and PHP stable_dumps().
-- Lua tables are ambiguous (array vs object); we treat:
--   * tables with contiguous integer keys 1..n as arrays  → "[...]"
--   * all other tables as objects                          → "{...}"
--   * empty table {} is treated as an empty array "[]"
local function is_array(t)
  if type(t) ~= 'table' then return false end
  local n = 0
  for _ in pairs(t) do n = n + 1 end
  if n == 0 then return true end  -- empty table = empty array
  local i = 0
  for k, _ in pairs(t) do
    i = i + 1
    if k ~= i then return false end
  end
  return true
end
M.is_array = is_array

local function stable_sort_recursive(obj)
  local t = type(obj)
  if t == 'nil' or t == 'boolean' or t == 'number' or t == 'string' then
    return obj
  end
  if t == 'table' then
    if is_array(obj) then
      local out = {}
      for i, v in ipairs(obj) do
        out[i] = stable_sort_recursive(v)
      end
      return out
    end
    -- object: collect keys, sort, rebuild
    local keys = {}
    for k, _ in pairs(obj) do keys[#keys + 1] = k end
    table.sort(keys, function(a, b) return tostring(a) < tostring(b) end)
    local out = {}
    for _, k in ipairs(keys) do
      out[k] = stable_sort_recursive(obj[k])
    end
    return out
  end
  return tostring(obj)
end

-- JSON encoder — mirrors json_encode($x, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES)
-- No pretty printing, no escaping of /, no \u conversion (UTF-8 bytes passed through).
local function json_escape_string(s)
  -- Escape per RFC 8259; do NOT escape forward slash.
  s = s:gsub('\\', '\\\\')
       :gsub('"', '\\"')
       :gsub('\b', '\\b')
       :gsub('\f', '\\f')
       :gsub('\n', '\\n')
       :gsub('\r', '\\r')
       :gsub('\t', '\\t')
  -- Control chars 0x00-0x1F → \u00XX
  s = s:gsub('([\x00-\x1f])', function(c)
    return string.format('\\u%04x', c:byte())
  end)
  return s
end
M.json_escape_string = json_escape_string

local function encode_json(obj)
  local t = type(obj)
  if t == 'nil' then return 'null' end
  if t == 'boolean' then return obj and 'true' or 'false' end
  if t == 'number' then
    -- Match JS/PHP number formatting:
    --   * integers (including whole floats) → no decimal point
    --   * non-finite → "null" (matches JSON.stringify)
    if obj ~= obj or obj == math.huge or obj == -math.huge then return 'null' end
    if math.type(obj) == 'integer' then
      return tostring(obj)
    end
    -- float: if whole, emit as integer (matches JSON.stringify in JS for 1.0 → 1)
    -- But preserve PHP JSON_PRESERVE_ZERO_FRACTION? Looking at PHP, that flag keeps 1.0 as "1.0".
    -- JS JSON.stringify(1.0) returns "1". Python json.dumps(1.0) returns "1.0".
    -- The fingerprint spec uses JS-style: 1.0 → "1".
    -- We follow JS here for cross-stack consistency.
    if obj == math.floor(obj) and math.abs(obj) < 1e15 then
      return tostring(math.floor(obj))
    end
    -- Use %.17g for max precision round-trip; matches Lua's default tostring() for floats.
    return tostring(obj)
  end
  if t == 'string' then
    return '"' .. json_escape_string(obj) .. '"'
  end
  if t == 'table' then
    if is_array(obj) then
      if #obj == 0 and next(obj) == nil then
        return '[]'  -- truly empty
      end
      local parts = {}
      for _, v in ipairs(obj) do
        parts[#parts + 1] = encode_json(v)
      end
      return '[' .. table.concat(parts, ',') .. ']'
    end
    -- object
    local keys = {}
    for k, _ in pairs(obj) do keys[#keys + 1] = k end
    table.sort(keys, function(a, b) return tostring(a) < tostring(b) end)
    local parts = {}
    for _, k in ipairs(keys) do
      local kstr = type(k) == 'string' and k or tostring(k)
      parts[#parts + 1] = '"' .. json_escape_string(kstr) .. '":' .. encode_json(obj[k])
    end
    return '{' .. table.concat(parts, ',') .. '}'
  end
  -- functions, userdata, threads → null
  return 'null'
end
M.encode_json = encode_json

function M.stable_dumps(obj)
  return encode_json(stable_sort_recursive(obj))
end

-- ─── normalize: replace non-deterministic values before hashing ───────────────
-- Mirrors PHP normalize() / JS fingerprint.js normalize().
-- Supported rules: timestamps, uuids, absPaths, dynamicDates, floatPrecision,
-- floatTolerance (default 2 decimals, "floatTolerance:N" for N decimals), epochs
function M.normalize(obj, rules)
  if not rules or #rules == 0 then return obj end
  local rset = {}
  for _, r in ipairs(rules) do rset[r] = true end

  local t = type(obj)
  if t == 'string' then
    if rset['timestamps'] and obj:match('^%d%d%d%d%-%d%d%-%d%dT[%d:.Z+%-]+$') then
      return '<TIMESTAMP>'
    end
    if rset['uuids'] and obj:match('^[0-9a-fA-F]+%-[0-9a-fA-F]+%-[0-9a-fA-F]+%-[0-9a-fA-F]+%-[0-9a-fA-F]+$')
       and #obj == 36 then
      return '<UUID>'
    end
    if rset['absPaths'] and obj:sub(1, 1) == '/' then
      local parts = {}
      for part in obj:gmatch('[^/]+') do parts[#parts + 1] = part end
      if #parts >= 3 then
        return '<ROOT>/' .. table.concat(parts, '/', 4)
      end
    end
    if rset['floatPrecision'] then
      -- Strip trailing .0 from number-like strings
      local new = obj:gsub('^%-?(%d+)%.0+$', '%1')
      if new ~= obj then return new end
    end
    return obj
  end
  if t == 'number' then
    if rset['epochs'] and obj > 1000000000 and obj < 9999999999999 then
      return '<EPOCH>'
    end
    -- floatTolerance
    local ftRule = nil
    for _, r in ipairs(rules) do
      if r:sub(1, 14) == 'floatTolerance' then ftRule = r break end
    end
    if ftRule then
      local decimals = 2
      local colon = ftRule:find(':')
      if colon then
        decimals = tonumber(ftRule:sub(colon + 1)) or 2
      end
      local factor = 10 ^ decimals
      return math.floor(obj * factor + 0.5) / factor
    end
    if rset['floatPrecision'] and math.type(obj) == 'float' and obj == math.floor(obj) and math.abs(obj) < 1e15 then
      return math.floor(obj)  -- normalize whole float to int
    end
    return obj
  end
  if t == 'table' then
    if is_array(obj) then
      local out = {}
      for i, v in ipairs(obj) do out[i] = M.normalize(v, rules) end
      return out
    end
    local out = {}
    for k, v in pairs(obj) do out[k] = M.normalize(v, rules) end
    return out
  end
  return obj
end

-- ─── strip_fields: remove ignored fields from object output ───────────────────
function M.strip_fields(obj, fields)
  if not fields or #fields == 0 then return obj end
  local fset = {}
  for _, f in ipairs(fields) do fset[f] = true end

  local t = type(obj)
  if t == 'table' then
    if is_array(obj) then
      local out = {}
      for i, v in ipairs(obj) do out[i] = M.strip_fields(v, fields) end
      return out
    end
    local out = {}
    for k, v in pairs(obj) do
      if not fset[k] then out[k] = M.strip_fields(v, fields) end
    end
    return out
  end
  return obj
end

-- ─── deep_clone: deep copy via JSON round-trip ────────────────────────────────
function M.deep_clone(val)
  local s = M.stable_dumps(val)
  -- Decode back; use a minimal JSON decoder
  return M.json_decode(s)
end

-- ─── JSON decoder (minimal, supports null/bool/number/string/array/object) ────
local json_decode
local function skip_ws(s, pos)
  while pos <= #s and s:byte(pos) <= 32 do pos = pos + 1 end
  return pos
end

local function decode_value(s, pos)
  pos = skip_ws(s, pos)
  local c = s:sub(pos, pos)
  if c == '"' then
    -- string
    pos = pos + 1
    local out = {}
    while pos <= #s do
      local ch = s:sub(pos, pos)
      if ch == '"' then
        return table.concat(out), pos + 1
      elseif ch == '\\' then
        pos = pos + 1
        local esc = s:sub(pos, pos)
        if esc == 'u' then
          local hex = s:sub(pos + 1, pos + 4)
          local cp = tonumber(hex, 16)
          if cp then
            -- encode as UTF-8
            if cp < 0x80 then
              out[#out + 1] = string.char(cp)
            elseif cp < 0x800 then
              out[#out + 1] = string.char(0xC0 + math.floor(cp / 0x40), 0x80 + (cp % 0x40))
            else
              out[#out + 1] = string.char(0xE0 + math.floor(cp / 0x1000),
                                          0x80 + math.floor(cp / 0x40) % 0x40,
                                          0x80 + cp % 0x40)
            end
          end
          pos = pos + 5
        elseif esc == 'b' then out[#out + 1] = '\b'; pos = pos + 1
        elseif esc == 'f' then out[#out + 1] = '\f'; pos = pos + 1
        elseif esc == 'n' then out[#out + 1] = '\n'; pos = pos + 1
        elseif esc == 'r' then out[#out + 1] = '\r'; pos = pos + 1
        elseif esc == 't' then out[#out + 1] = '\t'; pos = pos + 1
        elseif esc == '"' then out[#out + 1] = '"'; pos = pos + 1
        elseif esc == '\\' then out[#out + 1] = '\\'; pos = pos + 1
        elseif esc == '/' then out[#out + 1] = '/'; pos = pos + 1
        else out[#out + 1] = esc; pos = pos + 1
        end
      else
        out[#out + 1] = ch
        pos = pos + 1
      end
    end
    error("unterminated string in JSON")
  elseif c == 't' then
    return true, pos + 4  -- "true"
  elseif c == 'f' then
    return false, pos + 5  -- "false"
  elseif c == 'n' then
    return nil, pos + 4  -- "null"
  elseif c == '[' then
    pos = pos + 1
    local arr = {}
    pos = skip_ws(s, pos)
    if s:sub(pos, pos) == ']' then return arr, pos + 1 end
    while true do
      local val
      val, pos = decode_value(s, pos)
      arr[#arr + 1] = val
      pos = skip_ws(s, pos)
      local sep = s:sub(pos, pos)
      if sep == ',' then pos = pos + 1
      elseif sep == ']' then return arr, pos + 1
      else error("expected , or ] in JSON array") end
    end
  elseif c == '{' then
    pos = pos + 1
    local obj = {}
    pos = skip_ws(s, pos)
    if s:sub(pos, pos) == '}' then return obj, pos + 1 end
    while true do
      -- key must be a string
      local key
      key, pos = decode_value(s, pos)
      if type(key) ~= 'string' then error("expected string key in JSON object") end
      pos = skip_ws(s, pos)
      if s:sub(pos, pos) ~= ':' then error("expected : in JSON object") end
      pos = pos + 1
      local val
      val, pos = decode_value(s, pos)
      obj[key] = val
      pos = skip_ws(s, pos)
      local sep = s:sub(pos, pos)
      if sep == ',' then pos = pos + 1
      elseif sep == '}' then return obj, pos + 1
      else error("expected , or } in JSON object") end
    end
  else
    -- number — scan until delimiter
    local start = pos
    while pos <= #s do
      local b = s:byte(pos)
      if (b >= 48 and b <= 57) or b == 45 or b == 43 or b == 46 or b == 101 or b == 69 then
        pos = pos + 1
      else
        break
      end
    end
    local numstr = s:sub(start, pos - 1)
    if numstr == '' then error("unexpected character in JSON: " .. c) end
    local n = tonumber(numstr)
    if not n then error("invalid number in JSON: " .. numstr) end
    return n, pos
  end
end

function M.json_decode(s)
  if s == nil or s == '' then return nil end
  local val, pos = decode_value(s, 1)
  return val
end

-- ─── sha256_hex: compute SHA-256 digest, return lowercase hex ─────────────────
-- Uses external `sha256sum` binary (coreutils, universally available on Linux/macOS).
-- Pure-Lua implementation would add ~200 lines; deferring to the system tool matches
-- what bash wrappers (capture_go.sh, capture_rust.sh) already do.
local function shell_quote(s)
  -- Single-quote escape: '...' with embedded ' becoming '\''
  return "'" .. s:gsub("'", "'\\''") .. "'"
end

function M.sha256_hex(s)
  -- Write to temp file to avoid shell-escaping pitfalls (matches PHP approach implicitly)
  local tmpfile = os.tmpname()
  local f = io.open(tmpfile, 'wb')
  if not f then
    os.remove(tmpfile)
    error("fingerprint_lua: cannot open temp file for sha256")
  end
  f:write(s)
  f:close()
  local cmd = 'sha256sum ' .. shell_quote(tmpfile) .. ' 2>/dev/null'
  local handle = io.popen(cmd, 'r')
  if not handle then
    os.remove(tmpfile)
    error("fingerprint_lua: cannot run sha256sum (is coreutils installed?)")
  end
  local output = handle:read('*a')
  handle:close()
  os.remove(tmpfile)
  local hex = output:match('^(%x+)')
  if not hex then
    error("fingerprint_lua: sha256sum produced no hex output")
  end
  return hex:lower()
end

-- ─── hex_to_base36: arbitrary-precision hex → base36 string ───────────────────
-- Mirrors JS BigInt('0x' + hex).toString(36) and Python to_base36(int(hex, 16)).
-- Long-division on the hex string; correct for any input length.
function M.hex_to_base36(hex)
  hex = hex:lower():gsub('^0+', '')
  if hex == '' then return '0' end
  local digits = '0123456789abcdefghijklmnopqrstuvwxyz'
  local result = {}
  while hex ~= '' do
    -- Divide hex (interpreted as a big-endian number) by 36, in-place
    local remainder = 0
    local quotient = {}
    local leading = true
    for i = 1, #hex do
      local d = tonumber(hex:sub(i, i), 16)
      local value = remainder * 16 + d
      local q = math.floor(value / 36)
      remainder = value % 36
      if q == 0 and leading then
        -- skip leading zero in quotient
      else
        leading = false
        quotient[#quotient + 1] = string.format('%x', q)
      end
    end
    -- remainder is the next base36 digit (LSB first)
    result[#result + 1] = digits:sub(remainder + 1, remainder + 1)
    hex = table.concat(quotient)
  end
  -- result has digits LSB-first; reverse for MSB-first
  local n = #result
  for i = 1, math.floor(n / 2) do
    result[i], result[n - i + 1] = result[n - i + 1], result[i]
  end
  return table.concat(result)
end

-- ─── fingerprint: SHA-256(stableStringify(input) + '|' + stableStringify(output)) → base36 → first 7 chars ──
function M.fingerprint(input_data, output_data, rules, ignore_fields)
  local clean_input = M.strip_fields(M.normalize(M.deep_clone(input_data), rules or {}), ignore_fields or {})
  local clean_output = M.strip_fields(M.normalize(M.deep_clone(output_data), rules or {}), ignore_fields or {})
  local combined = M.stable_dumps(clean_input) .. '|' .. M.stable_dumps(clean_output)
  local hash_hex = M.sha256_hex(combined)
  local base36 = M.hex_to_base36(hash_hex)
  return base36:sub(1, 7)
end

-- ─── extract_schema: structural fingerprint (replace all values with type names) ──
function M.extract_schema(obj)
  local t = type(obj)
  if t == 'nil' then return 'null' end
  if t == 'boolean' then return 'boolean' end
  if t == 'number' then return 'number' end
  if t == 'string' then return 'string' end
  if t == 'table' then
    if is_array(obj) then
      if #obj == 0 and next(obj) == nil then return 'array' end
      local seen = {}
      local schemas = {}
      local sample_size = math.min(#obj, 5)
      for i = 1, sample_size do
        local s = M.extract_schema(obj[i])
        local key = M.stable_dumps(s)
        if not seen[key] then
          seen[key] = true
          schemas[#schemas + 1] = s
        end
      end
      if #schemas == 1 then return { schemas[1] } end
      return schemas
    end
    -- object: sort keys, recurse
    local keys = {}
    for k, _ in pairs(obj) do keys[#keys + 1] = k end
    table.sort(keys, function(a, b) return tostring(a) < tostring(b) end)
    local out = {}
    for _, k in ipairs(keys) do out[k] = M.extract_schema(obj[k]) end
    return out
  end
  return 'unknown'
end

return M

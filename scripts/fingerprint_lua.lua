-- scripts/fingerprint_lua.lua — deterministic hash for regression contracts
--
-- IDENTICAL algorithm to fingerprint.js / fingerprint.py / fingerprint_php.php.
-- Same input MUST produce the same 7-char hash as the JS implementation
-- (cross-stack parity verified: fingerprint("hello", "olleh") == "5nssd6s").
--
-- This is a shared module — required by both capture_lua.lua and validate_lua.lua.
--
-- API:
--   local fp = require("fingerprint_lua")
--   fp.sha256_hex(str)            → 64-char lowercase hex
--   fp.stable_stringify(value)    → canonical JSON string (sorted keys)
--   fp.normalize(value, rules)    → normalized value (mirrors JS normalize)
--   fp.to_base36(hexstr)          → base36 string of a hex number
--   fp.fingerprint(in, out, cfg)  → 7-char base36 hash
--   fp.json_decode(str)           → Lua value (nil for "null"/"undefined")
--   fp.json_encode(value)         → JSON string (canonical via stable_stringify)
--
-- Cross-stack consistency:
--   JS:     BigInt('0x' + sha256_hex).toString(36).slice(0, 7)
--   Python: to_base36(int(sha256_hex, 16))[:7]
--   PHP:    to_base36(gmp_init(sha256_hex, 16))[:7]
--   Lua:    to_base36(sha256_hex):sub(1, 7)   (this file)
--
-- Pure Lua 5.3+ — no external dependencies (uses vendored scripts/sha2.lua).

local sha2 = require("sha2")

local M = {}

-- ─── SHA-256 ──────────────────────────────────────────────────────────────────

function M.sha256_hex(str)
  return sha2.sha256(str)
end

-- ─── Base36 conversion ────────────────────────────────────────────────────────
--
-- Convert an arbitrary-length hex string to base36. Mirrors JS
-- BigInt('0x' + hex).toString(36). Lua 5.4 numbers are doubles (only 53 bits
-- of integer precision), so we cannot use native arithmetic on a 256-bit hash.
-- Instead we perform long division by 36 directly on the hex string, collecting
-- remainders as base36 digits (least-significant first), then reverse.

local BASE36_DIGITS = "0123456789abcdefghijklmnopqrstuvwxyz"

function M.to_base36(hexstr)
  if hexstr == nil or hexstr == "" then return "0" end
  -- Normalize: lowercase, strip leading zeros.
  hexstr = string.lower(hexstr)
  hexstr = string.gsub(hexstr, "^0+", "")
  if hexstr == "" then return "0" end

  local digits = {}  -- least-significant first
  local current = hexstr
  while current ~= "" do
    local quotient = {}
    local remainder = 0
    local started = false
    for i = 1, #current do
      local c = string.sub(current, i, i)
      local digit = tonumber(c, 16)  -- 0..15
      local value = remainder * 16 + digit
      local q = math.floor(value / 36)
      remainder = value - q * 36     -- 0..35
      if q ~= 0 then started = true end
      if started then
        quotient[#quotient + 1] = string.format("%x", q)
      end
    end
    -- remainder is the next base36 digit (least-significant first)
    digits[#digits + 1] = string.sub(BASE36_DIGITS, remainder + 1, remainder + 1)
    current = table.concat(quotient)
  end

  -- Reverse to most-significant first.
  for i = 1, #digits // 2 do
    local j = #digits - i + 1
    digits[i], digits[j] = digits[j], digits[i]
  end
  return table.concat(digits)
end

-- ─── JSON string escaping ─────────────────────────────────────────────────────
--
-- Matches JS JSON.stringify string output: " \ and control chars escaped,
-- \uXXXX lowercase for control chars below 0x20, non-ASCII bytes passed
-- through as-is (UTF-8 preserved — same as JS default).

local function json_escape_string(s)
  local out = {}
  for i = 1, #s do
    local b = string.byte(s, i)
    if b == 0x22 then        out[#out + 1] = '\\"'
    elseif b == 0x5C then    out[#out + 1] = "\\\\"
    elseif b == 0x08 then    out[#out + 1] = "\\b"
    elseif b == 0x09 then    out[#out + 1] = "\\t"
    elseif b == 0x0A then    out[#out + 1] = "\\n"
    elseif b == 0x0C then    out[#out + 1] = "\\f"
    elseif b == 0x0D then    out[#out + 1] = "\\r"
    elseif b < 0x20 then     out[#out + 1] = string.format("\\u%04x", b)
    else                     out[#out + 1] = string.char(b)
    end
  end
  return '"' .. table.concat(out) .. '"'
end

-- ─── stable_stringify ─────────────────────────────────────────────────────────
--
-- Canonical JSON serialization: object keys sorted recursively, no whitespace.
-- Mirrors scripts/fingerprint.js stableStringify() so that Lua and JS produce
-- byte-identical output for the same value → identical SHA-256 → identical hash.
--
-- Sentinels (match JS exactly):
--   nil          → "null"
--   NaN          → '"__nan__"'
--   +Inf / -Inf  → '"__infinity__"' / '"__neg_infinity__"'
--   function     → '"__function__"'
--   circular     → '"__circular__"'
--
-- Array vs object heuristic: a Lua table is treated as an array iff every key
-- is an integer in 1..n (contiguous). Otherwise it is treated as an object
-- (string keys sorted lexicographically). Empty tables serialize as "{}".

local function is_array_table(t)
  local n = 0
  for _ in pairs(t) do n = n + 1 end
  if n == 0 then return false end
  for i = 1, n do
    if t[i] == nil then return false end
  end
  -- Ensure no extra non-integer keys beyond 1..n
  local count = 0
  for _ in pairs(t) do count = count + 1 end
  return count == n
end

local function stable_stringify(obj, seen)
  seen = seen or {}
  if obj == nil then return "null" end
  local t = type(obj)
  if t == "string" then
    return json_escape_string(obj)
  elseif t == "number" then
    if obj ~= obj then return '"__nan__"' end
    if obj == math.huge then return '"__infinity__"' end
    if obj == -math.huge then return '"__neg_infinity__"' end
    if math.type(obj) == "integer" then
      return tostring(obj)
    end
    -- Float: normalize whole-valued floats to integer form (5.0 → "5")
    -- so that Lua float and JS Number serialize identically.
    if obj == math.floor(obj) and math.abs(obj) < 1e21 then
      return tostring(math.tointeger(obj) or math.floor(obj))
    end
    return tostring(obj)
  elseif t == "boolean" then
    return obj and "true" or "false"
  elseif t == "table" then
    if seen[obj] then return '"__circular__"' end
    seen[obj] = true
    local result
    if is_array_table(obj) then
      local n = 0
      for _ in pairs(obj) do n = n + 1 end
      local parts = {}
      for i = 1, n do
        parts[#parts + 1] = stable_stringify(obj[i], seen)
      end
      result = "[" .. table.concat(parts, ",") .. "]"
    else
      -- Object: collect + sort keys as strings.
      local keys = {}
      for k, _ in pairs(obj) do
        keys[#keys + 1] = tostring(k)
      end
      table.sort(keys)
      local parts = {}
      for _, k in ipairs(keys) do
        -- Numeric-looking keys: JS Object.keys stringifies them, JSON.stringify
        -- of the key string yields the quoted string. We always quote string keys.
        parts[#parts + 1] = json_escape_string(k) .. ":" .. stable_stringify(obj[k], seen)
      end
      result = "{" .. table.concat(parts, ",") .. "}"
    end
    seen[obj] = nil
    return result
  end
  -- function / userdata / thread
  return '"__function__"'
end
M.stable_stringify = stable_stringify

-- ─── normalize ────────────────────────────────────────────────────────────────
--
-- Minimal normalization mirroring the JS `normalize(value, rules)` rules that
-- are relevant to non-JS stacks. Supports the common rules: timestamps, uuids,
-- absPaths, epochs, floatPrecision. Less common JS rules (incrementingIds,
-- randomIds, autoIncrement, isoDates, timezoneOffsets, dynamicDates,
-- normalizeNow, floatTolerance) are not yet ported — Lua clusters that need
-- them should use normalize rules supported here, or fall back to entry-only
-- fingerprinting.

local function normalize_string(s, rules)
  for _, rule in ipairs(rules) do
    if rule == "timestamps" and string.match(s, "^%d%d%d%d%-%d%d%-%d%dT[%d:.Z+%-]+$") then
      return "<TIMESTAMP>"
    elseif rule == "uuids" and string.match(s, "^[0-9a-fA-F][0-9a-fA-F][0-9a-fA-F][0-9a-fA-F][0-9a-fA-F][0-9a-fA-F][0-9a-fA-F][0-9a-fA-F]%-[0-9a-fA-F][0-9a-fA-F][0-9a-fA-F][0-9a-fA-F]%-[0-9a-fA-F][0-9a-fA-F][0-9a-fA-F][0-9a-fA-F]%-[0-9a-fA-F][0-9a-fA-F][0-9a-fA-F][0-9a-fA-F]%-[0-9a-fA-F][0-9a-fA-F][0-9a-fA-F][0-9a-fA-F][0-9a-fA-F][0-9a-fA-F][0-9a-fA-F][0-9a-fA-F][0-9a-fA-F]$") then
      return "<UUID>"
    elseif rule == "absPaths" and string.sub(s, 1, 1) == "/" then
      local parts = {}
      for seg in string.gmatch(s, "[^/]+") do
        parts[#parts + 1] = seg
      end
      if #parts >= 3 then
        return "<ROOT>/" .. table.concat({ table.unpack(parts, 3) }, "/")
      end
    elseif rule == "floatPrecision" then
      -- Strip trailing ".0" from number-like strings: "1500000.0" → "1500000"
      local stripped = string.gsub(s, "^%-?(%d+)%.0+$", "%1")
      if stripped ~= s then return stripped end
    end
  end
  return s
end

local function normalize(obj, rules, seen)
  rules = rules or {}
  seen = seen or {}
  if obj == nil then return nil end
  local t = type(obj)
  if t == "string" then
    return normalize_string(obj, rules)
  elseif t == "number" then
    for _, rule in ipairs(rules) do
      if rule == "epochs" and obj > 1000000000 and obj < 9999999999999 then
        return "<EPOCH>"
      end
    end
    return obj
  elseif t == "table" then
    if seen[obj] then return obj end
    seen[obj] = true
    if is_array_table(obj) then
      local n = 0
      for _ in pairs(obj) do n = n + 1 end
      local out = {}
      for i = 1, n do
        out[i] = normalize(obj[i], rules, seen)
      end
      seen[obj] = nil
      return out
    else
      local out = {}
      for k, v in pairs(obj) do
        out[k] = normalize(v, rules, seen)
      end
      seen[obj] = nil
      return out
    end
  end
  return obj
end
M.normalize = normalize

-- ─── stripFields ──────────────────────────────────────────────────────────────
--
-- Mirror of JS stripFields(obj, ignoreFields, ignorePaths): drop object keys
-- listed in ignoreFields (top-level + nested). ignorePaths (JSON-pointer style)
-- is not yet ported — Lua clusters should use ignoreFields for now.

local function strip_fields(obj, ignoreFields, ignorePaths, seen)
  ignoreFields = ignoreFields or {}
  ignorePaths = ignorePaths or {}
  seen = seen or {}
  if type(obj) ~= "table" or seen[obj] then return obj end
  -- Fast path: nothing to strip.
  if #ignoreFields == 0 and #ignorePaths == 0 then return obj end
  seen[obj] = true
  if is_array_table(obj) then
    local n = 0
    for _ in pairs(obj) do n = n + 1 end
    local out = {}
    for i = 1, n do
      out[i] = strip_fields(obj[i], ignoreFields, ignorePaths, seen)
    end
    seen[obj] = nil
    return out
  else
    local out = {}
    for k, v in pairs(obj) do
      local skip = false
      for _, f in ipairs(ignoreFields) do
        if tostring(k) == f then skip = true; break end
      end
      if not skip then
        out[k] = strip_fields(v, ignoreFields, ignorePaths, seen)
      end
    end
    seen[obj] = nil
    return out
  end
end
M.strip_fields = strip_fields

-- ─── fingerprint ──────────────────────────────────────────────────────────────
--
-- Core fingerprint function. Produces a 7-char base36 hash from input + output.
-- Algorithm (identical to JS):
--   cleanInput  = stripFields(normalize(input,  rules), ignoreFields, ignorePaths)
--   cleanOutput = stripFields(normalize(output, rules), ignoreFields, ignorePaths)
--   combined = stableStringify(cleanInput) .. "|" .. stableStringify(cleanOutput)
--   hash = sha256_hex(combined)
--   return to_base36(hash):sub(1, 7)

function M.fingerprint(input, output, clusterConfig)
  clusterConfig = clusterConfig or {}
  local normalizeRules = clusterConfig.normalize or {}
  local ignoreFields = clusterConfig.ignoreFields or {}
  local ignorePaths = clusterConfig.ignorePaths or {}

  local cleanInput = strip_fields(normalize(input, normalizeRules), ignoreFields, ignorePaths)
  local cleanOutput = strip_fields(normalize(output, normalizeRules), ignoreFields, ignorePaths)

  local combined = stable_stringify(cleanInput) .. "|" .. stable_stringify(cleanOutput)
  local hash = M.sha256_hex(combined)
  return M.to_base36(hash):sub(1, 7)
end

-- ─── JSON decoder ─────────────────────────────────────────────────────────────
--
-- Minimal but correct recursive-descent JSON parser used by capture_lua.lua
-- (to read regrets/manifest.json) and validate_lua.lua (to read INPUT/OUTPUT/
-- INPUTS lines from .regret files). Returns nil for JSON null.
-- Supports: objects, arrays, strings (with escapes incl. \u), numbers, true,
-- false, null. UTF-8 \uXXXX via the built-in utf8 library (BMP only).

local utf8_char = utf8 and utf8.char or function(c) return string.char(c) end

local function json_decode(str)
  local pos = 1
  local len = #str

  local function skip_ws()
    while pos <= len do
      local c = string.byte(str, pos)
      if c == 32 or c == 9 or c == 10 or c == 13 then
        pos = pos + 1
      else
        break
      end
    end
  end

  local parse_value

  local function parse_string()
    pos = pos + 1  -- skip opening quote
    local parts = {}
    while pos <= len do
      local c = string.byte(str, pos)
      if c == 0x22 then  -- "
        pos = pos + 1
        return table.concat(parts)
      elseif c == 0x5C then  -- backslash
        pos = pos + 1
        local e = string.byte(str, pos)
        if e == 0x22 then parts[#parts + 1] = '"'
        elseif e == 0x5C then parts[#parts + 1] = "\\"
        elseif e == 0x2F then parts[#parts + 1] = "/"
        elseif e == 0x62 then parts[#parts + 1] = "\b"
        elseif e == 0x66 then parts[#parts + 1] = "\f"
        elseif e == 0x6E then parts[#parts + 1] = "\n"
        elseif e == 0x72 then parts[#parts + 1] = "\r"
        elseif e == 0x74 then parts[#parts + 1] = "\t"
        elseif e == 0x75 then  -- \uXXXX
          local hex = string.sub(str, pos + 1, pos + 4)
          local code = tonumber(hex, 16)
          pos = pos + 4
          if code >= 0xD800 and code <= 0xDBFF and string.byte(str, pos + 1) == 0x5C and string.byte(str, pos + 2) == 0x75 then
            -- High surrogate; try to read low surrogate
            local lo = tonumber(string.sub(str, pos + 3, pos + 6), 16)
            if lo and lo >= 0xDC00 and lo <= 0xDFFF then
              local cp = 0x10000 + ((code - 0xD800) * 0x400) + (lo - 0xDC00)
              pos = pos + 6
              parts[#parts + 1] = utf8_char(cp)
            else
              parts[#parts + 1] = utf8_char(code)
            end
          else
            parts[#parts + 1] = utf8_char(code)
          end
        else
          error("json_decode: bad escape \\" .. string.char(e) .. " at pos " .. pos, 2)
        end
        pos = pos + 1
      else
        parts[#parts + 1] = string.char(c)
        pos = pos + 1
      end
    end
    error("json_decode: unterminated string", 2)
  end

  local function parse_number()
    local start = pos
    if string.byte(str, pos) == 0x2D then pos = pos + 1 end  -- -
    while pos <= len do
      local c = string.byte(str, pos)
      if (c >= 0x30 and c <= 0x39) or c == 0x2E or c == 0x65 or c == 0x45 or c == 0x2B or c == 0x2D then
        pos = pos + 1
      else
        break
      end
    end
    local text = string.sub(str, start, pos - 1)
    return tonumber(text)
  end

  local function parse_array()
    pos = pos + 1  -- skip [
    local arr = {}
    skip_ws()
    if string.byte(str, pos) == 0x5D then  -- ]
      pos = pos + 1
      return arr
    end
    while true do
      arr[#arr + 1] = parse_value()
      skip_ws()
      local c = string.byte(str, pos)
      if c == 0x2C then  -- ,
        pos = pos + 1
        skip_ws()
      elseif c == 0x5D then  -- ]
        pos = pos + 1
        return arr
      else
        error("json_decode: expected ',' or ']' at pos " .. pos, 2)
      end
    end
  end

  local function parse_object()
    pos = pos + 1  -- skip {
    local obj = {}
    skip_ws()
    if string.byte(str, pos) == 0x7D then  -- }
      pos = pos + 1
      return obj
    end
    while true do
      skip_ws()
      if string.byte(str, pos) ~= 0x22 then
        error("json_decode: expected string key at pos " .. pos, 2)
      end
      local key = parse_string()
      skip_ws()
      if string.byte(str, pos) ~= 0x3A then  -- :
        error("json_decode: expected ':' at pos " .. pos, 2)
      end
      pos = pos + 1
      obj[key] = parse_value()
      skip_ws()
      local c = string.byte(str, pos)
      if c == 0x2C then  -- ,
        pos = pos + 1
      elseif c == 0x7D then  -- }
        pos = pos + 1
        return obj
      else
        error("json_decode: expected ',' or '}' at pos " .. pos, 2)
      end
    end
  end

  parse_value = function()
    skip_ws()
    if pos > len then error("json_decode: unexpected end of input", 2) end
    local c = string.byte(str, pos)
    if c == 0x7B then return parse_object()       -- {
    elseif c == 0x5B then return parse_array()    -- [
    elseif c == 0x22 then return parse_string()   -- "
    elseif c == 0x74 then  -- true
      pos = pos + 4
      return true
    elseif c == 0x66 then  -- false
      pos = pos + 5
      return false
    elseif c == 0x6E then  -- null
      pos = pos + 4
      return nil
    elseif c == 0x2D or (c >= 0x30 and c <= 0x39) then
      return parse_number()
    else
      error("json_decode: unexpected char '" .. string.char(c) .. "' at pos " .. pos, 2)
    end
  end

  local value = parse_value()
  return value
end
M.json_decode = json_decode

-- ─── JSON encoder (canonical, via stable_stringify) ───────────────────────────

function M.json_encode(value)
  return stable_stringify(value)
end

return M

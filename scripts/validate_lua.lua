#!/usr/bin/env lua
-- scripts/validate_lua.lua — regression validator for Lua clusters
--
-- Reads .regret files from regrets/, re-invokes the entry function with the
-- stored input(s), recomputes the fingerprint, and compares to the stored HASH.
-- Prints PASS/FAIL per cluster. Exit non-zero if any cluster FAILs.
--
-- Multi-input .regret files (with an INPUTS line) validate EVERY input — the
-- golden INPUT/OUTPUT/HASH for input[0], plus each entry in INPUTS for inputs 1+.
-- A mismatch on ANY input fails the cluster (mirrors JS validate.js / issue #315).
--
-- Usage:
--   lua scripts/validate_lua.lua
--   lua scripts/validate_lua.lua --cluster reverse
--   lua scripts/validate_lua.lua --fail-fast
--   lua scripts/validate_lua.lua --manifest ./regrets/manifest.json

-- ─── Resolve scripts/ directory so requires work from any CWD ─────────────────
local scriptDir = string.match(arg[0], "^(.*)/[^/]*$")
if scriptDir and #scriptDir > 0 then
  package.path = scriptDir .. "/?.lua;" .. scriptDir .. "/?/?.lua;" .. package.path
else
  package.path = "./?.lua;" .. package.path
end

local fp = require("fingerprint_lua")

-- ─── CLI args ─────────────────────────────────────────────────────────────────

local function get_arg(args, flag)
  for i = 1, #args do
    if args[i] == flag and args[i + 1] then
      return args[i + 1]
    end
  end
  return nil
end

local passArgs = {}
for i = 1, #arg do passArgs[i] = arg[i] end

local clusterFilter = get_arg(passArgs, "--cluster")
local manifestPath = get_arg(passArgs, "--manifest") or "regrets/manifest.json"
local failFast = false
for _, a in ipairs(passArgs) do
  if a == "--fail-fast" then failFast = true end
end

-- ─── Helpers ──────────────────────────────────────────────────────────────────

local function read_file(path)
  local f, err = io.open(path, "r")
  if not f then return nil, err end
  local content = f:read("*a")
  f:close()
  return content
end

local function deep_clone(value, seen)
  seen = seen or {}
  if type(value) ~= "table" or seen[value] then return value end
  seen[value] = true
  local n = 0
  for _ in pairs(value) do n = n + 1 end
  local isArr = true
  if n == 0 then isArr = false
  else
    for i = 1, n do
      if value[i] == nil then isArr = false; break end
    end
    if isArr then
      local count = 0
      for _ in pairs(value) do count = count + 1 end
      if count ~= n then isArr = false end
    end
  end
  local copy = {}
  if isArr then
    for i = 1, n do copy[i] = deep_clone(value[i], seen) end
  else
    for k, v in pairs(value) do copy[k] = deep_clone(v, seen) end
  end
  seen[value] = nil
  return copy
end

-- ─── Parse a .regret file ─────────────────────────────────────────────────────

local function parse_regret(content)
  -- Split into header + data on the first line that is exactly "---".
  local headerLines = {}
  local dataLines = {}
  local seenSep = false
  for line in string.gmatch(content, "([^\n]*)\n?") do
    if line == "" and not seenSep then
      -- ignore leading blank lines
    elseif line == "---" and not seenSep then
      seenSep = true
    elseif not seenSep then
      headerLines[#headerLines + 1] = line
    else
      dataLines[#dataLines + 1] = line
    end
  end

  local meta = {}
  for _, line in ipairs(headerLines) do
    local colon = string.find(line, ": ", 1, true)
    if colon then
      local key = string.sub(line, 1, colon - 1)
      local val = string.sub(line, colon + 2)
      if key == "version" then
        meta.version = tonumber(val)
      elseif key == "multiArgs" then
        meta.multiArgs = (val == "true")
      elseif key == "watches" or key == "normalize" or key == "ignoreFields"
          or key == "valuePaths" or key == "ignorePaths" then
        -- Parse [a, b, c] → array of strings
        local inner = string.match(val, "^%[(.*)%]$")
        if inner and #inner > 0 then
          local arr = {}
          for item in string.gmatch(inner, "([^,]+)") do
            item = item:match("^%s*(.-)%s*$")
            -- strip surrounding quotes if present
            item = item:match('^"(.*)"$') or item
            arr[#arr + 1] = item
          end
          meta[key] = arr
        else
          meta[key] = {}
        end
      else
        meta[key] = val
      end
    end
  end

  -- Extract INPUT / OUTPUT / HASH / INPUTS from dataLines.
  -- INPUT and OUTPUT are single-line JSON (our capture writes compact JSON).
  -- Prefixes use variable spacing (e.g. "HASH   <hash>" uses 3 spaces) — strip
  -- the keyword + leading whitespace so values parse cleanly.
  local function strip_prefix(line, keyword)
    -- Match `KEYWORD` followed by 1+ spaces, return the rest (trimmed).
    local rest = string.match(line, "^" .. keyword .. "%s+(.*)$")
    return rest
  end
  local inputLine, outputLine, hashLine, inputsLine
  for _, line in ipairs(dataLines) do
    if string.sub(line, 1, 6) == "INPUT " and not inputLine then
      inputLine = strip_prefix(line, "INPUT")
    elseif string.sub(line, 1, 7) == "OUTPUT " and not outputLine then
      outputLine = strip_prefix(line, "OUTPUT")
    elseif string.sub(line, 1, 5) == "HASH " and not hashLine then
      hashLine = strip_prefix(line, "HASH")
    elseif string.sub(line, 1, 7) == "INPUTS " and not inputsLine then
      inputsLine = strip_prefix(line, "INPUTS")
    end
  end

  local parsedInput = nil
  if inputLine and inputLine ~= "undefined" then
    parsedInput = fp.json_decode(inputLine)
  end
  local parsedOutput = nil
  if outputLine and outputLine ~= "undefined" then
    parsedOutput = fp.json_decode(outputLine)
  end

  local extraInputs = {}
  if inputsLine then
    local arr = fp.json_decode(inputsLine)
    if type(arr) == "table" then
      for _, e in ipairs(arr) do
        extraInputs[#extraInputs + 1] = { input = e.input, output = e.output, hash = e.hash }
      end
    end
  end

  return {
    meta = meta,
    input = parsedInput,
    output = parsedOutput,
    goldenHash = hashLine,
    extraInputs = extraInputs,
    raw = content,
  }
end

-- ─── Load manifest (for cluster config: file, entry, multiArgs, normalize) ────

local manifest = nil
local manifestContent = read_file(manifestPath)
if manifestContent then
  local ok, m = pcall(fp.json_decode, manifestContent)
  if ok and type(m) == "table" and m.clusters then
    manifest = m
  end
end

local function find_cluster_config(id)
  if not manifest then return nil end
  for _, c in ipairs(manifest.clusters) do
    if c.id == id and c.stack == "lua" then return c end
  end
  return nil
end

-- ─── Invoke entry function on an input ────────────────────────────────────────

local function invoke_entry(file, entry, multiArgs, input)
  -- Fresh load each time — dofile avoids require-cache staleness across runs.
  local mod = dofile(file)
  local entryFn
  if type(mod) == "table" then
    entryFn = mod[entry]
  elseif type(mod) == "function" then
    entryFn = mod
  end
  if type(entryFn) ~= "function" then
    return nil, 'entry "' .. tostring(entry) .. '" not found in ' .. file
  end
  local argsInput = deep_clone(input)
  if multiArgs and type(argsInput) == "table" then
    return entryFn(table.unpack(argsInput))
  else
    return entryFn(argsInput)
  end
end

-- ─── Validate a single .regret file ───────────────────────────────────────────

local function validate_regret(regretPath)
  local id = string.match(regretPath, "([^/]+)%.regret$")
  local content = read_file(regretPath)
  if not content then
    print('FAIL ' .. id .. ': could not read ' .. regretPath)
    return false
  end

  local regret = parse_regret(content)
  local cfg = find_cluster_config(id) or {}
  local file = regret.meta.file or cfg.file
  local entry = regret.meta.entry or cfg.entry
  local multiArgs = regret.meta.multiArgs or cfg.multiArgs or false
  local clusterConfig = {
    normalize = regret.meta.normalize or cfg.normalize or {},
    ignoreFields = regret.meta.ignoreFields or cfg.ignoreFields or {},
    ignorePaths = regret.meta.ignorePaths or cfg.ignorePaths or {},
  }

  if not file or not entry then
    print('FAIL ' .. id .. ': missing file/entry in .regret and manifest')
    return false
  end

  -- Build the list of (input, expectedHash) pairs to validate.
  -- input[0] from INPUT/HASH lines; inputs[1+] from INPUTS line.
  local checks = {}
  if regret.goldenHash then
    checks[#checks + 1] = { input = regret.input, expected = regret.goldenHash }
  end
  for _, e in ipairs(regret.extraInputs) do
    checks[#checks + 1] = { input = e.input, expected = e.hash }
  end
  if #checks == 0 then
    print('FAIL ' .. id .. ': no HASH found in .regret')
    return false
  end

  local allPass = true
  for i, check in ipairs(checks) do
    local callOk, output = pcall(invoke_entry, file, entry, multiArgs, check.input)
    if not callOk then
      print('FAIL ' .. id .. ' (input #' .. i .. '): invocation error: ' .. tostring(output))
      allPass = false
    else
      local liveHash = fp.fingerprint(check.input, output, clusterConfig)
      if liveHash == check.expected then
        -- per-input pass (only print aggregate below to keep output clean)
      else
        print('FAIL ' .. id .. ' (input #' .. i .. '): expected ' .. check.expected .. ' got ' .. liveHash)
        allPass = false
      end
    end
  end

  if allPass then
    print('PASS ' .. id .. ' (' .. #checks .. ' input' .. (#checks > 1 and 's' or '') .. ')')
    return true
  else
    return false
  end
end

-- ─── Find .regret files ───────────────────────────────────────────────────────

local regretDir = "regrets"
local regretFiles = {}
local pipe = io.popen('ls ' .. regretDir .. '/*.regret 2>/dev/null')
if pipe then
  for line in pipe:lines() do
    local fname = string.match(line, "([^/]+)$")
    local id = fname and string.match(fname, "^(.*)%.regret$")
    if id and (not clusterFilter or id == clusterFilter) then
      regretFiles[#regretFiles + 1] = line
    end
  end
  pipe:close()
end

if #regretFiles == 0 then
  print('No .regret files found' .. (clusterFilter and (' for "' .. clusterFilter .. '"') or '') .. '.')
  os.exit(1)
end

-- ─── Main ─────────────────────────────────────────────────────────────────────

local anyFailed = false
for _, path in ipairs(regretFiles) do
  local ok = validate_regret(path)
  if not ok then
    anyFailed = true
    if failFast then break end
  end
end

if anyFailed then
  os.exit(1)
end
os.exit(0)

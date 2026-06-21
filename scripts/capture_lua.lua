#!/usr/bin/env lua
-- scripts/capture_lua.lua — capture runner for Lua clusters
--
-- Reads regrets/manifest.json, filters stack: "lua" clusters, loads each
-- cluster's Lua module via dofile(), invokes the entry function on each input,
-- computes a 7-char fingerprint (identical algorithm to JS/Python/PHP/Go), and
-- writes a standard .regret file per cluster.
--
-- Usage:
--   lua scripts/capture_lua.lua
--   lua scripts/capture_lua.lua --cluster reverse
--   lua scripts/capture_lua.lua --manifest ./regrets/manifest.json
--
-- Exit code: 0 if all clusters captured, 1 if any failed.

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

local cliArgs = { table.unpack(arg, 1) }
-- Drop the script name (arg[0]) — already consumed via arg[0] above for scriptDir.
-- `arg` in Lua: arg[0] is script name, arg[1..n] are CLI args. We want [1..n].
local passArgs = {}
for i = 1, #arg do passArgs[i] = arg[i] end

local clusterFilter = get_arg(passArgs, "--cluster")
-- Default manifest: <cwd>/regrets/manifest.json (user runs from project root).
local manifestPath = get_arg(passArgs, "--manifest") or "regrets/manifest.json"

-- ─── Helpers ──────────────────────────────────────────────────────────────────

local function read_file(path)
  local f, err = io.open(path, "r")
  if not f then return nil, err end
  local content = f:read("*a")
  f:close()
  return content
end

local function iso_timestamp()
  -- ISO 8601 UTC, e.g. 2026-06-20T12:34:56Z (mirrors JS new Date().toISOString()).
  return os.date("!%Y-%m-%dT%H:%M:%SZ")
end

local function deep_clone(value, seen)
  seen = seen or {}
  if type(value) ~= "table" or seen[value] then return value end
  seen[value] = true
  -- Detect array vs object by checking 1..n contiguity.
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

-- ─── Load manifest ────────────────────────────────────────────────────────────

local manifestContent = read_file(manifestPath)
if not manifestContent then
  io.stderr:write('Could not read manifest: ' .. manifestPath .. '\n')
  io.stderr:write('   Create regrets/manifest.json first. See SKILL.md for format.\n')
  os.exit(1)
end

local ok, manifest = pcall(fp.json_decode, manifestContent)
if not ok or type(manifest) ~= "table" or not manifest.clusters then
  io.stderr:write('Invalid JSON in manifest: ' .. manifestPath .. '\n')
  os.exit(1)
end

-- ─── Capture each Lua cluster ─────────────────────────────────────────────────

local function capture_cluster(cluster)
  local id = cluster.id
  local entry = cluster.entry
  local watches = cluster.watches or {}
  local file = cluster.file
  local fingerprintLevel = cluster.fingerprintLevel or "entry"
  local normalizeRules = cluster.normalize or {}
  local ignoreFields = cluster.ignoreFields or {}
  local ignorePaths = cluster.ignorePaths or {}
  local multiArgs = cluster.multiArgs or false
  local luaModule = cluster.luaModule
  local luaPath = cluster.luaPath
  local inputs = cluster.inputs or {}
  local clusterConfig = {
    normalize = normalizeRules,
    ignoreFields = ignoreFields,
    ignorePaths = ignorePaths,
  }

  print('')
  print('Capturing: ' .. id)
  print('   File:    ' .. tostring(file))
  print('   Entry:   ' .. tostring(entry))
  print('   Watches: ' .. table.concat(watches, ', '))

  if not file then
    print('   Capture failed: cluster missing required "file" field')
    return false
  end

  -- Load the Lua module. Prefer dofile (fresh load each run — no require cache).
  -- If file is relative, resolve from CWD.
  local absFile = file
  local loadOk, moduleOrErr = pcall(dofile, absFile)
  if not loadOk then
    print('   Capture failed: could not load ' .. file .. ': ' .. tostring(moduleOrErr))
    return false
  end
  -- The module may be a table (module pattern: `local M = {}; return M`)
  -- or a bare function (top-level `return function(s) ... end`).
  local entryFn
  if type(moduleOrErr) == "table" then
    entryFn = moduleOrErr[entry]
  elseif type(moduleOrErr) == "function" and (entry == nil or entry == id) then
    entryFn = moduleOrErr
  end
  if type(entryFn) ~= "function" then
    print('   Capture failed: entry "' .. tostring(entry) .. '" not found in ' .. file)
    return false
  end

  local results = {}
  local captureOk = true
  local captureErr = nil
  for i, input in ipairs(inputs) do
    local inputForRecord = deep_clone(input)
    local inputForArgs = deep_clone(input)
    local output
    local callOk, callErr
    if multiArgs and type(inputForArgs) == "table" then
      callOk, callErr = pcall(entryFn, table.unpack(inputForArgs))
      output = callErr
    else
      callOk, callErr = pcall(entryFn, inputForArgs)
      output = callErr
    end
    if not callOk then
      print('   Capture failed on input #' .. i .. ': ' .. tostring(callErr))
      captureOk = false
      captureErr = callErr
      break
    end
    local hash = fp.fingerprint(inputForRecord, output, clusterConfig)
    results[#results + 1] = { input = inputForRecord, output = output, fp = hash }
  end

  if not captureOk or #results == 0 then
    print('   Capture failed: no inputs captured')
    return false
  end

  -- Golden = first result.
  local golden = results[1]
  local regretHash = golden.fp
  local regretPath = 'regrets/' .. id .. '.regret'
  local timestamp = iso_timestamp()

  -- Build .regret file content (header + --- + INPUT/OUTPUT/HASH [+ INPUTS]).
  local lines = {
    'cluster: ' .. id,
    'version: 1',
    'fingerprint: ' .. regretHash,
    'captured: ' .. timestamp,
    'watches: [' .. table.concat(watches, ', ') .. ']',
    'entry: ' .. entry,
    'stack: lua',
    'fingerprintLevel: ' .. fingerprintLevel,
  }
  if file then
    lines[#lines + 1] = 'file: ' .. file
  end
  if luaModule then
    lines[#lines + 1] = 'luaModule: ' .. luaModule
  end
  if luaPath then
    lines[#lines + 1] = 'luaPath: ' .. luaPath
  end
  if multiArgs then
    lines[#lines + 1] = 'multiArgs: true'
  end
  if #normalizeRules > 0 then
    lines[#lines + 1] = 'normalize: [' .. table.concat(normalizeRules, ', ') .. ']'
  end
  if #ignoreFields > 0 then
    lines[#lines + 1] = 'ignoreFields: [' .. table.concat(ignoreFields, ', ') .. ']'
  end

  lines[#lines + 1] = '---'
  lines[#lines + 1] = 'INPUT  ' .. fp.json_encode(golden.input)
  lines[#lines + 1] = 'OUTPUT ' .. fp.json_encode(golden.output)
  lines[#lines + 1] = 'HASH   ' .. golden.fp

  -- Multi-input: INPUTS line carries results[2..n] (mirrors JS capture.js).
  if #results > 1 then
    local payload = {}
    for i = 2, #results do
      local r = results[i]
      payload[#payload + 1] = { input = r.input, output = r.output, hash = r.fp }
    end
    lines[#lines + 1] = 'INPUTS ' .. fp.json_encode(payload)
  end

  -- Ensure regrets/ directory exists.
  os.execute('mkdir -p regrets')
  local f, err = io.open(regretPath, 'w')
  if not f then
    print('   Capture failed: could not write ' .. regretPath .. ': ' .. tostring(err))
    return false
  end
  f:write(table.concat(lines, '\n') .. '\n')
  f:close()

  print('   Fingerprint: ' .. regretHash)
  print('   Saved: ' .. regretPath)
  return true
end

-- ─── Main ─────────────────────────────────────────────────────────────────────

local anyFailed = false
local luaCount = 0
for _, cluster in ipairs(manifest.clusters) do
  if cluster.stack == "lua" then
    luaCount = luaCount + 1
    if clusterFilter and cluster.id ~= clusterFilter then
      -- skip
    else
      local ok = capture_cluster(cluster)
      if not ok then anyFailed = true end
    end
  end
end

if luaCount == 0 then
  print('No Lua clusters found in manifest (stack: "lua").')
end

if anyFailed then
  os.exit(1)
end
os.exit(0)

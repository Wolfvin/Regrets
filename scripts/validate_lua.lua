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
-- Update mode (--update <id> --reason "..."): re-captures the cluster's inputs,
-- rewrites INPUT/OUTPUT/HASH/INPUTS lines + captured timestamp, appends an entry
-- to regrets/audit.log with old/new hash, reason, and a chain hash linking to
-- the previous entry (mirrors JS validate.js --update flow).
--
-- Usage:
--   lua scripts/validate_lua.lua
--   lua scripts/validate_lua.lua --cluster reverse
--   lua scripts/validate_lua.lua --fail-fast
--   lua scripts/validate_lua.lua --manifest ./regrets/manifest.json
--   lua scripts/validate_lua.lua --update reverse --reason "reverse now uses utf8 reverse"

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
local updateTarget = get_arg(passArgs, "--update")
local updateReason = get_arg(passArgs, "--reason")
local failFast = false
for _, a in ipairs(passArgs) do
  if a == "--fail-fast" then failFast = true end
end

-- ─── Update-mode arg validation (mirrors JS validate.js) ─────────────────────
if updateTarget and not updateReason then
  print('ERROR: --update requires --reason')
  print('   Example: --update reverse --reason "reverse now uses utf8 reverse"')
  os.exit(2)
end
if updateReason and updateTarget then
  -- JS requires >= 4 words; mirror that to keep UX consistent.
  local _, wordCount = string.gsub(updateReason, "%S+", "")
  if wordCount < 4 then
    print('ERROR: --reason is too vague: "' .. updateReason .. '"')
    print('   Be specific. e.g. "reverse now handles utf8 multi-byte sequences"')
    os.exit(2)
  end
end
local updateMode = updateTarget ~= nil

-- regretDir is used by update_regret() and by the .regret file scanner below.
-- Declared here as a top-level local so all functions can see it.
local regretDir = "regrets"

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
  -- Normalize CRLF -> LF first. Git's core.autocrlf=true (the standard
  -- Windows git setting) rewrites .regret files to CRLF on checkout; the
  -- gmatch pattern below captures "[^\n]*" which includes a trailing '\r'
  -- on each line, so `line == "---"` never matches ("---\r" ~= "---"),
  -- breaking every cluster's separator detection on an unmodified
  -- checkout. Same root cause (and severity) as the confirmed-via-
  -- execution bug in RegretJava.java's parseRegret() (#522).
  content = content:gsub("\r\n", "\n")
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

-- ─── Update mode: re-capture one cluster and rewrite its .regret file ─────────
--
-- Mirrors JS validate.js --update flow:
--   1. Read the .regret file (parse header + INPUT/OUTPUT/HASH/INPUTS)
--   2. Re-invoke entry on every stored input (input[0] + each INPUTS entry)
--   3. Recompute fingerprints
--   4. Rewrite INPUT/OUTPUT/HASH/INPUTS lines + refresh `captured:` timestamp
--   5. Append entry to regrets/audit.log with old/new hash, reason, chain hash
--   6. Print summary
local function iso_timestamp()
  return os.date('!%Y-%m-%dT%H:%M:%SZ')
end

local function update_regret(regretPath, reason)
  local id = string.match(regretPath, "([^/]+)%.regret$")
  local content = read_file(regretPath)
  if not content then
    print('UPDATE FAIL ' .. id .. ': could not read ' .. regretPath)
    return false
  end
  -- Same CRLF normalization as parse_regret() -- this function re-parses
  -- the header lines independently below (its own gmatch loop), so the
  -- normalization there doesn't cover this one.
  content = content:gsub("\r\n", "\n")

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
    print('UPDATE FAIL ' .. id .. ': missing file/entry in .regret and manifest')
    return false
  end

  -- Build the list of all inputs (input[0] + extras from INPUTS line).
  local allInputs = {}
  if regret.input ~= nil then
    allInputs[#allInputs + 1] = regret.input
  end
  for _, e in ipairs(regret.extraInputs) do
    allInputs[#allInputs + 1] = e.input
  end
  if #allInputs == 0 then
    print('UPDATE FAIL ' .. id .. ': no inputs found in .regret')
    return false
  end

  -- Re-invoke + recompute hash for each input.
  local results = {}
  for i, input in ipairs(allInputs) do
    local callOk, output = pcall(invoke_entry, file, entry, multiArgs, input)
    if not callOk then
      print('UPDATE FAIL ' .. id .. ' (input #' .. i .. '): invocation error: ' .. tostring(output))
      return false
    end
    local inputForRecord = deep_clone(input)
    local h = fp.fingerprint(inputForRecord, output, clusterConfig)
    results[#results + 1] = { input = inputForRecord, output = output, fp = h }
  end

  local golden = results[1]
  local oldHash = regret.goldenHash or '?'
  local newHash = golden.fp

  -- Reconstruct the .regret file.
  -- Header: keep all original lines, but replace `captured:` and `fingerprint:`.
  -- Body: rewrite INPUT/OUTPUT/HASH, and INPUTS (if multi-input).
  local headerLines = {}
  local seenSep = false
  for line in string.gmatch(content, "([^\n]*)\n?") do
    if line == "---" and not seenSep then
      seenSep = true
      break
    elseif line ~= "" then
      headerLines[#headerLines + 1] = line
    end
  end

  -- Replace captured: and fingerprint: in header.
  local newTimestamp = iso_timestamp()
  for i, line in ipairs(headerLines) do
    if string.sub(line, 1, 9) == "captured:" then
      headerLines[i] = 'captured: ' .. newTimestamp
    elseif string.sub(line, 1, 12) == "fingerprint:" then
      headerLines[i] = 'fingerprint: ' .. newHash
    end
  end

  -- Build new body.
  local bodyLines = {
    '---',
    'INPUT  ' .. fp.json_encode(golden.input),
    'OUTPUT ' .. fp.json_encode(golden.output),
    'HASH   ' .. golden.fp,
  }
  if #results > 1 then
    local payload = {}
    for i = 2, #results do
      local r = results[i]
      payload[#payload + 1] = { input = r.input, output = r.output, hash = r.fp }
    end
    bodyLines[#bodyLines + 1] = 'INPUTS ' .. fp.json_encode(payload)
  end

  local newContent = table.concat(headerLines, '\n') .. '\n' .. table.concat(bodyLines, '\n') .. '\n'

  -- Write back.
  local f, err = io.open(regretPath, 'w')
  if not f then
    print('UPDATE FAIL ' .. id .. ': could not write ' .. regretPath .. ': ' .. tostring(err))
    return false
  end
  f:write(newContent)
  f:close()

  -- Append to audit.log with chain hash.
  local auditLog = regretDir .. '/audit.log'
  local prevChain = '0000000'  -- genesis
  local auditContent = read_file(auditLog)
  if auditContent and #auditContent > 0 then
    -- Walk backwards for the last "chain:" line.
    local lastChain = nil
    for line in string.gmatch(auditContent, "([^\n]*)\n?") do
      local m = string.match(line, "^%s*chain:%s*(%S+)")
      if m then lastChain = m end
    end
    if lastChain then prevChain = lastChain end
  end

  -- Sanitize reason: replace newlines to prevent audit.log corruption.
  local safeReason = string.gsub(reason, "[\r\n]", " ")

  -- Best-effort git provenance (mirror JS — failures leave fields absent).
  local gitAuthor = nil
  local gitSha = nil
  local p = io.popen('git config user.name 2>/dev/null', 'r')
  if p then
    local name = p:read('*l')
    p:close()
    if name and #name > 0 then
      local p2 = io.popen('git config user.email 2>/dev/null', 'r')
      if p2 then
        local email = p2:read('*l')
        p2:close()
        gitAuthor = email and #email > 0 and (name .. ' <' .. email .. '>') or name
      else
        gitAuthor = name
      end
    end
  end
  p = io.popen('git rev-parse --short HEAD 2>/dev/null', 'r')
  if p then
    local sha = p:read('*l')
    p:close()
    if sha and #sha > 0 then gitSha = sha end
  end
  local ciRunId = os.getenv('GITHUB_RUN_ID') or os.getenv('CI_RUN_ID')

  local entryLines = {
    newTimestamp .. '  UPDATE  ' .. id,
    '  old: ' .. oldHash,
    '  new: ' .. newHash,
    '  reason: ' .. safeReason,
    '  by: AI refactor session',
  }
  if gitAuthor then entryLines[#entryLines + 1] = '  gitAuthor: ' .. gitAuthor end
  if gitSha    then entryLines[#entryLines + 1] = '  gitSha: ' .. gitSha end
  if ciRunId   then entryLines[#entryLines + 1] = '  ciRunId: ' .. ciRunId end

  local entryContent = table.concat(entryLines, '\n')
  -- Chain hash = first 7 chars of sha256(prevChain + entryContent).
  -- We have access to fp.sha256_hex via the fingerprint module.
  local chainHash = fp.sha256_hex(prevChain .. entryContent):sub(1, 7)
  local entry = '\n' .. entryContent .. '\n  chain: ' .. chainHash

  local af, aerr = io.open(auditLog, 'a')
  if not af then
    print('UPDATE WARN ' .. id .. ': could not append to ' .. auditLog .. ': ' .. tostring(aerr))
    -- Still count as success — .regret was updated, audit log is secondary.
  else
    af:write(entry)
    af:close()
  end

  print('UPDATE ' .. id .. ': ' .. oldHash .. ' → ' .. newHash)
  print('   reason: ' .. safeReason)
  print('   chain:  ' .. chainHash)
  print('   audit:  ' .. auditLog)
  return true
end

-- ─── Find .regret files ───────────────────────────────────────────────────────

-- regretDir is declared at the top of the file (shared with update_regret).
-- In update mode, only consider the updateTarget cluster; otherwise respect --cluster filter.
local filterId = updateTarget or clusterFilter or nil
local regretFiles = {}
local pipe = io.popen('ls ' .. regretDir .. '/*.regret 2>/dev/null')
if pipe then
  for line in pipe:lines() do
    local fname = string.match(line, "([^/]+)$")
    local id = fname and string.match(fname, "^(.*)%.regret$")
    if id and (not filterId or id == filterId) then
      regretFiles[#regretFiles + 1] = line
    end
  end
  pipe:close()
end

if #regretFiles == 0 then
  print('No .regret files found' .. (filterId and (' for "' .. filterId .. '"') or '') .. '.')
  os.exit(1)
end

-- ─── Main ─────────────────────────────────────────────────────────────────────

if updateMode then
  -- Update mode: re-capture the targeted cluster's inputs and rewrite the .regret file.
  -- Only one cluster is updated per invocation (mirrors JS validate.js --update).
  if #regretFiles > 1 then
    print('ERROR: --update expects exactly one matching .regret file, found ' .. #regretFiles)
    os.exit(2)
  end
  print('')
  print('🔄 Update mode — cluster: ' .. updateTarget)
  print('   Reason: ' .. updateReason)
  print('')
  local ok = update_regret(regretFiles[1], updateReason)
  if not ok then os.exit(1) end
  os.exit(0)
end

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

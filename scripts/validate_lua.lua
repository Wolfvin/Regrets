#!/usr/bin/env lua
-- validate_lua.lua — regression validator for Lua clusters
--
-- Reads .regret files and re-invokes the entry function with the same input,
-- compares the resulting fingerprint to the golden hash, and reports PASS/FAIL.
--
-- Usage:
--   lua scripts/validate_lua.lua
--   lua scripts/validate_lua.lua --cluster luhn-valid
--   lua scripts/validate_lua.lua --fail-fast
--   lua scripts/validate_lua.lua --runs 5            # drift detection
--   lua scripts/validate_lua.lua --update luhn-valid --reason "explain why"

local fp = dofile((arg[0]:gsub('[^/]+$', '')) .. 'fingerprint_lua.lua')

-- ─── CLI args ─────────────────────────────────────────────────────────────────
local function get_arg(args, flag)
  for i = 1, #args - 1 do
    if args[i] == flag then return args[i + 1] end
  end
  return nil
end

local function has_flag(args, flag)
  for i = 1, #args do
    if args[i] == flag then return true end
  end
  return false
end

local args = arg
local cluster_filter = get_arg(args, '--cluster')
local fail_fast = has_flag(args, '--fail-fast')
local runs = tonumber(get_arg(args, '--runs') or '1') or 1
local update_target = get_arg(args, '--update')
local update_reason = get_arg(args, '--reason')
local manifest_path = get_arg(args, '--manifest') or './regrets/manifest.json'

if update_target and not update_reason then
  io.stderr:write('❌ --update requires --reason\n')
  io.stderr:write('   Example: --update luhn-valid --reason "describe why behavior changed"\n')
  os.exit(1)
end

if update_reason then
  -- Count words
  local count = 0
  for _ in update_reason:gmatch('%S+') do count = count + 1 end
  if count < 4 then
    io.stderr:write('❌ --reason is too vague: "' .. update_reason .. '"\n')
    io.stderr:write('   Be specific. e.g. "tax rate updated from 11% to 12% per new regulation"\n')
    os.exit(1)
  end
end

-- ─── CWD ──────────────────────────────────────────────────────────────────────
local function cwd()
  local h = io.popen('pwd 2>/dev/null')
  local s = h:read('*l') or '.'
  h:close()
  return s
end
local CWD = cwd()
local regret_dir = CWD .. '/regrets'

-- ─── Parse .regret file ───────────────────────────────────────────────────────
local function parse_regret(content)
  local meta_part, data_part = content:match('^(.-)\n%-%-%-\n(.*)$')
  if not meta_part then
    -- Fallback: maybe no data section
    meta_part = content
    data_part = ''
  end
  local meta = {}
  for line in meta_part:gmatch('[^\n]+') do
    local k, v = line:match('^([%w_]+): (.+)$')
    if k then
      if k == 'watches' or k == 'normalize' or k == 'ignoreFields' or k == 'valuePaths' then
        local list = {}
        v = v:match('^%[(.*)%]$') or v
        for item in v:gmatch('[^,]+') do
          item = item:match('^%s*(.-)%s*$')
          if item ~= '' then list[#list + 1] = item end
        end
        meta[k] = list
      elseif k == 'version' then
        meta[k] = tonumber(v) or 1
      elseif k == 'multiArgs' then
        meta[k] = v == 'true'
      else
        meta[k] = v
      end
    end
  end

  local input_line, output_line, hash_line
  for line in data_part:gmatch('[^\n]+') do
    if line:sub(1, 6) == 'INPUT ' then input_line = line:sub(7) end
    if line:sub(1, 7) == 'OUTPUT ' then output_line = line:sub(8) end
    if line:sub(1, 5) == 'HASH ' then hash_line = line:sub(6) end
  end

  local parsed_input = input_line and fp.json_decode(input_line) or nil
  local parsed_output = output_line and fp.json_decode(output_line) or nil
  if input_line == 'undefined' then parsed_input = nil end
  if output_line == 'undefined' then parsed_output = nil end

  meta.input = parsed_input
  meta.output = parsed_output
  meta.golden_hash = hash_line and hash_line:match('^%s*(%S+)') or nil
  meta.raw = content
  return meta
end

-- ─── Load manifest ────────────────────────────────────────────────────────────
local manifest_file = io.open(manifest_path, 'r')
if not manifest_file then
  io.stderr:write('❌ Could not read manifest: ' .. manifest_path .. '\n')
  os.exit(1)
end
local manifest = fp.json_decode(manifest_file:read('*a'))
manifest_file:close()
if not manifest or not manifest.clusters then
  io.stderr:write('❌ Invalid manifest JSON\n')
  os.exit(1)
end

-- ─── Find Lua .regret files ──────────────────────────────────────────────────
local filter_id = cluster_filter or update_target
local regret_files = {}
local popen = io.popen
local ls = popen('ls ' .. regret_dir .. '/*.regret 2>/dev/null')
if ls then
  for line in ls:lines() do
    local name = line:match('([^/]+)%.regret$')
    if name and (not filter_id or name == filter_id) then
      regret_files[#regret_files + 1] = name
    end
  end
  ls:close()
end

if #regret_files == 0 then
  io.stderr:write('❌ No .regret files found' .. (filter_id and (' for "' .. filter_id .. '"') or '') .. '.\n')
  os.exit(1)
end

-- ─── Module loader (matches capture_lua.lua) ──────────────────────────────────
local function load_module(file_path)
  local abs = file_path:sub(1, 1) == '/' and file_path or (CWD .. '/' .. file_path)
  local chunk, err = loadfile(abs)
  if not chunk then
    return nil, 'Cannot load ' .. file_path .. ': ' .. (err or 'unknown error')
  end
  local ok, mod = pcall(chunk)
  if not ok then
    return nil, 'Error running ' .. file_path .. ': ' .. tostring(mod)
  end
  if type(mod) ~= 'table' then
    return nil, 'Module ' .. file_path .. ' did not return a table (got ' .. type(mod) .. ')'
  end
  return mod
end

local function resolve_entry(mod, entry)
  local dot = entry:find('%.')
  if dot then
    local outer = entry:sub(1, dot - 1)
    local inner = entry:sub(dot + 1)
    local t = mod[outer]
    if type(t) ~= 'table' then return nil, 'module.' .. outer .. ' is not a table' end
    local fn = t[inner]
    if type(fn) ~= 'function' then return nil, 'module.' .. outer .. '.' .. inner .. ' is not a function' end
    return fn
  end
  local fn = mod[entry]
  if type(fn) ~= 'function' then return nil, 'module.' .. entry .. ' is not a function' end
  return fn
end

-- ─── Run cluster N times ──────────────────────────────────────────────────────
local function run_cluster(cluster_def, regret, n_runs)
  local entry = cluster_def.entry
  local file = cluster_def.file or ''
  local multi_args = cluster_def.multiArgs == true
  local normalize_rules = cluster_def.normalize or {}
  local ignore_fields = cluster_def.ignoreFields or {}

  local mod, err = load_module(file)
  if not mod then return nil, err end
  local fn, ferr = resolve_entry(mod, entry)
  if not fn then return nil, ferr end

  local hashes = {}
  local hashes_per_input = {}
  local last_output = nil
  local first_output = nil  -- output for the golden input (matches INPUT line in .regret)

  -- Validate against the golden input first, then any other inputs from the manifest
  local inputs_to_validate = { regret.input }
  if cluster_def.inputs then
    for _, inp in ipairs(cluster_def.inputs) do
      local a = fp.stable_dumps(inp)
      local b = fp.stable_dumps(regret.input)
      if a ~= b then
        inputs_to_validate[#inputs_to_validate + 1] = inp
      end
    end
  end

  for _ = 1, n_runs do
    for idx, current_input in ipairs(inputs_to_validate) do
      local input_for_args = fp.deep_clone(current_input)
      local ok, output
      if multi_args and type(input_for_args) == 'table' and fp.is_array(input_for_args) then
        ok, output = pcall(fn, table.unpack(input_for_args))
      else
        ok, output = pcall(fn, input_for_args)
      end
      if not ok then
        return nil, 'Entry function threw: ' .. tostring(output)
      end
      last_output = output
      -- Capture the output for the golden (first) input on the first run only.
      -- This is what gets written to the OUTPUT line when --update is used,
      -- keeping INPUT/OUTPUT/HASH consistent in the .regret file.
      if idx == 1 and first_output == nil then
        first_output = output
      end
      local h = fp.fingerprint(current_input, output, normalize_rules, ignore_fields)
      hashes[#hashes + 1] = h
      local key = fp.stable_dumps(current_input)
      if not hashes_per_input[key] then hashes_per_input[key] = {} end
      hashes_per_input[key][#hashes_per_input[key] + 1] = h
    end
  end

  return { hashes = hashes, hashes_per_input = hashes_per_input, last_output = last_output, first_output = first_output }
end

-- ─── Update a .regret ─────────────────────────────────────────────────────────
local function update_regret(regret_path, regret, new_hash, live_output, reason)
  local old_hash = regret.golden_hash
  local now = os.date('!%Y-%m-%dT%H:%M:%S') .. string.format('.%06d+00:00', (os.clock() % 1) * 1000000)
  local safe_reason = reason:gsub('[\r\n]+', ' ')

  local new_content = regret.raw
  -- Lua's `^` anchors to start of subject string, not line. Use `\n` prefix
  -- to anchor to start of line; fingerprint/captured/OUTPUT/HASH all appear
  -- exactly once per .regret file so a plain (non-anchored) gsub is safe.
  new_content = new_content:gsub('fingerprint: [^\n]+', 'fingerprint: ' .. new_hash, 1)
  new_content = new_content:gsub('captured: [^\n]+', 'captured: ' .. now, 1)
  new_content = new_content:gsub('OUTPUT [^\n]+', 'OUTPUT ' .. fp.stable_dumps(live_output), 1)
  new_content = new_content:gsub('HASH[ \t]+[^\n]+', 'HASH   ' .. new_hash, 1)

  local f = io.open(regret_path, 'w')
  f:write(new_content)
  f:close()

  -- Hash chain (matches PHP behavior)
  local audit_log = regret_dir .. '/audit.log'
  local prev_chain = '0000000'
  local af = io.open(audit_log, 'r')
  if af then
    local content = af:read('*a')
    af:close()
    -- find last chain: line (e.g. "  chain: abc1234")
    local last_chain
    for line in content:gmatch('[^\n]+') do
      local m = line:match('chain:%s+(%S+)')
      if m then last_chain = m end
    end
    if last_chain then prev_chain = last_chain end
  end

  local cluster_id = regret_path:match('([^/]+)%.regret$')
  local new_entry = now .. '  UPDATE  ' .. cluster_id ..
                    '\n  old: ' .. old_hash ..
                    '\n  new: ' .. new_hash ..
                    '\n  reason: ' .. safe_reason ..
                    '\n  by: Lua capture/validate session'
  local chain_input = prev_chain .. new_entry
  local chain_hex = fp.sha256_hex(chain_input)
  local chain_hash = fp.hex_to_base36(chain_hex):sub(1, 7)

  local af2 = io.open(audit_log, 'a')
  if af2 then
    af2:write('\n' .. new_entry .. '\n  chain: ' .. chain_hash .. '\n')
    af2:close()
  end

  return { old_hash = old_hash, new_hash = new_hash }
end

-- ─── Main loop ────────────────────────────────────────────────────────────────
local update_mode = update_target ~= nil
local drift_mode = runs > 1 and not update_mode

if update_mode then
  print('\n🔄 Update mode — cluster: ' .. update_target .. '\n   Reason: ' .. update_reason .. '\n')
elseif drift_mode then
  print('\n🔍 Drift detection — ' .. runs .. ' runs per cluster...\n')
else
  print('\n🔍 Validating ' .. #regret_files .. ' cluster(s)...\n')
end

local results = {}

for _, name in ipairs(regret_files) do
  local stop = false
  do
    local regret_path = regret_dir .. '/' .. name .. '.regret'
    local rf = io.open(regret_path, 'r')
    if not rf then
      print(string.format('  ❌ %-35s cannot read .regret file', name))
      results[#results + 1] = { id = name, pass = false, error = 'cannot read' }
    else
      local regret = parse_regret(rf:read('*a'))
      rf:close()

      -- Find matching cluster
      local def
      for _, c in ipairs(manifest.clusters) do
        if c.id == name and c.stack == 'lua' then def = c break end
      end
      if not def then
        print(string.format('  ⚠️  %-35s not in manifest (or not lua stack) — skipping', name))
      else
        local run_result, err = run_cluster(def, regret, runs)
        if not run_result then
          print(string.format('  ❌ %-35s ERROR: %s', name, err or 'unknown'))
          results[#results + 1] = { id = name, pass = false, error = err }
        else
          local live_hash = run_result.hashes[1]
          local is_match = live_hash == regret.golden_hash

          local is_drift = false
          if drift_mode then
            for _, hs in pairs(run_result.hashes_per_input) do
              local seen = {}
              for _, h in ipairs(hs) do seen[h] = true end
              local n = 0
              for _ in pairs(seen) do n = n + 1 end
              if n > 1 then is_drift = true break end
            end
          end

          local id_padded = name .. string.rep(' ', math.max(0, 35 - #name))

          if update_mode then
            if is_match then
              print(string.format('  ℹ️  %s unchanged — no update needed', id_padded))
              results[#results + 1] = { id = name, pass = true }
            else
              local ur = update_regret(regret_path, regret, live_hash, run_result.first_output, update_reason)
              print(string.format('  ✅ %s %s → %s  UPDATED', id_padded, ur.old_hash, ur.new_hash))
              results[#results + 1] = { id = name, pass = true, updated = true }
            end
          elseif drift_mode then
            if is_drift then
              print(string.format('  ❌ %s DRIFT  [%s]', id_padded, table.concat(run_result.hashes, ' / ')))
              results[#results + 1] = { id = name, pass = false, drift = true }
            else
              local icon = is_match and '✅' or '❌'
              print(string.format('  %s %s %s  × %d  %s', icon, id_padded, regret.golden_hash, runs, is_match and 'PASS+STABLE' or 'FAIL'))
              results[#results + 1] = { id = name, pass = is_match }
            end
          else
            local icon = is_match and '✅' or '❌'
            local hstr = is_match and regret.golden_hash or (regret.golden_hash .. ' → ' .. live_hash)
            print(string.format('  %s %s %-22s %s', icon, id_padded, hstr, is_match and 'PASS' or 'FAIL'))
            results[#results + 1] = { id = name, pass = is_match, golden = regret.golden_hash, live = live_hash }
          end
        end
      end
    end
  end

  if #results > 0 and not results[#results].pass and fail_fast then
    print('\n  --fail-fast: stopping.')
    break
  end
end

-- ─── Summary ──────────────────────────────────────────────────────────────────
local passed = 0
local failed = 0
local drifted = 0
local updated = 0
for _, r in ipairs(results) do
  if r.pass then passed = passed + 1 else failed = failed + 1 end
  if r.drift then drifted = drifted + 1 end
  if r.updated then updated = updated + 1 end
end

print('\n' .. string.rep('─', 60))

if update_mode then
  print(string.format('✅ Update complete. %d updated.\n   Audit: regrets/audit.log', updated))
  os.exit(0)
end
if drift_mode and drifted > 0 then
  print(string.format('❌ Drift in %d cluster(s). Add normalize rules and re-capture.\n', drifted))
  os.exit(1)
end
if failed == 0 then
  print(string.format('✅ All %d tests passed%s. Refactor is safe.\n', passed, drift_mode and (' (' .. runs .. ' runs — stable)') or ''))
  os.exit(0)
end
print(string.format('❌ %d/%d FAILED.\n', failed, #results))
for _, r in ipairs(results) do
  if not r.pass then
    print('  • ' .. r.id)
    if r.error then
      print('    ' .. r.error)
    else
      print(string.format('    Expected: %s  Got: %s', r.golden or '?', r.live or '?'))
    end
  end
end
print('\nFix the CODE — do not edit .regret files.\nRe-run: lua scripts/validate_lua.lua')
os.exit(1)

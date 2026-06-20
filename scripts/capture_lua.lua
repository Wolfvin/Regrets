#!/usr/bin/env lua
-- capture_lua.lua — regret capture runner for Lua clusters
--
-- Reads regrets/manifest.json, invokes Lua entry functions with inputs from
-- the manifest, hashes outputs, and writes .regret files in the same format
-- as JS/Python/PHP stacks.
--
-- Usage:
--   lua scripts/capture_lua.lua                          # capture all Lua clusters
--   lua scripts/capture_lua.lua --cluster luhn-valid     # capture one cluster
--   lua scripts/capture_lua.lua --manifest ./regrets/manifest.json
--   lua scripts/capture_lua.lua --only-new               # skip if .regret already exists
--
-- Manifest schema (Lua cluster):
--   {
--     "id": "luhn-valid",
--     "entry": "valid",                                  -- function name in the returned module table
--     "watches": ["valid", "checksum"],                  -- informational; Lua has no proxy
--     "file": "src/luhn.lua",                            -- relative to CWD
--     "stack": "lua",
--     "fingerprintLevel": "entry",                       -- only "entry" supported in v1
--     "inputs": [                                        -- list of input values
--       "79927398713",
--       ["arg1", "arg2"]                                 -- array form with multiArgs: true
--     ],
--     "multiArgs": false                                 -- optional, default false
--   }

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
local manifest_path = get_arg(args, '--manifest') or (os.getenv('PWD') or '.') .. '/regrets/manifest.json'
local only_new = has_flag(args, '--only-new')

-- Resolve CWD-relative paths
local function cwd()
  -- Lua has no built-in cwd; popen pwd
  local h = io.popen('pwd 2>/dev/null')
  local s = h:read('*l') or '.'
  h:close()
  return s
end
local CWD = cwd()

-- ─── Read manifest ────────────────────────────────────────────────────────────
local manifest_file = io.open(manifest_path, 'r')
if not manifest_file then
  io.stderr:write('❌ Could not read manifest: ' .. manifest_path .. '\n')
  io.stderr:write("   Create regrets/manifest.json first. See SKILL.md for format.\n")
  os.exit(1)
end
local manifest_src = manifest_file:read('*a')
manifest_file:close()

local manifest = fp.json_decode(manifest_src)
if not manifest or not manifest.clusters then
  io.stderr:write('❌ Invalid JSON in manifest: ' .. manifest_path .. '\n')
  os.exit(1)
end

-- ─── Filter to Lua clusters ──────────────────────────────────────────────────
local lua_clusters = {}
for _, c in ipairs(manifest.clusters) do
  if c.stack == 'lua' then
    if not cluster_filter or c.id == cluster_filter then
      lua_clusters[#lua_clusters + 1] = c
    end
  end
end

if #lua_clusters == 0 then
  print('No Lua clusters found in manifest.')
  os.exit(0)
end

-- Ensure regrets dir exists
local regret_dir = CWD .. '/regrets'
os.execute('mkdir -p ' .. regret_dir)

-- ─── Helper: invoke Lua module function ───────────────────────────────────────
-- Loads the file via dofile, expects it to return a table (the module).
-- Entry can be:
--   "fnName"       → module.fnName(...)
--   "Table.fnName" → module.Table.fnName(...)  (one level of nesting)
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
  -- "Table.fnName" → mod.Table.fnName (one level only)
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

-- ─── Run a single cluster ─────────────────────────────────────────────────────
local function run_cluster(cluster)
  local id = cluster.id
  local entry = cluster.entry
  local watches = cluster.watches or {}
  local file = cluster.file or ''
  local multi_args = cluster.multiArgs == true
  local inputs = cluster.inputs or { nil }
  local fp_level = cluster.fingerprintLevel or 'entry'
  local normalize_rules = cluster.normalize or {}
  local ignore_fields = cluster.ignoreFields or {}

  print('\n📡 Capturing: ' .. id)
  print('   File:    ' .. file)
  print('   Entry:   ' .. entry)
  print('   Watches: ' .. table.concat(watches, ', '))

  if file == '' then
    print('   ❌ Capture failed: missing "file" field')
    return false
  end

  local mod, err = load_module(file)
  if not mod then
    print('   ❌ Capture failed: ' .. (err or 'unknown'))
    return false
  end

  local fn, ferr = resolve_entry(mod, entry)
  if not fn then
    print('   ❌ Capture failed: ' .. (ferr or 'unknown'))
    return false
  end

  -- Skip if --only-new and .regret exists
  local regret_path = regret_dir .. '/' .. id .. '.regret'
  if only_new then
    local f = io.open(regret_path, 'r')
    if f then
      f:close()
      print('   ⏭️  Already captured — skip (--only-new)')
      return true
    end
  end

  -- Use first input as the golden
  local input = inputs[1]
  if input == nil and #inputs == 0 then input = nil end

  -- Deep-clone input BEFORE calling the function (matches PHP deep_clone)
  local input_for_record = fp.deep_clone(input)
  local input_for_args = fp.deep_clone(input)

  -- Invoke entry function
  local output
  local ok, call_err
  if multi_args and type(input_for_args) == 'table' and fp.is_array(input_for_args) then
    ok, output = pcall(fn, table.unpack(input_for_args))
  else
    ok, output = pcall(fn, input_for_args)
  end

  if not ok then
    print('   ❌ Entry function threw: ' .. tostring(output))
    return false
  end

  -- Trivial input guard: skip if output is nil
  if output == nil then
    print('   ⏭️  Output is nil — skipping (trivial guard)')
    return true
  end

  local fp_input = input_for_record
  local golden_fp = fp.fingerprint(fp_input, output, normalize_rules, ignore_fields)

  -- Write .regret file
  local timestamp = os.date('!%Y-%m-%dT%H:%M:%S') .. string.format('.%06d+00:00', (os.clock() % 1) * 1000000)

  local lines = {
    'cluster: ' .. id,
    'version: 1',
    'fingerprint: ' .. golden_fp,
    'captured: ' .. timestamp,
    'watches: [' .. table.concat(watches, ', ') .. ']',
    'entry: ' .. entry,
    'stack: lua',
    'fingerprintLevel: ' .. fp_level,
  }
  if file and file ~= '' then
    lines[#lines + 1] = 'file: ' .. file
  end
  if multi_args then
    lines[#lines + 1] = 'multiArgs: true'
  end
  if #normalize_rules > 0 then
    lines[#lines + 1] = 'normalize: [' .. table.concat(normalize_rules, ', ') .. ']'
  end
  if #ignore_fields > 0 then
    lines[#lines + 1] = 'ignoreFields: [' .. table.concat(ignore_fields, ', ') .. ']'
  end

  lines[#lines + 1] = '---'
  lines[#lines + 1] = 'INPUT  ' .. fp.stable_dumps(input_for_record)
  lines[#lines + 1] = 'OUTPUT ' .. fp.stable_dumps(output)
  lines[#lines + 1] = 'HASH   ' .. golden_fp

  local rf = io.open(regret_path, 'w')
  if not rf then
    print('   ❌ Cannot write ' .. regret_path)
    return false
  end
  rf:write(table.concat(lines, '\n') .. '\n')
  rf:close()

  print('   ✅ Fingerprint: ' .. golden_fp)
  print('   📄 Saved: regrets/' .. id .. '.regret')
  return true
end

-- ─── Main loop ────────────────────────────────────────────────────────────────
print('📡 Capturing Lua clusters...')
local passed, failed = 0, 0
for _, cluster in ipairs(lua_clusters) do
  if run_cluster(cluster) then
    passed = passed + 1
  else
    failed = failed + 1
  end
end

print('\n' .. string.rep('─', 50))
print(string.format('Capture complete: %d captured, %d failed', passed, failed))
if failed > 0 then
  print('\n⚠️  Fix failed captures before proceeding to PHASE 2.')
  print("   Hint: Check that 'entry' and 'watches' names match exports in your file.")
  os.exit(1)
end
print('\nNext: lua scripts/validate_lua.lua')
print('If all green → you are clear to refactor.')

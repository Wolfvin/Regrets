# Lua Stack Variant

Regression fingerprinting for Lua projects using a generated Lua runner script that invokes entry functions, computes cross-stack-compatible fingerprints, and writes/compares `.regret` files.

## Status: Working — capture + validate implemented

Lua stack support is **working end-to-end** — both `capture_lua.sh capture` and `capture_lua.sh validate` generate and run a Lua runner script that invokes entry functions, computes cross-stack-compatible fingerprints (pure-Lua SHA-256 + base36), and writes/compares `.regret` files.

**Verification:** run `bash scripts/verify_lua_stack.sh` from the repo root to see a full end-to-end demo (capture → validate PASS for no-change and valid-refactor, FAIL for breaking change, plus cross-stack fingerprint parity with JS, plus module-based capture).

### What's implemented

- **Capture**: `bash scripts/capture_lua.sh capture` generates `regrets/regret_capture.lua`, runs the Lua interpreter, writes `.regret` files for each cluster.
- **Validate**: `bash scripts/capture_lua.sh validate` generates `regrets/regret_validate.lua`, re-invokes each entry function with the saved input, compares the live fingerprint to the golden, reports PASS/FAIL.
- **Single-cluster**: `bash scripts/capture_lua.sh --cluster <id>` (capture) or `bash scripts/capture_lua.sh validate --cluster <id>`.
- **Cross-stack parity**: Lua fingerprints match JS fingerprints for the same input/output (verified for int, string, array, NaN/Inf sentinels).
- **File-based capture**: `file` field points to a `.lua` file; the file is `loadfile()`'d and either its return value (module table) or `_G[entry]` is used.
- **Module-based capture**: `module` field specifies a module name to `require()`; `module[entry]` is the entry function.
- **multiArgs support**: when `multiArgs: true`, each input must be an array; each element becomes one function argument.
- **Partial capture (#318 parity)**: if one input throws, the cluster still captures with the remaining inputs (matching the JS stack's behavior).
- **Pure-Lua SHA-256**: the SHA-256 algorithm is implemented in pure Lua (no external dependencies), so the runner works with any Lua 5.4+ interpreter.
- **Pure-Lua big-integer base36**: the hex-to-base36 conversion (needed because SHA-256 produces 256-bit hashes that exceed Lua's 64-bit integers) is implemented via a limb-array big-integer with `divmod`.

### What's NOT yet implemented (deferred to follow-up PRs)

- **Callee contracts** (`<parent>.calls.<callee>.regret`): Lua doesn't have a Proxy like JS, so callee wrapping would require metatable-based recording wrappers — a larger feature.
- **Multi-input `INPUTS` line (#315 parity)**: currently the `.regret` file stores only the first successful input as the golden. Multi-input contracts would need the `INPUTS` line added to the Lua capture path.
- **`expectThrow` support**: Lua capture doesn't yet read `{ __expectThrow: true, value: <input> }` input markers.

---

## Quick Start

1. Install Lua 5.4+ (e.g. `apt install lua5.4`, or build from source: https://www.lua.org/ftp/lua-5.4.7.tar.gz)
2. Add `"stack": "lua"` clusters to `regrets/manifest.json`
3. Run `bash scripts/capture_lua.sh` to capture
4. Run `bash scripts/capture_lua.sh validate` to validate
5. All `.regret` files use identical format to JS/Python/Go stacks

---

## Manifest for Lua Clusters

```json
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
      "id": "greet",
      "entry": "greet",
      "module": "mymodule",
      "stack": "lua",
      "fingerprintLevel": "entry",
      "inputs": ["world", "Lua"]
    }
  ]
}
```

### Lua-specific fields

| Field | Required | Description |
|-------|----------|-------------|
| `stack` | ✅ | Must be `"lua"` |
| `entry` | ✅ | Name of the entry function |
| `file` | ❌* | Path to `.lua` file (relative to project root). The file is `loadfile()`'d; either its return value (module table) or `_G[entry]` is used. |
| `module` | ❌* | Module name to `require()`. `module[entry]` is the entry function. Takes precedence over `file`. |
| `multiArgs` | ❌ | When `true`, each input must be an array; each element becomes one function argument. Default: `false` (single-arg invocation). |

\* Either `file` or `module` must be specified.

---

## How it works

### File-based capture

When `file` is specified, the Lua runner:
1. `loadfile()` the file
2. Executes the chunk to define globals and/or get the return value
3. If the chunk returns a table, looks up `entry` on it
4. Otherwise looks up `_G[entry]`
5. Invokes the function with each input from the manifest

```lua
-- math.lua — returns a module table
local M = {}
function M.add(a, b) return a + b end
return M
```

### Module-based capture

When `module` is specified, the Lua runner:
1. `require()` the module (adds project dir to `package.path`)
2. Looks up `entry` on the returned module table
3. Invokes the function with each input

```lua
-- mymodule.lua
local M = {}
function M.greet(name) return "Hello, " .. name .. "!" end
return M
```

### Fingerprint algorithm

The fingerprint is `sha256(stableStringify(input) + "|" + stableStringify(output))` → base36 → first 7 chars — identical to JS/Python/Go stacks.

The SHA-256 is implemented in pure Lua (~100 lines) because Lua's stdlib has no SHA-256. The base36 conversion uses a limb-array big-integer because SHA-256 produces 256-bit hashes that exceed Lua's 64-bit integers.

### .regret file format

Identical to all other stacks:

```
cluster: add
version: 1
fingerprint: 63qoext
captured: 2026-06-20T18:27:21.003969Z
entry: add
stack: lua
fingerprintLevel: entry
---
INPUT  [1,2]
OUTPUT 3
HASH   63qoext
```

---

## Cross-stack parity

Lua fingerprints are **byte-identical** to JS fingerprints for the same input/output. Verified:

| Input | Output | Lua hash | JS hash |
|-------|--------|----------|---------|
| `[1,2]` | `3` | `63qoext` | `63qoext` |
| `"hello"` | `"olleh"` | `5nssd6s` | `5nssd6s` |

This means a `.regret` file captured by the Lua stack can be validated by the JS stack (and vice versa) — the golden hash is the same.

---

## Limitations

- **Lua 5.4+ required**: the SHA-256 implementation uses Lua 5.4's native bitwise operators (`&`, `|`, `~`, `<<`, `>>`). Lua 5.3 also has these operators but hasn't been tested.
- **No callee wrapping**: Lua has no Proxy equivalent; callee contracts are not supported.
- **Single-input golden**: the `.regret` file stores only the first successful input as the golden (no `INPUTS` line for multi-input contracts yet).
- **No `expectThrow`**: inputs marked `{ __expectThrow: true, value: <input> }` are not handled specially.

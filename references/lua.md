# Lua Stack Variant — Regrets Integration

The Lua stack captures regression fingerprints for pure Lua functions using a
vendored pure-Lua SHA-256 implementation — **no external dependencies, no
native extensions**. Works with Lua 5.3+ (uses the 64-bit integer subtype and
bitwise operators). This implementation produces `.regret` files identical in
format to the JS / Python / PHP / Go stacks.

## Status: Working

Verified end-to-end on the bundled fixture (`tests/fixtures/lua-example/`):

1. **Capture** → 2 `.regret` files written, `✅ reverse captured (hash: 5nssd6s)`,
   `✅ count-vowels captured (hash: 5izc285)`, exit 0.
2. **Validate (no code change)** → `✅ reverse PASS`, `✅ count-vowels PASS`, exit 0.
3. **Breaking change** (`M.reverse` returns input unchanged) → validate reports
   `❌ reverse FAIL — expected 5nssd6s got 4mcbm7s`, exit 1.
4. **Valid refactor** (manual reverse loop instead of `string.reverse`) →
   validate still PASSes, exit 0.
5. **Cross-stack parity** — `fingerprint("hello", "olleh")` produces `5nssd6s`
   in Lua, identical to JS / Go / PHP.

---

## Quick Start

1. Add `"stack": "lua"` clusters to `regrets/manifest.json` (see schema below).
2. Create a `regrets/` folder in your Lua project root.
3. Run `lua scripts/capture_lua.lua` to capture fingerprints.
4. Refactor freely.
5. Run `lua scripts/validate_lua.lua` to validate. Exit 0 = green, non-zero = red.

Or use the unified runner (auto-detects `stack: "lua"` from the manifest):

```bash
node scripts/regret.js capture    # → dispatches to lua scripts/capture_lua.lua
node scripts/regret.js validate   # → dispatches to lua scripts/validate_lua.lua
```

### Requirements

- **Lua 5.3 or newer** (5.4 recommended). Uses the integer subtype and bitwise
  operators (`&`, `|`, `~`, `<<`, `>>`, unary `~`).
- No luarocks, no C extensions, no `lua-ossl`. SHA-256 is a vendored
  clean-room implementation of FIPS 180-4 (public-domain US government
  standard) in `scripts/sha2.lua`.

---

## Architecture

```
scripts/
├── sha2.lua              ← vendored pure-Lua SHA-256 (FIPS 180-4, public-domain)
├── fingerprint_lua.lua   ← stable_stringify + normalize + base36 + fingerprint + json_decode
├── capture_lua.lua       ← reads manifest, dofile()s the module, invokes entry, writes .regret
└── validate_lua.lua      ← reads .regret, re-invokes entry, compares hash, reports PASS/FAIL
```

`capture_lua.lua` and `validate_lua.lua` both resolve their own script directory
from `arg[0]` and prepend it to `package.path`, so they can be invoked from any
CWD (the fixture runs them via `lua ../../../scripts/capture_lua.lua`).

---

## Fingerprint Algorithm — Cross-Stack Parity

The fingerprint is **byte-identical** to the JS / Python / PHP / Go
implementations for the same input/output:

```
fingerprint(input, output) =
  to_base36( sha256_hex( stable_stringify(input) .. "|" .. stable_stringify(output) ) ):sub(1, 7)
```

| Step | JS | Lua |
|------|-----|-----|
| Stable JSON | `stableStringify()` (sorted keys, sentinels for NaN/Inf) | `stable_stringify()` (same rules — sorted keys, `__nan__` / `__infinity__` sentinels) |
| SHA-256 | `crypto.createHash('sha256')` (native) | `scripts/sha2.lua` (pure-Lua, FIPS 180-4) |
| Hex → base36 | `BigInt('0x'+hex).toString(36)` | `to_base36(hex)` — long division by 36 on the hex string (Lua numbers are doubles → cannot hold a 256-bit integer natively) |
| Truncate | `.slice(0, 7)` | `:sub(1, 7)` |

### Why long division for base36?

Lua 5.4 numbers are IEEE 754 doubles — only 53 bits of integer precision. A
SHA-256 digest is 256 bits, far beyond what a double can represent exactly. So
`to_base36()` performs long division by 36 directly on the hex string,
collecting remainders as base36 digits (least-significant first), then reverses.
This is ~50 iterations of dividing a 64-char hex string — trivially fast and
exact.

### Cross-Stack Consistency Check

```
INPUT:  "hello"
OUTPUT: "olleh"

JS:     5nssd6s  ✅
Go:     5nssd6s  ✅
PHP:    5nssd6s  ✅
Lua:    5nssd6s  ✅
```

The bundled Node test (`tests/capture-lua.test.js`) asserts this parity
directly: it parses the Lua-written `.regret` file, extracts INPUT/OUTPUT/HASH,
and recomputes the hash via the JS `fingerprint()` — they must match.

---

## Manifest for Lua Clusters

```json
{
  "clusters": [
    {
      "id": "reverse",
      "entry": "reverse",
      "watches": ["reverse"],
      "file": "strings.lua",
      "stack": "lua",
      "fingerprintLevel": "entry",
      "luaModule": "strings",
      "luaPath": "./?.lua",
      "inputs": ["hello", "regrets", "level"]
    },
    {
      "id": "count-vowels",
      "entry": "count_vowels",
      "watches": ["count_vowels"],
      "file": "strings.lua",
      "stack": "lua",
      "fingerprintLevel": "entry",
      "luaModule": "strings",
      "luaPath": "./?.lua",
      "inputs": ["hello", "aeiou", "xyz"]
    }
  ]
}
```

### Lua-Specific Manifest Fields

| Field | Required | Description |
|-------|----------|-------------|
| `stack` | ✅ | Must be `"lua"` |
| `file` | ✅ | Path to the Lua module file, relative to the project root (CWD). Loaded via `dofile()` for a fresh load each run. |
| `entry` | ✅ | Name of the function inside the module table. For a module file `local M = {}; function M.reverse(s) ... end; return M`, use `"reverse"`. |
| `luaModule` | ❌ | Informational — the logical module name (e.g. `"strings"`). Used for documentation; `dofile()` is used for loading (not `require`), so this field is not strictly required. |
| `luaPath` | ❌ | Informational — the `package.path` pattern (e.g. `"./?.lua"`). Capture/validate use `dofile()` on the `file` field directly, so this is informational only. |
| `inputs` | ✅ | Array of inputs. Each input is passed to the entry function as a single argument (or unpacked if `multiArgs: true`). |
| `watches` | ❌ | Array of function names to monitor (informational for Lua — same limitation as PHP, no ghost proxy). |
| `multiArgs` | ❌ | If `true`, array inputs are unpacked as multiple arguments: `entryFn(table.unpack(input))`. Default `false`. |
| `normalize` | ❌ | Array of normalization rules. Supported: `timestamps`, `uuids`, `absPaths`, `epochs`, `floatPrecision`. (Subset of JS rules — see Limitations.) |
| `ignoreFields` | ❌ | Object keys to drop before fingerprinting (top-level + nested). |
| `fingerprintLevel` | ❌ | `"entry"` (default, recommended). |

---

## Module Pattern

The Lua stack expects the **module pattern** (`local M = {}; ...; return M`):

```lua
-- strings.lua
local M = {}

function M.reverse(s)
    return string.reverse(s)
end

function M.count_vowels(s)
    local _, n = string.gsub(s, "[aeiouAEIOU]", "")
    return n
end

return M
```

Then in the manifest, `"entry": "reverse"` resolves to `M.reverse`.

A bare top-level function (file returns a single function) is also supported —
set `"entry"` to the cluster `id` (or omit it) and the file's returned function
is invoked directly.

---

## Example `.regret` Output

```
cluster: reverse
version: 1
fingerprint: 5nssd6s
captured: 2026-06-20T18:22:33Z
watches: [reverse]
entry: reverse
stack: lua
fingerprintLevel: entry
file: strings.lua
luaModule: strings
luaPath: ./?.lua
---
INPUT  "hello"
OUTPUT "olleh"
HASH   5nssd6s
INPUTS [{"hash":"5hnum9u","input":"regrets","output":"sterger"},{"hash":"2e0jclf","input":"level","output":"level"}]
```

The `INPUTS` line carries the per-input contract for inputs 1+ (mirrors the JS
multi-input format from issue #315). `validate_lua.lua` checks **every** input —
a mismatch on any one fails the cluster.

---

## Differences from JS/Python Stacks

| Feature | JS | Python | PHP | Lua |
|---------|-----|--------|-----|-----|
| Ghost Proxy | ✅ native `Proxy` | ✅ decorator | ❌ direct invocation | ❌ direct invocation |
| `fingerprintLevel: "entry"` | ✅ | ✅ | ✅ | ✅ |
| `fingerprintLevel: "full"` | ✅ | ✅ | ⚠️ manual | ⚠️ manual |
| Dynamic import | `import()` | `importlib` | `require_once` | `dofile()` |
| SHA-256 | native `crypto` | stdlib `hashlib` | native `hash()` | vendored `sha2.lua` (pure Lua) |
| Cross-stack parity | ✅ | ✅ | ✅ | ✅ |
| External deps | none | none | GMP ext (for base36) | **none** |

### Lua Limitation: No Automatic Ghost Proxy

Like PHP, Lua has no equivalent of JavaScript's `Proxy`. This means:

1. **`fingerprintLevel: "entry"`** works perfectly — it hashes the final output.
2. **`fingerprintLevel: "full"`** requires manual instrumentation — you must
   wrap watched functions yourself (not yet automated).
3. **`watches` field** is informational — it documents which functions
   contribute to the output but does not automatically instrument them.

For most refactoring workflows, `fingerprintLevel: "entry"` is sufficient and
recommended (as stated in SKILL.md: "entry is recommended for AI-refactor
workflows — most permissive, only cares about final contract").

### Normalization Rules — Subset Ported

The Lua `normalize()` supports the common rules: `timestamps`, `uuids`,
`absPaths`, `epochs`, `floatPrecision`. Less common JS rules
(`incrementingIds`, `randomIds`, `autoIncrement`, `isoDates`,
`timezoneOffsets`, `dynamicDates`, `normalizeNow`, `floatTolerance`) are not
yet ported. Clusters needing those rules should restructure inputs to avoid
non-determinism, or wait for the rules to be ported.

### Empty Array vs Empty Object

Lua tables are ambiguous — an empty table `{}` serializes as `"{}"` (object)
in `stable_stringify`. A Lua function returning an empty array `{}` will
fingerprint as `{}`, not `[]`. This differs from JS where `[]` and `{}` are
distinct. For functions that legitimately return empty arrays, wrap the output
or use a sentinel. (Rare in practice — most functions return non-empty
output.)

---

## NPM Script Equivalents for Lua

```json
{
  "regret:capture:lua": "lua ../../The-skill/regresion-testing/scripts/capture_lua.lua",
  "regret:validate:lua": "lua ../../The-skill/regresion-testing/scripts/validate_lua.lua"
}
```

Or use the unified runner which auto-detects Lua clusters from the manifest:

```json
{
  "regret:capture": "node ../../The-skill/regresion-testing/scripts/regret.js capture",
  "regret:validate": "node ../../The-skill/regresion-testing/scripts/regret.js validate",
  "regret:health": "node ../../The-skill/regresion-testing/scripts/regret.js health"
}
```

---

## Compatibility with JS/Python/PHP Manifests

Lua clusters can coexist with JS, Python, PHP, Go, and Rust clusters in the
same `manifest.json`. The capture/validate scripts filter by the `stack` field:

- `capture_lua.lua` only processes `stack: "lua"` clusters
- `validate_lua.lua` only validates `.regret` files whose header declares
  `stack: lua`
- `regret.js` auto-detects all stacks present in the manifest and dispatches to
  each stack's handler in turn
- `health.js` reads the same `audit.log` — health reports cover all stacks

---

## Out of Scope (Future Work)

- **Callee wrapping** for Lua (not implemented — same limitation as PHP).
- **Coroutine-based async functions** (edge case — deferred).
- **C-extension bindings** (require a C compiler — deferred).
- **`regret update` audit.log** writing (the `--update` flag is accepted but
  does not yet write the hash-chain audit log; re-capture is the recommended
  update path for Lua clusters).
- **Drift detection** (`--runs N`) — not yet implemented for Lua.

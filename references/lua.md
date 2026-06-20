# Lua Stack Variant — Regrets Integration

The Lua stack brings Regrets' output-fingerprint regression testing to Lua
codebases. It targets pure-Lua libraries (LÖVE games, Neovim plugins,
WezTerm config, Redis scripts, embedded scripting) where refactor-safety
matters and existing test frameworks don't catch behavior drift.

The Lua implementation follows the PHP pattern: a native Lua runner script
plus a shared fingerprint helper. It produces `.regret` files byte-identical
in format to the JS, Python, PHP, Go, and Rust stacks.

## Quick Start

1. Add `"stack": "lua"` clusters to `regrets/manifest.json` (see schema below).
2. Run `lua scripts/capture_lua.lua` to capture fingerprints.
3. Run `lua scripts/validate_lua.lua` to validate (all clusters).
4. Run `lua scripts/validate_lua.lua --runs 5` for drift detection.
5. Run `lua scripts/validate_lua.lua --update <id> --reason "<detailed reason>"` to re-capture after an intentional behavior change.

A complete working example lives in `examples/lua/` — see `examples/lua/README.md`.

## Prerequisites

- **Lua 5.3+** (tested with Lua 5.4.6; Lua 5.1 / LuaJIT should also work but
  `table.unpack` must exist — on 5.1 use `unpack`).
- **`sha256sum`** from coreutils (already on Linux; macOS users may need
  `brew install coreutils` and may have it as `gsha256sum` — symlink if needed).

The `sha256sum` dependency matches the bash-wrapper pattern used by
`capture_go.sh` and `capture_rust.sh`. A pure-Lua SHA-256 implementation
would add ~200 lines for no real portability gain on the Linux/macOS
hosts Lua developers overwhelmingly use.

## Manifest Schema

```json
{
  "clusters": [
    {
      "id": "luhn-valid",
      "entry": "valid",
      "watches": ["valid"],
      "file": "src/luhn.lua",
      "stack": "lua",
      "fingerprintLevel": "entry",
      "inputs": ["79927398713", "79927398710", "4111111111111111"]
    }
  ]
}
```

Field notes:

| Field | Required | Description |
|---|---|---|
| `id` | ✅ | Cluster identifier — becomes the `.regret` filename |
| `entry` | ✅ | Function name in the module table. Use dotted form `Table.fn` for one level of nesting (e.g. `M.fn` if the module returns `{ M = { fn = ... } }`) |
| `file` | ✅ | Path to the Lua source, relative to CWD. Must `return` a table (the module). |
| `stack` | ✅ | Must be `"lua"` |
| `fingerprintLevel` | ✅ | Only `"entry"` is supported in v1 (see Limitations below) |
| `inputs` | optional | Array of input values; first input is the golden one captured to `.regret`. Defaults to `[null]`. |
| `watches` | optional | Informational only — Lua has no Proxy, so callee wrapping isn't possible. Listed in the `.regret` file for documentation. |
| `multiArgs` | optional | If `true`, an array input is unpacked as multiple arguments to the entry function (e.g. `[a, b]` → `fn(a, b)`). Default `false`. |
| `normalize` | optional | Same rules as JS/PHP: `timestamps`, `uuids`, `absPaths`, `dynamicDates`, `floatPrecision`, `floatTolerance`, `floatTolerance:N`, `epochs` |
| `ignoreFields` | optional | Object field names to strip from output before hashing |

## Module Format

The Lua file referenced by `file` must `return` a table containing the entry function:

```lua
-- src/luhn.lua
local M = {}

function M.checksum(num_str)
  -- ...
  return check_digit
end

function M.valid(num_str)
  -- ...
  return is_valid
end

return M
```

The `entry` field in the manifest is the key inside the returned table
(`"checksum"`, `"valid"`, etc.). For one level of nesting, use dot notation
(`"Subtable.fn"`).

## fingerprint_lua.lua — SHA-256 + Base36

The fingerprint algorithm is **identical** to JS / Python / PHP / Go:

```
combined = stableStringify(input) .. '|' .. stableStringify(output)
hash_hex = sha256(combined)
base36 = hex_to_base36(hash_hex)
fingerprint = base36:sub(1, 7)
```

### Cross-Stack Consistency Check

Verified with `lua scripts/verify_fingerprint.lua`:

| Input | Output | Lua | Python |
|---|---|---|---|
| `5783` (int) | `2111852` (int) | `5hj9vhu` | `5hj9vhu` |
| `"hello"` | `"world"` | `67cq6s6` | `67cq6s6` |
| `[1,2,3]` | `{"sum":6}` | `1xafmhi` | `1xafmhi` |
| `{"a":1,"b":{"c":2}}` | `{"ok":true,"val":42}` | `5bv4zx4` | `5bv4zx4` |

The first case matches the existing `proof/pyluach/elapsed-days.regret`
golden hash — meaning the Lua stack can validate against Python golden
contracts and vice versa.

### Pure-Lua Big-Integer Base36

Lua has no built-in arbitrary-precision integers. The implementation in
`fingerprint_lua.lua` performs long division on the hex string directly
(`hex_to_base36`), producing the same result as JS `BigInt('0x'+hex).toString(36)`,
Python `to_base36(int(hex, 16))`, and PHP `gmp_strval(gmp_init(hex, 16), 36)`.

For a 256-bit SHA-256 hash, this is ~50 base36 digits produced in ~3200
simple arithmetic operations — negligible overhead.

## Limitations

- **`fingerprintLevel: "entry"` only.** Lua has no equivalent of JS `Proxy`
  or Python `unittest.mock.patch`, so callee functions cannot be transparently
  wrapped without source transformation. The `watches` field is informational
  only and listed in the `.regret` file for documentation purposes. This is
  the same limitation as the PHP stack (see `references/php.md`).
- **`sha256sum` external dependency.** Required for the SHA-256 hash. If
  unavailable, `fingerprint_lua.lua` will throw a clear error.
- **Table ambiguity.** Lua tables are ambiguous between arrays and objects.
  We treat `{1,2,3}` (contiguous integer keys from 1) as arrays and
  `{a=1,b=2}` as objects, matching the JS/PHP convention. The empty table
  `{}` is treated as an empty array (`"[]"`).
- **No ESM/CJS-like module resolution.** The `file` path is resolved
  relative to CWD; `package.path` is not consulted.

## File Layout

```
scripts/
├── fingerprint_lua.lua   Shared: stable_dumps, normalize, sha256_hex,
│                         hex_to_base36, fingerprint, extract_schema,
│                         json_decode, deep_clone
├── capture_lua.lua       Capture runner (reads manifest, writes .regret)
├── validate_lua.lua      Validate runner (reads .regret, compares hashes)
└── verify_fingerprint.lua  Cross-stack consistency self-test

examples/lua/
├── src/luhn.lua          Example: pure-Lua Luhn algorithm
├── regrets/
│   ├── manifest.json     Two Lua clusters
│   └── *.regret          Generated by capture
└── README.md             Walkthrough: capture → validate PASS → mutate → FAIL

references/lua.md         This file
```

## Integration with `regret install` (future work)

The Lua stack is NOT yet wired into `scripts/install.js`'s auto-discovery.
To use it, manually author `regrets/manifest.json` (see the example). A
follow-up PR can add Lua file detection to `analyzer.js` and the
`install.js` dispatch table.

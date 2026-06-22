# Julia Stack — Regrets Usage Guide

This guide explains how to use Regrets with **Julia** codebases. Julia is a
high-performance, dynamically-typed language for technical computing, with
LLVM-based JIT compilation.

## Prerequisites

- **Julia 1.11+** on `PATH` (or set `JULIA=/path/to/julia` env var).
  - Prebuilt binary: https://julialang.org/install/
  - The `JSON` stdlib package is required (Julia 1.7+ ships it but doesn't
    load it by default — Regrets auto-installs it on first run into
    `~/.julia/environments/regrets`).
- **Node.js 16+** (for manifest JSON parsing — `capture_julia.sh` and
  `validate_julia.sh` invoke `node` for JSON parsing).

Verify your install:

```bash
julia --version
# julia version 1.11.5

node --version
# v18.x or higher
```

## Architecture

Julia is JIT-compiled (LLVM) — `julia script.jl` parses, lowers, compiles,
and runs. There is no separate compile step. The Regrets Julia stack
mirrors the architecture of the Nim/PHP/Ruby adapters (compiled languages
without runtime reflection), NOT the JS/Python adapters (which use a
Ghost Proxy to intercept callee calls).

```
scripts/
├── fingerprint_julia.jl   Shared module: stableStringify, fingerprint, toBase36
├── _julia_harness_gen.cjs Node helper: render per-cluster Julia harness source
├── capture_julia.sh       Bash wrapper: read manifest → invoke → write .regret
└── validate_julia.sh      Bash wrapper: read .regret → re-invoke → compare hash
```

## Manifest Schema

```json
{
  "clusters": [{
    "id": "slugify",
    "entry": "slugify",
    "watches": ["slugify"],
    "file": "lib/slugify.jl",
    "stack": "julia",
    "fingerprintLevel": "entry",
    "inputs": ["Hello, World!", "Café résumé", "..."]
  }]
}
```

### Fields (Julia-specific)

| Field | Required | Description |
|---|---|---|
| `id` | yes | Cluster identifier. Used as the `.regret` filename. |
| `entry` | yes | Top-level function name in the user's source file. Must be a valid Julia identifier (`^[A-Za-z_][A-Za-z0-9_]*$`). |
| `file` | yes | Path to the user's `.jl` source file (relative to project root). |
| `stack` | yes | Must be `"julia"`. |
| `inputs` | yes | Array of input values. The first element is the one captured to the `.regret` file (mirrors Nim adapter behavior). |
| `watches` | optional | Informational only — Julia has no equivalent of the JS Ghost Proxy. |
| `fingerprintLevel` | optional | Defaults to `"entry"`. Only `"entry"` is supported. |

### Supported Input Types

The harness dispatches by JSON type at runtime:

| JSON type | Julia type | Notes |
|---|---|---|
| string | `String` | Most common case. |
| integer | `Int64` (fallback `Float64`) | Try `Int64` first, fall back to `Float64` if the function's signature demands. |
| float | `Float64` | Whole-number floats are normalized to `Int` form during stringify (matches JS `JSON.stringify(2.0) → "2"`). |
| bool | `Bool` | |
| array of strings | `Vector{String}` | |
| array of ints | `Vector{Int64}` | |
| array of floats | `Vector{Float64}` | |
| array (mixed) | `Vector{Any}` (raw JSON node) | Fallback if all element-type conversions fail. |

### Supported Output Types

The harness uses `stableStringify` to serialize the function's return value:

| Julia type | JSON form | Notes |
|---|---|---|
| `String` | `"..."` | Standard JSON string. |
| `Int64` / `Integer` | bare number | No quotes. |
| `Float64` | bare number | Whole-number floats normalize to `Int` form (`2.0 → "2"`) to match JS. |
| `Bool` | `true` / `false` | |
| `Vector{T}` | `[...]` | Recursive — each element stringified. |
| `Tuple` | `[...]` | Treated as JSON array (positional). |
| `NamedTuple` | `{"field1":..., "field2":...}` | Field names become JSON keys (sorted alphabetically). |
| `Dict{K,V}` | `{...}` | Keys sorted by `JSON.json(String(k))`. |
| `nothing` / `missing` | `null` | Both map to JSON `null`. |
| `NaN` | `"__nan__"` | Sentinel (issue #322 — prevents hash collisions). |
| `Inf` | `"__infinity__"` | Sentinel. |
| `-Inf` | `"__neg_infinity__"` | Sentinel. |
| `Date` / `DateTime` | ISO-8601 string | Matches JS `Date.prototype.toJSON`. |

## Workflow

### Phase 1: Capture

From a directory containing `regrets/manifest.json`:

```bash
bash scripts/capture_julia.sh
# or capture one cluster:
bash scripts/capture_julia.sh --cluster slugify
# or use a custom manifest path:
bash scripts/capture_julia.sh --manifest ./my-manifest.json
```

For each cluster, the script:

1. Generates a per-cluster Julia harness file at `/tmp/regret_harness_julia_<id>_$$.jl`.
2. The harness `include`s `fingerprint_julia.jl` (shared module) and the
   user's source file (so all top-level functions become visible).
3. The harness parses the embedded input JSON, dispatches to the entry
   function based on input type, computes the fingerprint, and prints
   `REGRET_INPUT`/`REGRET_OUTPUT`/`REGRET_HASH` lines.
4. The bash wrapper parses these lines and writes
   `regrets/<cluster-id>.regret` in the standard format.

### Phase 2: Refactor

Make any change to the user's source code. The harness `include`s the file
fresh on each invocation, so changes take effect immediately — no rebuild
needed (Julia's JIT recompiles on demand).

### Phase 3: Validate

```bash
bash scripts/validate_julia.sh
# or validate one cluster:
bash scripts/validate_julia.sh --cluster slugify
# stop on first FAIL:
bash scripts/validate_julia.sh --fail-fast
```

For each cluster, the script regenerates the harness, runs it, computes a
live hash, and compares it to the golden `HASH` in the `.regret` file.

**Exit code:** `0` if all clusters PASS, `1` if any FAIL.

### Update Mode (NOT YET SUPPORTED)

`regret update <cluster> --reason "..."` is **not yet implemented** for
the Julia stack. Use the workaround:

```bash
bash scripts/capture_julia.sh --cluster <cluster-id>
git add regrets/<cluster-id>.regret
git commit -m "refactor(<scope>): <description>

Behavior changed intentionally for <cluster-id>. Re-captured."
```

This is a known parity gap with JS/Python/Bash/Perl/C++. Future work.

## Working Example

See `proof/julia_slugify/` for a complete end-to-end demo:

```bash
cd proof/julia_slugify
bash run_demo.sh
```

The demo:

1. Captures the baseline (2 clusters: `slugify`, `slugify-batch`).
2. Validates (must PASS).
3. Applies a VALID refactor (rename var + extract helper) → must PASS.
4. Applies a BREAKING refactor (hyphen → underscore) → must FAIL.
5. Restores the original file → must PASS.
6. Verifies cross-stack parity: Julia HASH == JS `fingerprint()` == Nim hash.

## Cross-Stack Fingerprint Parity

The Julia adapter uses the **same** algorithm as `fingerprint.js` /
`fingerprint.py` / `fingerprint_nim.nim` / `fingerprint_perl.pl` /
`fingerprint_rb.rb` / `fingerprint_lua.lua` / `fingerprint_php.php`:

```
combined = stableStringify(input) + "|" + stableStringify(output)
hashHex  = sha256(combined)              # 64-char lowercase hex
b36      = toBase36(hashHex)             # BigInt → base36 lowercase
fingerprint = b36[0:7]                   # first 7 chars
```

For the same `(input, output)` pair, Julia produces a byte-identical 7-char
hash to all other supported stacks. Verified by
`proof/julia_slugify/verify-parity.mjs`:

```
cluster         | Julia hash   | JS hash    | Nim hash   | match
──────────────────────────────────────────────────────────────────────
slugify-batch   | 2tph9ny      | 2tph9ny    | 2tph9ny    | ✅
slugify         | 615ytfn      | 615ytfn    | 615ytfn    | ✅
```

## Implementation Notes

### Why no `--update` mode yet

The `--update` flow (re-capture + append to `audit.log` with a chain hash)
requires a parser for the existing `.regret` file format. The Julia adapter
currently writes `.regret` files but doesn't read them back. Implementing
`--update` would mean porting the audit.log chain logic from
`validate.js` / `validate.py`. Tracked as a parity gap — not a bug.

### JSON stdlib auto-install

The harness needs the `JSON` package (stdlib, but not loaded by default in
Julia 1.7+). On first run, `capture_julia.sh` creates a project env at
`~/.julia/environments/regrets` and runs `Pkg.add("JSON")` there. This is
a one-time cost (~5 seconds). Subsequent runs use the cached env.

To use a custom env (e.g. one that already has additional packages your
code needs), set `JULIA_PROJECT=/path/to/your/env` before invoking
`capture_julia.sh` / `validate_julia.sh`.

### Julia 1.11 API: `Base.string(n; base=36)` (not `Base.base`)

In older Julia (≤1.10), `Base.base(36, n)` produced a base36 string.
Julia 1.11 removed `Base.base` — the modern API is `Base.string(n; base=36)`.
The `fingerprint_julia.jl` module uses the modern form, so it requires
Julia 1.11+. (For older Julia, replace `Base.string(n; base=36)` with
`Base.base(36, n)`.)

### Why `deepClone` doesn't use JSON round-trip

`JSON.json(NaN)` throws by default (spec-compliant — JSON spec doesn't
allow NaN). The Julia adapter's `deepClone` works around this by replacing
non-finite floats with their sentinel strings (`__nan__`, `__infinity__`,
`__neg_infinity__`) before cloning. The clone is structurally identical to
the original for hashing purposes (because `stableStringify` emits those
same sentinels anyway).

### Trailing-zero bug avoided

The Nim adapter had a bug in its `toBase36` (stripped trailing zeros from
the SHA-256 hex hash, corrupting the BigInt value). See
`proof/nim_third_verify/README.md` Finding #1 for the full story. The
Julia adapter's `toBase36` strips **only leading zeros** (via regex
`r"^0+"`), avoiding the same trap.

## Future Work

- Implement `--update` mode (parity with JS/Python/Bash/Perl/C++).
- Add `--runs N` drift detection (parity with JS validate.js).
- Multi-input INPUTS contract (Issue #315 parity) — currently only the
  first input is captured.
- Callee wrapping (call-tracking via Julia's reflection / Cassette.jl) —
  not yet attempted; the Julia adapter has parity with Nim/PHP/Ruby which
  also don't do callee wrapping.

## Limitations

- Single-argument functions only. Multi-arg functions need a wrapper that
  takes a single tuple or JSON object. (Same limitation as the Nim adapter.)
- No closure/private function support. Only top-level functions can be
  captured. (Same as all other compiled-language adapters.)
- No callee wrapping. Only the entry function's output is fingerprinted —
  intermediate callees are not tracked. (Same as Nim/PHP/Ruby adapters.)

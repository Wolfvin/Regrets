# Nim Stack Support

This document describes how to use Regrets with [Nim](https://nim-lang.org/) source files.

## Overview

The Nim adapter follows the same architecture as the Ruby/PHP adapters (compiled-language
style), not the JS/Python ghost-proxy style. Nim is a statically-typed compiled language,
so we generate a per-cluster harness `.nim` file that `include`s your source code, calls
the entry proc with the captured input, and emits the input/output/hash triple on stdout
for the bash wrapper to parse.

### Files

| File | Purpose |
|------|---------|
| `scripts/fingerprint_nim.nim` | Shared module: `stableDumps`, `normalize`, `stripFields`, `toBase36`, `deepClone`, `fingerprint`, `extractSchema`. Same algorithm as `fingerprint.js` / `fingerprint.py` / `fingerprint_rb.rb`. Includes a clean-room FIPS 180-4 SHA-256 implementation (Nim 2.2.0 stdlib does not ship `std/sha256`). |
| `scripts/capture_nim.sh` | Bash wrapper: reads `manifest.json`, generates a per-cluster harness `.nim` file, compiles + runs it, writes the `.regret` file. |
| `scripts/validate_nim.sh` | Bash wrapper: reads each `.regret` file, regenerates the harness, re-runs, compares the new hash against the golden hash. Reports PASS/FAIL. Supports `--cluster`, `--runs N` (drift detection), `--update <id> --reason "..."`, `--fail-fast`. |
| `scripts/_nim_harness_gen.cjs` | Node helper called by both wrappers. Renders the per-cluster harness Nim source from the cluster JSON. |
| `scripts/_nim_regret_write.cjs` | Node helper called by `capture_nim.sh`. Writes the `.regret` file from the harness output. |
| `proof/nim_slugify/` | Working example with 2 clusters on a real URL-slug generator. Includes `run_demo.sh` that walks through baseline → valid refactor (PASS) → breaking refactor (FAIL). |

## Manifest Schema (Nim-specific)

```json
{
  "clusters": [{
    "id": "slugify",
    "entry": "slugify",
    "watches": ["slugify"],
    "file": "lib/slugify.nim",
    "stack": "nim",
    "fingerprintLevel": "entry",
    "inputs": ["Hello, World!", "Café résumé", ...]
  }]
}
```

### Required fields

- `id` — Unique cluster identifier (kebab-case OK; hyphens are sanitized to `_` in temp file names).
- `entry` — Top-level Nim proc symbol name (must be a valid Nim identifier; letters, digits, underscore; must start with letter or underscore).
- `file` — Path to source file (relative to project root). The file is `include`d into the harness, so **all symbols** (private or exported) become visible.
- `stack` — Must be `"nim"`.
- `inputs` — Array of test inputs. The first input is the golden contract (matches Ruby/PHP behavior). Other inputs are informational; they do not affect capture but are documented for human reviewers.

### How input type dispatch works

Nim is statically typed, but the manifest `inputs` field is JSON. The generated harness
uses a `template invokeEntry` with `compiles()` branches that try common conversions
in order:

1. `entry(inputNode.getStr())` — `string` input
2. `entry(inputNode.getInt())` — `int` / `BiggestInt` input
3. `entry(inputNode.getFloat())` — `float` / `float64` input
4. `entry(inputNode.getBool())` — `bool` input
5. `entry(inputNode.getElems().mapIt(it.getStr()))` — `seq[string]` input
6. `entry(inputNode.getElems().mapIt(it.getInt()))` — `seq[int]` input
7. `entry(inputNode.getElems().mapIt(it.getFloat()))` — `seq[float]` input
8. `entry(inputNode.getElems().mapIt(it.getBool()))` — `seq[bool]` input
9. `entry(inputNode)` — `JsonNode` input (fallback)

The first branch that compiles wins. If none match, you get a clear compile-time error.

### Multi-argument procs

Multi-argument procs (e.g. `proc add(a: int, b: int): int`) are not directly supported
by the type-dispatch template. For multi-arg procs, wrap them in a single-arg adapter:

```nim
proc addInternal(a: int, b: int): int = a + b

proc add*(input: JsonNode): JsonNode =
  %addInternal(input["a"].getInt(), input["b"].getInt())
```

Then capture `add` with object inputs like `{"a": 1, "b": 2}`.

## Source code conventions

Mark captured procs with `*` (exported) for clarity, though `include` exposes private
symbols too. Pure functions only — no I/O, no globals, no random. Same rules as other
stacks.

```nim
# lib/slugify.nim
import std/strutils

proc slugify*(text: string): string =
  result = text.toLowerAscii().replace(" ", "-")
```

## Commands

```bash
# Capture — generate .regret files for all Nim clusters in manifest
node scripts/regret.js capture
# or directly:
bash scripts/capture_nim.sh --manifest ./regrets/manifest.json

# Validate — re-run all clusters, compare against golden hashes
node scripts/regret.js validate
# or directly:
bash scripts/validate_nim.sh --manifest ./regrets/manifest.json

# Validate one cluster
bash scripts/validate_nim.sh --cluster slugify

# Drift detection (5 runs per cluster)
bash scripts/validate_nim.sh --runs 5

# Update a cluster's golden contract (writes audit.log entry)
bash scripts/validate_nim.sh --update slugify --reason "tax rate updated from 11% to 12%"

# Fail-fast (CI gate)
bash scripts/validate_nim.sh --fail-fast
```

## Cross-stack parity

The Nim adapter produces **byte-identical fingerprints** to JS, Python, PHP, and Ruby
for the same input/output pair. Verified by `proof/nim_slugify/PARITY.md` — 11 test
cases covering strings, empty strings, Unicode (Café résumé), and `seq[string]` arrays,
all matching the Python reference hashes.

This means a Nim cluster's `.regret` file is interchangeable with a Ruby cluster's
`.regret` file as long as the input/output JSON is identical.

## Environment

- Requires Nim 2.0+ on PATH (or set `NIM=/path/to/nim` env var).
- The harness is compiled with `nim c -d:release --path:$SCRIPT_DIR` so the `fingerprint_nim` module is importable.
- No external C dependencies (SHA-256 is implemented in pure Nim).

## Limitations

- **Single-arg procs only.** Multi-arg procs need a wrapper (see above).
- **No callee wrapping.** Like Ruby/PHP, the Nim adapter captures only the entry proc's input→output. Callee `.calls.*.regret` files (JS-only) are not generated.
- **First input is the golden contract.** Only the first entry in `inputs` is captured (matches Ruby/PHP behavior). Other inputs are documented in the manifest but not validated unless the user manually edits the `.regret` file's INPUT line.
- **No `fingerprintMode: schema` or `mixed` support yet.** The harness calls `fingerprint(inputNode, outputNode)` without mode flags. Add this if needed by extending `_nim_harness_gen.cjs`.

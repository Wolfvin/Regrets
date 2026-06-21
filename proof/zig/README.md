# Zig Stack Proof of Concept

This directory demonstrates the Regrets Zig stack end-to-end:
**capture → refactor → validate**. Three clusters cover the common
shapes: integer arithmetic (multi-arg), string formatting (multi-arg
with mixed types), and single-arg string transformation.

## Layout

```
proof/zig/
├── README.md                    ← this file
├── fingerprint_parity_check.js  ← JS reference fingerprints (for parity verification)
├── src/
│   └── example.zig              ← the Zig source under fingerprint
└── regrets/
    ├── manifest.json            ← cluster definitions
    ├── add.regret               ← captured (run capture_zig.sh to regenerate)
    ├── greet.regret
    └── title-case-words.regret
```

## Quick Start

```sh
# 1. Make sure zig 0.14+ is installed (ZIG_BIN if zig isn't on PATH).
#    Verified on Zig 0.16.0. Zig 0.13 and earlier are NOT compatible
#    (the runner template uses APIs that changed in 0.14+ — see
#    scripts/capture_zig.sh header for the full compatibility matrix).
zig version  # → 0.16.0 (or any 0.14+ version)

# 2. Capture fingerprints.
cd proof/zig
bash ../../scripts/capture_zig.sh
# → regrets/add.regret, regrets/greet.regret, regrets/title-case-words.regret

# 3. Validate (no code change → all PASS).
bash ../../scripts/validate_zig.sh
# → exit 0

# 4. Make a BREAKING refactor.
sed -i 's/a + b/a - b/' src/example.zig
bash ../../scripts/validate_zig.sh
# → exit 1, "❌ FAIL (0 pass, 1 fail)" for the add cluster

# 5. Make a VALID refactor (same input→output mapping).
sed -i 's/a - b/b + a/' src/example.zig   # commutative, same output
bash ../../scripts/validate_zig.sh
# → exit 0 (all PASS)
```

## Cluster Catalog

| Cluster ID | Function | Inputs | Notes |
|---|---|---|---|
| `add` | `add(a: i64, b: i64) i64` | `[1,2]`, `[10,20]`, `[0,0]`, `[-5,7]` | Integer arithmetic (multi-arg) |
| `greet` | `greet(allocator, name: []const u8, excited: bool) []u8` | `["world",true]`, `["world",false]`, `["",true]` | String formatting (allocator + multi-arg) |
| `title-case-words` | `titleCaseWords(allocator, input: []const u8) []u8` | `"hello world"`, `"the quick brown fox"`, `""` | Single-arg string transformation |

## Fingerprint Parity

The Zig fingerprint implementation produces IDENTICAL output to the JS
reference (`scripts/fingerprint.js`) for the same input→output pair.

Verified via `fingerprint_parity_check.js`:

| Label | Input | Output | JS hash | Zig hash |
|---|---|---|---|---|
| `add_int_1_2` | `[1,2]` | `3` | `63qoext` | `63qoext` ✓ |
| `add_int_10_20` | `[10,20]` | `30` | `560s4tf` | `560s4tf` ✓ |
| `add_int_0_0` | `[0,0]` | `0` | `536pw5k` | `536pw5k` ✓ |
| `add_int_neg` | `[-5,7]` | `2` | `41dkf14` | `41dkf14` ✓ |
| `greet_world_true` | `["world",true]` | `"Hello, world!"` | `pn5ngnw` | `pn5ngnw` ✓ |
| `greet_world_false` | `["world",false]` | `"Hello, world"` | `5e6bync` | `5e6bync` ✓ |
| `greet_empty_true` | `["",true]` | `"Hello, !"` | `389xxnc` | `389xxnc` ✓ |
| `tcw_hello` | `"hello world"` | `"Hello World"` | `4am2hvn` | `4am2hvn` ✓ |
| `tcw_fox` | `"the quick brown fox"` | `"The Quick Brown Fox"` | `511xzkf` | `511xzkf` ✓ |
| `tcw_empty` | `""` | `""` | `5oge4st` | `5oge4st` ✓ |

To regenerate the parity table:

```sh
node fingerprint_parity_check.js
```

## Architecture

The Zig stack follows the same architecture as the Kotlin stack (the
closest analog — both are compiled languages with a runtime that
needs to invoke arbitrary user functions):

1. **`capture_zig.sh`** reads the manifest, filters `stack: "zig"`
   clusters, and for each cluster:
   - Generates a shared runner library (`regret_runner.zig`) containing
     the `Value` type, `stableStringify`, `fingerprint`, and JSON spec
     parsing. This file is identical across all clusters.
   - Copies the user's source file into the build dir as `user_source.zig`
     (Zig 0.13's `@import` doesn't allow paths outside the main module's
     directory tree).
   - Generates a per-cluster `main_<id>.zig` that `@import`s both the
     runner lib and the user source, and defines a `regret_entry`
     wrapper that coerces the runtime `Value` input → native Zig args,
     calls the user's `pub fn` (by comptime-known name via `@field`),
     and packs the return value back into a `Value`.
   - Compiles + runs the main, feeds the invocation spec (JSON) via
     stdin, captures stdout (INPUT/OUTPUT/HASH lines), and writes the
     `.regret` file.

2. **`validate_zig.sh`** reads each `.regret` file, regenerates the
   same runner + per-cluster main, re-runs each function with the
   stored INPUT, recomputes the hash, and compares to the stored HASH.
   Reports PASS/FAIL per input and exits 0/1.

The runner is shared between capture and validate via the
`--emit-runner` hidden flag — `validate_zig.sh` calls
`capture_zig.sh --emit-runner` to extract the runner heredoc, ensuring
the fingerprint computation cannot drift between the two scripts.

## Limitations / Roadmap

- **Single-arg and 2-arg functions only.** The per-cluster main
  supports arities 1 and 2 (plus 3 when the first arg is an
  allocator). Higher arities require extending the `callThree`/
  `callFour` dispatch in the wrapper. Tracked as a future improvement.
- **No callee wrapping.** The JS/Python stacks support callee
  contracts (re-validating functions called by the entry function).
  The Zig stack does not yet implement this — it's a Community Preview.
- **No `--update` flag.** Use `capture_zig.sh` to re-capture when the
  contract intentionally changes.
- **First input only stored as golden.** Multi-input clusters only
  store input[0]'s hash in the `.regret` file (same as Kotlin). Inputs
  2+ are re-derived and reported as INFO during validate (no stored
  hash to compare against). Future work: add an `INPUTS` line for
  multi-input parent contracts (matching the JS stack's issue #315).

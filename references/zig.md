# Zig Stack — Regrets Reference

This document describes the Regrets Zig stack: how to install it, configure
clusters, run capture + validate, and the architecture of the runner.

## Installation

### Requirements

- **Zig 0.16.0+** on `PATH` or at `$ZIG_BIN`. The repo pins this version
  via a `.zigversion` file at the root. Older versions (0.14 and 0.15)
  are partially compatible but untested; 0.13 and earlier are **NOT
  compatible**.

  Zig 0.16 overhauled the I/O API (internally called the "Writergate"
  refactor). The runner template relies on:
  - `std.Io.File.stdout()` / `stderr()` / `stdin()` — cross-platform
    replacements for the removed `std.io.getStdOut()` family.
  - `file.writeStreamingAll(io, bytes)` and `file.readStreaming(io, ...)`
    — every I/O operation now takes a `std.Io` instance (created via
    `std.Io.Threaded.init(allocator, .{})`). The `Threaded` backend
    picks the optimal implementation per OS at runtime: io_uring on
    Linux, kqueue on macOS/BSDs, IOCP on Windows. This is what makes
    the same compiled runner work on both Windows and Linux — earlier
    attempts used `std.os.linux.read/write` directly, which silently
    broke on Windows (see issue #531).
  - `std.heap.DebugAllocator` (replaces `GeneralPurposeAllocator`,
    removed in 0.14).
  - `std.StringArrayHashMapUnmanaged` (replaces the managed variant,
    changed in 0.14).
  - `std.ArrayList(T) = .empty` + allocator-passing methods (replaces
    `.init(allocator)`, changed in 0.14).
  - `@typeInfo(T).@"fn"` (renamed from `.Fn` in 0.14 because `fn`
    became a reserved keyword).

  Install from <https://ziglang.org/download/>. On Windows, `winget
  install Zig.Zig` is the easiest path.

- **Node.js 16+** on `PATH` (used for manifest JSON parsing — bash can't
  parse JSON natively).

### Verify installation

```sh
zig version   # → 0.16.0 (or any 0.16+ version)
node --version  # → v16+ (or higher)
```

## Manifest Schema

Add a cluster with `"stack": "zig"` to your `regrets/manifest.json`:

```json
{
  "clusters": [
    {
      "id": "add",
      "entry": "add",
      "file": "src/math.zig",
      "stack": "zig",
      "fingerprintLevel": "entry",
      "multiArgs": true,
      "inputs": [
        [1, 2],
        [10, 20],
        [-5, 7]
      ]
    }
  ]
}
```

### Field reference

| Field | Required | Description |
|---|---|---|
| `id` | ✓ | Cluster identifier (used as the `.regret` filename). |
| `entry` | ✓ | The `pub fn` name in the source file to invoke. |
| `file` | ✓ | Path to the `.zig` source file (relative to the project root). |
| `stack` | ✓ | Must be `"zig"`. |
| `fingerprintLevel` | ✓ | Must be `"entry"` (only entry-level fingerprinting is supported). |
| `multiArgs` | — | `true` if each input is an array of args; `false` (default) if each input is a single value. |
| `inputs` | ✓ | Array of inputs. Each input is either a single value (when `multiArgs=false`) or an array of args (when `multiArgs=true`). |

## CLI Usage

### Capture

```sh
bash scripts/capture_zig.sh                 # capture all Zig clusters
bash scripts/capture_zig.sh --cluster add   # capture one cluster
bash scripts/capture_zig.sh --manifest ./regrets/manifest.json
bash scripts/capture_zig.sh --quiet         # only print summary line
bash scripts/capture_zig.sh --verbose       # print extra detail (build dir, runner output)
```

### Validate

```sh
bash scripts/validate_zig.sh                 # validate all Zig clusters
bash scripts/validate_zig.sh --cluster add   # validate one cluster
bash scripts/validate_zig.sh --quiet
bash scripts/validate_zig.sh --verbose
```

**Exit codes (validate):**
- `0` — all clusters PASS
- `1` — at least one cluster FAILed (hash mismatch or runtime error)
- `2` — environment error (zig/node missing, manifest not found)

## Supported Function Signatures

The per-cluster wrapper auto-detects the function's arity and arg types
via `@typeInfo(@TypeOf(user.fn)).@"fn".params` (the `.@"fn"` tag was
named `.Fn` in Zig 0.13 and earlier — renamed in 0.14+ because `fn`
became a reserved keyword).

Currently supported (extended in this PR to cover red-team patterns):

| Signature | Example | Notes |
|---|---|---|
| `(a: i64, b: i64) i64` | `add(a, b)` | Integer arithmetic — original |
| `(allocator, name: []const u8, excited: bool) []u8` | `greet(alloc, name, excited)` | Allocator + 2 args — original |
| `(allocator, input: []const u8) []u8` | `titleCaseWords(alloc, input)` | Allocator + 1 arg — original |
| `(input: []const u8) []u8` | (future) | No-allocator 1-arg |
| `(a: i64) i64` | (future) | Single integer arg → integer |
| `(a: i64) bool` | `isEven(n)` | **NEW** — int → bool (red-team) |
| `(input: []const u8) i64` | `countWords(s)` | **NEW** — string → int, no error union (red-team) |
| `(allocator, []const u8, i64) []u8` | `repeat(alloc, s, n)` | **NEW** — 3-arg with i64 third param (red-team) |
| `(i64, i64) !i64` | `safeMul(a, b)` | **NEW** — error union auto-detected via `@typeInfo` (red-team) |

### Error union auto-detection

The wrapper inspects `@typeInfo(return_type)` at comptime. If the return
is `.error_union`, the wrapper uses `try @call(...)`; otherwise it uses a
plain `@call(...)`. This means functions like `countWords` (plain `i64`
return) and `safeMul` (`!i64` return) both work without manifest changes.

### Unsupported

- Arity > 3 (the wrapper's `callThree` is a stub).
- Functions returning struct/array/enum types. Future work: extend the
  wrapper to handle more return types via `@typeInfo` dispatch.
- Methods (functions on structs). Future work: add a `method` field to
  the manifest and generate a wrapper that instantiates the struct.

## Fingerprint Algorithm

The Zig fingerprint is byte-for-byte identical to the JS/Python/Kotlin/Go/Rust
implementations:

```
fingerprint(input, output) =
  sha256(stableStringify(input) + "|" + stableStringify(output))
    → base36 → first 7 chars
```

`stableStringify` produces deterministic JSON with sorted keys, matching
the JS `stableStringify()` / Python `stable_dumps()` / Kotlin
`stableStringify()` implementations byte-for-byte.

### Parity verification

```sh
cd proof/zig
node fingerprint_parity_check.js   # prints JS reference fingerprints
bash ../../scripts/capture_zig.sh  # captures Zig fingerprints
# Compare the HASH lines in regrets/*.regret to the JS reference.
```

## .regret File Format

Identical to all other stacks:

```
cluster: <id>
version: 1
fingerprint: <7-char base36>
captured: <ISO timestamp>
watches: [<entry>]
entry: <entry>
stack: zig
fingerprintLevel: entry
multiArgs: <true|false>
env: {"zig_version":"0.16.0"}
---
INPUT  <stable-stringified input>
OUTPUT <stable-stringified output>
HASH   <7-char base36>
```

## Red-team fixture

`proof/zig_redteam/` exercises patterns NOT covered by `proof/zig/`:

- `i64 → bool` (isEven) — different return type than any proof/zig cluster
- `[]const u8 → i64` (countWords) — string in, int out, NO error union
- `(allocator, []const u8, i64) → []u8` (repeat) — 3-arg with i64 third param
- `(i64, i64) → !i64` (safeMul) — error union (auto-detected via `@typeInfo`)

Run: `bash proof/zig_redteam/run_demo.sh` (3 phases: baseline → valid
refactor → breaking refactor).

These patterns exposed real gaps in the original wrapper template that
this PR fixes (error union auto-detection, i64→bool, []const u8→i64,
3-arg with i64).

### Shared runner (`regret_runner.zig`)

Generated by `capture_zig.sh` (extracted via `--emit-runner` for
`validate_zig.sh`). Contains:

- `Value` — JSON-like sum type (null, bool, int, float, string, array, object).
- `stableStringify` — port of `scripts/fingerprint.js`'s `stableStringify`.
- `fingerprint` — port of `scripts/fingerprint.js`'s `fingerprint`.
- `parseSpec` — parses the JSON invocation spec from stdin.
- `run(comptime UserSource)` — main loop: reads spec, invokes
  `UserSource.regret_entry(allocator, input)` per input, emits
  INPUT/OUTPUT/HASH lines, and (in validate mode) RESULT PASS/FAIL.

### Per-cluster main (`main_<id>.zig`)

Generated per cluster. `@import`s the shared runner and the user's
source (copied to `user_source.zig` in the build dir). Defines:

- `regret_entry(allocator, input: Value) !Value` — coerces the runtime
  `Value` input → native Zig args, calls the user's `pub fn` (by
  comptime-known name via `@field`), and packs the return value back
  into a `Value`.
- `main()` — calls `regret.run(@This())`.

### Build directory (`.regret-zig-build/`)

Created at capture/validate time, contains:

- `regret_runner.zig` — shared runner lib.
- `user_source.zig` — copy of the user's source file (Zig 0.13's
  `@import` doesn't allow paths outside the main module's directory tree).
- `main_<id>.zig` — per-cluster main.
- `spec_<id>.json` — invocation spec fed to the runner via stdin.
- `zig.err` — stderr from the last `zig run` invocation (kept on `--verbose`).

Cleaned up automatically unless `--verbose` is passed.

## Troubleshooting

### `error: import of file outside module path`

Zig 0.13's `@import` doesn't allow paths outside the main module's
directory tree. The capture script copies the user's source into the
build dir as `user_source.zig` to work around this. If you see this
error, make sure the `file` field in your manifest is a relative path
from the project root (not an absolute path or a path with `..`).

### `error: no field named 'Fn' in union 'builtin.Type'`

Zig 0.14+ renamed the `@typeInfo` tag from `.Fn` to `.@"fn"` (because
`fn` became a reserved keyword). The wrapper template in this PR uses
`.@"fn"` — if you see this error, you're running a wrapper generated by
an older version of `capture_zig.sh` that used `.Fn`. Re-run capture to
regenerate.

### `error: root source file struct 'heap' has no member named 'GeneralPurposeAllocator'`

Zig 0.14+ replaced `std.heap.GeneralPurposeAllocator` with
`std.heap.DebugAllocator`. The runner template in this PR uses
`DebugAllocator` — if you see this error, you're running a runner
generated by an older version of `capture_zig.sh`. Re-run capture to
regenerate.

### `error: no field or member function named 'writeAll' in 'Io.File'`

Zig 0.16 reworked the I/O API. The runner template uses
`std.Io.File.stdout() / .stderr() / .stdin()` +
`file.writeStreamingAll(io, bytes)` + `file.readStreaming(io, ...)`
through a `std.Io.Threaded` instance — these are the cross-platform
entry points added by the Writergate refactor. If you see this error,
you're running a runner generated by an older version of
`capture_zig.sh` that used the removed `std.io.getStdOut().writer()`
API. Re-run capture to regenerate the runner.

### `StreamTooLong` abort during capture (Windows)

Symptom: `capture_zig.sh` on Windows spins reading stdin until the
16 MB cap is hit, then aborts with `error.StreamTooLong`.

Root cause: an earlier version of the runner template used
`std.os.linux.read(0, ...)` and `std.os.linux.write(1, ...)` directly.
On Linux these are the actual syscalls and they work; on Windows
`std.os.linux` is a Linux-target-only namespace — calls into it return
bogus values or never signal EOF, so the read loop never terminates.

Fix: this is issue #531. The runner template now uses the Zig 0.16
`std.Io` API (see "Requirements" above), which is cross-platform. Make
sure your `capture_zig.sh` is from this branch (`fix/zig-windows-531`)
or later, then re-run capture to regenerate the runner.

### `error: root source file struct 'fs' has no member named 'File'`

You're seeing the Writergate removal of `std.fs.File` from Zig 0.16.
`File` now lives at `std.Io.File`. The runner template already uses the
new path — if you see this, your `capture_zig.sh` predates the fix.
Re-run capture to regenerate the runner.

### `UnsupportedSignature` error

The per-cluster wrapper doesn't recognize the function's signature.
Check the [Supported Function Signatures](#supported-function-signatures)
table. If your signature isn't listed, you'll need to extend the
wrapper's `callOne`/`callTwo`/`callThree` dispatch (in
`scripts/capture_zig.sh`'s per-cluster main heredoc).

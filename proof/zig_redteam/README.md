# Zig Red-Team Fixture — `proof/zig_redteam/`

This fixture exercises patterns **NOT covered by `proof/zig/`** to guard
against confirmation bias (per `CONTEXT.md → Lesson Learned`).

## Patterns verified

| Cluster | Entry fn | Input type | Output type | Notes |
|---------|----------|------------|-------------|-------|
| `is-even` | `isEven(n: i64) bool` | `i64` | `bool` | Different return type than any proof/zig cluster (which only has `i64` and `[]u8` returns). Exposed a gap: original wrapper only handled `(i64) → i64`, not `(i64) → bool`. |
| `count-words` | `countWords(input: []const u8) i64` | `[]const u8` | `i64` | String in, int out, NO error union. Exposed a gap: original wrapper used `try @call(...)` unconditionally, which fails to compile for non-error-union returns. |
| `repeat` | `repeat(allocator, s: []const u8, n: i64) ![]u8` | `(allocator, []const u8, i64)` | `[]u8` | 3-arg with `i64` third param. Original wrapper only handled `(allocator, []const u8, bool) → []u8`. |
| `safe-mul` | `safeMul(a: i64, b: i64) !i64` | `(i64, i64)` | `!i64` | Error union return. Exposed a gap: original wrapper assumed `(i64, i64) → i64` (no error), so `try` failed to compile. |

## Why these patterns

The original `proof/zig/src/example.zig` only exercises:
- `(i64, i64) → i64` (add)
- `(allocator, []const u8, bool) → []u8` (greet)
- `(allocator, []const u8) → []u8` (titleCaseWords)

The wrapper's `@typeInfo(@TypeOf(...)).@"fn".params` dispatch tree has many
more branches that were never exercised. The red-team fixture probes 4 more
branches and exposed real gaps in the wrapper template:

1. **`i64 → bool`** — original wrapper assumed `(i64) → i64` only.
2. **`[]const u8 → i64` (no error union)** — original wrapper used `try`
   unconditionally, which fails for non-error-union returns.
3. **`(allocator, []const u8, i64) → []u8`** — original wrapper only handled
   `bool` as the third param.
4. **`(i64, i64) → !i64`** — original wrapper assumed `(i64, i64) → i64`
   (no error), so `try` failed to compile.

The fix: extended the wrapper to dispatch on return type at comptime via
`@typeInfo(PayloadTy)`, and auto-detect error union returns via
`@typeInfo(return_type) == .error_union` — using `try @call` when true,
plain `@call` otherwise.

## Running

```bash
# From repo root, with Zig 0.14+ on PATH
bash proof/zig_redteam/run_demo.sh
```

The demo walks through three phases:

1. **Phase 0 — Baseline**: capture + validate all 4 clusters. Must PASS.
2. **Phase 1 — VALID refactor**: rename internal vars only (`count → tally`,
   `in_word → word_start`). Output for every input is unchanged. Must PASS.
3. **Phase 2 — BREAKING refactor**: change `isEven` from `@mod(n, 2) == 0`
   (even) to `@mod(n, 2) == 1` (odd). For input `4`, output flips from
   `true` to `false` → fingerprint changes → validate MUST FAIL on `is-even`
   only. The other 3 clusters stay green.

### Subtle red-team finding during development

My first BREAKING refactor attempt was `isEven(n) → n > 0`. This *should*
have failed validate, but it didn't — because input[0] for `is-even` is `4`,
and both `@mod(4, 2) == 0` and `4 > 0` return `true`. The fingerprint was
unchanged.

This is actually a documented limitation of the Zig stack (per the PR #420
known limitations): "First input only stored as golden in .regret file."
Only `inputs[0]` is captured as the golden contract, so a refactor that
changes behavior for inputs 1+ but not input[0] won't be detected.

I updated the demo to use a refactor that flips output[0] specifically. This
is a real limitation worth documenting for future workers — multi-input
parity with JS (#315) is a separate concern.

## Cross-stack parity

The `safe-mul` cluster's hash `1udz6ou` (input `[3, 4]` → output `12`) is
computable on any Regrets-supported stack — same
`sha256(stableStringify(input) + "|" + stableStringify(output))` → base36
→ first 7 chars algorithm. The JSON serialization is identical across
stacks.

## Files

- `src/redteam.zig` — source file with 4 exported `pub fn`s.
- `regrets/manifest.json` — 4 cluster definitions.
- `regrets/*.regret` — generated golden contracts.
- `run_demo.sh` — orchestrates the 3-phase verification.

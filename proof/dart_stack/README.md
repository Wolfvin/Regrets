# Dart Stack — Regrets Example

This directory contains a working example of the **Dart stack** for the Regrets
output-fingerprint regression testing tool. It demonstrates the full
capture → validate lifecycle on real (non-synthetic) Dart utility functions.

## Files

| File | Purpose |
|---|---|
| `string_utils.dart` | Real Dart utility functions: `snakeCase`, `isEmail`, `formatThousands`, `levenshtein`. Pure functions, no side effects — ideal fingerprint targets. |
| `manifest.json` | Regrets manifest with 4 clusters (one per function), each declaring its `inputs[]`. |
| `example_output/` | Sample `.regret` files showing the exact output format that `capture_dart.sh` produces. |
| `README.md` | This file. |

## Prerequisites

Dart SDK 3.0+ must be on `PATH`. Install from <https://dart.dev/get-dart>.

```bash
dart --version  # Dart SDK version: 3.12.2 (stable) ...
```

## Running the Example

From the **repo root** (so `regrets/manifest.json` resolves correctly):

```bash
# 1. Copy the example manifest into the regrets/ runtime dir
mkdir -p regrets
cp proof/dart_stack/manifest.json regrets/manifest.json

# 2. Capture — invoke each function with its inputs, write .regret files
bash scripts/capture_dart.sh
# Expected: 21 .regret files written to regrets/*.regret

# 3. Validate — re-invoke functions, compare hashes
bash scripts/validate_dart.sh
# Expected: 21 passed, 0 failed
```

## Demonstrating the Contract

### Valid refactor → all PASS

Rename an internal variable (no behavior change):

```bash
# In proof/dart_stack/string_utils.dart, rename `buf` → `buffer` in snakeCase()
# (single find-and-replace on the variable name; output stays "hello_world")
sed -i 's/\bbuf\b/buffer/g' proof/dart_stack/string_utils.dart

bash scripts/validate_dart.sh
# Expected: 21 passed, 0 failed  — the contract is preserved
```

### Breaking refactor → FAIL with diff

Change the separator from `_` to `-` (output changes):

```bash
# In proof/dart_stack/string_utils.dart, snakeCase now writes '-' instead of '_'
sed -i "s/buf.write('_');/buf.write('-');/g" proof/dart_stack/string_utils.dart

bash scripts/validate_dart.sh
# Expected: 5/6 snake-case.*.regret FAIL with clear diff:
#   ❌ FAIL  snake-case.input0.regret
#      expected out:   "hello_world"
#      actual out:     "hello-world"
#   (input4 still PASSes because input "" → output "" is unchanged)
```

### Legitimate behavior change → `--update`

When the contract legitimately changes (e.g., a new style guide mandates
hyphens), use `--update` to re-capture the new golden:

```bash
bash scripts/validate_dart.sh \
  --update snake-case \
  --reason "snakeCase separator changed from underscore to hyphen per new style guide"

# This re-runs capture_dart.sh for the snake-case cluster and writes an entry
# to regrets/audit.log documenting the change.
```

## Cross-Stack Fingerprint Consistency

The Dart fingerprint implementation is **byte-for-byte identical** to the JS
and Python implementations — the same `(input, output)` pair produces the same
7-char base36 hash regardless of which stack captured it. Verify with:

```bash
node scripts/_dart_cross_stack_check.mjs
# Expected: 4/4 cases match — JS hash equals Dart hash for the same (input, output)
```

This means a `.regret` file captured by `capture_dart.sh` is parseable by
`scripts/validate.js` (the JS validator), and vice versa. The contract is
portable across stacks.

## .regret File Format

Each `.regret` file matches the standard Regrets format (compatible with
`scripts/validate.js` `parseRegret()`):

```
cluster: snake-case
version: 1
fingerprint: 69495z4
captured: 2026-06-21T05:02:24.629Z
watches: [snakeCase]
entry: snakeCase
stack: dart
fingerprintLevel: entry
---
INPUT  "HelloWorld"
OUTPUT "hello_world"
HASH   69495z4
```

For multi-arg functions (`multiArgs: true` in the manifest), `INPUT` is a
JSON array of positional arguments:

```
INPUT  ["kitten","sitting"]
OUTPUT 3
HASH   tu16lpe
```

## Architecture

```
scripts/fingerprint_dart.dart    — stableStringify + sha256 → base36 → 7 chars
                                   (identical algorithm to fingerprint.js / .py / .go)
scripts/capture_dart.sh          — shell orchestrator: reads manifest, generates
                                   per-cluster Dart runner, writes .regret files
scripts/validate_dart.sh         — shell orchestrator: reads .regret, re-runs
                                   function, compares hash, reports PASS/FAIL
                                   + --update flow + --fail-fast + --quiet
scripts/_dart_capture_gen.cjs    — Node helper: generates the per-cluster
                                   capture runner .dart file from cluster JSON
scripts/_dart_validate_gen.cjs   — Node helper: generates the per-cluster
                                   validate runner .dart file from regret JSON
scripts/_dart_cross_stack_check.mjs — verification: JS hash == Dart hash
                                       for the same (input, output)
```

The runner generation happens in Node (rather than Bash heredocs) to avoid
shell interpolation issues with Dart's `${...}` syntax. The actual fingerprint
computation happens in pure Dart (`fingerprint_dart.dart`), not in JS — this
keeps the cross-stack contract honest (each stack computes its own hash using
its own implementation of the same algorithm).

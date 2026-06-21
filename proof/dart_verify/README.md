# Dart Stack — Independent Verification (PR #405)

This directory contains an **independent verification** of the Dart stack support
shipped in PR #405 (`feat/dart-stack-consolidated`). It was produced by a
**different worker session** than the one that wrote PR #405, on a **fresh set
of Dart functions** that deliberately exercise different idioms than PR #405's
own fixtures.

## Why this verification exists

CONTEXT.md's "Lesson Learned" explicitly warns:

> Test count tinggi (388-512 tests) TIDAK menjamin fitur benar-benar bekerja —
> red team menemukan callee wrapping GAGAL untuk pattern paling umum meski
> semua unit test pass, karena test ditulis dengan pattern yang sama dengan
> implementasi (confirmation bias).

PR #405 ships 4 fixture functions (`snakeCase`, `isEmail`, `formatThousands`,
`levenshtein`) authored by **the same worker** who wrote `capture_dart.sh`,
`validate_dart.sh`, and `fingerprint_dart.dart`. That is exactly the
confirmation-bias trap. This verification re-runs the contract using **5
different** Dart functions, each exercising a different Dart idiom.

## What was verified

| # | Verification step | Result |
|---|---|---|
| 1 | Prerequisites (Dart SDK 3.5.3, Node 24.15) | ✅ |
| 2 | v2 manifest installed (5 clusters, 25 inputs) | ✅ |
| 3 | `bash scripts/capture_dart.sh` writes 25 `.regret` files | ✅ |
| 4 | `bash scripts/validate_dart.sh` baseline → 25/25 PASS | ✅ |
| 5 | Cross-stack fingerprint parity: JS hash == Dart hash for all 25 cases | ✅ |
| 6 | Cross-tool `.regret` parseability: JS `parseRegret()` reads all 25 Dart-written files | ✅ |
| 7 | `npm test` still passes (no regression in JS-side test suite) | ✅ |
| 8 | Valid refactor (`buf` → `buffer` rename in slugify) → 25/25 PASS (contract preserved) | ✅ |
| 9 | Breaking refactor (separator `'-'` → `'_'` in slugify) → exit 1, 4/5 slug-case FAILs with diff | ✅ |
| 10 | `--update slugify --reason "..."` → re-captures + writes `audit.log` entry + post-update validate 25/25 PASS | ✅ |

**Final tag: `[REVIEW]`** — first-time independent verification. Per the v2
worker protocol, `[SUCCESS]` is reserved for revisions after review feedback
where all points have been addressed. This is my first submission, so it goes
to `[REVIEW]`.

## Fresh fixtures (proof/dart_verify/string_utils_v2.dart)

| Function | Dart idiom exercised | Different from PR #405's… |
|---|---|---|
| `slugify(String) → String` | ASCII filtering + char joining (no regex) | `snakeCase` (which uses regex-like char class checks) |
| `caesarCipher(String, int) → String` | Multi-arg, char rotation, supports negative shifts | (no multi-arg string function in PR #405's set) |
| `crc16(String) → int` | Manual table-driven checksum (no `dart:io`, no `package:crypto`) | (no manual crypto in PR #405's set) |
| `isValidIPv4(String) → bool` | Split + range check + leading-zero rejection | `isEmail` (which uses `RegExp`) |
| `countVowels(String) → int` | Simple loop + counter, edge case: empty string | (no plain counter in PR #405's set) |

These functions were chosen to cover input/output type combinations PR #405's
fixtures don't:
- `(String, int)` return type (crc16, countVowels)
- `(String, bool)` return type (isValidIPv4)
- `(String, int) → String` multiArgs (caesarCipher) — exercises `multiArgs: true` manifest field
- Empty-string edge case for both string-transform and counter functions

## How to reproduce

### Automated verification (safe subset)

```bash
# From repo root, with Dart SDK 3.0+ and Node 16+ on PATH
bash proof/dart_verify/run-verify.sh
```

This runs steps 1–7 above. Steps 8–10 (breaking refactor + `--update`) mutate
the source file, so they are intentionally NOT in `run-verify.sh` — see
"Manual breaking-refactor test" below for the commands.

### Manual breaking-refactor + --update test

```bash
# From repo root, with v2 manifest already installed at regrets/manifest.json
cp proof/dart_verify/string_utils_v2.dart /tmp/v2_fixture.bak

# Apply breaking refactor: change slugify separator from '-' to '_'
sed -i "s/buf.write('-');/buf.write('_');/g" proof/dart_verify/string_utils_v2.dart

# Validate — should FAIL with exit 1 (4 of 5 slugify inputs change output)
bash scripts/validate_dart.sh
# Expected: "📊 Dart validate: 21 passed, 4 failed, 0 updated" + exit 1
# The 5th slugify input (empty string → empty string) is unchanged → still PASS.

# Use --update to re-capture the new golden + write audit.log entry
bash scripts/validate_dart.sh \
  --update slugify \
  --reason "slugify separator changed from hyphen to underscore per new style guide"
# Expected: exit 0, "📊 Dart validate: 24 passed, 0 failed, 1 updated"
# + regrets/audit.log now contains an entry documenting the change.

# Post-update validate — should be all PASS (new golden matches new behavior)
bash scripts/validate_dart.sh
# Expected: exit 0, "📊 Dart validate: 25 passed, 0 failed, 0 updated"

# Restore the original fixture
cp /tmp/v2_fixture.bak proof/dart_verify/string_utils_v2.dart
rm /tmp/v2_fixture.bak

# Re-capture original baseline
bash scripts/capture_dart.sh
```

### Cross-stack fingerprint parity

```bash
# After capture_dart.sh has been run with the v2 manifest
node proof/dart_verify/cross_stack_parity_v2.mjs
# Expected: 25/25 MATCH — JS hash == Dart hash for all v2 cases.
```

This script reads each `.regret` file produced by `capture_dart.sh`, extracts
the `(input, output, dartHash)` triple, recomputes the hash in JS using
`scripts/fingerprint.js`, and asserts the two match. The contract holds iff
the underlying hash algorithm (`sha256(stableStringify(input) + '|' + stableStringify(output)) → base36 → first 7 chars`)
is byte-for-byte identical across stacks.

## .regret file format compatibility

The 25 `.regret` files produced by `capture_dart.sh` (Dart) were all
successfully parsed by `scripts/validate.js` `parseRegret()` (JS). All required
fields are present and correctly typed:

```
cluster: slugify
version: 1
fingerprint: 4ul4793
captured: 2026-06-21T06:42:13.123Z
watches: [slugify]
entry: slugify
stack: dart
fingerprintLevel: entry
---
INPUT  "Hello, World!"
OUTPUT "hello-world"
HASH   4ul4793
```

A new test file `tests/dart-stack.test.js` (added in this verification PR)
runs as part of `npm test` and verifies this compatibility without requiring
the Dart SDK to be installed — it tests against the committed sample `.regret`
files in `proof/dart_stack/example_output/`. This locks in the cross-stack
contract so future changes to either `fingerprint.js` or `fingerprint_dart.dart`
that break parity will be caught by CI.

## Test count delta

- Before this verification PR: 807 tests (per PR #405's description)
- After this verification PR: 850 tests (+43 new tests in `tests/dart-stack.test.js`)
- All 850 pass — no regression in existing tests.

The 43 new tests break down as:
- 7 `.regret` sample files × 5 assertions each = 35 tests (parseable, has all fields, INPUT/OUTPUT/HASH present, JS hash matches stored HASH, top-level `fingerprint` field matches `HASH`)
- 4 synthetic fingerprint parity cases (same as `scripts/_dart_cross_stack_check.mjs`)
- 3 script-existence tests (capture_dart.sh, validate_dart.sh, fingerprint_dart.dart all exist with expected content)

## Findings

### Confirmed working

1. **`capture_dart.sh` correctly reads `regrets/manifest.json`** and generates
   per-cluster Dart runners via `_dart_capture_gen.cjs`. The generated runners
   import the user's target file and the `fingerprint_dart.dart` helper, invoke
   the entry function with each declared input, and emit a JSON array of
   `{input, output, hash}` results to stdout.

2. **`validate_dart.sh` correctly re-invokes the entry function** with the
   recorded INPUT, recomputes the hash, and reports PASS/FAIL with a clear
   diff (expected vs actual hash AND expected vs actual output). Exit code is
   non-zero on any FAIL.

3. **The fingerprint algorithm is byte-for-byte identical across stacks.**
   For all 25 v2 fixture cases, `fingerprint.js` (JS) and
   `fingerprint_dart.dart` (Dart) produce the same 7-char base36 hash for the
   same `(input, output)` pair. This means a `.regret` file captured by Dart
   is validatable by JS, and vice versa.

4. **The trivial-output guard works.** Empty-string → empty-string outputs are
   NOT skipped (they're non-null and non-NaN). Null/NaN/Infinity outputs would
   be skipped per the guard. (Not directly tested in v2 fixtures because none
   of my functions produce null/NaN/Infinity — but the code path is visible
   in `_dart_capture_gen.cjs` lines 73–81.)

5. **`--update` flow works end-to-end.** It re-runs `capture_dart.sh` for the
   specified cluster, writes new golden hashes, AND writes an entry to
   `regrets/audit.log` with timestamp, cluster name, reason, and updater.
   Post-update validate is all PASS (new golden matches new behavior).

6. **`multiArgs: true` manifest field works.** `caesarCipher(input, shift)`
   was correctly invoked with two positional arguments for all 5 declared
   inputs (including the negative-shift case).

7. **npm test still passes** (807 → 850 tests, +43 from new dart-stack test).

### Limitations observed (not blocking — documented for future work)

1. **`validate_dart.sh` does NOT support `--cluster` filtering when the .regret
   file's cluster is not in the current manifest.** When I had leftover
   `snake-case.*.regret` files from PR #405's fixtures but the v2 manifest
   didn't include a `snake-case` cluster, validate emitted "Cluster snake-case
   not found in manifest" warnings to stderr (and skipped those files). The
   exit code was still 0 (because the warnings were on stderr and the
   in-manifest files all PASSed). This is graceful but a bit noisy — a future
   improvement could be to auto-skip .regret files whose cluster is not in the
   manifest without printing a warning (since this is a valid scenario when
   switching between fixtures).

2. **No `--runs N` drift detection** (PR #401 had this; PR #405 dropped it).
   PR #405's `validate_dart.sh` does not re-run clusters N times to detect
   non-determinism. This is a regression vs. PR #401, but PR #405 is the
   consolidation winner because it has better cross-stack parity. If drift
   detection is needed, it should be added as a separate enhancement.

3. **`Function.apply` in `_dart_validate_gen.cjs`** sidesteps Dart 3's strict
   type-checking by always wrapping input in a one-element list. This works
   for all current v2 fixtures but might fail for functions with required
   named parameters or factory constructors. Not tested (no such function in
   v2 fixtures) — document as a known limitation if encountered.

## Files added in this verification PR

| File | Purpose |
|---|---|
| `proof/dart_verify/string_utils_v2.dart` | 5 FRESH Dart functions for independent verification |
| `proof/dart_verify/manifest.json` | Manifest with 5 clusters (one per function), 25 inputs total |
| `proof/dart_verify/cross_stack_parity_v2.mjs` | JS hash == Dart hash verifier for all 25 v2 cases |
| `proof/dart_verify/run-verify.sh` | Safe-subset verification script (steps 1–7) |
| `proof/dart_verify/README.md` | This file |
| `tests/dart-stack.test.js` | Node test (43 tests) for .regret format compatibility — runs in `npm test` |

## Logs

The `run-verify.sh` script writes logs to `proof/dart_verify/*.log`:
- `capture.log` — capture_dart.sh output
- `validate_baseline.log` — baseline validate_dart.sh output
- `cross_stack.log` — cross_stack_parity_v2.mjs output
- `cross_tool.log` — JS parseRegret() cross-tool test output
- `npm_test.log` — npm test output

These logs are gitignored (see `.gitignore`) because they contain absolute paths
and timestamps that would create noisy diffs. Re-run `run-verify.sh` to
regenerate them locally.

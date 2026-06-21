# Independent Verification Report — Scala Stack (PR #461 + Issue #387)

**Worker:** Super Z (cycle 4)
**Date:** 2026-06-21
**Target:** Issue #387 (Scala claim), consolidate PRs #397 + #461
**Canonical PR picked:** #461 (extends #397 with 3 critical bug fixes)

## Why this verification exists

CONTEXT.md's "Lesson Learned" explicitly warns:

> Test count tinggi (388-512 tests) TIDAK menjamin fitur benar-benar bekerja — red team menemukan callee wrapping GAGAL untuk pattern paling umum meski semua unit test pass, karena test ditulis dengan pattern yang sama dengan implementasi (confirmation bias). Kalau diminta verifikasi sesuatu "sudah bekerja", JALANKAN test nyata dengan pattern yang berbeda dari yang dipakai untuk implementasi — jangan percaya klaim dari PR sebelumnya tanpa reproduce sendiri.

PR #461 verifies PR #397 with the SAME fixture (`proof/scala_slugify/Slugify.scala`) that PR #397 was implemented against. To break confirmation bias, this verification uses a FRESH fixture with completely different domain + different Scala idioms.

## Fresh fixture — `proof/scala_independent/Cases.scala`

Different domain (string-casing + email validation + number formatting + edit distance), different Scala idioms than PR #461's `Slugify.scala`:

| Pattern | PR #461's `Slugify.scala` | This PR's `Cases.scala` |
|---|---|---|
| Domain | URL slugification | Mixed: snake_case→camelCase, email validation, number formatting, Levenshtein |
| Function signatures | All `(args: Array[Object]): Any` (same shape) | Same shape, but exercises more type coercion paths |
| Branching | Simple `if/else` + `split`/`map`/`mkString` | Pattern matching on `Number`, `Int`, `Long`, recursive `lev()` helper |
| Output types | All `String` | Mix of `String`, `Boolean`, `Int` (exercises serialization paths) |
| Multi-arg cluster | One (slugify-multiargs, 2 inputs) | One (levenshtein, 7 input pairs) |
| Edge cases tested | 6 + 2 = 8 inputs | 8 + 8 + 8 + 7 = 31 inputs |

## All 5 critical flows verified

### 1. Capture — writes valid .regret files

```bash
cd proof/scala_independent && bash ../../scripts/capture_scala.sh
```

Result: 4/4 clusters captured, .regret files written with standard format:

```
cluster: <id>
version: 1
fingerprint: <7-char-hash>
captured: <ISO timestamp>
watches: [<entry>]
entry: <entry>
stack: scala
fingerprintLevel: entry
object: <object-name>
---
INPUT  <json>
OUTPUT <json>
HASH   <7-char-hash>
INPUTS [<per-input entries with hash/input/output>]
```

✅ All 4 .regret files conform to the standard format (cluster/version/fingerprint/captured fields + INPUT/OUTPUT/HASH block + optional INPUTS line for multi-input clusters).

### 2. Validate baseline — PASS

```bash
bash ../../scripts/validate_scala.sh
```

Result: 4/4 clusters PASS (current code matches captured .regret files exactly).

- `camel-case`: 8/8 inputs match
- `is-email`: 8/8 inputs match
- `format-thousands`: 8/8 inputs match (includes buggy outputs like `100`→`"001"` — Regrets tests behavioral contracts, not correctness)
- `levenshtein`: 7/7 inputs match

### 3. Cross-stack fingerprint parity — 31/31 Scala hashes == JS hashes

Script: `node /home/z/my-project/scripts/cycle4_scala_parity_check.mjs`

For every (input, output) pair captured in the Scala .regret files, computes the JS hash using `scripts/fingerprint.js`'s contract:

```js
const combined = stableStringify(input) + '|' + stableStringify(output)
const hash = createHash('sha256').update(combined, 'utf8').digest('hex')
return BigInt('0x' + hash).toString(36).slice(0, 7)
```

Result: **31/31 byte-identical** — Scala's `regret_fingerprint.scala` produces the same hash as JS's `fingerprint.js` for every input.

### 4. Breaking refactor — FAILs correctly

Applied to `camelCase` function:

```diff
- val tail = parts.drop(1).map(p => p.capitalize)
+ val tail = parts.drop(1).map(p => p)
```

(Signature unchanged, behavior changed: tail words no longer capitalized.)

Result: 5/8 inputs FAIL with clear diffs:

- `hello_world` → `helloworld` (expected `helloWorld`)
- `user_id` → `userid` (expected `userId`)
- `api_key_v2` → `apikeyv2` (expected `apiKeyV2`)
- `_private_field` → `privatefield` (expected `PrivateField`)
- `double__underscore` → `doubleunderscore` (expected `doubleUnderscore`)

3/8 inputs still PASS (correctly — empty string, single word, and trailing underscore don't trigger the buggy path).

Validate exits with code 1 (failure detected).

### 5. Valid refactor — PASSes correctly

Applied to `camelCase` function (after restoring baseline):

```diff
- val parts = s.split("_")
- val head = parts(0)
- val tail = parts.drop(1).map(p => p.capitalize)
+ val segments = s.split("_")
+ val head = segments(0)
+ val tail = segments.drop(1).map(p => p.capitalize)
```

(Variable rename — signature AND behavior preserved.)

Result: 8/8 inputs PASS — contract preserved, refactor is safe.

## Cross-stack parseability — 4/4 .regret files parseable by JS validate.js

Script: `node /home/z/my-project/scripts/cycle4_scala_validate_js_parse.mjs`

Uses the ACTUAL `parseRegret()` function exported from `scripts/validate.js`. All 4 Scala-generated .regret files parse cleanly — header fields extracted, golden INPUT/OUTPUT/HASH identified, INPUTS line parsed as JSON array.

## npm test — no regressions

```
ℹ tests 807
ℹ suites 206
ℹ pass 807
ℹ fail 0
ℹ duration_ms 76516
```

Baseline before this PR: 807/807 pass. After this PR: 807/807 pass. (No JS-side tests added — this PR is verification-only.)

## Canonical PR selection rationale

| Aspect | PR #397 (feat/scala-stack) | PR #461 (verify/scala-stack) |
|---|---|---|
| Commits | 1 scala feat commit + several unrelated merge commits | Same scala feat commit + 1 fix commit |
| .regret format | **BUGGY** — emits `fingerprints:` (plural) field + N INPUT/OUTPUT/HASH blocks | **STANDARD** — emits `fingerprint:` (singular) + 1 INPUT/OUTPUT/HASH block + optional INPUTS line |
| Parser | Hangs (infinite loop) on INPUTS line | Parses INPUTS line correctly |
| Cross-stack compat | Broken (other stacks expect `fingerprint:` singular) | Restored |
| npm test | 807/807 (claimed, not re-verified) | 807/807 (re-verified by this PR) |
| Independent fixture | None | None (used same Slugify.scala) |
| This PR adds | — | Fresh fixture + 31 parity checks + 4 parseability checks + 5 critical flows |

**Conclusion:** PR #461 is canonical — it includes all of PR #397's work plus 3 critical bug fixes. PR #397 should be closed as superseded by #461.

## What would move Scala to [SUCCESS]

This PR is **[REVIEW]** — first-time independent verification, not a revision after maintainer feedback. To promote to [SUCCESS]:

1. Maintainer merges PR #461 (or this stacked PR if preferred) into main
2. After merge, run `bash scripts/capture_scala.sh && bash scripts/validate_scala.sh` on main — must still PASS
3. Run `npm test` on main — must not regress
4. Verify the merged Scala stack is reachable from `bin/regret.js` (dispatcher wired correctly)
5. Then comment [SUCCESS] on issue #387

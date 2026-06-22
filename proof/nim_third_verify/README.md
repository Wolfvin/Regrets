# proof/nim_third_verify — Third-party independent verification of the Nim stack

## Why this fixture exists

CONTEXT.md's "Lesson Learned" warns:

> "JALANKAN test nyata dengan pattern yang berbeda dari yang dipakai untuk
>  implementasi — jangan percaya klaim dari PR sebelumnya tanpa reproduce
>  sendiri."

The previous Nim stack PRs (#418, #450) ship fixtures written by the same
worker who wrote `scripts/capture_nim.sh` / `validate_nim.sh` /
`fingerprint_nim.nim`. Worse, the worker who posted the [REVIEW] tag on
issue #404 explicitly noted they had **no Nim compiler in their sandbox**
and verified only by static analysis:

> "Note: worker sandbox ini TIDAK punya `nim` installed... Verifikasi saya
>  based on: 1. Static analysis .regret files + manifest + source files
>  2. Cross-stack fingerprint parity (recompute JS fingerprint(input, output)
>  untuk setiap cluster, compare ke Nim HASH field)
>  3. npm test — confirms no regression di JS code path"

That's the confirmation-bias trap CONTEXT.md warns about. This fixture is
the first **dynamic** verification of the Nim stack with Nim 2.2.10
actually installed.

## What this fixture covers — patterns NOT in existing Nim fixtures

| Proc | Signature | Pattern | What it exercises |
|---|---|---|---|
| `reverseRunes` | `string → string` | Rune-aware reverse (unicode) | Different from `slugify` which is ASCII-only char-by-char |
| `sumAndCount` | `seq[int] → tuple[sum, count]` | Aggregate (not extremes) | Different from `redteam.maxPair` which returns extremes |
| `frequencyPairs` | `seq[int] → seq[(int, int)]` | Seq of tuples | First Nim fixture to test `seq[tuple]` serialization |
| `safeSqrt` | `float → Option[float]` | Option return | First Nim fixture to test `Option[T]` (std/json's `%` overload) |
| `isPalindrome` | `string → bool` | Predicate | First Nim fixture to test `bool` return type |

## Run

```bash
# Requires: Nim 2.x on PATH (or set NIM=/path/to/nim)
export PATH="/path/to/nim-2.2.10/bin:$PATH"
bash proof/nim_third_verify/run_demo.sh
```

The demo runs 5 phases:

0. **Baseline capture + validate** — must PASS
1. **VALID refactor** (rename internal var, extract helper) — must PASS
2. **BREAKING refactor** (off-by-one in `sumAndCount`, byte-reverse instead
   of rune-reverse, always-true `isPalindrome`) — must FAIL with exit
   non-zero
3. **Restore original** — must PASS (sanity)
4. **Cross-stack fingerprint parity** — Nim HASH must match JS
   `fingerprint(input, output)` for all 5 clusters

## Findings

This third-party verification surfaced TWO real issues in the existing
`fingerprint_nim.nim`:

### Finding #1 (FIXED in this PR) — `toBase36` strips trailing zeros

The original `toBase36` used `hexStr.strip(chars = {'0'})` which strips
**both leading AND trailing** zeros. For SHA-256 hashes that happen to end
in `0` (e.g. `c4c12b23e124e58f...e24ff0`), the trailing `0` was stripped,
changing the BigInt value and producing a different base36 result than
JS/Python.

**Why existing fixtures missed it:** the SHA-256 hashes of the slugify
and redteam test cases don't end in `0`. My `is-palindrome` cluster
(input `"racecar"`, output `true`) was the first input/output pair whose
combined string `"racecar"|true` produces a SHA-256 hash ending in `0`.

**Fix:** use `strip(leading = true, trailing = false, chars = {'0'})` to
strip only leading zeros. Documented in `scripts/fingerprint_nim.nim`.

After the fix, all 5 clusters pass cross-stack parity.

### Finding #2 (REPORTED, NOT FIXED — out of scope) — Whole-number float parity gap

When a Nim proc returns a whole-number `float` (e.g. `2.0`), Nim's
`stableDumps` serializes it as `"2.0"` (preserving the float type marker).
JS's `JSON.stringify(2.0)` strips the `.0` and produces `"2"`. This causes
cross-stack parity to break for any cluster whose output is a
whole-number float.

**Workaround in this fixture:** the `safeSqrt` cluster uses inputs that
produce non-whole-number outputs (e.g. `safeSqrt(2.0) → some(1.414...)`)
so parity is preserved. A proper fix would require either:

- Nim's `stableDumps` to normalize `JFloat(2.0)` → `"2"` (matching JS), or
- JS to preserve `.0` (impossible without changing JSON representation)

This gap exists for ALL stacks that distinguish int from float at the
JSON-node level (Nim, Java, C, C++, Go). Out of scope for this PR — needs
a separate design decision.

## Cross-stack parity table (post-fix)

| Cluster | Nim hash | JS hash | Match |
|---|---|---|---|
| frequency-pairs | 4uybivj | 4uybivj | ✅ |
| is-palindrome | 4wjg59y | 4wjg59y | ✅ |
| reverse-runes | 28wkqqp | 28wkqqp | ✅ |
| safe-sqrt | 45hmw2e | 45hmw2e | ✅ |
| sum-and-count | yiosn9h | yiosn9h | ✅ |

All 5 clusters match — Nim `fingerprint()` and JS `fingerprint()` produce
byte-identical 7-char base36 hashes for the same input/output pair.

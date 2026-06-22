# proof/go_independent/ — Independent verification fixture for the Go stack

This fixture is the **independent worker's** verification of the Go stack
(`scripts/capture_go.sh` validate mode) on main. It exists because the
**author's** fixture in `proof/go_verify/` (slugify, base64, crc32, fnv1a,
is-valid-ipv4 — string + hash + IP validation) might pass while hiding bugs
that only surface on different inputs — the confirmation-bias anti-pattern
described in `CONTEXT.md → Lesson Learned`:

> Test count tinggi TIDAK menjamin fitur benar-benar bekerja. Kalau diminta
> verifikasi sesuatu "sudah bekerja", JALANKAN test nyata dengan pattern
> yang berbeda dari yang dipakai untuk implementasi — jangan percaya klaim
> dari PR sebelumnya tanpa reproduce sendiri.

## Domain choice

The author's fixture is **string + hash + IP validation**. The independent
fixture uses **3 completely different domains** and exercises Go idioms NOT
covered by the author's fixture:

| Package | Functions | New idiom (not in proof/go_verify/) |
|---|---|---|
| datetime | ParseISO8601, FormatDuration, WeekdayName, DaysBetween, AddBusinessDays | Multiple return values `(time.Time, error)`, `time.Format()` reference-date layout, error sentinel return, multiArgs (date+int) |
| finance | FormatCents, ApplyDiscount, SumCents, ParseMoney | Integer-cents arithmetic, floor rounding, multiArgs (cents+pct), reverse-parse error sentinel |
| collections | DedupeStrings, SortAndJoin, CountWords, Intersect, Chunk | Map return values (`map[string]int`), nested-loop + composite-key pattern, multiArgs (slice+sep), error sentinel via "INVALID" |

## Manifest

`regrets/manifest.json` declares 14 clusters. Highlights:

- **5 single-arg functions** (parse-iso8601, format-duration, weekday-name,
  sum-cents, parse-money, dedupe-strings, count-words, intersect, chunk)
- **5 multiArgs functions** (days-between, add-business-days, apply-discount,
  sort-and-join) — input is a JSON array, each element becomes a function arg
- **3 multi-input clusters** (parse-iso8601, days-between, count-words) —
  testing the Issue #315 INPUTS-line contract
- **1 error-path test** (parse-iso8601 4th input "not-a-date" → error
  returned → excluded from INPUTS line by trivial-input guard)

## Files

- `datetime/datetime.go` — 5 date/time utility functions
- `finance/finance.go` — 4 money/currency utility functions
- `collections/collections.go` — 5 collection utility functions
- `go.mod` — Go module declaration
- `regrets/manifest.json` — cluster config (14 clusters)
- `regrets/*.regret` — captured golden contracts (14 files, DO NOT edit manually)
- `demo-refactor-flow.sh` — end-to-end demo script: 14 checks
  (capture → baseline PASS → 5× valid refactor PASS → 5× breaking refactor
  FAIL → multi-input contract check → cross-stack parity check → multiArgs
  pass-through check)
- `verify-parity.mjs` — cross-stack fingerprint parity check
  (go HASH == JS fingerprint())
- `README.md` — this file

## Run

```bash
# Set up Go env (adjust paths to your local install)
export PATH="/home/z/go/bin:${PATH}"
export GOPATH=/home/z/go-path
export GOCACHE=/tmp/go-cache
export GOMODCACHE=/home/z/go-path/pkg/mod

# End-to-end demo (14 checks)
bash proof/go_independent/demo-refactor-flow.sh

# Cross-stack parity
node proof/go_independent/verify-parity.mjs

# Independent test suite
node --test tests/go-stack-independent.test.js

# Or via npm test
npm test
```

## Verification outcome

Picked this stack via the probability picker script
(`scripts/regrets_picker_v2.py`, seed=42) — Go was [REVIEW] status with
single issue (the original claim issue #400). Verified independently on
Go 1.24.4 (downloaded directly from go.dev).

- ✅ 14 clusters captured, 0 failed
- ✅ baseline validate: 14/14 PASS
- ✅ 5 valid refactors (output-preserving): 5/5 PASS
  - format-duration: switch fast-path for small inputs
  - format-cents: use math.Abs for negative path
  - dedupe-strings: use map[string]struct{} instead of bool
  - apply-discount: extract base price variable
  - count-words: use strings.Split + manual filter
- ✅ 5 breaking refactors (output-changing): 5/5 FAIL (correctly detected)
  - format-duration: omit hours (Xm Ys instead of Xh Ym Zs)
  - format-cents: emit "$-X.YY" instead of "-$X.YY"
  - dedupe-strings: last-occurrence order, not first
  - apply-discount: round UP instead of DOWN
  - count-words: lowercase all words (breaks on mixed-case input)
- ✅ cross-stack fingerprint parity: 14/14 match (go HASH == JS fingerprint())
- ✅ Issue #315 multi-input contract: INPUTS line written for 9 multi-input clusters
- ✅ multiArgs pass-through: days-between INPUT is JSON array (multiArgs=true honored)
- ✅ error path: parse-iso8601 invalid input excluded from INPUTS line
- ✅ npm test: 1057 tests pass (1033 PASS + 24 skipped, 0 FAIL) — no regression (+11 new tests)

Final tag: **[REVIEW]** — first submit for this independent verification work.

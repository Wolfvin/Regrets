# proof/awk_independent/ — Independent verification fixture for the Awk stack

This fixture is the **independent worker's** verification of the Awk stack
(`scripts/capture_awk.mjs` + `scripts/validate_awk.mjs`) on main. It exists
because the **author's** fixture in `proof/awk/` (sum_column, fibonacci,
max_value, reverse_lines, word_count, csv_field_count) might pass while
hiding bugs that only surface on different inputs — the confirmation-bias
anti-pattern described in `CONTEXT.md → Lesson Learned`:

> Test count tinggi TIDAK menjamin fitur benar-benar bekerja. Kalau diminta
> verifikasi sesuatu "sudah bekerja", JALANKAN test nyata dengan pattern
> yang berbeda dari yang dipakai untuk implementasi — jangan percaya klaim
> dari PR sebelumnya tanpa reproduce sendiri.

## Domain choice

The author's fixture is **math/string-math** (column sums, fibonacci,
max-value, word-count, csv-field-count). The independent fixture uses a
completely different domain — **text/log processing** — and exercises awk
idioms NOT covered by the author's fixture:

| Cluster | Idiom not covered by proof/awk/ |
|---|---|
| `apache_status_class.awk` | Field-aware parsing + regex class dispatch ($9 field) |
| `markdown_links.awk` | `match()` + `RSTART`/`RLENGTH` iteration with multiple matches per line |
| `dedupe_lines.awk` | Associative-array dedup (the most idiomatic awk pattern) |
| `indent_prefix.awk` | `-v var=N` parameter pass-through via `cluster.args` |
| `transpose_matrix.awk` | Nested loop + `split()` + composite-key 2D array emulation |

## Manifest

`regrets/manifest.json` declares 5 clusters. Three are multi-input
(`markdown-links`, `dedupe-lines`, `transpose-matrix`) — testing the
Issue #315 INPUTS-line contract. One uses `cluster.args` (`indent-prefix`)
to verify `-v var=N` pass-through. One exercises the trivial-input guard
(`markdown-links` third input has no links → empty stdout → skipped).

## Files

- `apache_status_class.awk`, `markdown_links.awk`, `dedupe_lines.awk`,
  `indent_prefix.awk`, `transpose_matrix.awk` — the 5 awk programs
- `regrets/manifest.json` — cluster config
- `regrets/*.regret` — captured golden contracts (DO NOT edit manually)
- `demo-refactor-flow.sh` — end-to-end demo script: 13 checks
  (capture → baseline PASS → 5× valid-refactor PASS → 5× breaking-refactor
  FAIL → multi-input contract check → cluster.args pass-through check)
- `verify-parity.mjs` — cross-stack fingerprint parity check
  (awk HASH == JS fingerprint())

## Run

```bash
# End-to-end demo (13 checks)
bash proof/awk_independent/demo-refactor-flow.sh

# Cross-stack parity
node proof/awk_independent/verify-parity.mjs

# Independent test suite
node --test tests/awk-stack-independent.test.js

# Or via npm test
npm test
```

## Verification outcome

Picked this stack via the probability picker script
(`scripts/regrets_picker.py`, seed=13) — Awk was [REVIEW] status with
single open PR. Verified independently on mawk 1.3.4 (Debian's default awk).

- ✅ 5 clusters captured
- ✅ baseline validate: 5/5 PASS
- ✅ 5 valid refactors (output-preserving): 5/5 PASS
- ✅ 5 breaking refactors (output-changing): 5/5 FAIL (correctly detected)
- ✅ cross-stack fingerprint parity: 5/5 match (awk HASH == JS fingerprint())
- ✅ Issue #315 multi-input contract: INPUTS line written for 3 multi-input clusters
- ✅ cluster.args pass-through: `-v indent=3` honored by capture_awk.mjs
- ✅ npm test: 998 tests pass (985 PASS + 13 skipped, 0 FAIL) — no regression

Final tag: **[REVIEW]** — first submit for this independent verification work.

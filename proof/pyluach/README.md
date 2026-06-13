# Pyluach Refactor Proof — Regrets Regression Testing

## Target Repository
[simlist/pyluach](https://github.com/simlist/pyluach) — A Python package for Hebrew (Jewish) calendar dates and conversions

## Why pyluach?
The LEAST obvious choice for regression testing — who tests Hebrew calendar libraries? This makes it the perfect edge case to prove Regrets works on unexpected domains. Pyluach contains pure mathematical and string transformation functions that are deterministic and ideal for fingerprint-based regression testing, yet nobody would think to apply regression testing to a calendar conversion library.

## What Was Refactored

### `pyluach/gematria.py` — Hebrew numeral conversion
1. **Added module-level docstring** with clear purpose description
2. **Replaced inline `_GEMATRIOS` dict** with a compact format for readability
3. **Extracted `_SPECIAL_REPLACEMENTS` dict** — the traditional gematria substitutions (יה→טו, יו→טז) that avoid writing divine names are now a named constant instead of hidden `.replace()` calls
4. **Extracted `_apply_special_replacements()`** — a dedicated function for the special replacement logic, making the divine-name-avoidance rule explicit and self-documenting
5. **Named `_GERESH`, `_GERSHAYIM`, `_TAV` constants** — replaced inline Unicode characters with named constants for readability
6. **Improved variable names** in `_get_letters()`: `ones` → `ones_digit`, `tens` → `tens_digit`, `hundreds` → `hundreds_raw`, `four_hundreds` → `tav_count`/`tav_prefix`
7. **Added comprehensive docstrings** to all functions with parameter documentation
8. **Simplified `_stringify_gematria()`** — used early return for empty string, clearer single/multi-char logic

### `pyluach/utils.py` — Calendar utility functions
1. **Simplified `_is_leap()`** — replaced redundant `if (condition): return True; return False` with direct `return condition`
2. **Added docstring** to `_is_leap()` explaining the 19-year Metonic cycle
3. **Extracted `_apply_postponement()`** from `_elapsed_days()` — the three dehiyyah (postponement) rules (Molad Zakein, Gatarad, Betutakafot) are now in a separate, well-documented function with named boolean variables
4. **Renamed** `alt_day` → `adjusted_day` for clarity
5. **Used `frozenset`** in `_month_length()` instead of lists for membership testing (O(1) lookup)
6. **Added named constants** `_THIRTY_DAY_MONTHS`, `_TWENTY_NINE_DAY_MONTHS` with comments
7. **Used ternary expressions** for variable-length months in `_month_length()` (more Pythonic)
8. **Simplified `_month_name()`** — used ternary expression to select names list
9. **Added docstrings** to all modified functions

## 3-Way Verification Proof

### VERIFICATION 1 — Regrets Fingerprint
All 7 clusters GREEN after refactor:

| Cluster | Fingerprint | Status |
|---------|------------|--------|
| gematria-convert | 69vpdvu | PASS |
| hebrew-leap | 5wtkimf | PASS |
| month-length | fny25om | PASS |
| month-name | 3pfo2au | PASS |
| elapsed-days | 5hj9vhu | PASS |
| get-letters | 2lcwua6 | PASS |
| stringify-gematria | 5etsuwj | PASS |

### VERIFICATION 2 — Raw Output vs KEBENARAN 1
All outputs IDENTICAL to pre-refactor baseline.

### VERIFICATION 3 — Cross-Check
Fingerprints from new output match KEBENARAN 2 exactly.

## Fingerprint Before/After

| Cluster | Before | After | Match |
|---------|--------|-------|-------|
| gematria-convert | 69vpdvu | 69vpdvu | MATCH |
| hebrew-leap | 5wtkimf | 5wtkimf | MATCH |
| month-length | fny25om | fny25om | MATCH |
| month-name | 3pfo2au | 3pfo2au | MATCH |
| elapsed-days | 5hj9vhu | 5hj9vhu | MATCH |
| get-letters | 2lcwua6 | 2lcwua6 | MATCH |
| stringify-gematria | 5etsuwj | 5etsuwj | MATCH |

## Regrets Improvement Discovered
This testing validated that Regrets' Python stack works correctly on:
- Multi-argument functions (`multiArgs: true`) for `_month_length` and `_month_name`
- Pure functions with Hebrew Unicode string outputs
- Deeply nested logic (dehiyyah postponement rules in `_elapsed_days`)
- Small primitive outputs (boolean from `_is_leap`, integer from `_elapsed_days`)

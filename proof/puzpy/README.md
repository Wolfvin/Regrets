# puzpy Refactor Proof — Regrets Regression Testing

## Target Repository
[alexdej/puzpy](https://github.com/alexdej/puzpy) — A Python library for reading and writing Across Lite `.puz` crossword puzzle files

## Why puzpy?
The LEAST obvious choice for regression testing — who regression-tests a crossword puzzle file parser? The `.puz` format involves proprietary binary checksums, solution scrambling with shift/rotate/shuffle operations, and stateful rebus parsing. This is an absurdly niche domain that nobody would expect to see tested with a regression tool.

## What Was Refactored
`puz.py` — meaningful but behavior-preserving changes:

1. **`data_cksum`**: Extracted magic numbers into named constants (`WRAP_BIT`, `MASK_16BIT`), renamed `b` → `byte_val`, `lowbit` → `low_bit`, added comprehensive docstring
2. **`scramble_string`**: Renamed parameter `s` → `text` and loop variable `k` → `digit`, replaced shadowed variable `s` with `result`, improved docstring with grid example
3. **`unscramble_string`**: Renamed `s` → `text`, renamed `l` → `text_len` (fixed E741 lint violation), renamed `k` → `digit`, introduced `result` variable
4. **`square`**: Renamed `aa` → `rows`, `r` → `row`, `c` → `col`, added comprehensive docstring
5. **`shuffle`**: Broke single expression into named variables (`first_half`, `second_half`, `interleaved`, `trailing_char`), added docstring with example
6. **`restore`**: Renamed `s` → `source`, `t` → `replacement`, replaced unsafe `next()` generator with explicit `iter()` + list append pattern, added comprehensive docstring
7. **`is_blacksquare`**: Replaced `list` membership check with `frozenset` for O(1) lookups (`_BLACKSQUARE_CHARS`), added docstring

## 3-Way Verification Proof

### VERIFICATION 1 — Regrets Fingerprint
All 12 clusters GREEN after refactor:

| Cluster | Fingerprint | Status |
|---------|------------|--------|
| scramble-string | 2klhzf5 | ✅ PASS |
| unscramble-string | 5uo65ye | ✅ PASS |
| key-digits | 5igr350 | ✅ PASS |
| square-transform | 22un0dx | ✅ PASS |
| shift-chars | 4l85po4 | ✅ PASS |
| shuffle-string | 57m2jhs | ✅ PASS |
| unshuffle-string | 2iaj9or | ✅ PASS |
| is-blacksquare | 2j8acjo | ✅ PASS |
| replace-chars | 2dcht4i | ✅ PASS |
| parse-dict | 54j2z2i | ✅ PASS |
| dict-to-string | r3xq9k6 | ✅ PASS |
| restore-chars | 1i6y90k | ✅ PASS |

### VERIFICATION 2 — Raw Output vs KEBENARAN 1
All outputs IDENTICAL to pre-refactor baseline.

### VERIFICATION 3 — Cross-Check
Fingerprints from new output match KEBENARAN 2 exactly.

## Fingerprint Before/After

| Cluster | Before | After | Match |
|---------|--------|-------|-------|
| scramble-string | 2klhzf5 | 2klhzf5 | ✅ |
| unscramble-string | 5uo65ye | 5uo65ye | ✅ |
| key-digits | 5igr350 | 5igr350 | ✅ |
| square-transform | 22un0dx | 22un0dx | ✅ |
| shift-chars | 4l85po4 | 4l85po4 | ✅ |
| shuffle-string | 57m2jhs | 57m2jhs | ✅ |
| unshuffle-string | 2iaj9or | 2iaj9or | ✅ |
| is-blacksquare | 2j8acjo | 2j8acjo | ✅ |
| replace-chars | 2dcht4i | 2dcht4i | ✅ |
| parse-dict | 54j2z2i | 54j2z2i | ✅ |
| dict-to-string | r3xq9k6 | r3xq9k6 | ✅ |
| restore-chars | 1i6y90k | 1i6y90k | ✅ |

## Regrets Insights Discovered

### 1. `pythonPath` Required for Single-Module Projects
When the target project is a single-file Python module (like `puz.py`), the `pythonPath` field in the manifest is essential. Without it, `capture.py` and `validate.py` cannot import the module because it's not on `sys.path`. The `pythonPath: "."` setting tells Regrets to add the project root to `sys.path`.

### 2. `multiArgs` Behavior for Multi-Argument Functions
Python functions that take multiple positional arguments need `"multiArgs": true` in the manifest. Without this, the entire input is passed as a single argument, causing TypeErrors. This is especially important for functions like `scramble_string(text, key)` or `square(data, w, h)`.

### 3. Bytes Inputs Not Directly Supported
Functions like `data_cksum(data: bytes, cksum: int)` that require `bytes` input cannot be directly fingerprinted by Regrets because JSON serialization doesn't support `bytes`. For such functions, a wrapper function that converts string to bytes would be needed, or Regrets could add `"inputTransform"` support in the manifest.

### 4. Frozenset/Constants Placed After Functions
When refactoring `is_blacksquare()` to use a module-level `frozenset`, the constant must be defined AFTER the `BLACKSQUARE` and `BLACKSQUARE2` module constants. This is a Python module ordering consideration when doing refactors that introduce new module-level constants.

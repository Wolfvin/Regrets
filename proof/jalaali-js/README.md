# Refactor Proof: jalaali/jalaali-js

## Target Repo

- **Repo**: [jalaali/jalaali-js](https://github.com/jalaali/jalaali-js)
- **What it does**: Converts between Gregorian and Jalaali (Persian) calendar systems
- **Why this repo was chosen**: Nobody thinks to regression-test a niche Persian calendar library. It's the definition of an unlikely test case for Regrets — pure math functions, no DOM, no I/O, completely deterministic, and extremely niche (Iranian calendar system used by ~100M people but virtually unknown in Western dev circles).

## Refactoring Summary

### Changes Made

1. **`div()` → `intDiv()`**: Renamed for clarity. The original name was cryptic — `intDiv` makes it immediately clear this is integer division that truncates toward zero.

2. **Extracted `normalizeDateArgs()`**: The `toJalaali()` function had inline Date-object normalization mixed with the actual conversion logic. Extracted to a separate function for single-responsibility.

3. **Extracted `findBreakInterval()`**: Both `jalCal()` and `jalCalLeap()` contained identical break-year lookup loops. Extracted the common logic into `findBreakInterval()`, used by `jalCalLeap()`. Note: `jalCal()` cannot use this because it needs the accumulated `leapJ` count from traversing all intervals.

4. **Added documentation comments**: Explained the behavior of `intDiv` and `mod`, and documented why `jalCal` cannot use `findBreakInterval`.

### What Was NOT Changed

- All function signatures remain identical
- All function outputs remain identical
- The `breaks` array is unchanged
- No behavior changes of any kind

## Verification Results

### VERIFIKASI 1 — Regrets Fingerprint Validation

All 10 clusters PASS after refactoring:

```
✅ d2g-julian-to-gregorian             1wqi591                PASS
✅ d2j-julian-to-jalaali               2cl0ilc                PASS
✅ g2d-gregorian-to-julian             2kivask                PASS
✅ is-leap-jalaali-year                4m253ff                PASS
✅ is-valid-jalaali-date               5b77992                PASS
✅ j2d-jalaali-to-julian               5adcrf6                PASS
✅ jal-cal                             v1d20xq                PASS
✅ jalaali-month-length                67tykov                PASS
✅ to-gregorian                        4rcn6td                PASS
✅ to-jalaali                          634kqca                PASS
```

### VERIFIKASI 2 — Direct Output Comparison

Raw output comparison between pre-refactor (KEBENARAN 1) and post-refactor:

```
$ diff truth1-raw-output.json truth1-post-refactor.json
(empty — zero differences)
```

### VERIFIKASI 3 — Cross-Validation (Fingerprint Stability)

Drift detection with 5 runs, all PASS+STABLE:

```
✅ d2g-julian-to-gregorian   1wqi591  × 5  PASS+STABLE
✅ d2j-julian-to-jalaali     2cl0ilc  × 5  PASS+STABLE
✅ g2d-gregorian-to-julian   2kivask  × 5  PASS+STABLE
✅ is-leap-jalaali-year      4m253ff  × 5  PASS+STABLE
✅ is-valid-jalaali-date     5b77992  × 5  PASS+STABLE
✅ j2d-jalaali-to-julian     5adcrf6  × 5  PASS+STABLE
✅ jal-cal                   v1d20xq  × 5  PASS+STABLE
✅ jalaali-month-length      67tykov  × 5  PASS+STABLE
✅ to-gregorian              4rcn6td  × 5  PASS+STABLE
✅ to-jalaali                634kqca  × 5  PASS+STABLE
```

### Existing Test Suite

All 8 original mocha tests pass after refactoring.

## Fingerprint Comparison (Before vs After)

| Cluster | Fingerprint Before | Fingerprint After | Match? |
|---------|-------------------|-------------------|--------|
| d2g-julian-to-gregorian | 1wqi591 | 1wqi591 | ✅ |
| d2j-julian-to-jalaali | 2cl0ilc | 2cl0ilc | ✅ |
| g2d-gregorian-to-julian | 2kivask | 2kivask | ✅ |
| is-leap-jalaali-year | 4m253ff | 4m253ff | ✅ |
| is-valid-jalaali-date | 5b77992 | 5b77992 | ✅ |
| j2d-jalaali-to-julian | 5adcrf6 | 5adcrf6 | ✅ |
| jal-cal | v1d20xq | v1d20xq | ✅ |
| jalaali-month-length | 67tykov | 67tykov | ✅ |
| to-gregorian | 4rcn6td | 4rcn6td | ✅ |
| to-jalaali | 634kqca | 634kqca | ✅ |

All 10/10 fingerprints identical. Refactor is proven safe.

# Proof: Regrets Tested Against biorhythm-calculator

## Target Repository

**Repo**: [alrico88/biorhythm-calculator](https://github.com/alrico88/biorhythm-calculator)
**What it does**: A JavaScript library for calculating biorhythms — a debunked 19th-century pseudoscience claiming human bodies follow three sinusoidal cycles (physical: 23 days, emotional: 28 days, intellectual: 33 days).

## Why This Repo?

This is the **most unlikely** test case for regression testing:

1. **It's pseudoscience** — Nobody would think "I need to regression-test my biorhythm calculator"
2. **Niche domain** — Biorhythms were debunked decades ago; this library exists in a forgotten corner of npm
3. **No standard test data** — Unlike chess libraries or barcode validators, there are no reference biorhythm test suites
4. **The irony is the point** — Regression-testing pseudoscience proves the tool works anywhere

## Pure Functions Identified

| Function | Signature | Deterministic? |
|----------|-----------|----------------|
| `calculateBiorhythm(dob, date)` | `(Date, Date) → {physical, emotional, intellectual}` | ✅ Yes |
| `calculateBiorhythmRange(dob, date, days)` | `(Date, Date, number) → [{day, biorhythm}]` | ✅ Yes |
| `getHowManyFullCycles(dob, date)` | `(Date, Date) → number` | ✅ Yes |
| `getDifferenceInDays(dateLeft, dateRight)` | `(Date, Date) → number` | ✅ Yes |
| `getDateRange(date, days)` | `(Date, number) → Date[]` | ✅ Yes |

## Regrets Discovery: Drift Detection Bug

During testing, a **critical false positive** was discovered in Regrets' drift detection (`--runs N`):

**Bug**: When a cluster has multiple inputs in the manifest, drift detection compared fingerprints across ALL inputs as one flat set. Since different inputs naturally produce different fingerprints, this ALWAYS reported drift for clusters with >1 input.

**Fix**: Per-input drift detection — same input must produce same fingerprint across runs. Different inputs producing different fingerprints is expected, not drift.

## Refactor Performed

### calculator.js
- **Removed** `number-helper-functions` dependency → inline `roundTo(num, decimals)` using `Math.round`
- **Eliminated** `createCalculator` closure → direct `computeBiorhythmValue(daysDifference, cycleLength, decimals)`
- **Exported** `computeBiorhythmValue` and `roundTo` for reuse

### cycles.js
- **Removed** `math-helper-functions` dependency → inline `calcPercent()` and `ruleOfThree()`
- **Exported** both helper functions for direct testing

## 3-Verification Proof

### VERIFIKASI 1 — Regrets (All GREEN)
```
✅ calculate-biorhythm-range    4630kdi  PASS
✅ calculate-biorhythm          4f8fmn1  PASS
✅ get-date-range               5ozuwma  PASS
✅ get-difference-in-days       2ad0spn  PASS
✅ get-how-many-full-cycles     3igav9t  PASS
```

### VERIFIKASI 2 — Raw Output (All 16 pairs IDENTICAL)
Every input/output pair from post-refactor matches KEBENARAN 1 (pre-refactor ground truth).

### VERIFIKASI 3 — Cross-Check (Fingerprints MATCH)
All 5 fingerprints computed from post-refactor output match KEBENARAN 2 (pre-refactor .regret files).

## Before/After Fingerprints

| Cluster                       | Fingerprint | Match |
|-------------------------------|-------------|-------|
| calculate-biorhythm           | 4f8fmn1     | ✅    |
| calculate-biorhythm-range     | 4630kdi     | ✅    |
| get-how-many-full-cycles      | 3igav9t     | ✅    |
| get-difference-in-days        | 2ad0spn     | ✅    |
| get-date-range                | 5ozuwma     | ✅    |

All fingerprints unchanged. Refactor is safe.

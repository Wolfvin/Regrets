# Case Study: @kalenderjawa/petungan — Javanese Calendar Converter

## Overview

A regression testing case study applying Regrets to `@kalenderjawa/petungan`, a niche Javanese calendar conversion library. This library converts between Javanese (AJ), Gregorian (CE/Masehi), and Hijri (AH) calendar years using Julian Day Number (JDN) calculations and continuous drift formulas.

**Why this is an unusual test case:** Nobody would think to regression-test a Javanese calendar library. It's an extremely niche domain — a mathematical calendar converter for a calendar system used primarily in Indonesian Java. The code is pure mathematics with no DOM, no network, no side effects. Yet it proved to be an ideal test case because:

1. All functions are pure — perfect for fingerprint capture
2. The code has clear behavioral contracts (year conversions)
3. The domain is obscure enough that edge cases are easy to miss
4. The codebase had structural issues ideal for refactoring

## Project Profile

| Aspect | Details |
|--------|---------|
| Repository | `kalenderjawa/petungan` |
| Language | JavaScript (ES Modules) |
| Stack | `js` |
| Functions | 10 exported functions across 3 source files |
| Dependencies | Zero runtime dependencies |
| Test framework | Vitest |

## Cluster Design

10 clusters were defined, covering all major entry points:

| Cluster | Entry Function | File | Fingerprint |
|---------|---------------|------|-------------|
| jawa-to-masehi-precise | `konversiJawaMasehiPrecise` | pelok.js | 44rqio1 |
| masehi-to-jawa-precise | `konversiMasehiJawaPrecise` | pelok.js | h7bzqvy |
| jawa-to-masehi-direct | `konversiJawaMasehiDirect` | direct.js | 44rqio1 |
| masehi-to-jawa-direct | `konversiMasehiJawaDirect` | direct.js | h7bzqvy |
| jawa-to-hijriyah | `konversiTahunJawaKeTahunHijriyah` | jh.js | 1ke6bo7 |
| hijriyah-to-jawa | `konversiTahunHijriyahKeTahunJawa` | jh.js | 3d1n6lo |
| masehi-to-jawa-main | `konversiTahunMasehiKeTahunJawa` | jm.js | h7bzqvy |
| jawa-to-masehi-main | `konversiTahunJawaKeTahunMasehi` | jm.js | 44rqio1 |
| tabel-konstanta-jawa | `tabelKonstantaKonversiTahunJawa` | pelok.js | 3dpqdsf |
| cari-tahun-referensi-jawa | `cariTahunReferensiJawa` | pelok.js | 1y65a96 |

## Lessons Learned

### 1. Zero-dependency pure functions are ideal Regrets targets

Calendar conversion functions take an integer and return an integer. No mocking, no fixtures, no network. Capture and validate were instant and 100% deterministic from the first run. Zero false positives, zero drift across 5 runs.

**Implication:** When selecting test targets for Regrets, prioritize pure mathematical/data transformation functions. They require zero setup and produce stable fingerprints.

### 2. Circular dependency detection during refactoring

When extracting `JAVANESE_CALENDAR_CONSTANTS` from `pelok.js` into a new `constants.js` module, we initially imported it back from `pelok.js` in `direct.js`. This created a circular dependency: `pelok.js → direct.js → pelok.js`. ES module live bindings caused "Cannot access before initialization" errors.

**Solution:** Extract shared constants into a zero-dependency module (`constants.js`) that both `pelok.js` and `direct.js` import from. This eliminates the circular dependency while maintaining the same API.

**Pattern:** When splitting a module during refactoring:
1. Identify shared state (constants, types)
2. Extract to a zero-dependency module first
3. Then extract the dependent modules
4. Update the original module to re-export from new modules

### 3. Functions with no arguments need `inputs: [null]`

The `tabelKonstantaKonversiTahunJawa()` function takes no arguments. The manifest must specify `"inputs": [null]` (not `"inputs": []` which causes capture to fail with `results[0]` undefined).

### 4. `console.warn` in pure functions is a code smell

The original `jh.js` and `pelok.js` used `console.warn` for years before the calendar base year. This is technically a side effect. During refactoring, these were removed — pure functions should not have side effects, including console output. If warnings are needed, they should be in the calling code, not the pure conversion function.

### 5. Same fingerprint across different clusters is expected

Multiple clusters produce the same fingerprint (e.g., `jawa-to-masehi-precise`, `jawa-to-masehi-direct`, and `jawa-to-masehi-main` all produce `44rqio1`). This is correct behavior — they all convert Javanese years to Gregorian years with the same inputs and outputs. The fingerprint only proves the contract holds, not that the implementation path is unique.

### 6. Schema mode for large structured output

The `tabelKonstantaKonversiTahunJawa` function returns an array of 78 objects. Using `"fingerprintMode": "schema"` captures the structure without being brittle about specific constant values. This is appropriate when the shape of the output matters more than exact values.

## Refactoring Performed

### Before (3 files)

```
src/
  index.js   — barrel re-exports
  pelok.js   — 379 lines: constants + JDN helpers + Direct engine + Precise engine + legacy API
  jm.js      — main Gregorian↔Javanese API
  jh.js      — Javanese↔Hijri conversions
```

### After (6 files)

```
src/
  index.js      — barrel re-exports (unchanged)
  constants.js  — shared calendar constants (zero dependencies)
  jdn.js        — Julian Day Number helpers (Gregorian↔JDN, Hijri↔JDN)
  direct.js     — Direct drift-formula engine
  pelok.js      — Precise engine + legacy API (reduced from 379 to ~240 lines)
  jm.js         — main Gregorian↔Javanese API (cleaned up console.warn)
  jh.js         — Javanese↔Hijri conversions (cleaned up console.warn, removed unused vars)
```

### Changes

1. **Extracted `constants.js`** — Zero-dependency module for shared calendar constants. Eliminates circular dependency risk.
2. **Extracted `jdn.js`** — Julian Day Number conversion helpers. Pure astronomical calculations, independently testable.
3. **Extracted `direct.js`** — Direct drift-formula engine. Self-contained with clear mathematical documentation.
4. **Reduced `pelok.js`** — Now contains only Precise engine + legacy table API. No longer a "god module".
5. **Removed `console.warn` from pure functions** — Side effects removed from `jh.js` and `jm.js`.
6. **Removed unused variables** — `AWAL_TAHUN_JAWA` and `AWAL_TAHUN_HIJRIYAH` in `jh.js`.
7. **Improved JSDoc** — All functions now have complete documentation with algorithm descriptions.

## 3-Verification Proof

| Verification | Method | Result |
|-------------|--------|--------|
| V1 — Regrets | All 10 clusters GREEN, 5 runs STABLE | ✅ PASS |
| V2 — Direct output | Current output identical to KEBENARAN 1 | ✅ PASS |
| V3 — Cross fingerprint | Fingerprints match KEBENARAN 2 | ✅ PASS |

**Conclusion:** Refactor is provably safe. Behavioral contracts are preserved.

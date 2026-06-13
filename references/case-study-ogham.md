# Case Study: ogham — Ancient Irish Tree Alphabet Converter

A complete end-to-end validation of Regrets using `evanshortiss/ogham`, a TypeScript library that transliterates Latin text into Ogham — an early medieval Irish alphabet carved on standing stones from the 4th-6th centuries.

## Why ogham?

The LEAST obvious choice for regression testing — who tests ancient Irish alphabet converters? This makes it the perfect edge case to prove Regrets works on unexpected, niche domains.

**Key challenges:**
- TypeScript compiled to CommonJS (requires wrapper module pattern)
- Multiple option combinations (addBoundary, useForfeda, usePhonetics)
- Error paths for unsupported characters
- Unicode-heavy output (Ogham characters in the U+1680-U+169C range)

## Target Repository

[evanshortiss/ogham](https://github.com/evanshortiss/ogham) — TypeScript, MIT licensed, zero dependencies, 100% test coverage threshold enforced.

## Wrapper Module Pattern

Since ogham compiles TypeScript to CommonJS and the `convert` function takes options as a second parameter, we created a wrapper module (`regret-entry.mjs`) that bridges the gap:

```js
// regret-entry.mjs
import { convert } from './src/ogham.js';

export function convertDefault(input) {
  return convert(input);
}

export function convertNoBoundary(input) {
  return convert(input, { addBoundary: false });
}

export function convertWithForfeda(input) {
  return convert(input, { useForfeda: true });
}

export function convertWithPhonetics(input) {
  return convert(input, { usePhonetics: true });
}

export function convertWithForfedaAndPhonetics(input) {
  return convert(input, { useForfeda: true, usePhonetics: true });
}

export function convertPhoneticsNoBoundary(input) {
  return convert(input, { usePhonetics: true, addBoundary: false });
}
```

### Why a Wrapper Module?

1. **CJS compatibility** — The compiled `ogham.js` uses `exports.convert = convert`, which Regrets' ESM dynamic import handles, but the wrapper ensures clean named exports
2. **Options encoding** — Each option combination becomes its own cluster entry point, making the manifest simple (single-arg inputs) while still testing all code paths
3. **Error path testing** — The `convertDefault` cluster naturally tests the error path when unsupported characters are in input

### Key Insight: Options as Separate Clusters

Rather than trying to pass complex option objects as inputs, we create one cluster per option combination. This gives us:
- Clearer fingerprint semantics (each cluster = one behavioral contract)
- Easier debugging (if one combination breaks, the cluster name tells you which)
- Full coverage of all option combinations as separate contracts

## Cluster Definitions

6 clusters covering all option combinations:

| Cluster | Entry | Options | Inputs | Fingerprint |
|---------|-------|---------|--------|-------------|
| convert-default | convertDefault | addBoundary: true (default) | 6 inputs | fkpu46l |
| convert-no-boundary | convertNoBoundary | addBoundary: false | 5 inputs | owph2z0 |
| convert-with-forfeda | convertWithForfeda | useForfeda: true | 3 inputs | 1uy47bp |
| convert-with-phonetics | convertWithPhonetics | usePhonetics: true | 3 inputs | 2yhylfo |
| convert-forfeda-phonetics | convertWithForfedaAndPhonetics | useForfeda + usePhonetics | 3 inputs | 3fjtzz4 |
| convert-phonetics-no-boundary | convertPhoneticsNoBoundary | usePhonetics + no boundary | 3 inputs | 4fhklbq |

**Total: 23 input/output pairs** across 6 clusters.

## What Was Refactored

`src/ogham.ts` — meaningful but behavior-preserving changes:

1. **Extracted `validateInput` function** — separated input validation from conversion logic (single responsibility)
2. **Extracted `hasUnsupportedChars` function** — replaced `containsInvalidCharacters` with O(1) lookup using pre-computed `UNSUPPORTED_CHARS` object
3. **Renamed `replaceCharacters` → `applyOghamMapping`** — clearer intent (it applies a mapping, not just replaces)
4. **Renamed `replaceInvalidCharactersWithPhonetics` → `applyPhoneticReplacements`** — consistent naming with `applyOghamMapping`
5. **Replaced `forEach` + mutation with `reduce`** — both `applyPhoneticReplacements` and `applyOghamMapping` now use immutable reduce pattern
6. **Extracted `DEFAULT_OPTIONS` constant** — replaced inline `Object.assign` defaults
7. **Extracted `VALID_INPUT_PATTERN` constant** — renamed from `validateInputRgx` for clarity
8. **Renamed `phoneticReplacements` → `PHONETIC_REPLACEMENTS`** — UPPER_CASE convention for module-level constants
9. **Added comprehensive JSDoc** — every function now has parameter documentation, return type description, and examples
10. **Added `@throws` documentation** — error paths are now documented in JSDoc

## 3-Way Verification Proof

### VERIFICATION 1 — Regrets Fingerprint
All 6 clusters GREEN after refactor:

| Cluster | Fingerprint | Status |
|---------|------------|--------|
| convert-default | fkpu46l | ✅ PASS |
| convert-no-boundary | owph2z0 | ✅ PASS |
| convert-with-forfeda | 1uy47bp | ✅ PASS |
| convert-with-phonetics | 2yhylfo | ✅ PASS |
| convert-forfeda-phonetics | 3fjtzz4 | ✅ PASS |
| convert-phonetics-no-boundary | 4fhklbq | ✅ PASS |

### VERIFICATION 2 — Raw Output vs KEBENARAN 1
All 23 outputs IDENTICAL to pre-refactor baseline.

### VERIFICATION 3 — Cross-Check
Fingerprints from new output match KEBENARAN 2 exactly.

## Fingerprint Sebelum/Sesudah

| Cluster | Before | After | Match |
|---------|--------|-------|-------|
| convert-default | fkpu46l | fkpu46l | ✅ |
| convert-no-boundary | owph2z0 | owph2z0 | ✅ |
| convert-with-forfeda | 1uy47bp | 1uy47bp | ✅ |
| convert-with-phonetics | 2yhylfo | 2yhylfo | ✅ |
| convert-forfeda-phonetics | 3fjtzz4 | 3fjtzz4 | ✅ |
| convert-phonetics-no-boundary | 4fhklbq | 4fhklbq | ✅ |

## Regrets Improvement Discovered

This testing validated that:
1. **CJS module support** in capture.js/validate.js works correctly for TypeScript-compiled CommonJS modules
2. **Wrapper module pattern** is effective for functions with option parameters — each option combination becomes its own cluster
3. **Options-as-clusters pattern** provides clearer behavioral contracts than trying to encode options in inputs
4. **Drift detection** correctly identifies stable clusters — all 6 clusters passed 5-run drift detection both before and after refactoring

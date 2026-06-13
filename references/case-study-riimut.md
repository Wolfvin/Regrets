# Case Study: riimut — Runic Alphabet Translator

A real-world case study demonstrating Regrets regression testing on an unconventional, niche codebase.

## Project Overview

**Repository**: [stscoundrel/riimut](https://github.com/stscoundrel/riimut)
**Domain**: Historical linguistics — transforms Latin letters to/from runic alphabets (Elder Futhark, Younger Futhark, Medieval Futhork, Anglo-Frisian Futhorc)
**Language**: TypeScript (compiled to CommonJS)
**Why niche**: Who translates Viking-era runes in JavaScript? This serves a hyper-niche community of Old Norse linguists and medievalists.

## Cluster Design

9 clusters covering all 5 runic dialects, each with letters-to-runes and runes-to-letters transformation functions:

| Cluster | Entry Function | File | Fingerprint |
|---------|---------------|------|-------------|
| elder-futhark-letters-to-runes | `lettersToRunes` | dist/dialects/elder-futhark.js | 29px81n |
| elder-futhark-runes-to-letters | `runesToLetters` | dist/dialects/elder-futhark.js | 55owsl9 |
| younger-futhark-letters-to-long-branch | `lettersToLongBranchRunes` | dist/dialects/younger-futhark.js | up3kw5s |
| younger-futhark-letters-to-short-twig | `lettersToShortTwigRunes` | dist/dialects/younger-futhark.js | 2r7lqee |
| younger-futhark-runes-to-letters | `runesToLetters` | dist/dialects/younger-futhark.js | 1s8i39c |
| medieval-futhork-letters-to-runes | `lettersToRunes` | dist/dialects/medieval-futhork.js | 5eh2lg7 |
| medieval-futhork-runes-to-letters | `runesToLetters` | dist/dialects/medieval-futhork.js | 3uip1sa |
| futhorc-letters-to-runes | `lettersToRunes` | dist/dialects/futhorc.js | 1f963l9 |
| futhorc-runes-to-letters | `runesToLetters` | dist/dialects/futhorc.js | 5f6z8cr |

## Key Observations

### Pure Functions = Perfect Fingerprinting

All runic transformation functions are **pure** — given the same input, they always produce the same output. This made them ideal candidates for value-mode fingerprinting. Zero drift was detected across 5 runs for all 9 clusters.

### CommonJS Module Handling

riimut compiles TypeScript to CommonJS (`"module": "commonjs"` in tsconfig.json). The capture.js CJS handling (merging `mod.default` with the namespace) worked correctly — the dialect modules export both named exports and a default object.

### Multiple Clusters from Same File

Both `elder-futhark-letters-to-runes` and `elder-futhark-runes-to-letters` reference `dist/dialects/elder-futhark.js`. This is fully supported — each cluster independently imports the module and creates its own ghost proxy. No cross-contamination occurred because the functions are pure and stateless.

### Non-Latin Unicode Characters

The inputs and outputs contain runic Unicode characters (ᚠᚢᚦᚨᚱᚲ etc.). The fingerprint algorithm handles these correctly — `JSON.stringify` and `stableStringify` preserve Unicode characters without issues.

## Refactoring Verified

The following refactoring was performed on riimut and verified safe using Regrets:

1. **transform.ts**: Replaced `for...of` loop with string concatenation → `Array.map().join()` for better performance and readability. Added input type guard (`typeof content !== "string"` → return `""`).

2. **All mapping files** (8 files): Added lazy-initialized caching (memoization) for Map objects. Previously, each call to `getLetterMapping()` / `getRuneMapping()` created a new Map with 30+ entries. After refactoring, the Map is created once and cached in a module-level variable.

### Verification Results

All 3 verification methods confirmed the refactoring was safe:

| Verification | Method | Result |
|-------------|--------|--------|
| VERIFICATION 1 — Regrets | `validate.js` — all clusters GREEN | ✅ 9/9 PASS |
| VERIFICATION 2 — Direct Output | Run functions directly, compare with pre-refactor raw output | ✅ 24/24 IDENTICAL |
| VERIFICATION 3 — Cross-Check | Fingerprint from current output matches saved contract | ✅ 9/9 MATCH |

## Lessons Learned

1. **Pure function libraries are the ideal use case** — zero drift, zero false positives, zero normalization needed.
2. **CommonJS modules work out of the box** — no special configuration needed.
3. **Unicode handling is solid** — runic characters in inputs/outputs fingerprint correctly.
4. **Caching refactoring is safe** — memoization of static data doesn't change behavior, and Regrets proves it.
5. **Multiple clusters per file is fine** — as long as functions don't share mutable state.

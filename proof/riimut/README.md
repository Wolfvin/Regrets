# Proof: Regrets Validated Refactor on stscoundrel/riimut

## Target Repo

**stscoundrel/riimut** — A TypeScript library for transliterating between Latin scripts and Norse runic writing systems (Elder Futhark, Younger Futhark Long Branch/Short Twig, Anglo-Saxon Futhorc, Medieval Futhork).

**Why this repo?** Nobody would think to regression-test a Norse rune transliteration library. It's niche, historical, and absurdly specific — the perfect unlikely test case for Regrets.

## Refactor Summary

### What Changed

1. **`transform.ts` → `transliterate()`**: Renamed the core function from the generic `transform` to the semantically precise `transliterate`. Replaced imperative string concatenation (`for` + `result +=`) with functional `map().join()`. Added `RuneDictionary` type alias for `Map<string, string>`.

2. **All 4 dialect files**: Updated imports to use `transliterate` instead of `transform`. Simplified function bodies by removing unnecessary temp variables (e.g., `const result = transform(...); return result;` → `return transliterate(...)`).

3. **Backward compatibility**: `transform` is kept as a `@deprecated` alias for `transliterate`, so existing consumers are not broken.

### Why This Refactor Is Meaningful

- **Clarity**: `transliterate` accurately describes what the function does — character-by-character mapping between writing systems. `transform` could mean anything.
- **Performance**: `map().join()` avoids O(n²) string concatenation for large inputs.
- **Type safety**: `RuneDictionary` makes the Map's purpose explicit.
- **Maintainability**: Simplified dialect files are easier to read and less error-prone.

## Verification Results

### VERIFICATION 1 — Regrets (Fingerprint Match)

All 9 clusters PASS after refactor. Fingerprints unchanged from pre-refactor capture.

```
✅ elder-futhark-letters-to-runes      29px81n                PASS
✅ elder-futhark-runes-to-letters      55owsl9                PASS
✅ younger-futhark-long-branch         up3kw5s                PASS
✅ younger-futhark-short-twig          2x1neix                PASS
✅ younger-futhark-runes-to-letters    195hrt6                PASS
✅ futhorc-letters-to-runes            26arzan                PASS
✅ futhorc-runes-to-letters            4qfdtnk                PASS
✅ medieval-futhork-letters-to-runes   2zdgtma                PASS
✅ medieval-futhork-runes-to-letters   yvmskqv                PASS
```

### VERIFICATION 2 — Direct Output (KEBENARAN 1)

Ran all entry functions directly after refactor. Compared raw output against pre-refactor ground truth. All 9 IDENTIK.

```
✅ elder-futhark-letters-to-runes           IDENTIK
✅ elder-futhark-runes-to-letters           IDENTIK
✅ younger-futhark-long-branch              IDENTIK
✅ younger-futhark-short-twig               IDENTIK
✅ younger-futhark-runes-to-letters         IDENTIK
✅ futhorc-letters-to-runes                 IDENTIK
✅ futhorc-runes-to-letters                 IDENTIK
✅ medieval-futhork-letters-to-runes        IDENTIK
✅ medieval-futhork-runes-to-letters        IDENTIK
```

### VERIFICATION 3 — Cross Fingerprint (KEBENARAN 2)

Computed fingerprints from post-refactor output and compared against stored KEBENARAN 2. All 9 MATCH.

```
✅ elder-futhark-letters-to-runes           new: 29px81n stored: 29px81n MATCH
✅ elder-futhark-runes-to-letters           new: 55owsl9 stored: 55owsl9 MATCH
✅ younger-futhark-long-branch              new: up3kw5s stored: up3kw5s MATCH
✅ younger-futhark-short-twig               new: 2x1neix stored: 2x1neix MATCH
✅ younger-futhark-runes-to-letters         new: 195hrt6 stored: 195hrt6 MATCH
✅ futhorc-letters-to-runes                 new: 26arzan stored: 26arzan MATCH
✅ futhorc-runes-to-letters                 new: 4qfdtnk stored: 4qfdtnk MATCH
✅ medieval-futhork-letters-to-runes        new: 2zdgtma stored: 2zdgtma MATCH
✅ medieval-futhork-runes-to-letters        new: yvmskqv stored: yvmskqv MATCH
```

## Fingerprint Comparison (Before = After)

| Cluster | Fingerprint | Status |
|---------|-------------|--------|
| elder-futhark-letters-to-runes | 29px81n | IDENTIK |
| elder-futhark-runes-to-letters | 55owsl9 | IDENTIK |
| younger-futhark-long-branch | up3kw5s | IDENTIK |
| younger-futhark-short-twig | 2x1neix | IDENTIK |
| younger-futhark-runes-to-letters | 195hrt6 | IDENTIK |
| futhorc-letters-to-runes | 26arzan | IDENTIK |
| futhorc-runes-to-letters | 4qfdtnk | IDENTIK |
| medieval-futhork-letters-to-runes | 2zdgtma | IDENTIK |
| medieval-futhork-runes-to-letters | yvmskqv | IDENTIK |

## Regrets Improvement Discovered

During Phase 1 (drift detection), a critical false positive bug was discovered in `validate.js`:

**Bug**: When running drift detection (`--runs N`) with clusters that have multiple inputs, fingerprints from different inputs were mixed in the same array. Since different inputs naturally produce different fingerprints, the drift check (`new Set(hashes).size > 1`) always triggered.

**Fix**: In drift mode, only validate the golden input across N runs. See the main PR description for details.

## Files in This Proof

- `KEBENARAN_1_raw_output.json` — Ground truth: raw output from all 9 entry functions before refactor
- `KEBENARAN_2_fingerprints.json` — Contract: stored fingerprints before refactor
- `manifest.json` — Regrets manifest used for this validation
- `*.refactored` — Source code after refactor (for reference)

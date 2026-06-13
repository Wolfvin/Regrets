# Test Case: evanshortiss/ogham

## Why This Repo?

**Ogham** is a library that converts Latin text to Ogham — an ancient Celtic tree alphabet carved into standing stones in Ireland and Wales between the 4th and 9th centuries AD. This is the LEAST obvious choice for regression testing because:

1. **Nobody regression-tests medieval alphabets** — Ogham was last used for practical writing before the Viking Age
2. **Pure functions** — `convert(input, opts)` is deterministic: same input always produces same output
3. **Multiple code paths** — 3 boolean options (`addBoundary`, `useForfeda`, `usePhonetics`) create distinct behavioral branches
4. **Tiny repo** — 2 source files, ~128 lines, zero dependencies
5. **Unicode-heavy** — Tests Regrets' handling of non-ASCII output (Ogham Unicode block U+1680–U+169C)

## Cluster Summary

| Cluster | Entry | Options | Example |
|---------|-------|---------|---------|
| `convert-default` | `convert("eire")` | default (boundary on) | `"eire"` → `"᚛ᚓᚔᚏᚓ᚜"` |
| `convert-no-boundary` | `convert("eire", {addBoundary:false})` | no boundary | `"eire"` → `"ᚓᚔᚏᚓ"` |
| `convert-forfeda` | `convert("tae", {useForfeda:true})` | diphthong ligatures | `"tae"` → `"᚛ᚈᚙ᚜"` (ae → ᚙ) |
| `convert-phonetics` | `convert("jkvwxy", {usePhonetics:true})` | phonetic mapping | `"jkvwxy"` → `"᚛ᚌᚊᚃᚒᚒᚎᚔ᚜"` |

## Bug Found: Drift Detection False Positive

This test case exposed a critical bug in `validate.js` drift detection:

**Symptom**: All 4 clusters reported DRIFT with `--runs 5`, even though each individual run was deterministic.

**Root cause**: When a cluster has multiple `inputs` in the manifest, `runCluster()` flattened hashes from ALL inputs into a single `hashes[]` array. Different inputs naturally produce different fingerprints, so `new Set(hashes).size > 1` was always true.

**Fix**: Track per-input hash arrays separately. Only report drift when the SAME input produces different hashes across runs.

## Refactor Performed

After Regrets confirmed all clusters were stable, we refactored `ogham.ts`:

1. Replaced mutable `forEach` with functional `reduce` in transliterate()
2. Replaced imperative for-loop with `some()` in hasUnsupportedChars()
3. Removed stateful `/g` flag from validation regex
4. Renamed functions for clarity: `replaceCharacters` → `transliterate`, `containsInvalidCharacters` → `hasUnsupportedChars`
5. Extracted validation logic into separate `validateInput()` function
6. Introduced `DEFAULT_OPTIONS` constant

### 3-Layer Verification Results

| Verification | Method | Result |
|-------------|--------|--------|
| **VERIFIKASI 1** | Regrets validate | ✅ All 4 clusters GREEN |
| **VERIFIKASI 2** | Direct output vs KEBENARAN 1 | ✅ All outputs identical |
| **VERIFIKASI 3** | Fingerprint vs KEBENARAN 2 | ✅ All fingerprints match |

### KEBENARAN 1 (Raw Output Before Refactor)

```
convert-default: "eire" → "᚛ᚓᚔᚏᚓ᚜"
convert-default: "is maith liom tae" → "᚛ᚔᚄ ᚋᚐᚔᚈᚆ ᚂᚔᚑᚋ ᚈᚐᚓ᚜"
convert-default: "abc" → "᚛ᚐᚁᚉ᚜"
convert-default: "" → "᚛᚜"
convert-no-boundary: "eire" → "ᚓᚔᚏᚓ"
convert-no-boundary: "abc" → "ᚐᚁᚉ"
convert-forfeda: "is maith liom tae" → "᚛ᚔᚄ ᚋᚐᚔᚈᚆ ᚂᚔᚑᚋ ᚈᚙ᚜"
convert-forfeda: "ae oi ui ia" → "᚛ᚙ ᚖ ᚗ ᚘ᚜"
convert-phonetics: "jkvwxy" → "᚛ᚌᚊᚃᚒᚒᚎᚔ᚜"
convert-phonetics: "keys" → "᚛ᚊᚓᚔᚄ᚜"
```

### KEBENARAN 2 (Fingerprints Before Refactor)

| Cluster | Fingerprint |
|---------|------------|
| convert-default | fkpu46l |
| convert-no-boundary | 1qz85pl |
| convert-forfeda | 4it7h6l |
| convert-phonetics | 34dtcwq |

### Fingerprints After Refactor (IDENTICAL)

| Cluster | Fingerprint | Match? |
|---------|------------|--------|
| convert-default | fkpu46l | ✅ |
| convert-no-boundary | 1qz85pl | ✅ |
| convert-forfeda | 4it7h6l | ✅ |
| convert-phonetics | 34dtcwq | ✅ |

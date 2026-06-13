# Epitran Refactor Proof — Regrets Regression Testing

## Target Repository
[dmort27/epitran](https://github.com/dmort27/epitran) — A Python tool for transcribing orthographic text as IPA (International Phonetic Alphabet)

## Why epitran?
The LEAST obvious choice for regression testing — who tests IPA transcription libraries? This proves Regrets works on multi-language transliteration pipelines with class-based APIs, schema-mode fingerprinting, and chain testing across conversion steps.

## What Was Refactored
Core modules — meaningful but behavior-preserving changes:

1. **Renamed `_non_deterministic_mappings` → `_find_ambiguous_mappings`** — clearer intent
2. **Renamed `_load_g2p_map` → `_load_grapheme_to_phoneme_map`** — self-documenting name
3. **Renamed `_construct_regex` → `_build_greedy_match_regex`** — explains maximal munch strategy
4. **Renamed `is_korean` → `contains_korean_syllables`** — precisely describes what's detected
5. **Renamed `ligaturize` → `convert_affricates_to_ligatures`** — self-explanatory (alias preserved)
6. **Extracted `AFFRICATE_LIGATURES` module constant** — data separated from logic
7. **Renamed `StripDiacritics.process` → `strip_specified_diacritics`** — no more generic "process" (alias preserved)
8. **Renamed `_fields_to_function` → `_compile_replacement_rule`** — describes what's compiled
9. **Renamed `_fields_to_function_metathesis` → `_compile_metathesis_rule`** — same pattern
10. **Renamed `_sub_symbols` → `_expand_symbol_references`** — describes transformation
11. **Extracted `SPECIAL_LANGUAGE_BACKENDS` module constant** — discoverable and maintainable
12. **Added backward-compatible aliases** for all renamed public methods

## 4-Way Verification Proof

### VERIFICATION 1 — Regrets Fingerprint
All 10 clusters GREEN after refactor:

| Cluster | Fingerprint | Status |
|---------|------------|--------|
| spa-transliterate | 5x4d98i | ✅ PASS |
| deu-transliterate | 5j37svh | ✅ PASS |
| fra-transliterate | 3f8syig | ✅ PASS |
| spa-strict-trans | 5x4d98i | ✅ PASS |
| spa-word-to-tuples | 6724o1o | ✅ PASS |
| ligaturize | 5pxpkk6 | ✅ PASS |
| puncnorm | 1z6dwyb | ✅ PASS |
| strip-diacritics | 2daij2n | ✅ PASS |
| ipa-to-xsampa | 5u5264e | ✅ PASS |
| rules-apply | 4mcbm7s | ✅ PASS |

### VERIFICATION 2 — Raw Output vs KEBENARAN 1
All 40 outputs IDENTICAL to pre-refactor baseline.

### VERIFICATION 3 — Fingerprint Cross-Check
All 10 fingerprints match KEBENARAN 2.

### VERIFICATION 4 — Chain Validation
All 5 chains MATCH pre-refactor chain hashes:

| Chain | Hash | Status |
|-------|------|--------|
| spanish-to-xsampa | 389p9re | ✅ |
| spanish-to-ligatures | 6w1sy7s | ✅ |
| french-pipeline | 4ue8mxi | ✅ |
| german-pipeline | 9ljbs80 | ✅ |
| preprocess-transliterate-postprocess | 2slbp3y | ✅ |

## Fingerprint Before/After

| Cluster | Before | After | Match |
|---------|--------|-------|-------|
| spa-transliterate | 5x4d98i | 5x4d98i | ✅ |
| deu-transliterate | 5j37svh | 5j37svh | ✅ |
| fra-transliterate | 3f8syig | 3f8syig | ✅ |
| spa-strict-trans | 5x4d98i | 5x4d98i | ✅ |
| spa-word-to-tuples | 6724o1o | 6724o1o | ✅ |
| ligaturize | 5pxpkk6 | 5pxpkk6 | ✅ |
| puncnorm | 1z6dwyb | 1z6dwyb | ✅ |
| strip-diacritics | 2daij2n | 2daij2n | ✅ |
| ipa-to-xsampa | 5u5264e | 5u5264e | ✅ |
| rules-apply | 4mcbm7s | 4mcbm7s | ✅ |

# Case Study: epitran — IPA Transcription Library

**Repository**: https://github.com/dmort27/epitran
**Description**: A tool for transcribing orthographic text as IPA (International Phonetic Alphabet)
**Language**: Python
**Dependencies**: panphon, marisa-trie, jamo, regex

## Why epitran?

Epitran is one of the most niche targets for regression testing — who tests an IPA transcription library? It supports 50+ language/script pairs and has complex class-based APIs with multiple backends (SimpleEpitran, FliteLexLookup, Epihan, etc.). This proves Regrets works on:

- Multi-language transliteration pipelines
- Class-based APIs requiring adapter modules
- Schema-mode fingerprinting for complex tuple outputs
- Chain testing across language conversion steps
- Pure mapping functions with no external dependencies

## Adapter Pattern for Class-Based APIs

Epitran's main API is class-based: `Epitran('spa-Latn').transliterate('hola')`. Since Regrets needs standalone entry functions, we created thin adapter modules:

```python
# epitran/adapters/spa_transliterate.py
from epitran.simple import SimpleEpitran

_epi = SimpleEpitran('spa-Latn', preproc=True, postproc=True, ligatures=False)

def transliterate(text, normpunc=False, ligatures=False):
    return _epi.transliterate(text, normpunc, ligatures)

def general_trans(text, filter_func, normpunc=False, ligatures=False):
    return _epi.general_trans(text, filter_func, normpunc, ligatures)
```

This pattern is reusable for any class-based Python library.

## Schema-Mode Fingerprinting for Complex Outputs

`word_to_tuples()` returns deeply nested tuples with category, case, orthographic form, phonetic form, and feature vectors. Value-mode fingerprinting would be brittle — the exact feature vectors could change with panphon updates. Schema mode captures the structure:

```json
{
  "id": "spa-word-to-tuples",
  "fingerprintMode": "schema",
  "description": "Spanish word to tuples (structural)"
}
```

## Chain Testing: Multi-Step IPA Pipelines

Chains validate that clusters compose correctly end-to-end:

1. **spanish-to-xsampa**: transliterate('hola') → ipa2xs('ola')
2. **french-pipeline**: transliterate('bonjour') → ipa2xs('bɔ̃ʒuʁ')
3. **german-pipeline**: transliterate('hallo') → ligaturize('haloː')
4. **spanish-to-ligatures**: transliterate('queso') → ligaturize('keso')
5. **preprocess-transliterate-postprocess**: strip_diacritics('áéíóú') → transliterate('hola')

## Clusters Created

| Cluster ID | Entry Function | Mode | Fingerprint |
|---|---|---|---|
| spa-transliterate | transliterate | value | 5x4d98i |
| deu-transliterate | transliterate | value | 5j37svh |
| fra-transliterate | transliterate | value | 3f8syig |
| spa-strict-trans | strict_trans | value | 5x4d98i |
| spa-word-to-tuples | word_to_tuples | schema | 6724o1o |
| ligaturize | ligaturize | value | 5pxpkk6 |
| puncnorm | norm | value | 1z6dwyb |
| strip-diacritics | process | value | 2daij2n |
| ipa-to-xsampa | ipa2xs | value | 5u5264e |
| rules-apply | apply | value | 4mcbm7s |

## Results

- **Capture**: 10/10 clusters captured successfully
- **Validate**: 10/10 GREEN
- **Drift Detection**: 10/10 STABLE across 5 runs
- **Health**: 10/10 SOLID
- **Chain Capture**: 5/5 chains captured
- **Chain Validate**: 5/5 chains MATCH
- **False Positives**: ZERO

## Refactoring Performed

1. **Renamed `_non_deterministic_mappings` → `_find_ambiguous_mappings`** — clearer intent: this method finds graphemes that map to multiple phonemes
2. **Renamed `_load_g2p_map` → `_load_grapheme_to_phoneme_map`** — the abbreviation "g2p" is opaque; the full name is self-documenting
3. **Renamed `_construct_regex` → `_build_greedy_match_regex`** — "construct" is generic; "greedy match" explains the maximal munch tokenization strategy
4. **Renamed `is_korean` → `contains_korean_syllables`** — "is_korean" is vague (Korean text? Korean language?); the new name precisely describes what's detected
5. **Renamed `ligaturize` → `convert_affricates_to_ligatures`** — "ligaturize" is a made-up verb; the new name is self-explanatory (backward-compatible alias preserved)
6. **Extracted `AFFRICATE_LIGATURES` module constant** — mapping data separated from function logic
7. **Renamed `StripDiacritics.process` → `strip_specified_diacritics`** — "process" is the most generic name possible; the new name describes exactly what's stripped (backward-compatible alias preserved)
8. **Renamed `_fields_to_function` → `_compile_replacement_rule`** — describes what's compiled (a replacement rule) rather than the internal mechanism
9. **Renamed `_fields_to_function_metathesis` → `_compile_metathesis_rule`** — same pattern: describes the rule type
10. **Renamed `_sub_symbols` → `_expand_symbol_references`** — "sub" is ambiguous; "expand symbol references" describes the transformation
11. **Extracted `SPECIAL_LANGUAGE_BACKENDS` module-level constant** — the special backends dict was buried inside the class; extracting it makes it easier to discover and maintain
12. **Added backward-compatible aliases** for all renamed functions/methods to avoid breaking existing code

## Dual-Truth Verification

### VERIFICATION 1 — Regrets Fingerprint
All 10 clusters GREEN after refactor.

### VERIFICATION 2 — Raw Output vs KEBENARAN 1
All 40 outputs IDENTICAL to pre-refactor baseline.

### VERIFICATION 3 — Fingerprint Cross-Check
All 10 fingerprints match KEBENARAN 2.

### VERIFICATION 4 — Chain Validation
All 5 chains MATCH pre-refactor chain hashes.

## Key Insights

1. **Schema mode is essential for complex outputs.** `word_to_tuples()` returns deeply nested structures with feature vectors. Value mode would be too brittle; schema mode captures the structural contract.

2. **Adapter modules are the cleanest pattern for class-based APIs.** No Regrets modifications needed — just thin wrapper modules that instantiate the class and expose methods as standalone functions.

3. **Chain testing catches cross-cluster regressions.** A change in `transliterate` could break the downstream `ipa2xs` conversion. Chains validate the full pipeline end-to-end.

4. **Python chain testing was missing from Regrets.** The existing `contest.mjs` only supports JS modules. The new `contest.py` provides equivalent functionality for Python stacks, reading the same `chains.json` format and producing the same `.chain` file format.

5. **Backward-compatible aliases are essential for behavioral regression testing.** When renaming public methods, keeping old names as aliases ensures no fingerprint changes.

# Case Study: Hebrew Gematria Library (avi-perl/Hebrew)

This case study documents the experience of applying Regrets to `avi-perl/Hebrew`, a niche Python library for computing Hebrew Gematria (Jewish numerology) with 23 different calculation methods. The library is a challenging target because it relies heavily on class-based instance methods rather than standalone functions, requires an external `grapheme` dependency for Unicode handling, and involves cultural domain knowledge that most developers would never encounter.

## Repository

- **URL**: https://github.com/avi-perl/Hebrew
- **Stars**: 42
- **Language**: Python
- **Description**: A Python package for Hebrew text manipulation, Gematria calculation (23 methods), and number-to-Hebrew-letter conversion
- **Why niche**: Gematria is a Jewish numerology system where each Hebrew letter has a numerical value, used in Torah study and Kabbalistic tradition. Most developers outside of Jewish scholarship have never heard of it. The library supports 23 different calculation methods including Mispar Hechrachi (standard), AtBash (alphabet reversal), Mispar Bone'eh (progressive building), Mispar Ne'elam (hidden value), and more.

## Challenges Encountered

### 1. Class-Based API Requires Adapter Pattern

The `Hebrew` class exposes all functionality through instance methods (`Hebrew("שלום").gematria()`), but Regrets' Python capture/validate system expects standalone importable functions. **Solution**: Create a `regret_adapters.py` module that wraps class methods as standalone pure functions:

```python
def gematria_hechrachi(text: str) -> int:
    """Calculate Mispar Hechrachi (standard) gematria."""
    return Hebrew(text).gematria(method=GematriaTypes.MISPAR_HECHRACHI)
```

This pattern works because:
- Each adapter creates a fresh `Hebrew` instance per call (no shared state)
- All Gematria methods are pure (same input → same output)
- The adapter is thin — no logic added, just function wrapping

### 2. Multiple Clusters from Related Functions

The `Hebrew.gematria()` method supports 23 different calculation methods via a single method with an enum parameter. We created 9 separate clusters (one per method tested) by creating individual adapter functions for each method. This provides better isolation than trying to fingerprint a multi-method function.

### 3. Zero False Positives on First Attempt

Unlike the `pustaka` case study which also had zero false positives, this library's design is even more purely functional. Every Gematria calculation is deterministic — no timestamps, no random values, no I/O. This makes it an ideal candidate for Regrets fingerprinting. The 12 clusters were captured and validated on the first attempt with zero drift across 5 runs.

### 4. Number-to-Hebrew Conversion with Substitution Rules

The `number_to_hebrew_string` function has culturally-sensitive substitution rules (e.g., 15 becomes "טו" instead of "יה" because "יה" spells a form of God's name). Testing with `substitution_functions=None` was essential to verify the raw conversion logic separately from the cultural substitutions.

## Cluster Manifest

12 clusters were defined covering 3 categories of functionality:

### Number-to-Hebrew Conversion (2 clusters)
- `num-to-hebrew`: Default conversion with substitutions
- `num-to-hebrew-no-subst`: Raw conversion without substitution rules

### Gematria Calculations (7 clusters)
- `gematria-hechrachi`: Standard value (Mispar Hechrachi)
- `gematria-gadol`: Extended final letter values (Mispar Gadol)
- `gematria-atbash`: Alphabet reversal (AtBash)
- `gematria-musafi`: Value + letter count (Mispar Musafi)
- `gematria-boneeh`: Progressive building sum (Mispar Bone'eh)
- `gematria-hamerubah`: Squared value (Mispar HaMerubah HaKlali)
- `gematria-katan-mispari`: Digital root (Mispar Katan Mispari)

### String Manipulation (3 clusters)
- `hebrew-text-only`: Strip non-letter characters
- `hebrew-no-niqqud`: Remove vowel points
- `hebrew-no-maqaf`: Replace Hebrew hyphens with spaces

## Results

- **Capture**: 12/12 clusters captured successfully
- **Validate**: 12/12 GREEN on first run
- **Drift Detection**: 12/12 STABLE across 5 runs
- **Health**: 12/12 SOLID
- **False Positives**: ZERO — no iteration needed

## Refactoring Performed

1. **Extracted gematria dispatch pattern** — Replaced the massive 100+ line if-elif chain in `Hebrew.gematria()` with a dispatch dictionary pattern and individual calculator methods (`_gematria_musafi`, `_gematria_boneeh`, etc.)
2. **Extracted shared final-letter replacement** — Created `_get_letters_with_replaced_finals()` static method to eliminate code duplication between Mispar Shemi Milui and Mispar Ne'elam
3. **Decomposed number conversion** — Split `number_to_hebrew_string` into `_decompose_number()`, `_build_letter_components()`, and `_add_punctuation()` for better readability
4. **Cleaned up mappings.py** — Fixed duplicate docstrings, consolidated formatting

All 3 verifications passed after refactoring:
1. ✅ Regrets validate: All 12 clusters GREEN
2. ✅ Direct output comparison: All outputs identical to pre-refactor truth
3. ✅ Cross-fingerprint verification: All fingerprints match pre-refactor truth

## Lessons Learned

1. **The adapter pattern is essential for class-based libraries.** Many Python libraries use class-based APIs rather than standalone functions. The adapter module pattern (thin wrappers) makes these testable with Regrets without modifying the original library.

2. **Pure domain logic libraries are ideal Regrets targets.** Libraries that compute deterministic values (like Gematria, calendar systems, mathematical functions) produce inherently stable fingerprints. Zero configuration needed for normalization rules.

3. **One cluster per method is better than one cluster per class.** Rather than trying to fingerprint a multi-method function with enum parameters, create separate adapter functions and clusters. This gives better isolation and clearer failure diagnostics.

4. **Test substitution functions separately.** When a function has optional transformation steps (like Gematria's cultural substitution rules), create separate clusters with and without those steps to isolate the core logic from the cultural transformations.

# Korean Romanizer Case Study

## Target Repository

**osori/korean-romanizer** — A Python library for Korean Revised Romanization.
Converts Korean Hangul text to Latin script following the official
Revised Romanization of Korean standard.

**Why this was chosen:** Korean romanization is an extremely niche and
unlikely target for regression testing. It has pure, deterministic
functions (same Hangul input always produces the same Latin output),
making it ideal for fingerprint-based regression. The domain specificity
(Hangul phonology rules, Unicode jamo decomposition) means regressions
are subtle and easy to miss with traditional testing.

## Challenges & Solutions

### Challenge 1: Class-based API with constructor side effects

The library exposes `Romanizer(text).romanize()` and
`Pronouncer(text).pronounced` — both instantiate a class and
immediately compute a result in `__init__`. The Regrets Python capture
script expects standalone top-level functions as entry points.

**Solution:** Adapter module pattern. We created `regrets_adapter.py`
that wraps each class-based entry point into a standalone function:

```python
from korean_romanizer.romanizer import Romanizer

def romanize(text):
    """Top-level romanize entry point for regret capture."""
    return Romanizer(text).romanize()
```

This pattern is the Python equivalent of the JS wrapper module pattern
documented in `references/class-based.md`. The adapter lives in the
target project root and is referenced via `pythonPath: "."` in the
manifest.

### Challenge 2: Object return values need serialization

`Syllable(char)` returns an object with `initial`, `medial`, `final`
attributes. The Regrets fingerprint algorithm serializes output to JSON
before hashing. Custom objects don't serialize well unless they return
plain dicts.

**Solution:** The adapter function converts the object to a dict:

```python
def decompose_syllable(char):
    s = Syllable(char)
    return {
        "initial": s.initial,
        "medial": s.medial,
        "final": s.final,
        "reconstructed": str(s),
    }
```

This ensures consistent JSON serialization and deterministic
fingerprinting.

### Challenge 3: Private module functions as clusters

The library's internal functions (`_is_romanizable_hangul`,
`_romanize_syllable`, `_romanize_non_syllable`) are prefixed with
underscore (Python convention for private). Regrets needs to call them
as entry points.

**Solution:** The adapter imports private functions and re-exports them
with public names. This is acceptable because the adapter is a test-only
artifact — it does not change the library's public API.

## Cluster Design

| Cluster | Entry Function | Inputs | Purpose |
|---------|---------------|--------|---------|
| romanize-text | `romanize` | 9 Korean strings | End-to-end romanization |
| pronounce-text | `pronounce_text` | 7 Korean strings | Pronunciation sandhi rules |
| decompose-syllable | `decompose_syllable` | 4 characters | Syllable decomposition |
| romanize-single-char | `romanize_single_char` | 4 characters | Single character romanization |
| is-romanizable-hangul | `is_romanizable_hangul` | 5 characters | Hangul character detection |

## Manifest Configuration

```json
{
  "clusters": [
    {
      "id": "romanize-text",
      "entry": "romanize",
      "watches": ["romanize"],
      "stack": "python",
      "module": "regrets_adapter",
      "pythonPath": ".",
      "inputs": ["안녕하세요", "구미", "영동", "밝다", "강약", "좋아하고", "앉아봐", "닭의", "Hello, 안녕? 123"]
    }
  ]
}
```

Key manifest features used:
- `pythonPath: "."` — adds the project root to `sys.path` for adapter import
- `module: "regrets_adapter"` — dot-notation Python module path
- Mixed Korean and ASCII inputs — verifies non-Hangul passthrough

## Phase 1 Results

- 5 clusters captured, 0 failures
- 5-run drift detection: ALL PASS+STABLE
- No false positives detected
- No normalization rules needed (output is fully deterministic)

## Phase 2 — Two Truths

**Truth 1 (Raw Output):** All entry function return values saved to
`regrets/truth_1_raw_output.json` as a complete snapshot.

**Truth 2 (Regrets Fingerprint):** All cluster fingerprints from Phase 1
saved to `regrets/truth_2_fingerprints.json`.

Verification: Cross-computed fingerprints from Truth 1 data match
Truth 2 exactly — no false negatives.

## Phase 3 — Refactoring Proven Safe

### What Was Refactored

1. **Moved Unicode data from `syllable.py` to `tables.py`** — reversed
   the dependency direction so `tables.py` is a pure data leaf with no
   project-internal imports. This eliminated a circular dependency
   triangle.

2. **Decomposed `Pronouncer.final_substitute()`** — split a 97-line
   monolithic method into 5 focused methods:
   - `_determine_context()` — phonological context detection
   - `_apply_representative_sound()` — coda reduction rules 1-3
   - `_apply_h_rules()` — ㅎ (hiut) pronunciation rules
   - `_apply_double_consonant_linking()` — 겹받침 vowel linking
   - `_apply_single_consonant_linking()` — 홑받침 vowel linking

3. **Extracted pronunciation rule data to `tables.py`** — moved
   `DOUBLE_CONSONANT_FINAL`, `REPRESENTATIVE_SOUND`, `WITHOUT_H_FINAL`,
   `ASPIRATION_MAP` from inline code in `pronouncer.py` to `tables.py`
   as named constants.

4. **Improved naming** — renamed tables from generic names (`vowel`,
   `onset`, `coda`) to descriptive names (`VOWEL_ROMANIZATION`,
   `ONSET_ROMANIZATION`, `CODA_ROMANIZATION`) with backward-compatible
   aliases. Renamed `_romanize_non_syllable` →
   `_romanize_standalone_jamo`. Moved `_is_romanizable_hangul` to
   `syllable.py` as `is_hangul_char()`.

5. **Fixed `Syllable.__repr__`/`__str__` mutation bug** — these methods
   were calling `construct_syllable()` which mutated `self.char`. Made
   `_compose()` pure and added explicit `sync_char()` for when mutation
   is needed.

6. **Made `Syllable._decompose()` and `_is_composed_syllable_block()`
   static methods** — they don't depend on instance state.

7. **Replaced magic number 4352** with `_UNICODE_INITIAL_START` constant.

### 3-Verification Proof

| Verification | Result |
|-------------|--------|
| Regrets validate (all clusters) | ✅ ALL GREEN |
| Raw output vs Truth 1 | ✅ IDENTICAL |
| Cross-fingerprint vs Truth 2 | ✅ ALL MATCH |

All 61 existing pytest tests also pass after refactoring.

## Lessons for the Regrets Skill

### Lesson 1: Python Adapter Module Pattern

When the target library uses class-based APIs, create an adapter module
that wraps class methods into standalone functions. This is a
well-established pattern for JS (see `class-based.md`) but needs
explicit documentation for Python.

The adapter module should:
- Live in the target project root (not in `regrets/`)
- Use `pythonPath: "."` in the manifest
- Convert class instances to plain dicts for serialization
- Re-export private functions with public names when needed

### Lesson 2: Object-to-Dict Serialization

Python objects with attributes don't serialize consistently via
`json.dumps()`. When the target returns custom objects, the adapter
must convert them to plain dicts with explicit field selection.

This is especially important for:
- `@dataclass` objects — use `dataclasses.asdict()`
- Custom classes — manually construct dicts from attributes
- Objects with `__str__` — include the string representation as a field

### Lesson 3: String Inputs with Unicode

Korean (and other CJK) text works perfectly as Regrets input. The
fingerprint algorithm handles Unicode correctly through `stable_dumps()`.
No special configuration or normalization is needed for non-ASCII
strings.

This means Regrets is well-suited for testing any localization,
internationalization, or transliteration library — a domain where
regression bugs are particularly insidious because they can break
specific character combinations while leaving others working.

### Lesson 4: No Normalization Needed for Pure Functions

Libraries with purely deterministic functions (same input → same output)
require no normalization rules at all. This contrasts with the common
case where `timestamps`, `uuids`, or `epochs` need normalization.

For romanization/transliteration libraries, the entire output is
deterministic, making them ideal first targets for Regrets adoption.

# gimeltra Case Study — Semitic Script Transliteration

## Target Repository
[twardoch/gimeltra](https://github.com/twardoch/gimeltra) — No-nonsense transliteration between Semitic writing systems (Hebrew, Arabic, Syriac, Phoenician, Ugaritic, and 20+ others)

## Why gimeltra?
The LEAST obvious choice for regression testing — who regression-tests ancient Semitic script transliteration? This makes it the perfect edge case to prove Regrets works on unexpected domains. gimeltra converts between 25 writing systems using OpenType-style feature tables, with pure deterministic string transformations that are ideal for fingerprint-based testing, yet nobody in the assyriology or Semitic linguistics community would think to apply automated regression testing to their transliteration tools.

## Class-Based API Adapter Pattern
gimeltra uses a `Transliterator` class that loads data from a JSON file on instantiation. To make this work with Regrets' Ghost Decorator pattern (which requires fresh instances for each call to avoid state leakage), we created adapter functions in `regret_adapters.py`:

```python
from gimeltra.gimeltra import Transliterator

def tr_hebr_latn(text):
    """Transliterate Hebrew to Latin — fresh instance per call."""
    return Transliterator().tr(text, sc="Hebr", to_sc="Latn")
```

This pattern ensures:
- Each call creates a **fresh Transliterator instance** — no rotor/state leakage
- Functions are **pure** — same input always produces the same output
- Functions are **stateless** — no side effects between calls
- The `multiArgs` manifest field is not needed — each function takes a single string argument

## 8 Clusters Captured

| Cluster | Script Direction | Inputs | Fingerprint |
|---------|-----------------|--------|-------------|
| hebrew-to-latin | Hebr → Latn | 4 | 1to7ewp |
| arabic-to-latin | Arab → Latn | 3 | 4q0619s |
| syriac-to-latin | Syrc → Latn | 2 | 4ohe55l |
| phoenician-to-latin | Phnx → Latn | 2 | 1nqaivd |
| ugaritic-to-latin | Ugar → Latn | 2 | 65wlupt |
| latin-to-hebrew | Latn → Hebr | 2 | 2r40yhc |
| latin-to-arabic | Latn → Arab | 2 | ip358zn |
| auto-script-detect | Auto → ISO 15924 | 4 | 3yqwgev |

## Structural Refactoring Performed

### gimeltra/gimeltra.py (92 lines → 168 lines with documentation)

1. **Honest naming** — Replaced cryptic internal names:
   - `_tr()` → `_transliterate_pipeline()` — describes the three-stage pipeline
   - `_preprocess()` → `_normalize_input()` — explains the normalization stage
   - `_postprocess()` → `_apply_final_forms_and_ligatures()` — describes what it actually does
   - `_convert()` → `_convert_characters()` — more descriptive
   - `cwd` → `_DATA_DIR` — module-level constant with clear purpose
   - `db` → `_direct_map` — explains it's the direct character mapping
   - `db_ccmp` → `_composition_rules` — OpenType ccmp feature
   - `db_simplify` → `_simplification_rules` — diacritic stripping rules
   - `db_fina` → `_final_form_rules` — OpenType fina feature
   - `db_liga` → `_ligature_rules` — OpenType liga feature
   - Variable `t` → descriptive names (`result`, `normalized`, `converted`, `finalized`)
   - Variable `c` → `char` — self-documenting

2. **Single responsibility** — Extracted `_load_data()` from `__init__()` so data loading is a separate, testable operation

3. **Cohesion** — Added module-level docstring explaining the package's purpose and the class docstring explaining the pipeline

4. **Documentation** — Every method now has a complete docstring with Args/Returns describing the parameters and return values

5. **Reduced coupling** — Introduced `_UNKNOWN_SCRIPT` constant instead of inline `"Zyyy"` string

## 3-Way Verification Proof

### VERIFICATION 1 — Regrets Fingerprint
All 8 clusters GREEN after refactor:

| Cluster | Fingerprint | Status |
|---------|------------|--------|
| hebrew-to-latin | 1to7ewp | PASS |
| arabic-to-latin | 4q0619s | PASS |
| syriac-to-latin | 4ohe55l | PASS |
| phoenician-to-latin | 1nqaivd | PASS |
| ugaritic-to-latin | 65wlupt | PASS |
| latin-to-hebrew | 2r40yhc | PASS |
| latin-to-arabic | ip358zn | PASS |
| auto-script-detect | 3yqwgev | PASS |

### VERIFICATION 2 — Raw Output vs KEBENARAN 1
All outputs IDENTICAL to pre-refactor baseline.

### VERIFICATION 3 — Cross-Check
Fingerprints from new output match KEBENARAN 2 exactly.

## Regrets Improvement Discovered

This testing validated that Regrets' Python stack works correctly on:
- Class-based APIs with fresh-instance-per-call adapter pattern
- Unicode-heavy outputs (Hebrew, Arabic, Syriac, Phoenician, Ugaritic scripts)
- Auto-detection functions (returns short ISO 15924 codes instead of complex objects)
- Bidirectional transliteration (Latin → target AND target → Latin)
- Multi-script library covering 25 writing systems

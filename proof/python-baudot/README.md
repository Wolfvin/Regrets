# python-baudot Refactor Proof — Regrets Regression Testing

## Target Repository
[xvillaneau/python-baudot](https://github.com/xvillaneau/python-baudot) — A Python library for 5-bit stateful Baudot teleprinter encoding

## Why python-baudot?
The LEAST obvious choice for regression testing — nobody tests 1870s teleprinter encoding libraries! This makes it the perfect edge case to prove Regrets works on unexpected domains, especially stateful encoding systems.

## What Was Refactored
Multiple files with meaningful but behavior-preserving changes:

### `baudot/codecs/core.py`
1. **Replaced `collections.namedtuple` with `dataclass(frozen=True)`** for `Shift` — modern Python idiom, explicitly documents the `name` field, maintains hashability for dict keys
2. **Added constants** `CODE_MIN`, `CODE_MAX`, `TABLE_SIZE` — replaced magic numbers with named constants
3. **Renamed `_make_simple_encoding_table` → `_build_encoding_tables`** — clearer verb
4. **Improved variable names** in `_build_encoding_tables`: `match_set` instead of `match`, `code_matches` instead of `matches`, `code_index` instead of `i`, `shift_state` instead of `shift`
5. **Enhanced docstrings** with parameter documentation and behavioral descriptions
6. **Added detailed docstrings** to `BaudotCodec` abstract methods
7. **Reorganized encoding table builder** with clearer conditional structure

### `baudot/core.py`
1. **Extracted `_encode_single_char` helper** from the inline loop in `encode()`
2. **Extracted `_decode_single_code` helper** from the inline loop in `decode()`
3. **Added comprehensive docstrings** to all functions including the new helpers
4. **Improved parameter documentation** with types and behavior

### `baudot/handlers/tape.py`
1. **Replaced `namedtuple` with `dataclass(frozen=True)`** for `TapeConfig`
2. **Added docstrings** to `TapeConfig` and its fields
3. **Improved variable names**: `binary_str` instead of inline format, `visual` instead of `chars`, `bit_value_pairs` instead of `pairs`
4. **Added constants documentation** for `MSB_FIRST` bit weights

### `baudot/handlers/hexbytes.py`
1. **Extracted `_validate_code` helper** — shared validation for code range
2. **Added constants** `CODE_MIN`, `CODE_MAX`
3. **Enhanced docstrings** with behavioral descriptions

### `baudot/exceptions.py`
1. **Added `__all__` export list** — explicit public API
2. **Added descriptive docstrings** to every exception class explaining when it's raised

## 3-Way Verification Proof

### VERIFICATION 1 — Regrets Fingerprint
All 11 clusters GREEN after refactor:

| Cluster | Fingerprint | Status |
|---------|------------|--------|
| encode-ita2-standard | 4sx2nsu | ✅ PASS |
| decode-ita2-standard | 3un3ov9 | ✅ PASS |
| encode-ita2-us | 4sx2nsu | ✅ PASS |
| decode-ita2-us | 3un3ov9 | ✅ PASS |
| encode-ita1-continental | 1287jiv | ✅ PASS |
| decode-ita1-continental | 3m5sbq3 | ✅ PASS |
| codec-encode-char | 58irgya | ✅ PASS |
| codec-decode-code | 37m8285 | ✅ PASS |
| roundtrip-ita2-standard | 55n3xxh | ✅ PASS |
| roundtrip-ita2-us | 55n3xxh | ✅ PASS |
| roundtrip-ita1-continental | 480fcig | ✅ PASS |

### VERIFICATION 2 — Raw Output vs KEBENARAN 1
All outputs IDENTICAL to pre-refactor baseline. See `KEBENARAN_1_raw_output.json`.

### VERIFICATION 3 — Cross-Check
Fingerprints from new output match KEBENARAN 2 exactly. See `KEBENARAN_2_fingerprints.json`.

## Fingerprint Sebelum/Sesudah

| Cluster | Before | After | Match |
|---------|--------|-------|-------|
| encode-ita2-standard | 4sx2nsu | 4sx2nsu | ✅ |
| decode-ita2-standard | 3un3ov9 | 3un3ov9 | ✅ |
| encode-ita2-us | 4sx2nsu | 4sx2nsu | ✅ |
| decode-ita2-us | 3un3ov9 | 3un3ov9 | ✅ |
| encode-ita1-continental | 1287jiv | 1287jiv | ✅ |
| decode-ita1-continental | 3m5sbq3 | 3m5sbq3 | ✅ |
| codec-encode-char | 58irgya | 58irgya | ✅ |
| codec-decode-code | 37m8285 | 37m8285 | ✅ |
| roundtrip-ita2-standard | 55n3xxh | 55n3xxh | ✅ |
| roundtrip-ita2-us | 55n3xxh | 55n3xxh | ✅ |
| roundtrip-ita1-continental | 480fcig | 480fcig | ✅ |

## Key Insight
The `namedtuple` → `dataclass(frozen=True)` refactor is particularly interesting because both produce hashable, immutable objects with `.name` attribute access. The Regrets fingerprints remained identical because the behavioral contract (encoding/decoding outputs) was preserved — proving that Regrets correctly tests the contract, not the implementation.

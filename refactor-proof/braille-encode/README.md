# Refactor Proof: braille-encode

## Target Repo
[qntm/braille-encode](https://github.com/qntm/braille-encode) — Represent binary data as Braille Unicode characters.

**Why this repo?** The most unlikely test case for regression testing:
- A library that converts binary data to Braille characters and back
- Self-described as "useless" in its own npm keywords
- By qntm — known for esoteric encoding libraries (base65536, heck)
- Nobody would ever think to regression-test a Braille encoder
- Pure functions with zero dependencies — perfect for ghost proxy wrapping
- But with a hidden trap: `decode()` returns `Uint8Array`, which exposed a critical bug in Regrets' TypedArray handling

## What Was Refactored
1. **Extract lookup tables** — `encodechar` and `decodechar` moved to `src/lookup.js` as `ENCODE_MAP` and `DECODE_MAP`
   - Single responsibility: data structure separated from encoding/decoding logic
   - Added documentation of Braille dot numbering and significance
2. **Add JSDoc** — `encode()` and `decode()` now have proper documentation
3. **Improve error messages** — `decode()` now shows Unicode code point (U+0061) and character ('a') instead of decimal char code (97)
4. **Update test** — error message test updated to match improved format

## Verification Results

### KEBENARAN 1 — Raw Output (Before Refactor) vs After Refactor
| Function | Input | Output Before | Output After | Match |
|----------|-------|---------------|--------------|-------|
| encode | [212,29,140,217,143,0,178,4] | "⡓⣘⠙⣋⢹⠀⡥⠐" | "⡓⣘⠙⣋⢹⠀⡥⠐" | ✅ |
| encode | [0] | "⠀" | "⠀" | ✅ |
| encode | [255,0,128,127,1] | "⣿⠀⠁⣾⢀" | "⣿⠀⠁⣾⢀" | ✅ |
| encode | [15,240,85,170] | "⢸⡇⣒⠭" | "⢸⡇⣒⠭" | ✅ |
| decode | "⡓⣘⠙⣋⢹⠀⡥⠐" | [212,29,140,217,143,0,178,4] | [212,29,140,217,143,0,178,4] | ✅ |
| decode | "⠀" | [0] | [0] | ✅ |
| decode | "⣿" | [255] | [255] | ✅ |
| decode | "⠇⣇⡧⣧⡗⣗⡷⣷" | [224,241,242,243,244,245,246,247] | [224,241,242,243,244,245,246,247] | ✅ |

### KEBENARAN 2 — Fingerprint Before vs After
| Cluster | Fingerprint Before | Fingerprint After | Match |
|---------|-------------------|-------------------|-------|
| braille-encode | 38nwscl | 38nwscl | ✅ |
| braille-decode | 26mquf3 | 26mquf3 | ✅ |

### VERIFIKASI 1 — Regrets
```
✅ braille-decode   26mquf3  PASS
✅ braille-encode   38nwscl  PASS
```

### VERIFIKASI 2 — Direct Output
All 8 test cases produce identical output to pre-refactor ground truth.

### VERIFIKASI 3 — Cross Validation
New fingerprints match KEBENARAN 2 exactly.

### Original Test Suite
All 262 tests pass with 100% code coverage.

## Regrets Improvements Triggered
This test case exposed 4 bugs in Regrets (fixed in PR #4):
1. TypedArray serialization in `stableStringify`, `normalize`, `stripFields`, `extractSchema`
2. TypedArray handling in `deepClone`
3. Per-input drift detection (false positive with multiple inputs)
4. TypedArray serialization in `.regret` file OUTPUT line

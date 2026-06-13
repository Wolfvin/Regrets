# Morse-talk Refactor Proof — Regrets Regression Testing

## Target Repository
[morse-talk/morse-talk](https://github.com/morse-talk/morse-talk) — A Python Morse code translator

## Why morse-talk?
The LEAST obvious choice for regression testing — nobody tests Morse code libraries! This makes it the perfect edge case to prove Regrets works on unexpected domains.

## What Was Refactored
`morse_talk/encoding.py` — meaningful but behavior-preserving changes:

1. **Replaced `collections.OrderedDict` with regular `dict`** — Python 3.7+ guarantees insertion order
2. **Renamed `morsetab` → `MORSE_TABLE`** (PEP 8 constant naming), kept `morsetab` as backward-compat alias
3. **Replaced `map`+`lambda`+flatten in `_encode_binary`** with clear loop-based approach
4. **Extracted `_format_morse_symbols`** from nested closure in `_encode_to_morse_string`
5. **Added `_get_binary_map` helper** for binary symbol mapping
6. **Improved variable names** (`l` → `morse_symbols`, `s` → `joined`, etc.)
7. **Added proper docstrings** with parameter documentation
8. **Replaced `list(map(list, ...))` with list comprehension** in `_split_message`

## 3-Way Verification Proof

### VERIFICATION 1 — Regrets Fingerprint
All 7 clusters GREEN after refactor:

| Cluster | Fingerprint | Status |
|---------|------------|--------|
| encode-default | 3ngf9oq | ✅ PASS |
| encode-binary | 2ai4qsg | ✅ PASS |
| decode-default | 4ucsloq | ✅ PASS |
| encode-morse-internal | 3p26o2v | ✅ PASS |
| encode-binary-internal | 51y44ki | ✅ PASS |
| split-message | ubbhzzv | ✅ PASS |
| mlength | 3c8ivsg | ✅ PASS |

### VERIFICATION 2 — Raw Output vs KEBENARAN 1
All outputs IDENTICAL to pre-refactor baseline.

### VERIFICATION 3 — Cross-Check
Fingerprints from new output match KEBENARAN 2 exactly.

## Fingerprint Sebelum/Sesudah

| Cluster | Before | After | Match |
|---------|--------|-------|-------|
| encode-default | 3ngf9oq | 3ngf9oq | ✅ |
| encode-binary | 2ai4qsg | 2ai4qsg | ✅ |
| decode-default | 4ucsloq | 4ucsloq | ✅ |
| encode-morse-internal | 3p26o2v | 3p26o2v | ✅ |
| encode-binary-internal | 51y44ki | 51y44ki | ✅ |
| split-message | ubbhzzv | ubbhzzv | ✅ |
| mlength | 3c8ivsg | 3c8ivsg | ✅ |

## Regrets Improvement Discovered
This testing uncovered a critical Regrets bug: **drift detection was broken for multi-input clusters**. Fixed in PR #22.

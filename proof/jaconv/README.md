# jaconv — Japanese Character Interconverter

**Repository**: [ikegami-yukino/jaconv](https://github.com/ikegami-yukino/jaconv)  
**Stack**: Python  
**Clusters**: 14  
**Status**: All SOLID

## What is jaconv?

jaconv is a pure-Python library for converting between Japanese character encodings: Hiragana, Katakana (full-width and half-width), Hankaku/Zenkaku ASCII and digits, Roman-input alphabets, and Julius speech recognizer phoneme format.

## Why This Repo?

- **Niche domain**: Japanese character encoding — far from typical CRUD/web apps
- **Pure functions**: Every function is string-in → string-out, deterministic, no side effects
- **Large codebase**: 959-line monolithic module with massive `replace()` chains
- **Refactoring challenge**: Natural decomposition into domain modules (kana, width, romaji, julius)

## Clusters

| Cluster | Entry | Fingerprint |
|---------|-------|-------------|
| hira2kata | hira2kata | 3elv23o |
| hira2hkata | hira2hkata | 330zkoe |
| kata2hira | kata2hira | 3bqkaty |
| h2z-default | h2z | 2solpmo |
| h2z-ascii-digit | h2z | 2zkvw4g |
| z2h-default | z2h | 53t36xc |
| z2h-ascii-digit | z2h | f44quxy |
| normalize | normalize | t98ohy1 |
| kana2alphabet | kana2alphabet | 49den39 |
| alphabet2kana | alphabet2kana | 4mn4sz4 |
| kata2alphabet | kata2alphabet | 61uj8ha |
| alphabet2kata | alphabet2kata | 2iiyfbt |
| hiragana2julius | hiragana2julius | 3ckg83v |
| enlarge-smallkana | enlarge_smallkana | 25poxfr |

## Refactoring Proof

The monolithic `jaconv.py` (959 lines) was decomposed into 6 domain-specific modules:

| Module | Lines | Functions |
|--------|-------|-----------|
| helpers.py | 21 | _exclude_ignorechar, _convert, _translate |
| kana_convert.py | 121 | hira2kata, hira2hkata, kata2hira, enlarge_smallkana |
| width_convert.py | 173 | h2z, z2h + aliases |
| normalize_convert.py | 42 | normalize |
| romaji_convert.py | 289 | kana2alphabet, alphabet2kana, kata2alphabet, alphabet2kata |
| julius_convert.py | 332 | hiragana2julius |
| jaconv.py (facade) | 46 | Re-exports all public functions |

### Triple Verification Results

1. **Regrets validation**: All 14 clusters GREEN
2. **Raw output comparison**: All 45 input/output pairs match KEBENARAN 1
3. **Fingerprint cross-check**: All fingerprints match KEBENARAN 2 (5 runs, PASS+STABLE)

## Lessons Learned

### Nested Function Watch Limitation

When a function contains a nested helper (e.g., `_conv_dakuten` inside `h2z`), the Ghost Proxy cannot wrap it because it's not accessible at module level. The capture.py correctly warns: `Watch target "_conv_dakuten" is not callable — skipping`.

**Recommendation**: For clusters with nested helpers, use `fingerprintLevel: "entry"` (default) which only hashes the entry function's output. Avoid adding nested function names to `watches` — they will be skipped and the warning is misleading. Only add top-level module functions to `watches`.

### Multi-Args with Keyword Arguments

The `h2z` and `z2h` functions accept keyword arguments (`kana=`, `ascii=`, `digit=`). The `multiArgs: true` pattern works correctly when inputs are arrays that get spread as positional arguments. However, boolean keyword arguments must be passed positionally in the input array for the ghost wrapper to capture them correctly.

### Same Entry, Different Clusters

A single entry function (`h2z`) can appear in multiple clusters with different inputs and configurations. This is useful when the function has multiple behavioral modes (e.g., default kana-only vs. ascii+digit). Each cluster captures a distinct behavioral contract.

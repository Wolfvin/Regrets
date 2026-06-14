# jaconv — Japanese Character Interconverter

## Library/Project

| Field | Value |
|-------|-------|
| **Name** | jaconv |
| **Repository** | [ikegami-yukino/jaconv](https://github.com/ikegami-yukino/jaconv) |
| **Version/tag tested** | *(see manifest.json for commit)* |
| **Stack** | Python |
| **Domain** | Japanese character encoding conversion (Hiragana, Katakana, Hankaku/Zenkaku, Romaji, Julius) |

## Challenge

jaconv is a pure-Python library for converting between Japanese character encodings, presenting a fingerprinting challenge due to its niche domain far from typical CRUD/web apps. The codebase is a 959-line monolithic module with massive `replace()` chains, where every function is a pure string-in/string-out deterministic operation with no side effects. The refactoring challenge lies in decomposing this monolith into domain modules (kana, width, romaji, julius) while preserving the exact behavioral contract of 14 distinct conversion functions.

## Solution

Direct fingerprinting — all functions are pure and deterministic, requiring no adapter pattern. The monolithic `jaconv.py` was decomposed into 6 domain-specific modules plus a facade that re-exports all public functions. Each cluster uses `fingerprintLevel: "entry"` to hash only the entry function's output. The `pythonPath: "."` manifest setting ensures the single-file module is importable.

## Key Lessons

1. **Nested function watch limitation**
   When a function contains a nested helper (e.g., `_conv_dakuten` inside `h2z`), the Ghost Proxy cannot wrap it because it's not accessible at module level. Only add top-level module functions to `watches` — nested function names will be skipped with a misleading warning. Use `fingerprintLevel: "entry"` (default) for clusters with nested helpers.

2. **Multi-args with keyword arguments**
   The `h2z` and `z2h` functions accept keyword arguments (`kana=`, `ascii=`, `digit=`). The `multiArgs: true` pattern works when inputs are arrays spread as positional arguments, but boolean keyword arguments must be passed positionally in the input array for the ghost wrapper to capture them correctly.

3. **Same entry, different clusters**
   A single entry function (`h2z`) can appear in multiple clusters with different inputs and configurations. This is useful when the function has multiple behavioral modes (e.g., default kana-only vs. ascii+digit). Each cluster captures a distinct behavioral contract.

4. **Monolith decomposition pattern**
   A large single-file module can be decomposed by domain into smaller modules, with a facade file that re-exports all public functions. This preserves backward compatibility while allowing each domain to be maintained independently. The key is ensuring every re-export maps 1:1 to the original public API.

## How to Reproduce

```bash
# 1. Clone the target library
git clone https://github.com/ikegami-yukino/jaconv.git target-jaconv
cd target-jaconv

# 2. Install dependencies
pip install .

# 3. Copy the manifest into the project
mkdir -p regrets
cp /path/to/Regrets/proof/jaconv/manifest.json regrets/manifest.json

# 4. Capture baseline (if not already captured)
# node scripts/capture.js --manifest regrets/manifest.json

# 5. Validate against KEBENARAN baselines
# node scripts/validate.js --manifest regrets/manifest.json

# 6. Verify fingerprints match
# Compare output with proof/jaconv/KEBENARAN_1_raw_output.json
# Compare fingerprints with proof/jaconv/KEBENARAN_2_fingerprints.json
```

---

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

### Refactoring Proof: Module Decomposition

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

## Verification

| # | Method | Result |
|---|--------|--------|
| V1 | Cluster validate (all 14 GREEN) | PASS |
| V2 | Raw output vs KEBENARAN 1 (45 pairs) | IDENTICAL |
| V3 | Fingerprint match vs KEBENARAN 2 (5 runs, PASS+STABLE) | MATCH |
| V4 | Chain hash match | N/A |

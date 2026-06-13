# Single-File Python Module — Regrets Integration Pattern

## Problem

Many Python projects consist of a single file (e.g., `puz.py`) rather than a package with `__init__.py`. When using Regrets to regression-test such projects, the `importlib.import_module()` call in `capture.py` and `validate.py` fails because the module is not on `sys.path`.

## Solution

Add `"pythonPath": "."` to each cluster in the manifest:

```json
{
  "id": "scramble-string",
  "entry": "scramble_string",
  "module": "puz",
  "pythonPath": ".",
  "stack": "python",
  "multiArgs": true,
  "inputs": [["CATAR", 1234]]
}
```

This adds the project root to `sys.path` before importing, allowing `import puz` to work.

## `multiArgs` for Multi-Argument Functions

When a function takes multiple positional arguments (e.g., `scramble_string(text, key)`), each input in the manifest should be an array and `"multiArgs": true` must be set:

```json
{
  "id": "scramble-string",
  "entry": "scramble_string",
  "multiArgs": true,
  "inputs": [
    ["CATAR", 1234],
    ["HELLO", 1000]
  ]
}
```

Without `multiArgs`, the input `["CATAR", 1234]` would be passed as `scramble_string(["CATAR", 1234])` — a single list argument — rather than `scramble_string("CATAR", 1234)`.

## Bytes Input Limitation

Functions requiring `bytes` input (e.g., `data_cksum(data: bytes, cksum: int)`) cannot be directly fingerprinted because JSON serialization doesn't support `bytes`. Workarounds:

1. **Write a thin wrapper** that converts string → bytes before calling
2. **Use the `file` field** (for JS) or a test harness that reads from disk
3. **Future improvement**: Add `"inputTransform": "bytes"` to the manifest spec

## Checksum/Cipher Function Clusters

Functions that implement checksums, ciphers, or scrambling algorithms are ideal Regrets targets because:
- They are pure functions (no side effects, no I/O)
- Same input always produces same output (deterministic)
- They often have complex logic that benefits from refactoring
- They are critical to get right (corrupted checksums = broken files)

When clustering such functions, include edge cases:
- Empty string input
- Single character input
- Maximum key values
- Zero/identity key values

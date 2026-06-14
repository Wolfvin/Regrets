# Tuple-to-List Serialization Gotcha — Reference

## Problem

When verifying KEBENARAN 1 (raw output) against re-run output, Python functions that return tuples will cause a false mismatch:

```python
# Function returns a tuple
def _parse_detail_line(text: str) -> tuple:
    return (qty, name, unit_price, subtotal)

# KEBENARAN 1 stores (via JSON): [1.0, "", 14000.0, 28000.0]  (list)
# Re-run returns:                    (1.0, "", 14000.0, 28000.0)  (tuple)

# Python comparison:
[1.0, "", 14000.0, 28000.0] == (1.0, "", 14000.0, 28000.0)  # False!
```

This is NOT a behavioral difference — the tuple and list contain identical values. But Python treats them as unequal types, causing verification to falsely fail.

## Why It Happens

1. Regrets' `deep_clone()` converts tuples to lists (line 189-190 of `fingerprint.py`)
2. When `.regret` files and KEBENARAN files are saved, tuples are serialized as JSON arrays (lists)
3. When re-running functions for verification, Python returns the original tuple type
4. Comparing `list == tuple` in Python always returns `False`, even with identical contents

## Impact

- VERIFICATION 2 (raw output vs KEBENARAN 1) can falsely fail
- This creates unnecessary panic — the function output IS correct
- The fingerprint (VERIFICATION 1) is NOT affected because deep_clone normalizes before hashing

## Solution

When comparing re-run output against KEBENARAN 1, normalize both sides:

```python
import json

# Normalize: serialize and deserialize to eliminate type differences
actual_normalized = json.loads(json.dumps(actual))
expected_normalized = json.loads(json.dumps(expected))

if actual_normalized == expected_normalized:
    # ✅ Match (same values, type differences are serialization artifacts)
```

Or equivalently, convert tuples to lists before comparison:

```python
def normalize_for_comparison(val):
    """Convert tuples to lists recursively for JSON-safe comparison."""
    if isinstance(val, tuple):
        return [normalize_for_comparison(v) for v in val]
    if isinstance(val, list):
        return [normalize_for_comparison(v) for v in val]
    if isinstance(val, dict):
        return {k: normalize_for_comparison(v) for k, v in val.items()}
    return val
```

## Discovered During

This issue was discovered during the Coretax-Auto-Downloader (bank-statement-ocr) refactoring sprint. The `_parse_detail_line()` function in `nota/receipt_parser.py` returns a tuple `(qty, name, unit_price, subtotal)`, which was serialized as a list in KEBENARAN 1. The manual verification script compared `list == tuple` and got False, triggering a false alarm.

## Recommendation for Regrets

The `regret verify-kebenaran` command should automatically normalize types before comparison. All tuples should be converted to lists on both sides before checking equality, since JSON (the storage format) cannot distinguish between them.

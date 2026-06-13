# Bytes Output Transform — Hex Encoding for Binary Functions

## The Problem

Many Python libraries have functions that return `bytes` rather than JSON-serializable
objects. This is common in:

- **Encoding/decoding libraries** (e.g., PDF stream filters, cipher operations)
- **Binary format parsers** (e.g., CFF font parsing, image processing)
- **Cryptography** (e.g., encryption key computation, hash functions)

When Regrets tries to fingerprint these functions, `deep_clone()` handles `bytes` by
converting them to hex strings. This works for internal cloning, but creates a mismatch:

1. The `.regret` file stores the output as a hex string (from deep_clone)
2. KEBENARAN 1 would store the raw bytes object
3. Comparing the two becomes confusing — they look different even though they're
   semantically identical

## The Solution: `outputTransform: "hex"`

Add `"hex"` as a built-in output transform in the manifest. This explicitly declares
that the function returns bytes and they should be hex-encoded before fingerprinting.

### Manifest Usage

```json
{
  "id": "apply-png-predictor",
  "entry": "apply_png_predictor",
  "watches": ["apply_png_predictor", "paeth_predictor"],
  "module": "pdfminer.utils",
  "stack": "python",
  "multiArgs": true,
  "outputTransform": "hex",
  "inputs": [
    [0, 3, 4, 8, "...\u0000\u0001\u0002"]
  ]
}
```

### How It Works

When `outputTransform: "hex"` is specified:

1. The entry function runs normally, returning `bytes`
2. `apply_output_transform()` converts `bytes` → hex string (e.g., `"0a1b2c"`)
3. The hex string is fingerprinted and stored in the `.regret` file
4. Both KEBENARAN 1 and KEBENARAN 2 store hex strings — they're directly comparable

### Supported Output Types

| Output Type | Behavior |
|-------------|----------|
| `bytes` | Converted to hex string via `.hex()` |
| Non-bytes | Passed through unchanged |
| `list[bytes]` | Each element converted to hex string |

### Why Not Just Rely on deep_clone?

`deep_clone()` does convert bytes to hex, but it does so silently. With an explicit
`outputTransform: "hex"`:

1. The manifest clearly communicates that this function returns binary data
2. Both truth baselines use the same transform — no surprise mismatches
3. The `.regret` OUTPUT line shows hex, which is what gets fingerprinted
4. Other agents reading the manifest know to expect binary output

### Real-World Example: pdfminer.six

The `apply_png_predictor` function reverses PNG prediction filters on compressed
PDF stream data. Its signature:

```python
def apply_png_predictor(
    pred: int, colors: int, columns: int, bitspercomponent: int, data: bytes
) -> bytes:
```

Without `outputTransform: "hex"`, the `.regret` file would store a hex string
(implicitly via deep_clone) but the KEBENARAN 1 truth script would also store hex
— creating consistency. However, the manifest wouldn't communicate the binary nature
of this function, and if deep_clone's behavior ever changed, both truths could break
in different ways.

With `outputTransform: "hex"`, the transform is explicit, documented, and consistent.

## Implementation

Added to `capture.py` and `validate.py` in the `apply_output_transform` function:

```python
elif transform == 'hex':
    if isinstance(obj, bytes):
        return obj.hex()
    return obj
```

Also supported in `truth.py` for KEBENARAN 1 capture.

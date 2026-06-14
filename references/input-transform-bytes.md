# Input Transform — Bridging JSON and Binary Function Arguments

## The Problem

Many Python libraries have pure functions that accept `bytes` as input:

```python
def apply_png_predictor(pred, colors, columns, bitspercomponent, data: bytes) -> bytes:
def decode_text(s: bytes) -> str:
def unpad_aes(padded: bytes) -> bytes:
def nunpack(s: bytes, default: int = 0) -> int:
def getdict(data: bytes) -> dict:
```

Regrets stores inputs in `manifest.json`, which only supports JSON-serializable
types (strings, numbers, booleans, arrays, objects, null). Raw `bytes` cannot
be represented directly in JSON.

Before this feature, agents had two bad options:
1. Skip these functions entirely — leaving a large class of pure functions unprotected
2. Write wrapper scripts to convert between JSON and bytes — adding complexity and maintenance burden

## The Solution: `inputTransform`

Add an `inputTransform` field to the cluster manifest that converts JSON-safe
input values to the actual types the function expects before calling the entry
function.

### Manifest Usage

```json
{
  "id": "png-predictor",
  "entry": "apply_png_predictor",
  "watches": ["apply_png_predictor", "paeth_predictor"],
  "module": "pdfminer.utils",
  "stack": "python",
  "multiArgs": true,
  "inputTransform": "list_to_bytes",
  "outputTransform": "hex",
  "inputs": [
    [0, 1, 4, 8, [0, 10, 20, 30, 40]]
  ]
}
```

In this example:
- `inputTransform: "list_to_bytes"` converts the last argument `[0, 10, 20, 30, 40]` (list of ints) to `bytes` before calling the function
- `outputTransform: "hex"` converts the `bytes` output to a hex string for fingerprinting

### Supported Transforms

| Transform | Input in JSON | Converted Value | Use Case |
|-----------|---------------|-----------------|----------|
| `hex_to_bytes` | `"0a1b2c"` | `b"\x0a\x1b\x2c"` | Functions that accept a single bytes argument |
| `list_to_bytes` | `[10, 27, 44]` | `b"\x0a\x1b\x2c"` | Functions where input is a list of byte values |
| `list_of_hex_to_bytes` | `["0a1b", "2c3d"]` | `[b"\x0a\x1b", b"\x2c\x3d"]` | multiArgs functions with multiple bytes arguments |

### Multi-args Handling

For `multiArgs: true` clusters, `hex_to_bytes` and `list_to_bytes` apply
intelligently to each argument:

```json
{
  "multiArgs": true,
  "inputTransform": "hex_to_bytes",
  "inputs": [["0a1b2c", 3, 4, 8]]
}
```

Result: `entry_fn(bytes.fromhex("0a1b2c"), 3, 4, 8)` — only string arguments
are converted to bytes, integers pass through unchanged.

### How It Works in the Pipeline

```
manifest.json input → deep_clone (JSON-safe) → apply_input_transform → entry_fn()
                                              ↓
                                     bytes.fromhex() / bytes() etc.
```

The `input_for_record` (stored in the .regret file) retains the JSON-safe form.
The `input_for_args` (passed to the function) is the transformed binary form.
This means the .regret file remains human-readable while the function gets
the correct input types.

### Interaction with outputTransform

`inputTransform` and `outputTransform` are independent but often used together:
- `inputTransform` converts JSON → bytes before calling the function
- `outputTransform` converts bytes → hex after getting the result

Together they enable Regrets to protect the full lifecycle of binary-processing
functions: correct input, fingerprintable output.

## Real-World Example: pdfminer.six

The `apply_png_predictor` function reverses PNG prediction filters:

```python
def apply_png_predictor(
    pred: int, colors: int, columns: int, bitspercomponent: int, data: bytes
) -> bytes:
```

With `inputTransform: "list_to_bytes"` and `outputTransform: "hex"`:

```json
{
  "id": "png-predictor",
  "entry": "apply_png_predictor",
  "module": "pdfminer.utils",
  "stack": "python",
  "multiArgs": true,
  "inputTransform": "list_to_bytes",
  "outputTransform": "hex",
  "inputs": [
    [0, 1, 4, 8, [0, 10, 20, 30, 40]],
    [1, 1, 4, 8, [1, 10, 20, 30, 40]]
  ]
}
```

The last element of each input array (the data) is a list of integers that
gets converted to `bytes` before the function call. The output bytes are
converted to hex for fingerprinting. Both KEBENARAN baselines are consistent
because both use the same transforms.

## Concrete Finding

This feature was born from the moment during the pdfminer.six refactoring sprint
when I tried to create clusters for `decode_text`, `apply_png_predictor`,
`nunpack`, and `getdict` — all pure functions that accept `bytes`. I had to
exclude them entirely because there was no way to represent bytes input in
the manifest. These are some of the most important pure functions in the
entire codebase (PNG/TIFF filter reversal, CFF font parsing, text decoding),
and Regrets couldn't protect them. After adding inputTransform, all of these
functions become protectable.

# Stateful Encoding Libraries — Fingerprinting Guide

Testing stateful encoding libraries (like Baudot, Morse code, or other legacy protocols) presents unique challenges for regression testing: the same code can decode to different values depending on internal state, and the encode/decode cycle involves I/O objects that aren't directly serializable.

---

## The Problem

Stateful encoders use shift mechanisms (like LTRS/FIGS in Baudot) where the meaning of a code depends on the current state. Additionally, many encoding libraries use stream-based I/O (readers/writers) rather than pure functions, making them difficult to fingerprint directly.

### Challenge 1: Stream-Based I/O

Most encoding libraries follow a pattern like:

```python
# Encode: string → writer
writer = HexBytesWriter(output_stream)
encode_str("HELLO", codec, writer)

# Decode: reader → string
reader = HexBytesReader(input_stream)
result = decode_to_str(reader, codec)
```

These functions don't return values directly — they write to side-effect objects. Regrets' `fingerprint()` needs a serializable return value.

### Challenge 2: Stateful Decoding

The same 5-bit code decodes differently depending on shift state:

```python
# In ITA2 Standard:
# Code 1 in Letters state → 'E'
# Code 1 in Figures state → '3'
# Code 27 in any state → Shift to Figures
```

### Challenge 3: Non-Serializable Objects

Codec objects, Shift states, and stream objects can't be JSON-serialized directly for fingerprinting.

---

## Solution: Pure Wrapper Functions

Create a thin wrapper module that converts stream-based I/O into pure functions:

```python
# baudot_test_helpers.py
from io import BytesIO
from baudot import encode_str, decode_to_str
from baudot.codecs import ITA2_STANDARD
from baudot.handlers import HexBytesWriter, HexBytesReader

def encode_ita2_standard(text):
    """Encode a string using ITA2 STANDARD, return hex string."""
    if not text:
        return ''
    tmp = BytesIO()
    writer = HexBytesWriter(tmp)
    encode_str(text, ITA2_STANDARD, writer)
    result = tmp.getvalue().decode()
    tmp.close()
    return result

def decode_ita2_standard(hex_bytes):
    """Decode hex bytes string using ITA2 STANDARD, return string."""
    if not hex_bytes:
        return ''
    tmp = BytesIO(hex_bytes.encode())
    reader = HexBytesReader(tmp)
    result = decode_to_str(reader, ITA2_STANDARD)
    tmp.close()
    return result
```

### Why This Works

1. **Pure functions**: Each wrapper takes a string and returns a string — perfect for fingerprinting
2. **Serializable**: Both inputs and outputs are plain strings that JSON handles natively
3. **Deterministic**: Same input always produces same output (no randomness, no timestamps)
4. **No state leaks**: The BytesIO stream is created and destroyed within each call

---

## Manifest for Stateful Encoders

### Encode Cluster

```json
{
  "id": "encode-ita2-standard",
  "entry": "encode_ita2_standard",
  "watches": ["encode_ita2_standard"],
  "module": "baudot_test_helpers",
  "stack": "python",
  "fingerprintLevel": "entry",
  "description": "Encode strings to hex bytes using ITA2 STANDARD codec",
  "inputs": [
    "HELLO WORLD",
    "SOS",
    "A",
    ""
  ]
}
```

### Decode Cluster

Use actual encoded hex values as inputs (not arbitrary strings):

```json
{
  "id": "decode-ita2-standard",
  "entry": "decode_ita2_standard",
  "watches": ["decode_ita2_standard"],
  "module": "baudot_test_helpers",
  "stack": "python",
  "fingerprintLevel": "entry",
  "description": "Decode hex bytes to string using ITA2 STANDARD codec",
  "inputs": [
    "1f14011212180413180a1209",
    "1f051805",
    ""
  ]
}
```

### Roundtrip Cluster (Critical!)

Always include roundtrip clusters to verify encode→decode consistency:

```json
{
  "id": "roundtrip-ita2-standard",
  "entry": "roundtrip_ita2_standard",
  "watches": ["roundtrip_ita2_standard"],
  "module": "baudot_test_helpers",
  "stack": "python",
  "fingerprintLevel": "entry",
  "description": "Roundtrip: encode then decode — must return original",
  "inputs": [
    "HELLO WORLD",
    "SOS",
    "A"
  ]
}
```

### Low-Level Codec Cluster

For testing individual character encoding/decoding with explicit state:

```json
{
  "id": "codec-encode-char",
  "entry": "codec_encode_char",
  "watches": ["codec_encode_char"],
  "module": "baudot_test_helpers",
  "stack": "python",
  "multiArgs": true,
  "fingerprintLevel": "entry",
  "description": "Encode a single character with codec and state",
  "inputs": [
    ["E", "ITA2_STANDARD", null],
    ["3", "ITA2_STANDARD", null]
  ]
}
```

The wrapper function serializes non-JSON objects (like Shift states) into plain strings:

```python
def codec_encode_char(char, codec_name, state_name):
    codec = CODEC_MAP[codec_name]
    state = Shift(state_name) if state_name else None
    code, new_state = codec.encode(char, state)
    new_state_name = new_state.name if isinstance(new_state, Shift) else None
    return [code, new_state_name]  # Plain list — JSON-serializable
```

---

## Multiple Codec Variants

If the library supports multiple codecs (like ITA1, ITA2, US, Continental variants), create **separate clusters** for each. This ensures that refactoring one codec doesn't accidentally break another.

Recommended cluster structure for a multi-codec library:

| Cluster | What It Tests |
|---------|--------------|
| `encode-ita2-standard` | ITA2 Standard encoding |
| `decode-ita2-standard` | ITA2 Standard decoding |
| `roundtrip-ita2-standard` | ITA2 Standard encode→decode |
| `encode-ita2-us` | ITA2 US variant encoding |
| `roundtrip-ita2-us` | ITA2 US roundtrip |
| `encode-ita1-continental` | ITA1 Continental encoding |
| `codec-encode-char` | Low-level single-char encode |
| `codec-decode-code` | Low-level single-code decode |

---

## Common Pitfalls

### 1. Empty Input Handling

Always test empty string input. Many encoding libraries return empty output or special characters for empty input:

```json
{ "inputs": ["HELLO", "", "A"] }
```

### 2. Decode Input Must Be Valid

Decode inputs must be valid encoded hex strings. Don't use arbitrary strings as decode inputs — use the actual output from the encode function.

### 3. State Must Be Initialized for Low-Level Decoding

When testing `codec.decode(code, state)` directly, the `state` parameter must be a valid Shift instance. `None` only works for codes that are unambiguous across all states (like space).

### 4. Codec Object Serialization

Codec objects can't be passed as Regrets inputs. Use a string name → object mapping pattern:

```python
CODEC_MAP = {
    'ITA2_STANDARD': ITA2_STANDARD,
    'ITA2_US': ITA2_US,
    'ITA1_CONTINENTAL': ITA1_CONTINENTAL,
}

def codec_encode_char(char, codec_name, state_name):
    codec = CODEC_MAP[codec_name]  # Resolve by name
    ...
```

### 5. NamedTuple vs Dataclass for Shift States

If the library uses `namedtuple` for Shift states, the `.name` attribute works for both `namedtuple` and `dataclass`. This means you can safely refactor `namedtuple` → `dataclass(frozen=True)` without changing the wrapper functions or breaking fingerprints.

---

## Summary

| Challenge | Solution |
|-----------|----------|
| Stream-based I/O | Pure wrapper functions (string → string) |
| Stateful decoding | Explicit state in low-level clusters, roundtrip tests |
| Non-serializable objects | Name → object mapping pattern |
| Multiple codecs | Separate clusters per codec variant |
| Empty input | Always include empty string as test input |
| Codec refactoring | Roundtrip clusters catch cross-codec breakage |

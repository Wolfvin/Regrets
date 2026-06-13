# Case Study: python-codext — 233 Esoteric Encodings

## Overview

This case study documents applying Regrets to **dhondta/python-codext**, a Python library that extends the `codecs` module with 233 encoding schemes including Morse code, Braille, DNA sequences, Galactic alphabet (Minecraft), Kenny's language (South Park), Barbie cipher, Rick Astley cipher, I-Ching hexagrams, and more.

## Why This Repo Is Interesting

1. **Unusual domain**: Esoteric encoding schemes are rarely tested with regression tools
2. **Pure functions**: Every encode/decode is deterministic — perfect for fingerprinting
3. **Rich variety**: 233 different encodings across 10 categories (language, crypto, stegano, binary, base, etc.)
4. **Unicode challenges**: Braille, Hexagram, and Galactic encodings produce Unicode that challenges JSON serialization
5. **God object**: `__common__.py` at 1510 lines is a clear refactoring target

## Adapter Pattern

Since `codext.encode(text, encoding_name)` is a top-level API (not a module-exported function), we create an adapter module:

```python
# regrets_adapter.py
import sys, os
sys.path.insert(0, os.path.join(os.path.dirname(__file__), 'src'))
import codext

def morse_encode(text):
    return codext.encode(text, "morse")

def morse_decode(text):
    return codext.decode(text, "morse")

# ... 25 more adapter functions
```

## Unicode Roundtrip Pattern

For decode functions where the input is Unicode (Braille, Hexagram, Galactic), we use the roundtrip adapter pattern to avoid JSON serialization issues:

```python
def braille_decode(text):
    """Roundtrip: encode plaintext → decode the encoded form."""
    encoded = codext.encode(text, "braille")
    return codext.decode(encoded, "braille")
```

This tests the decode path with real encoded data while keeping the manifest input as plain ASCII.

## Manifest Example

```json
{
  "id": "morse-encode",
  "entry": "morse_encode",
  "watches": ["morse_encode"],
  "module": "regrets_adapter",
  "pythonPath": ".",
  "stack": "python",
  "fingerprintLevel": "entry",
  "description": "Encode text to Morse code",
  "inputs": ["hello world", "SOS", "test 123"]
}
```

Key fields:
- `module: "regrets_adapter"` — references the adapter module
- `pythonPath: "."` — adds project root to `sys.path`
- `stack: "python"` — routes to `capture.py` / `validate.py`

## Refactoring Proof

### Before
- `__common__.py`: 1510 lines — god object containing codec registration, guess/rank/score, utilities, error handling, language detection, and more

### After
- `__common__.py`: 1182 lines — codec registration, utilities, error handling
- `_guess.py`: 343 lines — guess/rank/score logic extracted as a cohesive module

### Verification
All 27 clusters GREEN after refactoring. Direct output comparison with pre-refactor baselines shows identical results.

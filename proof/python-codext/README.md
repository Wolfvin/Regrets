# python-codext — Case Study

## Target Repository

**dhondta/python-codext** — Extends Python's `codecs` library with 233 encodings/decodings including Morse code, Braille, DNA sequences, Galactic alphabet (Minecraft enchantment table), Kenny's language (South Park), Barbie cipher, Rick Astley cipher, I-Ching hexagrams, Resistor color codes, and many more.

**Why this repo?** It represents one of the most unusual computational domains — esoteric encoding schemes that most developers never encounter. The pure encode/decode functions are ideal Regrets targets: deterministic, no side effects, rich input/output variety.

## Stack

- **Language**: Python 100%
- **Stack**: `python` (using `capture.py` / `validate.py` / `health.py`)
- **Pattern**: Adapter module (`regrets_adapter.py`) wrapping `codext.encode()`/`codext.decode()` into top-level functions

## Adapter Pattern

python-codext exposes class-based codec APIs via `codext.encode(text, encoding_name)` and `codext.decode(text, encoding_name)`. Since Regrets' `capture.py` expects top-level entry functions in a module, we create an adapter:

```python
# regrets_adapter.py
import codext

def morse_encode(text):
    return codext.encode(text, "morse")

def morse_decode(text):
    return codext.decode(text, "morse")
```

Then in `regrets/manifest.json`:
```json
{
  "id": "morse-encode",
  "entry": "morse_encode",
  "module": "regrets_adapter",
  "pythonPath": ".",
  "stack": "python",
  "inputs": ["hello world", "SOS", "test 123"]
}
```

## Unicode Input Handling

Some encodings (Braille, Hexagram/I-Ching, Galactic) produce Unicode output that cannot be reliably stored as JSON input in `.regret` files. The workaround is the **roundtrip adapter pattern**:

```python
def braille_decode(text):
    """Decode Braille to text (roundtrip: encode then decode)."""
    encoded = codext.encode(text, "braille")
    return codext.decode(encoded, "braille")
```

This takes plaintext input, encodes it first, then decodes — testing the decode path while avoiding Unicode serialization issues.

## Clusters (27 total)

| Category | Clusters | Count |
|----------|----------|-------|
| Language | morse-encode/decode, braille-encode/decode, galactic-encode, kenny-encode/decode, navajo-encode | 8 |
| Crypto | affine-encode/decode, vigenere-encode/decode, atbash-encode/decode, rot13-encode/decode | 8 |
| Stegano/Unusual | hexagram-encode/decode, rick-encode/decode, dna-encode/decode, bacon-encode, barbie-encode | 8 |
| Binary | baudot-encode | 1 |
| Base | base32-encode/decode | 2 |

## Verification Results

### Phase 1 — All GREEN, ZERO drift
- 27/27 clusters captured
- 27/27 validated (all GREEN)
- 27/27 drift-stable (5 runs each)
- 27/27 SOLID health score

### Phase 3 — 4-Verification Proof (after refactoring)

**Refactoring performed**: Extracted `_guess.py` module from `__common__.py` (1510 lines → 1182 lines + 343 lines in new module), separating guess/rank/score logic from codec registration utilities.

| Verification | Result |
|-------------|--------|
| V1: Regrets cluster validate | ✅ 27/27 GREEN |
| V2: Direct output vs KEBENARAN 1 | ✅ All identical |
| V3: Fingerprint vs KEBENARAN 2 | ✅ All 27 match |
| V4: Chain validation | N/A (Python chains not yet supported) |

## Known Limitation: Python Chain Testing

Regrets' `contest.mjs` uses JavaScript `import()` for dynamic module loading, which does not support Python clusters. Chain testing with the `python` stack requires a Python-native chain runner. This is documented as an improvement opportunity.

# Case Study: pyEnigma — Class-Based Stateful Python API

Testing a class-based API with mutable state using the adapter pattern for Regrets regression testing.

## Target Repository

[cedricbonhomme/pyEnigma](https://github.com/cedricbonhomme/pyEnigma) — A Python simulator of the WWII German Enigma cipher machine.

## Why pyEnigma?

The LEAST obvious choice for regression testing — who tests WWII cipher machine simulators? This makes it the perfect edge case to prove Regrets works on unexpected domains, especially stateful class-based APIs.

## The Challenge: Stateful Classes

The Enigma machine is inherently stateful: each keypress advances the rotors, changing the machine's internal state. This means:

1. **`Enigma.encipher("HELLO")` always returns the same result** given the same initial configuration — the method is deterministic from a fresh state.
2. **But `encipher()` mutates the rotors** — calling it twice with the same input on the same instance produces different results because the rotors have advanced.

This is a common pattern in simulators, game engines, and state machines. Regrets' Ghost Decorator wraps functions, not class instances, so we need an **adapter layer**.

## Solution: Adapter Functions with Fresh Instances

Create `regret_adapters.py` with functions that:

1. Create a **fresh Enigma instance** for each call (resetting state)
2. Call the real `encipher()` method
3. Return the result as plain JSON data

```python
# regret_adapters.py
from pyenigma.rotor import ROTOR_I, ROTOR_II, ROTOR_III, ROTOR_Reflector_B
from pyenigma.enigma import Enigma

def encipher_default(plaintext):
    """Encipher with default Enigma I settings."""
    machine = Enigma(
        ROTOR_Reflector_B, ROTOR_I, ROTOR_II, ROTOR_III,
        key="AAA", plugs="", ring="AAA"
    )
    return machine.encipher(plaintext)

def roundtrip_encipher(plaintext):
    """Roundtrip: encipher then decipher with same config must return original."""
    config = {"ref": ROTOR_Reflector_B, "r1": ROTOR_I, "r2": ROTOR_II, "r3": ROTOR_III, "key": "AAA"}
    machine1 = Enigma(**config)
    cipher = machine1.encipher(plaintext)
    machine2 = Enigma(**config)  # fresh instance for decryption
    decrypted = machine2.encipher(cipher)
    return {"original": plaintext, "cipher": cipher, "decrypted": decrypted, "roundtrip_ok": decrypted == plaintext}
```

## Key Patterns Documented

### Fresh Instance Per Call

Stateful objects must be re-created for each fingerprint capture. Without this, rotor state from a previous call leaks into the next, causing drift.

```python
# WRONG — state leaks between calls
_machine = Enigma(ref, r1, r2, r3, key="AAA")
def encipher(plaintext):
    return _machine.encipher(plaintext)  # rotor state accumulates!

# CORRECT — fresh instance per call
def encipher(plaintext):
    machine = Enigma(ref, r1, r2, r3, key="AAA")
    return machine.encipher(plaintext)  # deterministic from clean state
```

### Roundtrip Contract Testing

The Enigma's self-reciprocal property (encipher is its own inverse) is a perfect roundtrip contract for Regrets:

```json
{
  "id": "roundtrip-encipher",
  "entry": "roundtrip_encipher",
  "stack": "python",
  "description": "Roundtrip: encipher then decipher must return original"
}
```

This catches a class of bugs that single-direction testing misses: if the rotor stepping logic is broken asymmetrically, single-direction encipher might still produce output, but the roundtrip would fail.

### Configuration Matrix Testing

Different Enigma configurations (reflector type, rotor selection, key, ring, plugboard) produce fundamentally different ciphers. Each configuration is a separate cluster:

| Cluster | Config | Tests |
|---------|--------|-------|
| encipher-default | Reflector B, Rotors I-II-III, key AAA | Basic encipher |
| encipher-plugboard | Same + 10 plug pairs | Plugboard wiring |
| encipher-rotor-iv-v | Rotors IV-V-I, key XYZ | Different rotor wirings |
| encipher-reflector-c | Reflector C | Different reflector wiring |
| encipher-ring-setting | Ring BBB | Ringstellung offset |
| encipher-naval-rotors | Rotors VI-VII-VIII, key ZZZ | M3/M4 naval rotors |
| roundtrip-encipher | Rotors I-II-III with plugboard | Self-reciprocal property |
| encipher-special-chars | Default settings | Non-alpha passthrough |

### Non-Alpha Character Passthrough

The Enigma only encrypts alphabetic characters — spaces, numbers, and punctuation pass through unchanged. This is an important edge case to test:

```json
{
  "id": "encipher-special-chars",
  "inputs": ["HELLO WORLD 123", "TEST 42!", "A B C 1 2 3"]
}
```

## What Was Refactored

### `pyenigma/rotor.py`
1. **Extracted `_build_reverse_wiring()`** helper — the inline reverse wiring computation was duplicated in `__init__` and `__setattr__`, now a single pure function
2. **Named constants** `_ALPHABET`, `_ALPHABET_SIZE`, `_ORD_A` — replaced magic numbers and inline `"ABCDEFGHIJKLMNOPQRSTUVWXYZ"`
3. **Improved variable names** in `encipher_right()` and `encipher_left()`: `index` → `connector_index`, `letter` → `wired_letter`, `out` → `output`
4. **Added comprehensive docstrings** to all classes and methods with parameter documentation
5. **Removed dead comments** (`# return letter`, `# index = (index )%26`)
6. **Organized rotor definitions** with section comments by historical era and model

### `pyenigma/enigma.py`
1. **Extracted `_build_plugboard_table()`** from `__init__` — plugboard construction is now a standalone pure function
2. **Extracted `_process_single_char()`** from the inline loop in `encipher()` — the signal path logic is now self-documenting
3. **Extracted `_restore_case()`** — case preservation logic separated from encryption logic
4. **Named constants** `_ALPHABET`, `_ORD_A` — removed magic values
5. **Improved variable names**: `plaintext_in_upper` → `plaintext_upper`, `c` → `char`, `t` → `signal`, `res` → `ciphertext`, `fres` → result
6. **Added comprehensive docstrings** to all functions and the class with behavioral documentation

## 3-Way Verification Proof

### VERIFICATION 1 — Regrets Fingerprint
All 8 clusters GREEN after refactor:

| Cluster | Fingerprint | Status |
|---------|------------|--------|
| encipher-default | 3y9bpzl | PASS |
| encipher-plugboard | 27xghkz | PASS |
| encipher-rotor-iv-v | 3dg1zlu | PASS |
| encipher-reflector-c | pl4ge0z | PASS |
| encipher-ring-setting | 311h6aq | PASS |
| roundtrip-encipher | 35tlzy3 | PASS |
| encipher-naval-rotors | 3zzyoh8 | PASS |
| encipher-special-chars | 3dackdg | PASS |

### VERIFICATION 2 — Raw Output vs KEBENARAN 1
All outputs IDENTICAL to pre-refactor baseline.

### VERIFICATION 3 — Cross-Check
Fingerprints from new output match KEBENARAN 2 exactly.

## Regrets Improvement Discovered

This testing validated that Regrets' Python stack works correctly on:
- Class-based APIs with mutable state (via adapter pattern)
- Stateful objects that require fresh instances per call
- Roundtrip/contract testing (self-reciprocal encryption property)
- Configuration matrix testing (same class, different configs)
- Non-alpha character passthrough edge cases
- Small primitive outputs (single character returns from encipher)

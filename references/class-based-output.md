# Class-Based Library Support — outputTransform and Environment Snapshot

## The Problem

Regrets was designed for libraries that export pure functions returning JSON-serializable
data. Many real-world Python and JS libraries are class-heavy — their APIs return class
instances with internal state, `bytes` objects, or tuples containing non-serializable types.

When `deep_clone()` encounters these types, it falls through to returning the same object
reference instead of a clone. This causes:

1. **Mutation corruption**: If the function mutates the return value after recording, the
   recorded output is silently corrupted because `deep_clone()` returned the same reference.
2. **Fingerprint instability**: The same live object may produce different fingerprints
   across runs due to garbage collection, weak references, or other mutations.
3. **Silent data loss**: `bytes` objects become `null` in JSON round-trip, class instances
   lose all their methods and internal state.

This gap was discovered during analysis of [pycrate-org/pycrate](https://github.com/pycrate-org/pycrate),
a telecom protocol encoding/decoding library where:
- `parse_NAS_MO()` returns `(Envelope_instance, int)` — a tuple with a class instance
- `Element.from_bytes()` is an instance method that mutates `self`
- `Envelope.get_val_d()` returns a dict with the semantic state of the object
- `bytes` values appear throughout the encoding/decoding pipeline

## Solution 1: outputTransform — Named Output Serializer

Add an `outputTransform` field to the cluster manifest that specifies how to convert
non-serializable outputs to JSON-safe values before fingerprinting:

```json
{
  "id": "nas-5gs-registration",
  "entry": "parse_NAS5G",
  "watches": ["parse_NAS5G"],
  "module": "pycrate_mobile.NAS",
  "stack": "python",
  "outputTransform": "get_val_d",
  "inputs": ["0741000b..."]
}
```

### Supported Transforms

| Transform | Python | JS | Description |
|-----------|--------|----|-------------|
| `get_val_d` | ✅ | — | Call `val.get_val_d()` (pycrate Envelope) |
| `to_dict` | ✅ | ✅ | Call `val.to_dict()` / `val.toDict()` |
| `to_bytes` | ✅ | — | Call `val.to_bytes()` (pycrate Element) |
| `to_json` | — | ✅ | Call `val.toJSON()` |
| `hex` | ✅ | ✅ | Convert bytes/Buffer to hex string |
| `repr` | ✅ | ✅ | Use `repr(val)` / `JSON.stringify(val)` |
| callable | ✅ | ✅ | Call custom function, use result |

### How It Works

1. **Capture**: After the entry function returns, `snapshot_output(result, transform)` is
   called instead of `deep_clone(result)`. This converts the output to a JSON-safe value
   using the specified transform.
2. **Validate**: The same transform is applied to the live output before computing the
   fingerprint for comparison.

### Example: pycrate NAS Parser

```python
# parse_NAS5G returns (Envelope_instance, int)
# Without outputTransform: deep_clone fails, returns same reference
# With outputTransform "get_val_d": each Envelope is converted to its value dict

# Before transform:
#   result = (AccessType_instance, 0)
# After transform:
#   result = [{'spare': 1, 'Value': 2}, 0]
```

## Solution 2: Enhanced deep_clone — Type-Aware Serialization

The `deep_clone()` function in `fingerprint.py` has been enhanced to handle common
non-JSON-serializable types automatically, without requiring `outputTransform`:

| Type | Before | After |
|------|--------|-------|
| `bytes` | Returns same reference (no clone) | Converts to hex string |
| `tuple` | Returns same reference (no clone) | Converts to list (recursing elements) |
| Instance with `get_val_d()` | Returns same reference | Calls `get_val_d()`, deep_clones result |
| Instance with `to_dict()` | Returns same reference | Calls `to_dict()`, deep_clones result |
| Other non-serializable | Returns same reference | Uses `repr()` (lossy but deterministic) |

This ensures that even without `outputTransform`, `deep_clone()` always produces an
actual clone (never the same reference), preventing mutation corruption.

## Solution 3: Environment Snapshot

Add an `env` field to the `.regret` file that records the runtime environment at
capture time. During validation, if the environment has changed, a warning is printed
before running the function:

```
env: {"python_version":"3.11.9","python_impl":"CPython","numpy":"1.26.4","gmpy2":"not_installed"}
```

### What's Captured

- Python/Node.js version
- Python implementation (CPython, PyPy)
- Platform and architecture
- Optional packages that affect behavior (numpy, gmpy2, etc.)

### Why This Matters

pycrate's behavior depends on whether `gmpy2` is installed:
- With `gmpy2`: `integer_types = (int, mpz_type)` — accepts mpz values
- Without `gmpy2`: `integer_types = (int,)` — rejects mpz values

If capture runs with `gmpy2` but validate runs without (or vice versa), the code
behaves differently even though the fingerprint is the same. The environment snapshot
warns about this mismatch before it causes silent failures.

## Backward Compatibility

All three solutions are **fully backward compatible**:

- `outputTransform` is optional — clusters without it use `deep_clone()` as before
- Enhanced `deep_clone()` produces the same results for JSON-serializable types
- `env` field is optional — old `.regret` files without it work fine
- The `.regret` file format is unchanged — new fields are additive

## Manifest Example — pycrate

```json
{
  "clusters": [
    {
      "id": "access-type-decode",
      "entry": "decode_access_type",
      "watches": ["decode_access_type"],
      "module": "pycrate_mobile.TS24501_IE",
      "stack": "python",
      "outputTransform": "get_val_d",
      "inputs": ["50"]
    },
    {
      "id": "nas5g-parse",
      "entry": "parse_NAS5G",
      "watches": ["parse_NAS5G"],
      "module": "pycrate_mobile.NAS",
      "stack": "python",
      "outputTransform": "get_val_d",
      "inputs": ["0741000b2e0120"]
    },
    {
      "id": "gtpc-encode",
      "entry": "encode_gtpc_msg",
      "watches": ["encode_gtpc_msg"],
      "module": "pycrate_mobile.TS29274_GTPC",
      "stack": "python",
      "outputTransform": "hex",
      "inputs": [{"msg_type": 1, "seq": 0}]
    }
  ]
}
```

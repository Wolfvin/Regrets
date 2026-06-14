# Python Class Instance Serialization in deep_clone

## The Problem

Many Python libraries return rich class instances — not plain dicts or primitives. For example, the `musicpy` library's `note`, `chord`, and `scale` classes carry data fields (name, octave, duration, volume, interval) and operator overloads. When Regrets fingerprints these outputs, `deep_clone()` must serialize the class instance to a JSON-compatible form.

Before this fix, `deep_clone()` in `fingerprint.py` handled:
1. `bytes` → hex string
2. `tuple` → list
3. Class instances with `get_val_d()` → dict
4. Class instances with `to_dict()` → dict
5. Primitives → as-is
6. JSON-serializable objects → JSON round-trip
7. Everything else → `repr()` string (lossy fallback)

**The gap**: Most Python class instances have neither `get_val_d()` nor `to_dict()`. They have `__dict__` attributes. The fallback to `repr()` loses all structured data — for musicpy's `note('C', 4)`, `repr()` gives `"C4"` but drops duration, volume, and channel information. Two notes with different durations would have the same fingerprint despite different behavior.

## The Fix

Add `__dict__`-based attribute snapshot serialization to `deep_clone()`, **before** the JSON round-trip attempt and `repr()` fallback:

```python
# Handle arbitrary class instances via __dict__ attribute snapshot
if hasattr(val, '__dict__') and not isinstance(val, type):
    try:
        snapshot = {'__type__': type(val).__name__}
        for k, v in vars(val).items():
            snapshot[k] = deep_clone(v)
        return snapshot
    except Exception:
        pass
```

This produces a dict with a `__type__` key for type discrimination:

```python
note('C', 4, duration=1/4, volume=100)
# deep_clone produces:
{
    "__type__": "note",
    "base_name": "C",
    "accidental": None,
    "num": 4,
    "duration": 0.25,
    "volume": 100,
    "channel": None
}
```

For `__slots__`-based classes (no `__dict__`):

```python
# Handle class instances with __slots__ (no __dict__) — use dir()-based scan
if hasattr(val, '__slots__') and not hasattr(val, '__dict__'):
    try:
        snapshot = {'__type__': type(val).__name__}
        for slot in val.__slots__:
            if hasattr(val, slot):
                snapshot[slot] = deep_clone(getattr(val, slot))
        return snapshot
    except Exception:
        pass
```

## Why `__type__` Discriminator?

Two different classes could have the same attribute names and values. Without a type discriminator, `note(base_name='C', num=4)` and a hypothetical `pitch(name='C', octave=4)` would produce the same fingerprint if their `__dict__` happened to overlap. Including `__type__` ensures distinct classes remain distinct.

## When Does This Matter?

This primarily affects Python libraries that:
1. Define custom classes for domain objects (music, math, science, finance)
2. Don't implement `to_dict()` or `get_val_d()` (most don't)
3. Have rich `__repr__` methods that hide internal state
4. Carry behavioral data in attributes beyond what `repr()` shows

### Real-World Example: musicpy

The `musicpy` library (Rainbow-Dreamer/musicpy) defines:
- `note` class: 238 lines, 28+ pure methods, carries name/octave/duration/volume/channel
- `chord` class: 1994 lines, 90+ methods, carries list of notes + interval array + tempos + pitch_bends
- `scale` class: 828 lines, 48+ pure methods, carries root note + interval pattern

Without `__dict__` serialization, a `chord` object's fingerprint would be based on `repr(chord)` which shows note names but not durations, intervals, or metadata. Two chords with identical notes but different rhythms would fingerprint identically — a false positive.

## Interaction with `outputTransform`

The `outputTransform: "repr"` manifest option still works as before — it's applied AFTER `deep_clone()`. If you explicitly want repr-based fingerprinting for a cluster, set `outputTransform: "repr"` and deep_clone's `__dict__` snapshot will be overridden.

The serialization order is:
1. `deep_clone()` converts class instance → `__dict__` snapshot dict
2. `apply_output_transform()` applies the requested transform to the snapshot
3. `fingerprint()` hashes the transformed output

## Backward Compatibility

This change affects fingerprints for any cluster whose output contains Python class instances WITHOUT `to_dict()` or `get_val_d()`. Previously, these were serialized via `repr()`; now they're serialized via `__dict__` snapshot.

**Action required**: After upgrading, re-run `capture` on all clusters. The new fingerprints will be based on `__dict__` snapshots and will differ from `repr()`-based fingerprints.

Clusters whose output is already plain JSON (dicts, lists, primitives) are unaffected — deep_clone is a no-op for those types.

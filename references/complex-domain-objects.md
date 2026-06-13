# Complex Domain Object Serialization — Fingerprinting Custom Classes

## The Problem

Many Python libraries define rich domain objects (e.g., `Chord`, `Note`, `Scale`)
that don't serialize to JSON natively. When Regrets tries to fingerprint the
output of a function that returns these objects, `deep_clone()` may fall back to
`repr()` which is lossy and non-deterministic across refactors.

Example from musicpy:

```python
class note:
    def __init__(self, name='C', octave=4, duration=1/4, ...):
        self.name = name
        self.octave = octave
        self.duration = duration
        ...

class chord:
    def __init__(self, *notes, **kwargs):
        self.notes = [...]      # list of note objects
        self.interval = [...]   # list of floats
        self.start_time = 0
        ...
```

When `C('Cmaj7')` returns a `chord` object containing `note` objects,
Regrets needs a way to serialize this into a deterministic, JSON-compatible
form for fingerprinting.

## Solution: outputTransform with Custom Serialization

### Option 1: `outputTransform: "to_dict"`

If your domain objects have a `to_dict()` method, Regrets can use it:

```json
{
  "clusters": [
    {
      "id": "chord-construct",
      "entry": "C",
      "module": "musicpy.musicpy",
      "stack": "python",
      "outputTransform": "to_dict",
      "inputs": ["Cmaj7"]
    }
  ]
}
```

The `to_dict` transform works recursively through `deep_clone()`, which calls
`obj.to_dict()` when available. This handles:
- Single objects with `to_dict()`
- Lists of objects (each element gets `to_dict()` called)
- Nested objects within dicts

### Option 2: `outputTransform: "module.function"`

For more control, define a custom serialization function:

```python
# regret_serialize.py
from musicpy.musicpy import to_dict

def chord_to_dict(chord_obj):
    """Custom serializer that handles musicpy chord objects."""
    return to_dict(chord_obj)
```

Then reference it in the manifest:

```json
{
  "outputTransform": "regret_serialize.chord_to_dict"
}
```

This is useful when:
- The built-in `to_dict()` doesn't produce a stable output
- You need to strip non-deterministic fields before serialization
- Different cluster types need different serialization logic

### Option 3: `outputTransform: "repr"` with `ignoreFields`

When `to_dict()` isn't available and custom functions are overkill:

```json
{
  "outputTransform": "repr",
  "ignoreFields": ["id", "timestamp"]
}
```

`repr()` produces a deterministic string for simple objects but may include
memory addresses for complex objects. Use `ignoreFields` to strip
non-deterministic parts.

### Option 4: Adapter Module with Serialization Baked In

Create an adapter that both imports and serializes:

```python
# regret_adapter.py
from musicpy.musicpy import C, N, S

def construct_chord_and_serialize(name):
    """Construct a chord and return a JSON-serializable dict."""
    result = C(name)
    # Use the library's built-in serialization
    return result.to_dict() if hasattr(result, 'to_dict') else repr(result)
```

```json
{
  "clusters": [
    {
      "id": "chord-construct",
      "entry": "construct_chord_and_serialize",
      "module": "regret_adapter",
      "stack": "python",
      "inputs": ["Cmaj7"]
    }
  ]
}
```

This is the most reliable approach because:
- The output is guaranteed JSON-serializable
- No transform needs to be applied after the call
- The adapter handles import issues too

## Handling Nested Custom Objects

The most common pitfall: `to_dict()` returns a dict, but the dict still
contains custom objects (e.g., a `chord` dict with `note` objects in a list).

Regrets' `deep_clone()` handles this recursively:
1. It calls `obj.to_dict()` on the top-level object
2. When serializing the resulting dict, it recursively calls `deep_clone()`
   on each value
3. Nested `note` objects that have `to_dict()` get serialized too
4. If a nested object doesn't have `to_dict()`, `deep_clone()` falls back
   to `repr()` or `__dict__`

**Important**: Ensure all nested objects in your domain either:
- Have `to_dict()` methods, OR
- Are JSON-serializable primitives (str, int, float, bool, None, list, dict)

If some nested objects lack `to_dict()`, the `__dict__` fallback usually works
but may miss computed properties or class-hierarchy attributes.

## Stability Checklist

Before fingerprinting custom objects, verify:

1. **Deterministic output**: Same input → same `to_dict()` output every time.
   Watch out for dict ordering (Python 3.7+ guarantees insertion order).

2. **No floating-point drift**: musicpy uses `1/4` for duration, which is
   `0.25` in Python. This is stable. But if durations are computed
   (e.g., `1/3`), use `normalize: ["floatPrecision"]` or
   `normalize: ["floatTolerance:4"]`.

3. **No mutable default args**: If the class constructor has mutable defaults,
   repeated calls may mutate shared state. Use `trackMutation: true` to detect.

4. **No external state**: If `to_dict()` includes file paths, timestamps,
   or environment-dependent values, add appropriate `normalize` rules.

5. **Round-trip fidelity**: If you plan to verify with KEBENARAN 1 (raw output),
   ensure the serialization is lossless enough that meaningful changes are
   detectable.

## Real-World Example: musicpy

musicpy's `chord` class has a `to_dict()` method that returns:

```python
{
    'notes': [
        {'name': 'C', 'octave': 4, 'duration': 0.25, ...},
        {'name': 'E', 'octave': 4, 'duration': 0.25, ...},
        ...
    ],
    'interval': [0.25, 0.25, ...],
    'start_time': 0,
    'other_messages': [],
    'tempos': [],
    'pitch_bends': [],
}
```

Configuration for Regrets:

```json
{
  "id": "chord-construct",
  "entry": "C",
  "module": "musicpy.musicpy",
  "stack": "python",
  "pythonPath": ".",
  "outputTransform": "to_dict",
  "inputs": ["Cmaj7", "Dm7", "Gsus4"],
  "normalize": ["floatPrecision"]
}
```

The `to_dict` transform ensures each `note` object inside the chord is
properly serialized. The `floatPrecision` normalization handles cases where
`0.25` might be represented as `0.25000000001` after computation.

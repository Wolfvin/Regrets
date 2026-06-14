# Case Study: musicpy — Music Programming Language with God Classes

## Target Repository

**Rainbow-Dreamer/musicpy** — A Python library for music composition using music theory algorithms. Compose music with Pythonic syntax, generate MIDI output from chords, scales, progressions, and rhythms.

| Aspect       | Details                                       |
|--------------|-----------------------------------------------|
| Repo         | https://github.com/Rainbow-Dreamer/musicpy    |
| Stars        | ~1,469                                        |
| Language     | Python                                        |
| License      | MIT                                           |
| Files        | 9 Python files (560KB total)                  |
| Key file     | `structures.py` — 6,609 lines, 38 classes    |

## Why musicpy?

Musicpy is the most concentrated god-object codebase in the Regrets case study series. A single file (`structures.py`) contains **38 classes** and **417 methods** spanning the entire music theory domain — notes, chords, scales, intervals, drum patterns, rhythm, and piece composition. The largest class (`chord`) alone is **1,995 lines**, followed by `piece` at **1,206 lines** and `drum` at **925 lines**. This is not a case of a few large functions — it's a case of entire domain models crammed into a single module with no separation of concerns.

This extreme concentration creates a uniquely challenging test for Regrets because:

1. **Class-based API with no standalone functions**: The entire API is instance methods (`chord.up()`, `scale.chord_progression()`, `drum.translate()`), requiring `classMethod` support in the Python capture/validate pipeline.
2. **Nested class instances**: A `chord` object contains a list of `note` objects, each with their own `__dict__`. A `scale` contains `Interval` objects. The `outputTransform: "dict"` only does shallow conversion — the nested `note` objects remain non-serializable.
3. **Complex inter-class dependencies**: The `chord` class references `scale`, `piece` references `track` and `chord`, and nearly everything references the `database` module. These cross-references make it impossible to test classes in isolation without proper support.
4. **Music theory determinism**: Despite the complexity, musicpy's core operations are pure and deterministic — the same chord always produces the same notes, the same scale always produces the same progression. This makes it ideal for fingerprint-based regression testing.

## Gaps Discovered in Regrets

### Gap 1: No `outputTransform: "snapshot"` for Deep Class-to-Dict Conversion

**Problem**: When a function returns a class instance that contains other class instances (e.g., `chord` contains `list[note]`), the existing `outputTransform: "dict"` only does a shallow `__dict__` conversion. The `note` objects inside the list remain as non-serializable class instances, causing `deep_clone` to fall back to `repr()` — losing internal state and producing unreliable fingerprints.

**Example**: `chord(['C', 'E', 'G'])` has `__dict__` containing `notes: [note('C4'), note('E4'), note('G4')]`. With `"dict"`, the output is `{"notes": [<note object>, <note object>, <note object>], "interval": [0, 0, 0], ...}` — the note objects are still unhashable.

**Solution**: Added `outputTransform: "snapshot"` which uses the existing `snapshot_state()` function to do deep recursive class-to-dict conversion. This walks through all nested objects and converts them to JSON-serializable dicts with `__class__` tags, producing output like `{"__class__": "chord", "notes": [{"__class__": "note", "base_name": "C", ...}, ...], "interval": [0, 0, 0], ...}`.

### Gap 2: No `classMethod` Support in Python Capture/Validate

**Problem**: The JS side of Regrets already supports `classMethod` in the manifest (construct an instance, optionally call setup methods, then call a target method). But the Python capture.py and validate.py only support standalone module-level functions. For musicpy's class-based API (`chord.up()`, `scale.chord_progression()`, etc.), the only workaround was creating adapter modules — extra files that wrap class methods as standalone functions.

**Example**: To test `chord(['C', 'E', 'G']).up(2)`, you'd need an adapter:
```python
# regret_adapters.py
def chord_up_C_major():
    from musicpy.structures import chord
    c = chord(['C', 'E', 'G'])
    return c.up(2)
```

This is fragile — each test case needs its own adapter function, and the adapter is not reusable for different inputs.

**Solution**: Added `classMethod`, `constructor`, `constructorArgs`, and `setup` support to Python's capture.py and validate.py, mirroring the JS implementation. Now you can define clusters directly:
```json
{
    "id": "chord-up",
    "entry": "chord",
    "classMethod": "up",
    "constructorArgs": [["C", "E", "G"]],
    "inputs": [2],
    "outputTransform": "snapshot",
    "stack": "python",
    "module": "musicpy.structures",
    "watches": ["up"]
}
```

### Gap 3: Shallow `deep_clone` Falls Back to `repr()` for Class Instances

**Problem**: When `deep_clone()` encounters a class instance without `to_dict()` or `get_val_d()`, it tries JSON round-trip (which fails), then falls back to `repr()`. This produces a lossy string like `"chord(notes=[C4, E4, G4], interval=[0, 0, 0])"` that doesn't capture the full internal state. If a refactoring changes internal state without changing `__repr__`, the fingerprint won't detect the change.

**Solution**: The `outputTransform: "snapshot"` transform addresses this by using `snapshot_state()` before `deep_clone()` enters the fingerprint pipeline. The `snapshot_state()` function recursively walks through class instances and converts them to dicts with `__class__` tags, preserving full structural information.

## Cluster Design

Clusters for musicpy focus on pure, deterministic class methods that form the core music theory computation:

| Cluster | Constructor | Method | Input | Description |
|---------|------------|--------|-------|-------------|
| chord-up | chord(['C','E','G']) | up | 2 | Transpose chord up by semitones |
| chord-down | chord(['C','E','G']) | down | 2 | Transpose chord down |
| chord-reverse | chord(['C','E','G']) | reverse | None | Reverse note order |
| chord-inversion | chord(['C','E','G']) | inversion | 1 | Chord inversion |
| chord-get-degree | chord(['C','E','G']) | get_degree | None | Get MIDI degrees |
| chord-names | chord(['C','E','G']) | names | None | Get note names |
| scale-names | scale('C','major') | names | None | Get scale note names |
| scale-up | scale('C','major') | up | 1 | Transpose scale up |
| note-degree | note('C',4) | degree (property) | N/A | Get MIDI degree of note |

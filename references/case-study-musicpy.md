# Case Study: musicpy — God Object Refactoring with Regrets

## Repo

[Rainbow-Dreamer/musicpy](https://github.com/Rainbow-Dreamer/musicpy) — Music programming language in Python.

## Domain

Music theory, composition, and MIDI manipulation. Provides rich domain objects
for notes, chords, scales, and multi-track pieces.

## Why This Repo Was Chosen

1. **Extreme god object**: `chord` class has 105 methods across 1,993 lines —
   the most severe god object encountered in any Regrets case study.
2. **Zero test coverage**: No tests at all, making Regrets the only safety net.
3. **Circular imports**: `structures.py` ↔ `musicpy.py` circular dependency
   challenges Regrets' import mechanism.
4. **Complex domain objects**: `note`, `chord`, `scale` objects with rich state
   that don't serialize to JSON natively — stress-tests `outputTransform`.
5. **Unique domain**: Music theory is completely different from any previous
   case study (encoding/transliteration libraries).

## Key Challenges for Regrets

### Challenge 1: Circular Import

`structures.py` does `import musicpy as mp` (late-bound), while `musicpy.py`
does `from structures import *` (import-time). When Regrets tries to import
the module, it must load `structures.py` first, then `musicpy.py`.

**Solution**: Import `musicpy.musicpy` as the entry module, which ensures
Python loads the dependency chain in the correct order. Set `pythonPath: "."`
in the manifest. See `references/circular-import.md`.

### Challenge 2: Custom Object Serialization

`C('Cmaj7')` returns a `chord` object containing `note` objects. The default
`deep_clone()` fallback to `repr()` produces non-deterministic output.

**Solution**: Use `outputTransform: "to_dict"` which recursively serializes
custom objects. The new `_recursive_to_dict()` function in capture.py/validate.py
handles nested objects by calling `to_dict()` on each level and recursing into
dicts and lists. See `references/complex-domain-objects.md`.

### Challenge 3: God Class Cluster Definition

The `chord` class has 105 methods. Defining individual clusters for each method
is impractical. Regrets' `scan.py` previously suggested one cluster per method,
resulting in 100+ clusters for a single class.

**Solution**: Enhanced `scan.py` with god-class detection (threshold: 20+ public
methods). For god classes, it suggests:
- Domain-grouped clusters using `constructor` + `instanceMethods` pattern
- Anchor clusters that test the full class contract

### Challenge 4: scan.js Python Class Method Bug

The JS scanner (`scan.js`) had a bug on lines 68-69 where `classMatches`
was defined but never iterated — it iterated `matches` again (already exhausted).
This meant Python class methods were NEVER discovered by `regret scan`.

**Solution**: Fixed line 69 to iterate `classMatches` instead of `matches`.

## Improvements Made to Regrets

| Improvement | File | Description |
|-------------|------|-------------|
| Fix scan.js Python class method bug | `scripts/scan.js:69` | Changed `for (const m of matches)` to `for (const m of classMatches)` |
| God-class detection in scan.py | `scripts/scan.py` | Added `_group_methods_by_domain()` and `_suggest_constructor_args()` for classes with 20+ public methods |
| `to_dict` outputTransform | `scripts/capture.py`, `scripts/validate.py` | Added `_recursive_to_dict()` for nested custom object serialization; added `to_dict` as a named transform |
| Circular import reference | `references/circular-import.md` | New reference doc for handling circular Python imports with Regrets |
| Complex domain objects reference | `references/complex-domain-objects.md` | New reference doc for fingerprinting custom class instances |

## Manifest Configuration

```json
{
  "projectName": "musicpy",
  "clusters": [
    {
      "id": "note-construct",
      "entry": "N",
      "module": "musicpy.musicpy",
      "stack": "python",
      "pythonPath": ".",
      "outputTransform": "to_dict",
      "inputs": ["C5", "D#4", "Bb3"],
      "normalize": ["floatPrecision"]
    },
    {
      "id": "chord-construct",
      "entry": "C",
      "module": "musicpy.musicpy",
      "stack": "python",
      "pythonPath": ".",
      "outputTransform": "to_dict",
      "inputs": ["Cmaj7", "Dm7", "Gsus4", "F#dim"],
      "normalize": ["floatPrecision"]
    },
    {
      "id": "scale-construct",
      "entry": "S",
      "module": "musicpy.musicpy",
      "stack": "python",
      "pythonPath": ".",
      "outputTransform": "to_dict",
      "inputs": ["C", "major"],
      "multiArgs": true
    }
  ]
}
```

## Lessons Learned

1. **Recursive serialization is essential** for domain-heavy libraries.
   One-level `to_dict()` is not enough when objects contain other objects.

2. **God classes need special handling** in cluster suggestions.
   Suggesting one cluster per method creates overwhelming noise.
   Domain-grouped clusters are more practical.

3. **Circular imports are common** in real Python projects.
   Regrets needs documentation (not code changes) to help agents navigate them.

4. **The `pythonPath` field is critical** — without it, `importlib.import_module()`
   may not find the project's modules when running from the regrets scripts directory.

# Parser/Pipeline Libraries — Regrets Reference

## Overview

This reference covers how to use Regrets with **parser and pipeline libraries** — codebases that parse structured text into rich object hierarchies, then transform those objects through middleware/pipeline stages.

**Key difference from transliteration libraries**: Parser libraries return **class instances** (not just strings), have **stateful parsing** with internal cursors, and use **pipeline/middleware patterns** for post-parse transformation. These patterns require specific Regrets configurations to capture behavior correctly.

## Case Study: python-bibtexparser

python-bibtexparser is a BibTeX parser library with:
- `Splitter` class: stateful, cursor-based parser that splits BibTeX strings into blocks
- `Library` class: container holding `Entry`, `String`, `Preamble`, `ExplicitComment`, `ImplicitComment` blocks
- `Entry` class: holds `Field` objects with key/value pairs
- Middleware pipeline: `parse_string()` runs splitter, then applies middleware in sequence
- `NameParts` dataclass: structured representation of person names (first, von, last, jr)

### Challenge 1: Rich Object Return Types

**Problem**: `parse_string()` returns a `Library` object containing `Entry` objects containing `Field` objects. `deep_clone()` via JSON round-trip silently drops class instances, producing `{}` instead of meaningful data.

**Solution**: Use `outputTransform: "dataclass_dict"` in the manifest. This triggers recursive serialization:
1. `dataclasses.asdict()` for dataclass instances (e.g., `NameParts`)
2. `__dict__` traversal with underscore stripping for regular classes (e.g., `Entry`, `Field`)
3. Full recursion through nested structures

```json
{
  "id": "parse-string",
  "entry": "parse_string",
  "watches": ["parse_string"],
  "file": "bibtexparser",
  "module": "bibtexparser",
  "stack": "python",
  "outputTransform": "dataclass_dict",
  "fingerprintLevel": "entry"
}
```

### Challenge 2: Pipeline/Middleware Pattern

**Problem**: The actual behavior is `splitter.split() → middleware1.transform() → middleware2.transform() → ...`. Regrets' chain testing can capture this, but the intermediate types are all `Library` objects, making chain steps look identical structurally.

**Solution**: Define chain steps that test each middleware independently, with inputs that exercise different code paths:

```json
{
  "chains": [
    {
      "id": "full-parse-pipeline",
      "steps": [
        { "cluster": "split-bibtex", "input": "@article{key, author = {Doe}}" },
        { "cluster": "separate-coauthors", "input": null }
      ]
    }
  ]
}
```

### Challenge 3: Private Backing Fields

**Problem**: Classes like `Entry` and `Field` use private backing fields (`_key`, `_value`, `_entry_type`) with public properties. The old `snapshot_state()` skipped attributes starting with `_`, losing all meaningful data.

**Solution**: The improved `deep_clone()` and `snapshot_state()` now strip leading underscores from private fields (`_key` → `key`), ensuring that property-backed class instances are properly serialized for fingerprinting.

## The `dataclass_dict` Output Transform

Added specifically for parser/pipeline libraries that return rich object hierarchies.

### When to use it

Use `outputTransform: "dataclass_dict"` when:
- The function returns class instances (not just primitives/strings)
- The class uses `@dataclass` or has `__dict__` attributes
- You need the full recursive structure preserved for fingerprinting

### How it works

1. If the value is a `@dataclass` instance → `dataclasses.asdict()` converts it recursively
2. If the value has `__dict__` → each attribute is recursively processed:
   - Private fields (`_key`) have underscore stripped → `key`
   - Dunder fields (`__class__`) are skipped
   - Nested objects are recursed into
3. If the value has `to_dict()` → that method is called
4. Primitives (str, int, float, bool, None) pass through unchanged

### Difference from `outputTransform: "dict"`

| Feature | `"dict"` | `"dataclass_dict"` |
|---------|----------|-------------------|
| Calls `obj.to_dict()` | Yes (first choice) | Yes (after dataclass/__dict__) |
| Uses `obj.__dict__` | Yes (fallback, shallow) | Yes (recursive, with underscore stripping) |
| Handles dataclasses | No | Yes (via `dataclasses.asdict()`) |
| Strips private underscores | No | Yes (`_key` → `key`) |
| Preserves class name | No | Yes (`__class__` field) |
| Recursion depth | Shallow | Full (nested objects handled) |

## Known Patterns for Parser Libraries

### Pure Function Entry Points

```json
{
  "id": "parse-single-name",
  "entry": "parse_single_name_into_parts",
  "watches": ["parse_single_name_into_parts"],
  "module": "bibtexparser.middlewares.names",
  "stack": "python",
  "outputTransform": "dataclass_dict",
  "fingerprintLevel": "entry",
  "inputs": ["Donald E. Knuth", "Ludwig van Beethoven"]
}
```

### Pipeline Entry Points (returns container object)

```json
{
  "id": "parse-string",
  "entry": "parse_string",
  "watches": ["parse_string"],
  "module": "bibtexparser",
  "stack": "python",
  "outputTransform": "dataclass_dict",
  "ignoreFields": ["parser_metadata"],
  "fingerprintLevel": "entry",
  "inputs": ["@article{knuth2024, author = {Donald E. Knuth}}"]
}
```

### Stateful Parser Methods (splitter)

For stateful classes like `Splitter`, the entry point is the method that produces output. Use the module-level function that wraps it:

```json
{
  "id": "split-bibtex",
  "entry": "parse_string",
  "watches": ["parse_string"],
  "module": "bibtexparser",
  "stack": "python",
  "outputTransform": "dataclass_dict",
  "ignoreFields": ["parser_metadata", "raw"],
  "fingerprintLevel": "entry",
  "inputs": ["@article{key, title = {Hello World}}"]
}
```

Note: `ignoreFields: ["raw"]` is recommended for parser libraries because the `raw` field contains the original text, which is redundant with the parsed structure and bloats the fingerprint.

## Recommendations for Parser Library Refactoring

1. **Always use `outputTransform: "dataclass_dict"`** for parser return types
2. **Use `ignoreFields`** to exclude `raw` (original text) and `parser_metadata` (auxiliary data) from fingerprinting
3. **Define chains for pipeline stages** — test each middleware independently
4. **Use `fingerprintLevel: "entry"`** rather than `"watched"` or `"full"` — parser internals are complex and brittle to track
5. **Test round-trip consistency** — `parse_string(write_string(library))` should produce equivalent output

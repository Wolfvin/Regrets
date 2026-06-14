# Class Hierarchy Python Projects

## Pattern

Libraries with deep dataclass inheritance hierarchies where the "output" is a tree
of nested dataclass instances rather than simple values. Common in:

- Citation parsers (eyecite, citation)
- NLP tokenizers (spaCy, NLTK)
- AST/code analysis tools
- Pydantic model-based APIs
- Any library where `Entry.__bases__` has depth > 1

## Challenge

The default `outputTransform: "dict"` fails for these projects because:

1. **Frozen dataclasses** have `__dict__` but some field values (like `tuple` of
   `Edition` objects) are not JSON-serializable.
2. **UserString subclasses** (e.g., `Token(CitationToken, UserString)`) — `dict()`
   captures the `data` attribute but loses all dataclass fields like `start`, `end`,
   `groups`, `exact_editions`.
3. **Nested dataclasses** — `FullCaseCitation.Metadata` is a dataclass inside a
   dataclass, and `dict()` only goes one level deep.
4. **Non-deterministic year bounds** — `_highest_valid_year = date.today().year + 1`
   causes fingerprints to change every January.
5. **Character offset positions** — Token `start`/`end` fields are absolute byte
   offsets that shift with any change to input text, but don't represent behavioral
   contracts.
6. **Class identity matters** — A `FullCaseCitation` and a `ShortCaseCitation` with
   identical field values represent different behavioral contracts. The fingerprint
   must distinguish them.

## Solution

### 1. Use `outputTransform: "dataclass_dict"`

Recursively converts dataclass instances to JSON-serializable dicts with a
`__class__` key preserving class identity:

```json
{
  "outputTransform": "dataclass_dict"
}
```

### 2. Use `normalize: ["currentYearBound"]`

Prevents drift from `date.today().year` validation bounds:

```json
{
  "normalize": ["currentYearBound"]
}
```

Replaces integers equal to the current year with `<CURRENT_YEAR>` and current year
+ 1 with `<CURRENT_YEAR+1>`. This is essential for citation validators, date range
checkers, and any code that uses "this year" as a boundary.

### 3. Use `normalize: ["tokenOffsets"]`

Normalizes character offset values in known offset keys to `<OFFSET>`:

```json
{
  "normalize": ["tokenOffsets"]
}
```

Affected keys: `start`, `end`, `span_start`, `span_end`, `full_span_start`,
`full_span_end`, `pin_cite_span_start`, `pin_cite_span_end`.

### 4. Use `ignoreFields: ["document"]`

For citation parsers that attach a `Document` reference to each citation object,
this field is circular and environment-dependent. Strip it:

```json
{
  "ignoreFields": ["document"]
}
```

### 5. Use adapter module pattern

When the library's entry function has complex dependencies or non-standard
import paths, create an adapter module that re-exports the entry function:

```python
# regret_adapters.py
from eyecite import get_citations, clean_text, resolve_citations, annotate_citations
```

Then reference it in the manifest:

```json
{
  "module": "regret_adapters",
  "pythonPath": "."
}
```

## Complete Example (eyecite)

```json
{
  "clusters": [
    {
      "id": "find-case-citation",
      "entry": "get_citations",
      "watches": ["get_citations"],
      "module": "regret_adapters",
      "stack": "python",
      "pythonPath": ".",
      "outputTransform": "dataclass_dict",
      "normalize": ["currentYearBound", "tokenOffsets"],
      "ignoreFields": ["document"],
      "inputs": [
        "1 U.S. 1",
        "Adarand Constructors, Inc. v. Peña, 515 U.S. 200, 240 (1995)",
        "Id. at 241"
      ]
    }
  ]
}
```

## When to Use This Pattern

- Output is a list of dataclass instances with nested metadata
- Any field contains `datetime` or `date` objects
- Character/string offsets are part of the output
- Class identity is semantically important (subclasses with same fields but different behavior)
- The library uses `date.today()` or `datetime.now()` for validation bounds

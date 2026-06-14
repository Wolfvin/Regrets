# Pipeline Function Adapter Pattern

## Problem

Many libraries have pipeline functions where one step's output feeds into the next:

```python
# eyecite pipeline:
citations = get_citations(text)           # returns list[CitationBase]
resolved = resolve_citations(citations)   # takes list[CitationBase], not string
annotated = annotate_citations(text, annotations, source_text)
```

Regrets can only call functions with **serializable inputs** (strings, numbers, lists, dicts).
It cannot pass complex objects like `CitationBase` instances as inputs.

This is a common pattern in:
- NLP pipelines (tokenizer → tagger → parser)
- Citation extraction (find → resolve → annotate)
- Data processing (extract → transform → load)
- AST/code analysis (parse → analyze → report)

## Solution: Adapter Functions

Create a `regret_adapters.py` module that wraps pipeline functions with
serializable-input signatures:

```python
# regret_adapters.py
from eyecite import get_citations, resolve_citations

def resolve_from_text(plain_text):
    """Adapter: get citations from text, then resolve them."""
    citations = get_citations(plain_text)
    resolutions = resolve_citations(citations)
    # Convert to serializable format
    result = []
    for resource, cite_list in resolutions.items():
        result.append({
            'resource_hash': hash(resource),
            'resource_class': type(resource).__name__,
            'citations': cite_list,
        })
    return result
```

Then reference the adapter in the manifest:

```json
{
  "id": "resolve-citations",
  "entry": "resolve_from_text",
  "watches": ["resolve_from_text"],
  "module": "regret_adapters",
  "stack": "python",
  "pythonPath": ".",
  "outputTransform": "dataclass_dict",
  "normalize": ["currentYearBound", "tokenOffsets"],
  "ignoreFields": ["document"],
  "inputs": ["Foo v. Bar, 1 U.S. 1. Foo at 2. Id. at 3."]
}
```

## Key Principles

1. **Adapter functions accept serializable inputs** — strings, numbers, lists, dicts
2. **Adapter functions call the real pipeline internally** — constructing complex objects as needed
3. **Return value must be fingerprintable** — use `outputTransform: "dataclass_dict"` for complex objects
4. **Use `ignoreFields` for circular references** — pipeline objects often reference back to their source
5. **The adapter module goes in the target project root** — set `pythonPath: "."` so it can be imported
6. **Use `normalize` rules for non-deterministic values** — `currentYearBound` for year-based validation, `tokenOffsets` for character positions

## Multi-Step Clean Functions

For functions that take multiple arguments (like `clean_text(text, steps)`),
create single-argument adapter functions:

```python
def clean_html_only(html_content):
    """Adapter: clean HTML markup from text."""
    return clean_text(html_content, ["html"])

def clean_inline_whitespace_only(text):
    """Adapter: clean inline whitespace from text."""
    return clean_text(text, ["inline_whitespace"])
```

This keeps each cluster focused on one cleaning step, making it easier to
identify which specific cleaning function broke during refactoring.

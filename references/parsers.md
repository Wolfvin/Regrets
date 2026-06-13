# Parser & AST Projects — Regrets Reference

Parsers and AST-heavy projects (compilers, interpreters, linters, formatters)
present unique challenges for output-based regression testing. This reference
covers patterns, pitfalls, and proven strategies for using Regrets with these
codebases.

---

## Why Parsers Are Hard to Fingerprint

Parsers combine three properties that make regression testing difficult:

1. **Generator/iterator output**: Most parsers yield tokens or AST nodes lazily.
   A `lex()` function returns an iterator; `iter_subtrees()` yields nodes.
   Regrets cannot fingerprint a generator object — it must be materialized first.

2. **Mutable state**: Parsers maintain state objects (line counters, scope stacks,
   indentation levels). Functions that advance or mutate this state produce
   different output on subsequent calls with the same input.

3. **Object identity via `id()`**: Tree/forest implementations often use `id()`
   for cycle detection and deduplication. These IDs change across runs, making
   fingerprints non-reproducible.

---

## Feature: `materializeOutput`

**When to use**: Your entry function returns a generator, iterator, map/filter
object, or any lazy sequence.

**How it works**: When `materializeOutput: true` is set in the manifest,
Regrets automatically consumes the iterator and stores the materialized list
in the `.regret` file. This works for both Python and JS stacks.

### Python Example

```json
{
  "id": "lexer-tokens",
  "entry": "lex",
  "watches": ["lex", "next_token"],
  "module": "lark.lexer",
  "stack": "python",
  "materializeOutput": true,
  "inputs": [
    {"text": "SELECT * FROM users"}
  ]
}
```

When `lex()` returns a generator, capture.py automatically converts it to
a `list` before fingerprinting. The `.regret` file stores the full list of
tokens, not the generator object.

### JavaScript Example

```json
{
  "id": "tokenizer-output",
  "entry": "tokenize",
  "watches": ["tokenize", "readToken"],
  "file": "src/tokenizer.js",
  "stack": "js",
  "materializeOutput": true,
  "inputs": ["const x = 42;"]
}
```

When `tokenize()` returns an iterable/generator, capture.js consumes it and
stores the array.

### What Gets Materialized

| Type | Materialized To | Stack |
|------|----------------|-------|
| Python `generator` | `list` | Python |
| Python `map`/`filter` | `list` | Python |
| Python `range` | `list` | Python |
| Python custom iterator | `list` | Python |
| JS `Generator` | `Array` | JS |
| JS `Iterable` (non-Array) | `Array` | JS |
| JS `AsyncIterable` | `Array` | JS |

Types already concrete (list, Array, dict, Object) are NOT materialized —
they pass through as-is.

---

## Feature: `trackMutation`

**When to use**: Your entry function mutates its input (in-place transforms,
state advancement, tree modifications).

**How it works**: When `trackMutation: true` is set, Regrets snapshots the
input state before AND after the function call. It computes a mutation
fingerprint from the before/after pair and stores it in the `.regret` file.
If a refactor changes the mutation behavior, the mutation fingerprint will
mismatch even if the return value is identical.

### Example

```json
{
  "id": "transform-inplace",
  "entry": "transform",
  "watches": ["transform"],
  "module": "my_module.tree_ops",
  "stack": "python",
  "trackMutation": true,
  "inputs": [
    {"type": "root", "children": [{"type": "leaf", "value": 42}]}
  ]
}
```

The `.regret` file will contain:
```
trackMutation: true
mutationFingerprint: abc1234
---
INPUT  {...}
OUTPUT {...}
HASH   xyz7890
MUTATION_BEFORE {"type": "root", "children": [...]}
MUTATION_AFTER  {"type": "root", "children": [...modified...]}
```

During validation, if the mutation fingerprint changes (meaning the function
now mutates input differently), Regrets reports `MUTATION MISMATCH` even if
the output fingerprint matches.

---

## Strategy: Splitting Parser Clusters

Don't try to fingerprint an entire parser pipeline in one cluster. Split by
domain:

### Recommended Cluster Boundaries for Parsers

| Cluster | Entry Function | What It Tests |
|---------|---------------|---------------|
| `grammar-load` | `load_grammar()` | Grammar text → internal representation |
| `lexer-tokens` | `lex()` | Source text → token stream |
| `parse-<algorithm>` | `parse()` | Token stream → parse tree/forest |
| `tree-transform` | `Transformer.transform()` | Parse tree → transformed tree |
| `tree-visit` | `Visitor.visit()` | Tree traversal side effects |
| `reconstruct` | `reconstruct()` | Tree → source text |

### What NOT to Cluster

- **God initializers** (e.g., `Lark.__init__`): Too many side effects (caching,
  file I/O, environment-dependent behavior). Create adapter functions instead.
- **Functions returning closures/partials**: Cannot be serialized or compared.
  Test them by calling the returned function instead.
- **Debug/visualization methods**: Often use `randint()`, `id()`, or `print()`.

---

## Normalization Rules for Parsers

| Rule | When to Use | Example |
|------|-------------|---------|
| `timestamps` | Parser logs include timestamps | `"Parsed at 2024-01-15T10:00:00Z"` → `<TIMESTAMP>` |
| `absPaths` | Error messages include file paths | `"/home/user/src/main.lark"` → `<ROOT>/src/main.lark"` |
| `objectIds` | Tree nodes include `id()` values | `{"node_id": 140234567890}` → `<OBJECT_ID>` |

> **Note**: `objectIds` is not yet a built-in normalize rule. For now, use
> `ignoreFields: ["node_id"]` or write an adapter that strips `id()`-based
> fields before returning.

---

## Adapter Pattern for Stateful Parsers

For functions that depend on mutable state (e.g., a `LexerState` with a
`LineCounter`), create a thin adapter module:

```python
# regrets_adapters/lexer_adapter.py
from lark.lexer import BasicLexer, LexerState, Token

def lex_to_list(grammar_text, source_text):
    """Adapter: creates a fresh lexer and materializes all tokens."""
    from lark import Lark
    parser = Lark(grammar_text, parser='earley', lexer='basic')
    lexer = parser.lex(source_text)
    return [str(t) for t in lexer]  # Convert tokens to strings for fingerprinting
```

Then in your manifest:
```json
{
  "id": "lexer-tokens",
  "entry": "lex_to_list",
  "watches": [],
  "module": "regrets_adapters.lexer_adapter",
  "stack": "python",
  "materializeOutput": true
}
```

---

## Common Pitfalls

### 1. `id()` in Tree/Forest Operations
**Problem**: SPPF forests and AST nodes often use `id()` for deduplication.
These IDs are memory addresses and change every run.

**Solution**: Fingerprint the final output (e.g., the reconstructed parse tree)
rather than intermediate forest structures. Use `fingerprintLevel: "entry"`.

### 2. Set/Dict Iteration Order
**Problem**: Parser tables built from sets/dicts may have iteration-order
dependent output.

**Solution**: Sort outputs before fingerprinting, or use `fingerprintMode: "schema"`
to test only the structure, not the values.

### 3. Pickle-Based Caching
**Problem**: Some parsers use pickle for caching. Pickle bytes are
Python-version and platform dependent.

**Solution**: Disable caching during capture (`keep_all_tokens=False`,
`use_cache=False`), or add `absPaths` normalization for cache file paths.

### 4. Conditional Imports
**Problem**: Behavior changes based on optional dependencies (e.g., `regex`
vs `re`, `interegular` for collision checking).

**Solution**: Pin dependencies in your test environment. Document which
packages must be installed for consistent fingerprints.

### 5. Non-Reentrant State
**Problem**: `LexerState` with `LineCounter` advances on each `feed()` call.
Running the same function twice on the same state object gives different output.

**Solution**: Always create fresh state objects in your adapter. Never reuse
state across captures.

---

## Case Study: Lark Parser

The Lark parsing toolkit (github.com/lark-parser/lark) was the first parser
project tested with Regrets. Key findings:

- **8 clusters** identified across grammar compilation, lexing, Earley/LALR
  parsing, tree operations, and reconstruction
- **`materializeOutput: true`** required for `lex()`, `iter_subtrees()`,
  and `reconstruct._reconstruct()`
- **Adapter modules** needed for `Lark.__init__` (to avoid cache/file I/O)
  and `Transformer_InPlace` (to create fresh input trees each run)
- **`id()` normalization** needed for Earley forest nodes — solved by
  fingerprinting the final `Tree` output instead of the forest

# Multi-Module Python Projects

Guide for using Regrets with complex, multi-module Python projects — projects
where the code is split across packages, subpackages, and dozens of files
rather than living in a single module.

## When This Guide Applies

- The target project has a package structure (`mypackage/sub/`)
- Entry functions return complex objects (not just primitives or dicts)
- Functions return generators or iterators
- The project has internal mutation-based architecture
- You need to fingerprint output from functions that modify objects in-place

Real examples: SQL parsers, AST transformers, template engines, data
pipelines, compiler frontends.

## Key Challenges

### 1. Complex Return Objects

Entry functions may return objects that can't be JSON-serialized — objects with
circular references, methods, custom `__repr__`, or internal state.

**Solution: `outputTransform`**

Add an `outputTransform` field to your cluster definition to convert complex
objects into fingerprintable form before hashing:

```json
{
  "id": "parse-select",
  "entry": "parse",
  "watches": ["parse"],
  "module": "sqlparse",
  "stack": "python",
  "outputTransform": "str",
  "inputs": ["SELECT * FROM users WHERE id = 1"]
}
```

Supported transforms:

| Transform | What it does | Best for |
|-----------|-------------|----------|
| `"str"` | `str()` each element | Objects with meaningful `__str__` (AST nodes, SQL statements) |
| `"repr"` | `repr()` each element | Objects where repr reveals structure |
| `"dict"` | `obj.__dict__` or `obj.to_dict()` | Objects with serializable attributes |
| `"len"` | `len(obj)` | Large collections where only size matters |
| `"type"` | `type(obj).__name__` | When only the type matters, not the content |
| `"module.fn"` | Import and call custom function | When you need full control over serialization |

When output is a list/tuple, the transform is applied to each element.
When output is a single object, the transform is applied once.

**Custom transform example:**

```python
# myproject/regret_helpers.py
def flatten_statements(statements):
    """Convert list of Statement objects to list of token tuples."""
    result = []
    for stmt in statements:
        result.append([(t.ttype, t.value) for t in stmt.flatten()])
    return result
```

```json
{
  "outputTransform": "regret_helpers.flatten_statements"
}
```

### 2. Generator Functions

Some entry functions return generators (using `yield`) or iterators. Regrets
automatically consumes generators and iterators into lists before
fingerprinting — no extra configuration needed.

```python
# This works out of the box:
def parsestream(sql):
    """Yields Statement objects one at a time."""
    yield Statement(...)
```

Regrets will call `list()` on the generator and fingerprint the full list of
yielded values. If you also need an `outputTransform`, it will be applied
after the generator is consumed.

### 3. In-Place Mutation

Many Python projects use in-place mutation rather than returning new objects.
For example, a grouping function might modify a tree structure without
returning anything.

Regrets fingerprints **return values**, not mutations. To verify mutation-based
code:

1. **Fingerprint at the API level** — Use the top-level entry function whose
   return value reflects all mutations. For a parser, fingerprint `parse()`,
   not the internal grouping functions.

2. **Use `fingerprintLevel: "full"`** — This captures the entire call sequence
   of watched functions, including their individual inputs and outputs.

3. **Design clusters around observable behavior** — The contract is what the
   user sees, not how the internals mutate state.

Example:

```json
{
  "id": "format-reindent",
  "entry": "format",
  "watches": ["format"],
  "module": "sqlparse",
  "stack": "python",
  "outputTransform": "str",
  "inputs": [
    {"sql": "select * from users", "options": {"reindent": true}}
  ]
}
```

### 4. Multi-Stage Pipelines

Projects like parsers often have a pipeline: tokenize → parse → group → format.
Use **chain testing** to verify the pipeline end-to-end:

```json
{
  "chains": [
    {
      "id": "parse-pipeline",
      "steps": [
        {
          "cluster": "tokenize-basic",
          "input": "SELECT * FROM users"
        },
        {
          "cluster": "parse-basic",
          "input": "SELECT * FROM users"
        },
        {
          "cluster": "format-reindent",
          "input": "SELECT * FROM users"
        }
      ]
    }
  ]
}
```

Each step references a cluster from the manifest. The chain hash captures the
entire pipeline fingerprint, ensuring no stage has changed behavior.

### 5. Package Import Paths

For installed packages, use the `module` field with dot notation:

```json
{
  "module": "sqlparse"
}
```

For local packages that aren't installed, use `pythonPath`:

```json
{
  "module": "sqlparse",
  "pythonPath": "."
}
```

For submodules:

```json
{
  "module": "sqlparse.engine.grouping",
  "pythonPath": "."
}
```

### 6. Fresh State Per Capture

Some classes maintain internal state (counters, caches, stacks). Ensure each
capture starts with a fresh instance by defining the entry function to create
a new instance each time:

```python
# Don't fingerprint a method on a shared instance
# Instead, wrap it:
def fresh_parse(sql):
    """Create a fresh parser each time."""
    return sqlparse.parse(sql)
```

For class-based APIs, use the adapter pattern described in
`references/class-adapter.md`.

## Strategy for Large Codebases

### Cluster Granularity

For a project with 4000+ lines across multiple modules, aim for 8-15 clusters:

1. **API-level clusters** (3-5): Cover the main entry points with diverse
   inputs. These are your safety net — if they stay green, your refactor
   didn't break observable behavior.

2. **Internal function clusters** (3-5): Cover key internal functions that
   you plan to refactor. These give you more granular feedback about which
   specific function changed.

3. **Pipeline clusters** (1-2): Chain tests that verify multi-step flows.

### Input Selection

Choose inputs that cover different code paths:

```json
{
  "id": "parse-statements",
  "entry": "parse",
  "watches": ["parse"],
  "module": "sqlparse",
  "stack": "python",
  "outputTransform": "str",
  "inputs": [
    "SELECT * FROM users",
    "INSERT INTO users (name) VALUES ('Alice')",
    "CREATE TABLE users (id INT PRIMARY KEY)",
    "BEGIN; SELECT 1; END;",
    "SELECT a, b FROM t WHERE x = 1 GROUP BY a HAVING COUNT(*) > 5"
  ]
}
```

Each input exercises different SQL constructs, ensuring broad coverage.

### What NOT to Fingerprint

- **Data files** (keyword dictionaries, lookup tables): These are constants,
  not behavior. Fingerprinting them adds noise.
- **Broken/dead code**: Skip `RightMarginFilter` if it raises
  `NotImplementedError`.
- **CLI functions**: I/O side effects make them hard to fingerprint cleanly.
  Test the underlying library functions instead.

## Checklist

- [ ] All entry functions return fingerprintable output (or use `outputTransform`)
- [ ] Generators are consumed (happens automatically)
- [ ] Fresh state per capture (no shared mutable state between runs)
- [ ] `pythonPath` set correctly for local packages
- [ ] `module` uses correct dot-notation for Python imports
- [ ] Chain tests cover multi-step pipelines
- [ ] `regret health` shows all clusters as SOLID
- [ ] `regret drift` shows no non-determinism across 5 runs

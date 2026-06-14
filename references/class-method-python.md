# classMethod for Python — Instance Method Fingerprinting

## Problem

Many Python libraries use class-based APIs where the primary usage pattern is:

```python
from library import SomeClass
instance = SomeClass(config1, config2)
result = instance.process(data)
```

Before this feature, Regrets Python stack could only fingerprint standalone module-level
functions (`entry: functionName`). This made it impossible to regression-test libraries
where the interesting behavior lives in **instance methods**, not standalone functions.

Real-world examples where this gap was discovered:
- **construct/construct**: Binary data structure parsing library. Usage:
  `Struct("a"/Byte, "b"/Byte).parse(b"\x01\x02")` — the `.parse()` and `.build()`
  methods are the entry points, not standalone functions.
- **parsedatetime**: Date/time parsing library. Usage:
  `Calendar().parse("tomorrow")` — the `.parse()` method defaults to `time.localtime()`
  for the source time, requiring `freezeTime` for deterministic fingerprinting.
- Any library that uses a builder pattern, configuration objects, or stateful processors.

Previously, Python users had to create manual entry wrapper files (see `references/class-based-python.md`).
The JS stack already had `classMethod` support, but Python did not.

## Solution: classMethod for Python

Mirrors the existing JS-side `classMethod` feature, adding it to the Python stack.

### Manifest Fields

```json
{
  "id": "struct-parse",
  "entry": "Struct",
  "watches": [],
  "file": "construct/core.py",
  "module": "construct",
  "stack": "python",
  "fingerprintLevel": "entry",
  "classMethod": "parse",
  "constructor": "Struct",
  "constructorArgs": ["a", "b"],
  "setup": [],
  "inputs": [
    {"type": "bytes", "value": "AQID"}
  ]
}
```

| Field | Required | Type | Description |
|-------|----------|------|-------------|
| `classMethod` | Yes (for class mode) | string | The instance method to call and fingerprint |
| `constructor` | No | string | Class name to instantiate (default: `entry`) |
| `constructorArgs` | No | array | Arguments passed to the constructor |
| `setup` | No | array | Optional list of `{method, args}` to call before the target method |

### Execution Flow

When `classMethod` is set:

1. Import the module specified by `module`/`file`
2. Get the class from the module using `constructor` (or `entry` as fallback)
3. Instantiate: `instance = Cls(*constructorArgs)`
4. Run each setup step: `instance[step.method](*step.args)`
5. Call the target method: `result = instance.classMethod(input)`
6. Fingerprint the result

### Example: parsedatetime

```json
{
  "id": "calendar-parse",
  "entry": "Calendar",
  "classMethod": "parse",
  "constructor": "Calendar",
  "constructorArgs": [],
  "module": "parsedatetime",
  "stack": "python",
  "freezeTime": "2025-06-14T12:00:00",
  "inputs": ["tomorrow", "next friday", "in 2 weeks"],
  "watches": []
}
```

This creates a `Calendar` instance, then fingerprints `calendar.parse("tomorrow")`, `calendar.parse("next friday")`, etc.

### Example: Calendar.parseDT

```json
{
  "id": "calendar-parse-dt",
  "entry": "Calendar",
  "classMethod": "parseDT",
  "constructor": "Calendar",
  "constructorArgs": [],
  "module": "parsedatetime",
  "stack": "python",
  "freezeTime": "2025-06-14T12:00:00",
  "inputs": ["tomorrow at 3pm", "next monday"],
  "watches": []
}
```

### Example: Calendar.inc (kwargs mode)

```json
{
  "id": "calendar-inc",
  "entry": "Calendar",
  "classMethod": "inc",
  "constructor": "Calendar",
  "constructorArgs": [],
  "module": "parsedatetime",
  "inputs": [{"month": 1}, {"year": 1}],
  "kwargs": true,
  "watches": []
}
```

### .regret File Format

The `.regret` file includes classMethod metadata:

```
cluster: struct-parse
version: 1
fingerprint: abc1234
captured: 2025-06-14T00:00:00Z
watches: []
entry: Struct
classMethod: parse
constructor: Struct
constructorArgs: ["a","b"]
setup: []
stack: python
fingerprintLevel: entry
freezeTime: 2025-06-14T12:00:00
---
INPUT  "AQID"
OUTPUT {"a": 1, "b": 2}
HASH   abc1234
```

### Differences from JS classMethod

The Python implementation mirrors the JS `classMethod` feature but with Python-specific
adaptations:

- Constructor args are passed as a list (positional) or dict (keyword with `kwargs: true`)
- The `instanceMethods` config from JS is not needed — Python's ghost decorator wraps
  module-level functions, while classMethod handles instance methods directly
- Output transforms (`outputTransform`) work identically

### Use Cases

1. **Binary format parsers** (construct, pycrate, kaitai-struct):
   Parse and build are instance methods on declarative structure objects.

2. **Stateful processors** (NLP pipelines, data transformers):
   Configuration happens at construction, processing is a method call.

3. **Builder patterns** (SQL query builders, ML model builders):
   The builder is constructed, configured, then `build()` or `execute()` is called.

4. **Codec classes** (compression, encryption, encoding):
   Encoder/decoder instances with `encode()`/`decode()` methods.

5. **Date/time parsing** (parsedatetime, dateparser):
   Calendar instances with `parse()`/`parseDT()` methods that depend on current time.

## Comparison: classMethod vs Entry Wrappers

| Approach | Pros | Cons |
|----------|------|------|
| `classMethod` in manifest | No extra files needed; declarative; works with freezeTime | Limited to simple constructor + setup + method call pattern |
| Entry wrapper file (see `class-based-python.md`) | Full flexibility; can handle complex init logic | Requires maintaining a separate Python file |

### Use `classMethod` when:
- The class constructor is simple (no complex dependencies)
- You just need to call one method after construction
- Setup is a simple sequence of method calls with static args
- You want to use `freezeTime` (which works seamlessly with classMethod)

### Use entry wrappers when:
- The class requires complex dependency injection
- You need to transform the output before fingerprinting
- You need custom logic between construction and the method call
- The class depends on external resources that need mocking

## Validation

The `classMethod` mode works with all existing validation features:
- `regret validate` — compares fingerprints (reads classMethod from .regret file)
- `regret drift` — runs multiple times for stability
- `regret health` — tracks cluster health
- `regret update` — safe update with audit trail
- `regret chain` — can chain class-based clusters
- `regret truth` — saves raw output from class methods

The .regret file stores `constructor`, `classMethod`, `constructorArgs`, and `setup` so that validation can reproduce the exact same instance state.

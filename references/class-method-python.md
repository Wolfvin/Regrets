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
- Any library that uses a builder pattern, configuration objects, or stateful processors.

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

| Field | Type | Description |
|-------|------|-------------|
| `classMethod` | string | The instance method to call and fingerprint |
| `constructor` | string | Class name to instantiate (default: `entry`) |
| `constructorArgs` | array | Arguments passed to the constructor |
| `setup` | array | Optional list of `{method, args}` to call before the target method |

### Execution Flow

When `classMethod` is set:

1. Import the module specified by `module`/`file`
2. Get the class from the module using `constructor` (or `entry` as fallback)
3. Instantiate: `instance = Cls(*constructorArgs)`
4. Run each setup step: `instance[step.method](*step.args)`
5. Call the target method: `result = instance.classMethod(input)`
6. Fingerprint the result

### .regret File Format

The `.regret` file includes classMethod metadata:

```
cluster: struct-parse
fingerprint: abc1234
entry: Struct
classMethod: parse
constructor: Struct
constructorArgs: ["a","b"]
setup: []
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

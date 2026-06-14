# Python Adapter Pattern — Bridging Circular Imports and Custom Serialization

## The Problem

Many Python projects have issues that prevent direct Regrets capture:

1. **Circular imports** — Module A imports Module B, which imports Module A.
   `importlib.import_module()` may fail or produce partially-initialized modules.

2. **Custom domain objects** — Functions return class instances (`Chord`, `Note`,
   `Scale`) that don't serialize to JSON natively. The fingerprint pipeline
   needs JSON-serializable output.

3. **Hidden entry points** — The public API is exposed through a top-level
   module that re-exports from internal modules, making it hard to target
   specific functions.

## Solution: Adapter Module

Create a thin adapter module (`regret_adapter.py`) at the project root that:

1. Controls the import order (resolves circular dependencies)
2. Wraps entry functions to return JSON-serializable output
3. Exposes standalone functions that Regrets can call directly

### Template

```python
"""Regrets adapter for [project] — bridges circular imports and custom serialization."""
import sys
import os

# Ensure project root is on sys.path
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

# Pre-load the dependency chain in correct order (resolves circular imports)
import project.internal_module   # Load base module first
import project.top_module        # Now the top-level module can resolve all refs

# Import what you need
from project.api import main_function, helper_function


def wrapped_function(input_arg):
    """Call main_function and serialize the result."""
    result = main_function(input_arg)
    return _serialize(result)


def _serialize(obj):
    """Convert custom objects to JSON-serializable form."""
    if hasattr(obj, 'to_dict') and callable(obj.to_dict):
        return obj.to_dict()
    if hasattr(obj, '__dict__'):
        d = {}
        for k, v in obj.__dict__.items():
            if not k.startswith('_'):
                if isinstance(v, (int, float, str, bool, type(None), list, dict)):
                    d[k] = v
                else:
                    d[k] = str(v)
        return d
    return str(obj)
```

### Manifest Configuration

```json
{
  "clusters": [
    {
      "id": "main-function",
      "entry": "wrapped_function",
      "watches": ["wrapped_function"],
      "module": "regret_adapter",
      "stack": "python",
      "pythonPath": ".",
      "outputTransform": "to_dict",
      "inputs": ["test_input_1", "test_input_2"]
    }
  ]
}
```

## Key Points

1. **Place the adapter at the project root** so Regrets can find it via
   `pythonPath: "."` and `module: "regret_adapter"`.

2. **The adapter handles serialization**, not the entry function. This means
   the `outputTransform` in the manifest can be `"to_dict"` (for the recursive
   serialization added in capture.py/validate.py) or left empty if the adapter
   already returns a dict.

3. **The `watches` list should include the adapter function name**, not internal
   functions. Since the ghost proxy wraps module-level exports, it can only
   observe calls to the adapter function itself.

4. **The "watched function never called" warning** is expected for adapter
   modules — the ghost proxy wraps `construct_chord` in the adapter, but the
   actual call to `C()` happens inside the function body, which the proxy
   can't intercept. For `fingerprintLevel: "entry"`, this is harmless.

5. **Import order matters**. If you get `ImportError` or `AttributeError`,
   try pre-loading the dependency chain in the adapter before importing the
   functions you need.

## When to Use

| Situation | Solution |
|-----------|----------|
| Circular imports | Adapter with controlled import order |
| Custom domain objects | Adapter with serialization wrapper |
| Both | Adapter that handles both (common) |
| Neither | Direct manifest — no adapter needed |

## Difference from JS Class-Instance Adapter

The JS adapter pattern (see `references/class-instance.md`) solves a different
problem: Ghost Proxy can't wrap instance methods. The Python adapter solves
both circular imports AND custom serialization — the Python Ghost Proxy works
differently (it wraps module-level functions, not instances).

## Real-World Example: musicpy

```python
# regret_adapter.py
import sys, os
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

# Pre-load dependency chain (structures → database → musicpy)
import musicpy.structures
import musicpy.database
import musicpy.musicpy

from musicpy.musicpy import C, N, S, scale, to_dict
from musicpy import algorithms as alg

def construct_chord(name):
    """Construct a chord from name and serialize to dict."""
    c = C(name)
    return to_dict(c)

def detect_chord(name):
    """Detect chord type from a chord name."""
    c = C(name)
    return alg.detect(c)
```

This adapter:
- Pre-loads `structures.py` before `musicpy.py`, breaking the circular import
- Wraps `C()` and `alg.detect()` in standalone functions
- Serializes chord objects using the library's `to_dict()` function
- Provides clean entry points for Regrets clusters

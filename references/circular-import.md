# Circular Import Handling — Regrets Capture in Coupled Codebases

## The Problem

Many Python projects have circular imports between modules. A common pattern:

```python
# structures.py
import musicpy as mp  # references musicpy module

class note:
    def to_standard(self):
        return mp.standardize_note(self.name)  # late-bound call to musicpy

class chord:
    def __call__(self, *args):
        return mp.C(*args)  # references musicpy.get_chord
```

```python
# musicpy.py
from structures import *  # imports everything from structures

def standardize_note(name): ...
def C(name): ...
```

When Regrets' `capture.py` tries to `importlib.import_module("musicpy")`, Python
may fail because `structures.py` tries to `import musicpy` before it's fully
initialized — a classic circular import error.

## Solution: Import Order Control

### Strategy 1: pythonPath + Module-Relative Import

Set `pythonPath` in the manifest so Regrets adds the project root to `sys.path`
before importing. This allows the module to resolve its own imports correctly:

```json
{
  "clusters": [
    {
      "id": "chord-construct",
      "entry": "C",
      "module": "musicpy.musicpy",
      "stack": "python",
      "pythonPath": ".",
      "inputs": ["Cmaj7"]
    }
  ]
}
```

### Strategy 2: Entry Module as the Leaf

Import the **leaf module** that doesn't create circular dependencies at import time.
In the example above, `musicpy.py` is the top-level module that imports from
`structures.py`. Importing `musicpy.musicpy` works because:
1. Python first loads `structures.py` (the dependency)
2. Then loads `musicpy.py` (the dependent)
3. The circular reference in `structures.py` (`import musicpy as mp`) is resolved
   at *call time* (late binding), not at *import time*

If you get `ImportError` or `AttributeError`, try importing the top-level module
instead of the inner one — it often ensures the full import chain completes.

### Strategy 3: Adapter Module for Circular Imports

When neither module can be imported cleanly, create an adapter module that
breaks the cycle:

```python
# regret_adapter.py (place at project root)
"""Adapter that imports musicpy in a controlled order."""
import sys
import os

# Ensure project root is on sys.path
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

# Import the top-level module first (it loads structures internally)
import musicpy as mp
from musicpy import C, S, N, P, read, write

# Export as standalone functions for Regrets
def construct_chord(name):
    return C(name)

def construct_scale(root, mode):
    return S(root, mode)

def construct_note(name, octave=4):
    return N(name, octave)
```

Then in the manifest, reference the adapter:

```json
{
  "clusters": [
    {
      "id": "chord-construct",
      "entry": "construct_chord",
      "module": "regret_adapter",
      "stack": "python",
      "pythonPath": "."
    }
  ]
}
```

### Strategy 4: Late Import Patching

If a module uses `import X` at the top level (not `from X import Y`), you can
sometimes resolve circular imports by ensuring the import target is loaded first:

```python
# In regret_adapter.py
import sys
# Pre-load the dependency chain in correct order
import musicpy.structures   # Load base module first
import musicpy.database     # Load data module
import musicpy.musicpy      # Now the top-level module can resolve all refs
```

## Diagnostic Checklist

If `regret capture` fails with an import error:

1. **Check the error message** — is it `ImportError` (module not found) or
   `AttributeError` (module found but attribute missing at import time)?

2. **Check import style** — `from X import Y` at module top level is stricter
   than `import X` with late binding (`X.Y` at call time). Late binding is
   more resilient to circular imports.

3. **Try different module paths** — `musicpy.musicpy` vs `musicpy.structures`
   vs `musicpy` (package). One may work where others don't.

4. **Check pythonPath** — ensure the project root directory is on `sys.path`
   before import. Use the `pythonPath` manifest field.

5. **Check for lazy imports** — some projects use `import X` inside functions
   to break cycles. This is actually good for Regrets — the import succeeds
   as long as the module is fully loaded by the time the function is called.

6. **Create an adapter** — if all else fails, an adapter module gives you
   full control over import order.

## When to Worry

Circular imports only cause problems when:
- A module references another module's attributes **at import time** (top-level
  code, class body, or decorator)
- The referenced module hasn't been fully initialized yet

Late-bound references (accessing module attributes inside function bodies)
are safe because by the time the function is called, all modules are loaded.

## Real-World Example: musicpy

musicpy has a circular dependency between `structures.py` and `musicpy.py`:
- `structures.py` does `import musicpy as mp` and calls `mp.standardize_note()`
  inside method bodies (late binding — safe)
- `musicpy.py` does `from structures import *` at the top level (import time —
  requires structures to be loaded first)

Solution: Import `musicpy.musicpy` as the entry module. Python loads
`structures.py` first (as a dependency), then `musicpy.py`. The circular
reference in `structures.py` is resolved at call time when methods are
invoked, by which point `musicpy.py` is fully loaded.

# Class-Based Python Projects — Regrets Integration Guide

## The Problem

Regrets' Python capture works by calling `entry_fn(input)` on a module. But many Python projects use classes with methods and properties as their primary API. You can't directly call `SexagenaryCycle.from_int(1)` as a module-level function through Regrets' import mechanism.

## The Solution: Entry Wrapper Pattern

Create a `regrets/entry_wrappers.py` file that exposes class methods as standalone functions:

```python
# regrets/entry_wrappers.py

import os
import sys

# Ensure the project's source is importable
_src_path = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), 'src')
if _src_path not in sys.path:
    sys.path.insert(0, _src_path)

from myproject import MyClass

def my_class_do_something(input_dict):
    """Wrapper that calls MyClass.do_something() and serializes the result."""
    obj = MyClass.from_dict(input_dict)
    result = obj.do_something()
    return result.to_dict()  # Serialize to JSON-compatible format
```

Then in your manifest:

```json
{
  "id": "my-class-do-something",
  "entry": "my_class_do_something",
  "watches": ["my_class_do_something"],
  "module": "regrets.entry_wrappers",
  "stack": "python",
  "pythonPath": ["src", "."],
  "inputs": [...]
}
```

## Key Rules for Wrappers

1. **Return JSON-serializable data** — Regrets fingerprints JSON output. Don't return custom objects; convert to dicts/lists/primitives.

2. **Use `pythonPath` as an array** — If your project needs multiple directories in `sys.path` (e.g., `src/` for the package AND `.` for the regrets module), use the array form:
   ```json
   "pythonPath": ["src", "."]
   ```

3. **Handle class instantiation in the wrapper** — The entry function should create the object, call the method, and return serializable output.

4. **Add `__init__.py` to regrets/** — The `regrets/` directory needs an `__init__.py` file for Python to recognize it as a package.

5. **Name wrappers clearly** — Use the pattern `{ClassName}_{method_name}` for wrapper function names to make it obvious which class method is being tested.

## When to Use This Pattern

- The target project uses classes with methods as its primary API
- Properties or classmethods need to be fingerprinted
- The output of a method is a complex object that needs serialization
- Multiple instances need to be created as part of the test flow

## Alternative: Direct Module Testing

If the project exports standalone functions (no class wrappers needed), you can reference them directly:

```json
{
  "module": "myproject.utils",
  "entry": "calculate_something",
  "pythonPath": "src"
}
```

This is simpler but only works for module-level functions.

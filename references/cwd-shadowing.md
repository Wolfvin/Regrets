# CWD Package Shadowing Warning

## The Problem

When running Regrets from inside a project directory whose name matches the
Python package name, Python's import system may find the **directory** as a
namespace package instead of the actual package subdirectory.

### Example

```
/home/z/my-project/inflect/        ← project root (CWD when running regret)
  inflect/                          ← the actual Python package
    __init__.py                     ← the real module
```

When you run `python3 scripts/capture.py` from `/home/z/my-project/inflect/`,
Python adds the CWD to `sys.path`. When it tries to `import inflect`, it finds
the directory `/home/z/my-project/inflect/` first — which is a namespace
package with no `__init__.py` — instead of the real package at
`/home/z/my-project/inflect/inflect/__init__.py`.

### Symptom

```python
import inflect
# No error, but:
dir(inflect)  # → ['__doc__', '__file__', '__loader__', ...] (empty namespace)
inflect.engine  # → AttributeError: module 'inflect' has no attribute 'engine'
```

## How to Detect It

Run this from your project directory:

```python
import inflect
print(inflect.__path__)
# If it shows ['/home/z/my-project/inflect'] → namespace package (WRONG)
# If it shows ['/home/z/my-project/inflect/inflect'] → real package (CORRECT)
```

## Solutions

### Solution 1: Run from a different directory

```bash
cd /tmp && python3 /path/to/Regrets/scripts/capture.py --manifest /path/to/project/regrets/manifest.json
```

### Solution 2: Use a virtual environment

When you `pip install -e .` the package, the installed path takes priority
over the CWD namespace package.

### Solution 3: Regrets auto-detects and warns

Starting from this improvement, `regret capture` and `regret validate` detect
when a module's `__path__` points to the project root instead of the package
directory and print a warning with actionable advice.

## Implementation

The capture.py and validate.py scripts now check if the imported module's
`__path__` is a namespace package pointing to the CWD, and print a warning:

```
⚠️  CWD SHADOWING: Module "inflect" resolves to a namespace package at
   /home/z/my-project/inflect/ instead of the real package.
   This happens when the project directory name matches the package name.
   Fix: Run from a different directory, or use `pip install -e .`
```

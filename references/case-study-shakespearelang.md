# Case Study: shakespearelang — Esoteric Language Interpreter

## Project

**Repository:** zmbc/shakespearelang
**Description:** Python interpreter for the Shakespeare Programming Language (SPL)
**Stack:** Python 3.8+
**Why Niche:** SPL is an esoteric programming language from ~2001 where programs look like Shakespeare plays. Characters are variables, acts/scenes are control flow, and dialogues are arithmetic operations.

## What Was Tested

10 clusters covering the pure-logic surface of the interpreter:

| Cluster | Entry Function | Fingerprint | Description |
|---------|---------------|-------------|-------------|
| normalize-character-name | normalize_character_name | 2re56mf | Character name normalization |
| character-code-to-char | character_code_to_char | 45tqus6 | Character code conversion |
| compute-positive-noun-value | compute_positive_noun_value | 6dnasqq | Positive noun phrase arithmetic |
| compute-negative-noun-value | compute_negative_noun_value | 55wmkjd | Negative noun phrase arithmetic |
| compute-factorial | compute_factorial | 6dnasqq | Factorial computation |
| compute-square-root | compute_square_root | 5m8e79v | Truncated square root |
| compute-quotient | compute_quotient | 2bh4lop | C-style truncated division |
| compute-remainder | compute_remainder | 4jutxop | C-style truncated remainder |
| character-push-pop-sequence | character_push_pop_sequence | onnbwby | Stack operation simulation |
| compare-values | compare_values | diuu4tq | SPL comparison logic |

## Key Findings

### 1. pythonPath is Critical for Non-Installed Projects

When the target Python project is cloned but not installed via `pip install -e .`, the `importlib.import_module()` call in `capture.py` fails with `ModuleNotFoundError`. The solution is adding `"pythonPath": "."` to each cluster in the manifest, which adds the project root to `sys.path` before importing.

**Before (failed):**
```json
{
  "module": "shakespearelang.pure_logic",
  "stack": "python"
}
```

**After (works):**
```json
{
  "module": "shakespearelang.pure_logic",
  "pythonPath": ".",
  "stack": "python"
}
```

### 2. Pure Logic Extraction Pattern for Python

When the target project mixes pure logic with I/O (e.g., `print()`, `sys.stdin`), create a `pure_logic.py` wrapper module that:

1. Imports only the deterministic functions from the target
2. Wraps them in side-effect-free functions
3. Serves as the single entry point for Regrets fingerprinting
4. Can be re-exported from domain-specific submodules after refactoring

### 3. multiArgs Works Well for Multi-Parameter Python Functions

Functions like `compute_quotient(a, b)` and `compare_values(a, b, type)` that take multiple arguments work correctly with `"multiArgs": true` in the manifest, where each input is an array that gets spread as separate arguments.

### 4. Python Projects with Class-Based APIs Need Wrapper Functions

The shakespearelang project uses classes extensively (Character, Expression, Operation), which can't be directly fingerprinted by the Regrets Python capture script since it expects module-level callables. The solution is creating wrapper functions that instantiate the class, call the method, and return the result:

```python
def character_push_pop_sequence(push_values):
    c = Character()
    for v in push_values:
        c.push(v)
    pop_results = []
    for _ in range(len(push_values)):
        c.pop()
        pop_results.append(c.value)
    return {"final_value": c.value, "final_stack": list(c.stack), "pop_sequence": pop_results}
```

### 5. Refactoring Verification Workflow

The triple verification system proved effective:

1. **Regrets validation** (all clusters GREEN) — catches behavioral changes
2. **Direct output comparison** (vs Truth 1) — confirms raw output identity
3. **Fingerprint cross-check** (vs Truth 2) — confirms Regrets captured correctly

All three verifications passed after a major refactoring that:
- Split `_utils.py` into `name_normalization.py` + `error_formatting.py`
- Split `pure_logic.py` into 5 domain-specific modules (name_normalization, char_codec, arithmetic, stack_ops, comparison)
- Extracted `_code_to_character` from `_output.py` into `char_codec.py`
- Delegated arithmetic from `_expression.py` to `arithmetic.py`
- Delegated comparison from `_operation.py` to `comparison.py`
- Renamed functions for clarity (e.g., `compute_factorial` → `factorial`, aliased via `as`)

## Zero False Positives

All 10 clusters produced zero false positives and zero drift across 5 consecutive runs. The pure-function nature of the tested code made Regrets exceptionally reliable on this codebase.

## Recommendations for Python Stack

1. **Always set `pythonPath`** when the project isn't pip-installed
2. **Create `pure_logic.py` wrappers** for class-based or I/O-heavy APIs
3. **Use `multiArgs: true`** for functions taking multiple arguments
4. **Return structured dicts** from wrapper functions for richer fingerprints
5. **Test edge cases** (empty lists, negative numbers, zero) in inputs arrays

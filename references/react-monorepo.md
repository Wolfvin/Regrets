# React Monorepo Support

## Problem

React monorepo projects (like `react-jsonschema-form`, `react-select`, MUI, etc.) present unique challenges for Regrets:

1. **Mixed stacks**: Utils packages are pure JS/TS, but component packages need React rendering
2. **Incrementing IDs**: `lodash/uniqueId`, `nanoid`, `React.useId` produce non-deterministic output across runs
3. **Mutation-revert patterns**: Validators often mutate internal state temporarily and revert it — invisible to fingerprinting
4. **Deep schema recursion**: Functions like `retrieveSchema` and `getDefaultFormState` have 700+ lines of conditional logic with complex branching

## Solution

### 1. `normalize: ["incrementingIds"]`

Added to `fingerprint.js` and `fingerprint.py`. Normalizes auto-incrementing and unique IDs before hashing:

- `lodash/uniqueId('prefix-')` → `"prefix-<ID>"`
- Pure numeric IDs → `"<ID>"`
- React `useId` format (`:r0:`, `:rs0:`) → `"<ID>"`
- nanoid-style alphanumeric strings → `"<ID>"`

Usage in manifest.json:
```json
{
  "id": "array-field-render",
  "entry": "ArrayField",
  "file": "packages/core/dist/index.js",
  "stack": "react",
  "normalize": ["incrementingIds"],
  "inputs": [{ "schema": { "type": "array" } }]
}
```

### 2. JS Mutation Risk Detection

Added to `audit.js`. Detects functions that mutate their input arguments — a common source of subtle bugs in refactoring:

- `delete obj.prop` — property deletion on arguments
- `Object.assign(arg, ...)` — mutating first argument
- `arg.push()` / `arg.splice()` / `arg.sort()` — array mutation on arguments
- `arg.prop = value` — property assignment matching parameter names

This mirrors Python's `mutate_audit.py` for JS/TS projects.

### 3. React Monorepo Detection in `scan`

Added to `scan.js`. Detects `packages/` directories with React dependencies and provides:
- Stack recommendations (use `js` for utils, `react` for components)
- `incrementingIds` normalization suggestions
- Validator-specific guidance

## Origin

These improvements were identified while analyzing `rjsf-team/react-jsonschema-form`:

- `ArrayField` uses `lodash/uniqueId` → causes drift in render fingerprints
- `getFirstMatchingOption` does `delete augmentedSchema.required` → invisible mutation risk
- The monorepo has 17 packages with mixed stacks → `scan` was not helpful
- No JS equivalent of Python's `mutate_audit.py` existed

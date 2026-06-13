# Backward-Compatible Re-export Pattern for Module Splitting

## The Problem

When refactoring a large module into smaller domain-specific modules,
all existing import paths must continue to work. Breaking imports across
the codebase is a common source of regressions that Regrets alone
won't catch — because the broken import happens at module load time,
before any function runs.

## The Pattern

After splitting a module, leave the original file as a thin re-export:

```python
# BEFORE: shared/amount_parser.py (148 lines)
# Contains: parse_idr(), is_amount(), is_date_like()

# AFTER: shared/amount_parse.py
def parse_idr(text: str) -> float:
    # ... implementation ...
    pass

# AFTER: shared/amount_classify.py
def is_amount(text: str) -> bool:
    # ... implementation ...
    pass

# AFTER: shared/date_classify.py
def is_date_like(text: str) -> bool:
    # ... implementation ...
    pass

# AFTER: shared/amount_parser.py (backward compat)
from .amount_parse import parse_idr
from .amount_classify import is_amount
from .date_classify import is_date_like
```

## Why This Matters for Regrets

When you split a module that has a `.regret` file referencing it:

```json
{
  "id": "parse-idr",
  "module": "shared.amount_parser",
  "entry": "parse_idr",
  ...
}
```

Without the re-export, `importlib.import_module('shared.amount_parser')` would
fail because `parse_idr` no longer exists in that module. The re-export ensures
the manifest doesn't need updating — the import still resolves correctly.

## When to Use

- **Always** when splitting a module that's referenced in `regrets/manifest.json`
- **Always** when other modules import from the old location
- The re-export file should be the LAST thing you create, AFTER the new
  split modules are working

## Verification Checklist

After splitting a module:

1. Run `regret validate` — all clusters must still be GREEN
2. Run `regret drift` — no new drift introduced
3. Search the codebase for all imports from the old module path:
   ```bash
   grep -r "from shared.amount_parser import" .
   ```
4. Each import must still resolve (re-export guarantees this)
5. The re-export file should NOT contain any logic — only `from .x import y`

## JS/TS Equivalent

```javascript
// BEFORE: utils.js (300 lines)
export function formatDate() { ... }
export function formatPeriod() { ... }
export function sanitize() { ... }

// AFTER: date-utils.js
export function formatDate() { ... }
export function formatPeriod() { ... }

// AFTER: filename-utils.js
export function sanitize() { ... }

// AFTER: utils.js (backward compat)
export { formatDate, formatPeriod } from './date-utils.js'
export { sanitize } from './filename-utils.js'
```

## When to Remove Re-exports

Re-exports are technical debt. Once ALL consumers (including Regrets
manifests) have been updated to import from the new locations, the
re-export file can be removed. Until then, keep it.

**Pro tip:** Add a comment to mark re-export files:

```python
# ⚠️ BACKWARD COMPATIBILITY — This file re-exports from split modules.
# Update imports to: shared.amount_parse, shared.amount_classify, shared.date_classify
```

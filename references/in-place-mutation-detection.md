# In-Place Mutation Detection — Reference

## Problem

When applying Regrets to real-world Python codebases like OCR pipelines, many "logically pure" functions mutate their input arguments in-place while still producing deterministic results. This creates ambiguity for agents setting up manifests:

- Is the function pure (same logical output for same input)?
- Or is it impure (mutates shared references)?
- Should it be fingerprinted as-is, or wrapped with `deep_copy`?

**Real example from bank-statement-ocr:**

```python
def validate_red_flag(transactions: list) -> list:
    """Deterministic saldo chain validation — but mutates input dicts!"""
    for txn in transactions:
        if saldo_ok:
            txn['flag'] = 'OK'           # mutates input dict
            txn['catatan_manual'] = ''    # mutates input dict
        else:
            txn['flag'] = 'SALDO_MISMATCH'
            txn['_suspect_field'] = suspect
    return transactions
```

The function IS deterministic — same input always produces same output. But it mutates the input list's dicts in-place, meaning:

1. Running it twice on the same list gives DIFFERENT results (keys already exist on second run)
2. Fingerprinting the output directly works, but the "input" that was captured may now be dirty
3. An agent setting up a manifest wouldn't know this without reading every line of code

## Mutation Patterns Detected

The `scan.py` mutation detector catches these patterns:

| Pattern | AST Signature | Example |
|---------|---------------|---------|
| Dict key assignment | `ast.Subscript` + `ast.Assign` | `txn['flag'] = 'OK'` |
| List append | `ast.Attribute` + `ast.Call` | `items.append(entry)` |
| List extend | `ast.Attribute` + `ast.Call` | `results.extend(batch)` |
| List insert | `ast.Attribute` + `ast.Call` | `rows.insert(0, header)` |
| Dict update | `ast.Attribute` + `ast.Call` | `config.update(defaults)` |
| Dict setdefault | `ast.Attribute` + `ast.Call` | `data.setdefault('x', 0)` |
| List sort/reverse | `ast.Attribute` + `ast.Call` | `items.sort()` |
| Nested mutation | `ast.Subscript` + `ast.Attribute` | `data['key'].append(val)` |

## How Regrets scan.py Helps

When `regret scan` detects argument mutations, it adds:

```
     validate_red_flag(transactions)  [✅ pure]  [5 branch(es)] 🔄mutates(transactions[...] = ..., transactions[...] = ...)
     ⚠️  Mutation warning: Mutates args in-place: transactions[...] = ... — wrap with deep_copy before fingerprinting
```

This tells the agent:
1. The function is logically pure (deterministic)
2. BUT it mutates its arguments
3. The agent should wrap inputs with deep_copy in the manifest or adapter

## Recommended Pattern

For functions that mutate args but are otherwise pure, create an adapter:

```python
# regret_adapters.py
import copy
from rekening_koran.validation import validate_red_flag

def validate_red_flag_safe(transactions):
    """Adapter: deep_copy input before passing to validate_red_flag."""
    return validate_red_flag(copy.deepcopy(transactions))
```

Then in manifest.json:

```json
{
  "id": "validate-red-flag",
  "entry": "validate_red_flag_safe",
  "watches": ["validate_red_flag"],
  "file": "regret_adapters.py"
}
```

## Oversized Function Warning

Additionally, `regret scan` now warns about functions larger than 30 lines:

```
     ⚠️  run_bank_statement at line 42: 210 lines — consider extracting sub-functions before clustering
```

This helps agents avoid creating clusters for monolithic functions that need decomposition first.

## Dead Import Detection

Dead imports confuse dependency analysis. `regret scan` now flags them:

```
     ⚠️  Line 4: 'is_date_like' imported but never used
```

This was discovered in `dynamic_params.py` which imports `is_date_like` from `amount_parser` but never uses it — creating a false dependency in the module graph.

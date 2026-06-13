# Python Pipeline Pattern — OCR, NLP, and Data Processing

## Overview

This reference covers regression testing for Python projects that implement
multi-stage processing pipelines — OCR systems, NLP pipelines, ETL workflows,
and similar architectures where data flows through a series of transformations.

These projects have unique challenges for regression testing:

1. **Heavy I/O boundaries** — image loading, model inference, file writing
2. **Pure logic buried inside I/O-heavy modules** — amount parsing, date
   classification, validation rules
3. **Non-deterministic model output** — ML model inference can vary slightly
   between runs
4. **Large output structures** — lists of hundreds of transactions, each with
   multiple numeric fields
5. **Float arithmetic** — financial calculations with IDR amounts that can
   produce tiny floating-point differences

## Strategy: Extract Pure Logic, Fingerprint the Logic

The key insight: **don't fingerprint the pipeline — fingerprint the pure
functions inside it.**

### What to Cluster

| Function Type | Cluster? | Why |
|---------------|----------|-----|
| `parse_idr(text)` | ✅ Yes | Pure: string → float |
| `is_date_like(text)` | ✅ Yes | Pure: string → bool |
| `is_amount(text)` | ✅ Yes | Pure: string → bool |
| `validate_red_flag(txns)` | ✅ Yes | Pure: list → list (no I/O) |
| `saldo_chain_classify(txns)` | ✅ Yes | Pure: list → list (no I/O) |
| `_classify_token(col, text)` | ✅ Yes | Pure: string → field assignment |
| `run_bank_statement(img)` | ❌ No | I/O: loads image, runs ML models, writes Excel |
| `run_ensemble_ocr(img)` | ❌ No | I/O: runs PaddleOCR model |
| `classify_document(regions)` | ❌ No | I/O: runs Qwen LLM inference |

### Pure Logic Extraction Pattern

When the pipeline module mixes pure logic with I/O, extract the pure parts:

```
BEFORE (untestable):
  pipeline.py → run_bank_statement() → parse amounts, validate, write Excel

AFTER (testable):
  amount_parser.py → parse_idr(), is_amount(), is_date_like()    (pure!)
  validation.py    → validate_red_flag()                         (pure!)
  classifier.py    → saldo_chain_classify()                      (pure!)
  pipeline.py      → run_bank_statement() → uses pure modules    (thin shell)
```

## Handling Float Arithmetic

Financial computing often produces floating-point differences that are
semantically identical but numerically different. Use the `floatTolerance`
normalization rule:

```json
{
  "id": "validate-red-flag",
  "entry": "validate_red_flag",
  "watches": ["validate_red_flag"],
  "module": "rekening_koran.validation",
  "stack": "python",
  "normalize": ["floatTolerance:0"],
  "inputs": [
    [{"tanggal": "01/05", "debit": 500000, "kredit": 0, "saldo": 9500000}]
  ]
}
```

`floatTolerance:0` rounds to 0 decimal places (integers) before hashing —
perfect for IDR amounts that should be whole numbers.

`floatTolerance:2` rounds to 2 decimal places — for values that may have cents.

`floatTolerance` (without `:N`) defaults to 2 decimal places.

## Using `regret diff` to Debug Failed Validation

When a cluster goes RED after refactoring, `regret diff` shows exactly what
changed in the output:

```bash
node scripts/regret.js diff --cluster validate-red-flag
```

Output:
```
❌ validate-red-flag                       abc1234 → def5678
  ≠ [2].saldo
      golden:  9500000
      live:    9500001
  ≈ [3].debit
      golden:  500000
      live:    500000.0000001
      diff:    1e-07 (within float tolerance)
```

Symbols:
- `≠` value mismatch (likely a real regression)
- `≈` float tolerance difference (probably safe)
- `+` key added in live output
- `-` key removed from live output

This tells the agent exactly where to look — instead of guessing from
fingerprint hashes.

## Chain Testing for Pipeline Flows

Define chains that test the end-to-end flow through pure functions:

```json
{
  "chains": [
    {
      "id": "parse-and-validate",
      "steps": [
        {
          "cluster": "parse-idr",
          "input": "12.365.595"
        },
        {
          "cluster": "is-date-like",
          "input": "01/05/2025"
        },
        {
          "cluster": "validate-red-flag",
          "input": [{"tanggal": "01/05", "debit": 500000, "kredit": 0, "saldo": 9500000}]
        }
      ]
    }
  ]
}
```

Python chain steps are automatically handled by the unified runner — no
separate script needed.

## Normalization Rules for Pipeline Projects

| Rule | Pattern | Use Case |
|------|---------|----------|
| `floatTolerance` | Round floats to 2dp | Financial amounts |
| `floatTolerance:0` | Round floats to 0dp | IDR integer amounts |
| `floatTolerance:4` | Round floats to 4dp | Scientific data |
| `timestamps` | ISO 8601 → `<TIMESTAMP>` | Processing timestamps |
| `dynamicDates` | MMYYYY/YYYY → `<MMYYYY>`/`<YYYY>` | Period strings |

## Manifest Example: Bank Statement OCR

```json
{
  "clusters": [
    {
      "id": "parse-idr",
      "entry": "parse_idr",
      "watches": ["parse_idr"],
      "module": "shared.amount_parser",
      "stack": "python",
      "pythonPath": "bank-statement-ocr/",
      "description": "Parse IDR-formatted amount string to float",
      "inputs": [
        "12.365.595",
        "100.000,00",
        "-5.000",
        "",
        "0"
      ]
    },
    {
      "id": "is-amount",
      "entry": "is_amount",
      "watches": ["is_amount"],
      "module": "shared.amount_parser",
      "stack": "python",
      "pythonPath": "bank-statement-ocr/",
      "description": "Check if text looks like IDR amount",
      "inputs": [
        "12.365.595",
        "hello",
        "1.2",
        "52.000.00="
      ]
    },
    {
      "id": "is-date-like",
      "entry": "is_date_like",
      "watches": ["is_date_like"],
      "module": "shared.amount_parser",
      "stack": "python",
      "pythonPath": "bank-statement-ocr/",
      "description": "Check if text matches date formats",
      "inputs": [
        "01/05/2025",
        "2025-05-01",
        "01 May",
        "not a date"
      ]
    },
    {
      "id": "validate-red-flag",
      "entry": "validate_red_flag",
      "watches": ["validate_red_flag"],
      "module": "rekening_koran.validation",
      "stack": "python",
      "pythonPath": "bank-statement-ocr/",
      "normalize": ["floatTolerance:0"],
      "description": "Validate saldo chain — flag mismatches",
      "inputs": [
        [
          {"tanggal": "01/05", "keterangan": "TRF", "debit": 500000, "kredit": 0, "saldo": 9500000, "flag": "OK", "catatan_manual": ""},
          {"tanggal": "02/05", "keterangan": "INCOMING", "debit": 0, "kredit": 200000, "saldo": 9700000, "flag": "OK", "catatan_manual": ""}
        ]
      ]
    },
    {
      "id": "saldo-chain-classify",
      "entry": "saldo_chain_classify_debit_kredit",
      "watches": ["saldo_chain_classify_debit_kredit"],
      "module": "rekening_koran.table_extractor.transaction_parser",
      "stack": "python",
      "pythonPath": "bank-statement-ocr/",
      "normalize": ["floatTolerance:0"],
      "description": "Classify debit/kredit using saldo chain verification",
      "inputs": [
        [
          {"tanggal": "01/05", "debit": 0, "kredit": 500000, "saldo": 10500000, "flag": "OK"},
          {"tanggal": "02/05", "debit": 200000, "kredit": 0, "saldo": 10300000, "flag": "OK"}
        ]
      ]
    }
  ]
}
```

## Adapter Module for Deep Imports

When the target module is deeply nested, create an adapter:

```python
# bank-statement-ocr/regrets_adapter.py
from shared.amount_parser import parse_idr, is_amount, is_date_like
from rekening_koran.validation import validate_red_flag
from rekening_koran.table_extractor.transaction_parser import (
    saldo_chain_classify_debit_kredit,
    _is_saldo_awal_row,
    _classify_token_to_field,
)

# Re-export private functions for testing
is_saldo_awal_row = _is_saldo_awal_row
classify_token_to_field = _classify_token_to_field
```

Then use `"module": "regrets_adapter"` and `"pythonPath": "bank-statement-ocr/"` in the manifest.

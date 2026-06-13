# OCR & Parsing Pipeline Pattern

## Overview

OCR and document parsing pipelines present a unique challenge for regression testing: they combine heavy I/O (OCR engines, LLM inference, image processing) with pure logic (column detection, transaction parsing, data normalization). This reference describes how to apply Regrets to these codebases by extracting and fingerprinting the pure logic layer.

## The Boundary Problem

OCR pipelines typically follow this pattern:

```
Image → OCR Engine → Raw Tokens → Pure Logic → Structured Data → Export
         ↑ I/O           ↑ I/O        ↑ PURE        ↑ PURE        ↑ I/O
```

The **pure logic** middle section is where refactoring is most valuable and where Regrets provides the most protection. The I/O boundaries (OCR, LLM, export) are not fingerprintable directly.

## Strategy: Pure Logic Extraction

### Step 1: Identify Pure Functions

In an OCR pipeline, pure functions are those that:
- Take structured data as input (not images or files)
- Return structured data as output (not write to disk or call APIs)
- Have deterministic output for the same input
- No hidden dependencies on global state, time, or random numbers

Common pure functions in OCR pipelines:
| Category | Examples |
|----------|---------|
| Amount parsing | `parse_idr("1.500.000") → 1500000.0` |
| Column detection | `classify_column_auto(x, columns) → "debit"` |
| V-line math | `find_optimal_vline_between(...) → 245.5` |
| Transaction assembly | `build_transaction_from_row_data(row, columns) → {...}` |
| Validation | `validate_red_flag(transactions) → [...]` |
| Data normalization | `_normalize_fields(kv_pairs) → {...}` |

### Step 2: Create Test Fixtures for I/O Functions

For functions that depend on OCR output, capture the OCR output as a fixture:

```python
# regrets/fixtures/sample_layout_result.json
{
  "regions": [...],
  "tokens": [...],
  "row_groups": [...],
  "table_bbox": {"x1": 50, "y1": 200, "x2": 750, "y2": 900}
}
```

Use this fixture as the `input` in the manifest:

```json
{
  "id": "parse-transactions-v2",
  "entry": "parse_transactions_v2",
  "watches": ["parse_transactions_v2"],
  "module": "rekening_koran.table_extractor.transaction_parser",
  "stack": "python",
  "pythonPath": ".",
  "inputs": [
    {"layout_result": {"regions": [...], "tokens": [...]}, "columns": {"tanggal": {...}}}
  ]
}
```

### Step 3: Use `floatPrecision` Normalization

OCR pipelines often produce the same amount as either an integer or a float. Always add:

```json
{ "normalize": ["floatPrecision"] }
```

This prevents false negatives when one parsing path produces `1500000` and another produces `1500000.0`.

### Step 4: Handle In-Place Mutation Patterns

Many Python data pipeline functions mutate their input dicts in-place and return them:

```python
def saldo_chain_classify_debit_kredit(transactions, saldo_awal=0.0):
    for txn in transactions:
        txn['debit_kredit'] = ...  # mutates in-place
    return transactions
```

Regrets handles this correctly because `deepClone` is applied to both input and output before fingerprinting. However, be aware that the "output" includes the mutated input — the fingerprint captures the ENTIRE returned value, including the mutated fields.

If you want to fingerprint only the NEW fields added by mutation (not the entire transaction), use `ignoreFields`:

```json
{
  "ignoreFields": ["raw_text", "token_positions"]
}
```

### Step 5: Define Chains for Pipeline Flows

OCR pipelines are inherently multi-step. Define chains that capture the full flow:

```json
{
  "chains": [
    {
      "id": "rekening-koran-v2",
      "steps": [
        { "cluster": "detect-columns-v2", "input": {"layout_result": "..."} },
        { "cluster": "parse-transactions-v2", "input": {"layout_result": "...", "columns": "..."} },
        { "cluster": "validate-red-flag", "input": {"transactions": "..."} }
      ]
    }
  ]
}
```

This ensures that the end-to-end pipeline flow is preserved during refactoring.

## Refactoring Priorities for OCR Pipelines

### Decomposition (highest priority)
- Files >300 lines → split by version (v2 vs legacy) or by responsibility
- Functions >30 lines → extract sub-functions with descriptive names
- Giant parser functions → extract row-building, field-classification, and post-processing

### Cohesion
- Group all column detection logic in one module
- Group all transaction parsing logic in one module
- Separate post-processing (normalization, validation) from parsing

### Naming
- Replace version suffixes (`_v2`, `_v9`, `_v4`) with descriptive names
- Replace opaque names (`opsi_d`, `ensemble`) with descriptive names
- Functions named `parse_*` should return data, not mutate in-place

### Single Responsibility
- One parser function should either parse OR normalize, not both
- Export functions should not contain data transformation logic
- Pipeline orchestrators should delegate, not compute

### Reduce Coupling
- Parser functions should not import from OCR engine directly
- Column detection should not import from transaction parser
- Use fixture data to decouple pure logic from I/O

## Case Study: bank-statement-ocr

The `bank-statement-ocr` module in `Wolfvin/Coretax-Auto-Downloader` is a Python OCR pipeline for Indonesian bank statements (rekening koran). Key findings:

### Pure Functions Identified (30+)

The cleanest module is `vline_separator.py` — all 9 functions are pure, well-named, and short. This is the model for other modules.

The most problematic is `transaction_parser.py` (1028 lines) — contains 3 nearly-identical parser functions with duplicated row-building logic.

### Gaps Discovered in Regrets

1. **No `floatPrecision` normalization** — OCR amounts produce `1500000.0` vs `1500000`
2. **No guidance for OCR/parsing pipeline pattern** — This reference fills that gap
3. **No example of near-pure mutation functions** — Common in Python data pipelines, needs documentation

### Manifest Example

```json
{
  "clusters": [
    {
      "id": "parse-idr-amount",
      "entry": "parse_idr",
      "watches": ["parse_idr"],
      "module": "shared.amount_parser",
      "stack": "python",
      "pythonPath": "bank-statement-ocr",
      "normalize": ["floatPrecision"],
      "inputs": [
        "1.500.000",
        "500,00",
        "0",
        "",
        "Rp 1.234.567,89"
      ]
    },
    {
      "id": "is-date-like",
      "entry": "is_date_like",
      "watches": ["is_date_like"],
      "module": "shared.amount_parser",
      "stack": "python",
      "pythonPath": "bank-statement-ocr",
      "inputs": ["15/01/2024", "2024-01-15", "1500000", "abc"]
    },
    {
      "id": "assign-col-center-of-mass",
      "entry": "assign_col_by_center_of_mass",
      "watches": ["assign_col_by_center_of_mass"],
      "module": "rekening_koran.table_extractor.vline_separator",
      "stack": "python",
      "pythonPath": "bank-statement-ocr",
      "multiArgs": true,
      "inputs": [
        [100, 300, [150, 300, 500]],
        [400, 550, [150, 300, 500]],
        [50, 149, [150, 300, 500]]
      ]
    },
    {
      "id": "find-optimal-vline",
      "entry": "find_optimal_vlines",
      "watches": ["find_optimal_vlines", "find_optimal_vline_between", "count_token_intersections"],
      "module": "rekening_koran.table_extractor.vline_separator",
      "stack": "python",
      "pythonPath": "bank-statement-ocr",
      "multiArgs": true,
      "fingerprintLevel": "entry",
      "inputs": [
        [[{"x_min": 100, "x_max": 200}, {"x_min": 300, "x_max": 400}], [{"x_min": 50, "x_max": 750}], 50, 800]
      ]
    }
  ]
}
```

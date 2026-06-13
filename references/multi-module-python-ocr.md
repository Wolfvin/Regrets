# Multi-Module Python OCR Pipeline Pattern

## When to Use This Pattern

When your target project is a Python OCR/data processing pipeline with:
- Multiple subpackages (`shared/`, `module_a/`, `module_b/`)
- `sys.path.insert(0, ...)` for cross-module imports
- Pure utility functions in a shared layer
- Model-dependent functions that can't be fingerprinted directly
- Structured docstring annotations (`@FLOW`, `@CALLS`, `@MUTATES`, `@BEHAVIOR`)

## The Challenge

OCR pipelines combine two types of functions:

1. **Pure functions** — amount parsing, column detection, token assignment, date validation.
   These are deterministic, have no external dependencies, and are PERFECT for Regrets fingerprinting.

2. **Model-dependent functions** — OCR inference, AI classification, layout detection.
   These require PaddleOCR, Qwen, Docling, or other models to run.
   They can't be fingerprinted directly because:
   - They need model downloads (500MB+)
   - Their output may be non-deterministic across hardware
   - They have side effects (GPU memory, file I/O)

The key insight: **only fingerprint the pure functions**. The model-dependent functions
are tested through the application's own test suite, not through Regrets.

## Setup Steps

### 1. Scan for pure functions

```bash
python3 scripts/scan.py shared/ --recursive --pure --python-path
```

The `--pure` flag filters out model-dependent functions.
The `--python-path` flag detects `sys.path.insert` calls and suggests the correct
`pythonPath` for your manifest.

### 2. Generate manifest from scan

```bash
python3 scripts/scan.py shared/ --recursive --pure --manifest > regrets/manifest.json
```

### 3. Edit manifest — add representative inputs

The scanner suggests which functions to cluster, but you must provide concrete inputs.
For an amount parser like `parse_idr`:

```json
{
  "id": "parse-idr",
  "entry": "parse_idr",
  "watches": ["parse_idr"],
  "module": "shared.amount_parser",
  "pythonPath": "bank-statement-ocr/",
  "stack": "python",
  "inputs": [
    "12.365.595",
    "1.234.567.890",
    "-50.000",
    "0",
    "",
    "12.5"
  ]
}
```

### 4. Handle `sys.path.insert` with `pythonPath`

Many OCR pipelines use `sys.path.insert(0, str(Path(__file__).parent.parent))` to
make the shared module importable. Regrets needs `pythonPath` in the manifest to
set up the same import path:

```json
{
  "pythonPath": "bank-statement-ocr/"
}
```

This ensures `from shared.amount_parser import parse_idr` works correctly
during capture and validate.

### 5. Multi-argument functions

Functions like `assign_token_to_col(token, vlines, method)` need `multiArgs: true`
and inputs as arrays:

```json
{
  "id": "assign-token-to-col",
  "entry": "assign_token_to_col",
  "watches": ["assign_token_to_col", "assign_col_by_center_of_mass"],
  "module": "rekening_koran.table_extractor.vline_separator",
  "pythonPath": "bank-statement-ocr/",
  "stack": "python",
  "multiArgs": true,
  "inputs": [
    [{"x1": 100, "x2": 200, "text": "test"}, [150, 300], "com"],
    [{"x1": 50, "x2": 80, "text": "left"}, [150, 300], "xmin"]
  ]
}
```

### 6. Chain testing for data pipeline flows

OCR pipelines have natural multi-step flows. For example:

```json
{
  "chains": [
    {
      "id": "amount-classification-flow",
      "steps": [
        { "cluster": "parse-idr", "input": "1.234.567.890" },
        { "cluster": "is-amount", "input": "1.234.567.890" },
        { "cluster": "is-date-like", "input": "15/06/2026" }
      ]
    }
  ]
}
```

This verifies that the full parsing pipeline produces consistent results.

## Normalization Notes

For OCR pipelines, common normalization needs:

| Issue | Rule | Example |
|-------|------|---------|
| Float precision from OCR | `floatTolerance` or `floatPrecision` | `1500000.0` vs `1500000` |
| Dynamic dates in filenames | `dynamicDates` | `FPK-062026` → `FPK-<MMYYYY>` |
| Timestamps in metadata | `timestamps` | ISO timestamps in output |

## What NOT to Fingerprint

- Functions that call `run_paddleocr()`, `run_qwen_inference()`, or `get_layout_engine()`
- Functions that read files from disk (`cv2.imread`, `open()`)
- Functions that write Excel files (`openpyxl.Workbook`)
- Functions with `print()` statements (they're impure and their output goes to stdout)

These are boundary functions. Test them with the project's own test suite instead.

## Example: bank-statement-ocr

**Repository**: `Wolfvin/Coretax-Auto-Downloader` → `bank-statement-ocr/`

This is a multi-format document OCR pipeline v10 with three modules:
- `rekening_koran/` — Bank Statement → 3-sheet Excel
- `nota/` — Receipt/Invoice → 3-sheet Excel
- `lainnya/` — Generic → 1-sheet Excel

All backed by a `shared/` layer with pure utility functions.

**Fingerprintable pure functions** (19 total across shared/ + table_extractor/):
- `shared/amount_parser.py`: `parse_idr`, `is_amount`, `is_date_like`
- `rekening_koran/table_extractor/vline_separator.py`: All 9 functions
- `shared/dynamic_params.py`: `compute_y_tolerance`, `compute_header_skip_offset`, etc.
- `rekening_koran/validation.py`: `validate_red_flag`

**Not fingerprintable** (model-dependent):
- `shared/ocr_engine.py`: `run_paddleocr`, `run_ensemble_ocr`
- `shared/qwen_loader.py`: `run_qwen_inference`
- `shared/layout_engine.py`: `LayoutEngine.process`
- `shared/qwen_classifier.py`: `classify_document`

This project demonstrates why `--pure` filtering is essential: out of ~30+ functions
in the codebase, only 19 are fingerprintable. The rest require GPU models.

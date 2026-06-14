# Case Study: bank-statement-ocr (OCR Pipeline + Multi-Bank Statement Processing)

## Project Overview

**Repository:** `Wolfvin/Coretax-Auto-Downloader` (subdirectory: `bank-statement-ocr/`)
**Domain:** Bank statement OCR and parsing pipeline
**Language:** Python (with Rust component in `rekening-dev-mode/`)
**Lines of Code:** ~8,400 (Python)

This project processes bank statements (rekening koran) from Indonesian banks (BCA, BNI, BRI, Mandiri) using OCR (PaddleOCR PP-OCRv5, Docling Layout, Qwen3-0.6B). The pipeline extracts transaction tables, bank info headers, and exports to Excel.

## Architecture

```
bank-statement-ocr/
├── rekening_koran/           # Bank statement module
│   ├── pipeline.py           # Main orchestrator (442 LOC)
│   ├── export.py             # Excel export (370 LOC)
│   ├── validation.py         # Cross-validation
│   ├── info_extractor/       # Bank info extraction
│   │   ├── bank_info.py      # (456 LOC)
│   │   └── __init__.py
│   └── table_extractor/      # Transaction table parsing
│       ├── column_detection.py   # (687 LOC)
│       ├── transaction_parser.py # (1027 LOC) ← God function candidate
│       ├── vline_separator.py    # (409 LOC)
│       └── __init__.py
├── nota/                     # Receipt/nota module
│   ├── pipeline.py
│   ├── export.py
│   └── receipt_parser.py     # (757 LOC)
├── lainnya/                  # Other document module
│   ├── pipeline.py
│   └── export.py
├── shared/                   # Shared utilities
│   ├── amount_parser.py      # Pure IDR amount parsing (149 LOC)
│   ├── layout_engine.py      # Docling layout (499 LOC)
│   ├── ocr_engine.py         # PaddleOCR ensemble
│   ├── qwen_loader.py        # Qwen3-0.6B inference
│   ├── qwen_classifier.py    # Qwen classification
│   ├── grounding_validator.py # Qwen validation (387 LOC)
│   ├── image_preprocess.py   # Image preprocessing + SCUNet denoise
│   ├── dynamic_params.py     # Auto-computed parameters
│   └── excel_base.py         # Excel writing base
└── run.py                    # CLI entry point
```

## Key Refactoring Targets

### 1. `transaction_parser.py` (1027 LOC) — God Function Decomposition
- Contains 3 major parsers + 4 Qwen helper functions
- `parse_transactions_from_layout()` and `parse_transactions_v2()` share significant logic
- `ensemble_transactions_v4()` is a complex merge algorithm
- Should be split into: layout_parser.py, v2_parser.py, ensemble.py, qwen_helpers.py

### 2. `column_detection.py` (687 LOC) — Dual Algorithm Module
- Contains both v1 (`detect_columns`) and v2 (`detect_columns_v2`, `detect_columns_from_layout`) algorithms
- Should be split into: column_detection_v1.py, column_detection_v2.py

### 3. `receipt_parser.py` (757 LOC) — Large Single-Responsibility Violation
- Parses receipts with multiple Qwen-dependent paths
- Should extract Qwen interaction into a separate module

### 4. `pipeline.py` (442 LOC) — Orchestration Coupling
- Directly imports from too many submodules
- Mixed legacy (v8) and modern (v10) code paths
- Should extract legacy fallback into separate module

## Regrets Integration Pattern

### Pure Functions for Fingerprinting

The `shared/amount_parser.py` module is ideal for Regrets — it contains pure functions:

```python
from shared.amount_parser import parse_idr, is_amount, is_date_like

# These are pure functions with deterministic output:
parse_idr("12.365.595")  → 12365595.0
is_amount("52.000.00=")  → True
is_date_like("01/05/26") → True
```

### Pipeline Functions (Need Fixtures)

Pipeline functions require OCR output fixtures since they depend on PaddleOCR and Qwen:

```python
# Can't call directly — needs OCR fixtures
parse_transactions_v2(layout_result, columns)
```

For these, we create adapter modules that accept pre-computed fixtures instead of live OCR.

### sys.path Pattern

This project uses `sys.path.insert(0, ...)` for imports:
```python
sys.path.insert(0, str(Path(__file__).parent.parent))
```

The manifest must set `pythonPath` correctly:
```json
{
  "pythonPath": "bank-statement-ocr"
}
```

## Gaps Discovered in Regrets

1. **No truth.py** — Python stacks couldn't save KEBENARAN baselines
2. **No verify_kebenaran.py** — Python KEBENARAN verification was missing
3. **contest.py missing kwargs/outputTransform** — Chain testing couldn't handle Python pipeline functions
4. **No scan support for sys.path projects** — Projects using `sys.path.insert()` aren't discoverable by scan.py
5. **audit.py only runs Python checks** — Mixed-stack projects need cross-stack audit support

## Manifest Template

```json
{
  "projectName": "bank-statement-ocr",
  "preBuild": "",
  "clusters": [
    {
      "id": "parse-idr",
      "entry": "parse_idr",
      "watches": ["parse_idr"],
      "module": "shared.amount_parser",
      "stack": "python",
      "pythonPath": "bank-statement-ocr",
      "description": "Parse IDR-formatted amount string to float",
      "inputs": [
        "12.365.595",
        "52.000.00=",
        "-1.234.567",
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
      "pythonPath": "bank-statement-ocr",
      "description": "Classify text as IDR amount",
      "inputs": [
        "52.000.00=",
        "hello",
        "123",
        "-1.234.567"
      ]
    },
    {
      "id": "is-date-like",
      "entry": "is_date_like",
      "watches": ["is_date_like"],
      "module": "shared.amount_parser",
      "stack": "python",
      "pythonPath": "bank-statement-ocr",
      "description": "Classify text as date format",
      "inputs": [
        "01/05/26",
        "2026-01-15",
        "01 May",
        "hello world",
        "123"
      ]
    }
  ]
}
```

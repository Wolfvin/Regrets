# OCR/Pipeline Python Projects

Applying Regrets to OCR and document processing pipelines — where complex data
structures, in-place mutation, LLM non-determinism, and spatial coordinate data
create unique challenges for fingerprint stability.

## When This Applies

- OCR processing pipelines (PaddleOCR, Tesseract, Docling)
- Document classification with LLM backends (Qwen, GPT)
- Bank statement / invoice / receipt parsing
- Spatial coordinate-based table extraction
- Multi-format export (Excel, PDF, CSV)

## Key Challenges

### 1. LLM Non-Determinism

Most OCR pipelines now use LLM-based classification or validation. These calls
produce different outputs across runs, making value-level fingerprinting
impossible.

**Symptoms:** `regret drift` flags clusters as DRIFT even though the pipeline
is functioning correctly.

**Solutions:**
- Use `fingerprintMode: "schema"` for LLM-dependent outputs — the structure
  stays stable even when values differ
- Mock LLM calls during capture/validate with deterministic stubs
- Avoid fingerprinting LLM-calling functions directly — fingerprint the
  pure post-processing instead

```json
{
  "id": "column-map-ai",
  "entry": "map_headers_to_tokens",
  "fingerprintMode": "schema",
  "normalize": ["timestamps"]
}
```

### 2. In-Place Mutation

OCR pipelines commonly mutate data dicts in-place as they pass through
processing stages. A `transactions` list gets enriched by validation,
classification, and cleaning functions — each adding keys to the same dict.

**Symptoms:** `trackMutation` detects changes but doesn't tell you which keys
were added. Fingerprints differ between runs because mutation-added metadata
keys change the output hash.

**Solutions:**
- Run `regret mutate-audit <path>` to detect which functions mutate inputs
- Add mutation-added keys to `ignoreFields` in the manifest
- Use `trackMutation: true` to capture mutation fingerprints as contracts
- Wrap mutators in adapter functions that deep-clone input and return new objects

```json
{
  "id": "validate-red-flag",
  "entry": "validate_red_flag",
  "trackMutation": true,
  "ignoreFields": ["flag", "catatan_manual", "_suspect_field", "qwen_validation"]
}
```

### 3. Non-Serializable Output Types

Image processing functions return `numpy.ndarray`, Excel export returns
`openpyxl.Workbook`, and OCR engines return complex nested objects with numpy
polygon arrays. These can't be JSON-serialized for Regrets.

**Solutions:**
- Use `outputTransform` to convert to serializable form:
  - `"len"` for collections where only the count matters
  - `"str"` for objects where string representation is meaningful
  - `"dict"` for objects with `__dict__` or `.to_dict()`
  - Custom callable: `"mymodule.serialize_output"` for project-specific types
- For numpy arrays: use `"type"` or `"len"` transform, or convert to list first
- For Excel exports: fingerprint the data structure before writing, not the
  Workbook object itself

```json
{
  "id": "preprocess-image",
  "entry": "preprocess_image",
  "outputTransform": "len",
  "normalize": ["absPaths"]
}
```

### 4. Complex Nested Dict "God Objects"

OCR pipelines typically pass a single `layout_result` dict through multiple
processing stages. This dict accumulates keys at each step and becomes deeply
nested (5+ levels). Creating realistic input fixtures for Regrets clusters
requires capturing this entire structure.

**Solutions:**
- Use `regret capture` to save the actual `layout_result` as the cluster's
  input fixture — don't try to construct it manually
- Use `ignoreFields` to strip non-deterministic keys like `timings`
- Consider splitting the god-dict into smaller, domain-specific dataclasses
  during refactoring (this is both a refactoring target AND a Regrets enabler)

### 5. Spatial Coordinate Data

Token/region data includes `x1, y1, x2, y2, cx, cy` coordinates that are
deterministic for a given input image but vary across different images. When
creating Regrets clusters, you must use a fixed test image and never change it.

**Solutions:**
- Use a single reference image for all Regrets clusters
- Store the reference image alongside the manifest in `regrets/` directory
- Never use `floatTolerance` for coordinates — they must be exact for the
  same image

### 6. Module-Level Singleton State

AI model loading is typically cached in module-level singletons
(`_engine_instance = None`). This creates global mutable state that can
interfere with test isolation.

**Solutions:**
- Don't fingerprint model-loading functions
- Ensure model is loaded before any `regret capture` or `regret validate`
- If tests interfere with each other, call `unload_layout_engine()` between
  clusters (but this is expensive)

## Recommended Cluster Strategy

For OCR pipelines, organize clusters by **purity level**:

### Tier 1: Pure Functions (No I/O, No LLM)
These are the safest and most valuable clusters. Fingerprint at `"value"` level.

- Amount/date parsers (`parse_idr`, `is_amount`, `is_date_like`)
- Spatial computation (`compute_y_tolerance`, `group_into_rows`)
- Column assignment (`assign_col_by_xmin`, `assign_col_by_center_of_mass`)
- Field normalization (`_normalize_fields`, `_map_header_to_column`)
- Saldo chain arithmetic (`saldo_chain_classify_debit_kredit`)
- Ensemble merge logic (`ensemble_transactions_v4`)

### Tier 2: Pure Logic with Mutation
These mutate inputs but are deterministic. Use `trackMutation` and `ignoreFields`.

- Validation (`validate_red_flag`)
- Post-processing (`qwen_clean_keterangan`, `qwen_validate_dates`)

### Tier 3: LLM-Dependent (Non-Deterministic)
Fingerprint at `"schema"` level only, or mock the LLM.

- Classification (`classify_document`)
- Header mapping (`_map_headers_to_tokens`)
- AI validation (`qwen_validate_transactions`)

### Tier 4: I/O Functions (Skip or Mock)
Don't fingerprint directly. Fingerprint the data structure before/after instead.

- Model loading
- Image preprocessing (file I/O)
- Excel export (file I/O)

## Adapter Pattern for OCR Pipelines

Create a thin wrapper module that constructs the necessary data structures
from saved fixtures, bypassing the I/O-heavy pipeline:

```python
# regrets/adapter.py
import json
from pathlib import Path

def load_layout_fixture():
    """Load a pre-captured layout_result from fixture file."""
    fixture = Path(__file__).parent / "fixtures" / "layout_result.json"
    return json.loads(fixture.read_text())

def parse_idr_from_fixture():
    """Adapter: load fixture, call pure parser."""
    from shared.amount_parser import parse_idr
    layout = load_layout_fixture()
    amounts = []
    for region in layout.get("regions", []):
        for token in region.get("tokens", []):
            result = parse_idr(token["text"])
            amounts.append(result)
    return amounts
```

## Normalization Rules for OCR

Common `normalize` rules needed for OCR pipeline clusters:

| Rule | What It Normalizes | When to Use |
|------|-------------------|-------------|
| `timestamps` | ISO datetime strings → `<TIMESTAMP>` | Pipeline timings in output |
| `absPaths` | `/home/user/file.pdf` → `<ROOT>/file.pdf` | File paths in output |
| `epochs` | Unix timestamps → `<EPOCH>` | `time.time()` values |
| `floatTolerance:0` | Round floats to 0dp (integers) | Coordinate data that should be exact |
| `floatPrecision` | Normalize `1500000.0` → `1500000` | OCR amount parsing output |

## mutate-audit Command

Run `regret mutate-audit <path>` before defining clusters to discover which
functions mutate their input arguments. This is essential for OCR pipelines
where enrichment and validation functions commonly modify transaction dicts
in-place.

The audit will:
1. Find all functions that assign to `param[key] = value`
2. Find all functions that call `.append()`, `.update()`, `.pop()`, etc. on parameters
3. Extract literal key names when possible
4. Suggest `ignoreFields` for each mutating function

Example output:
```
⚠️  validate_red_flag (line 12)
   Mutates: transactions
   Types:   subscript_assign
   Keys:    flag, catatan_manual, _suspect_field
   💡 Suggested ignoreFields: ["_suspect_field", "catatan_manual", "flag"]
```

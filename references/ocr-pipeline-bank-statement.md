# OCR Parsing Pipeline — Regrets Considerations

## Context

When applying Regrets to OCR parsing pipelines (like bank-statement-ocr),
several challenges emerge that are different from typical library/NPM-style
projects.

## Challenge 1: Deep Module Paths with sys.path Hacks

OCR projects often use `sys.path.insert(0, ...)` at the top of files to make
cross-package imports work. When Regrets tries to `importlib.import_module()`,
the module path must account for these path manipulations.

**Solution:** Use the `pythonPath` manifest field to add the correct base
directory. Regrets already supports this, but agents need to be aware that
`sys.path` hacks in the target code can cause import failures during capture.

Example manifest for a deep module:
```json
{
  "id": "parse-idr",
  "module": "shared.amount_parser",
  "pythonPath": "bank-statement-ocr",
  "entry": "parse_idr",
  "stack": "python"
}
```

## Challenge 2: Mixed Key Naming in Dicts

OCR token dicts often have dual key names: `x1`/`x_min`, `x2`/`x_max`, etc.
This is because the code must handle tokens from multiple OCR engines that
use different naming conventions.

When fingerprinting, the same logical token can produce different fingerprints
depending on which key names are present. This is NOT a false positive — it's
a real difference in the dict structure.

**Solution:** Use `ignoreFields` to strip engine-specific keys, or normalize
the dict before fingerprinting. If the function being tested handles both
key naming conventions, ensure inputs use consistent naming.

## Challenge 3: Float Precision in Amount Parsing

IDR amounts often appear as:
- `12365595.0` (float from parsing)
- `12365595` (int representation)
- `"12.365.595"` (formatted string)

The `floatPrecision` normalize rule handles this, but agents must be aware
that `parse_idr()` returns `float` values that may differ in representation
across Python versions or after refactoring.

**Solution:** Use `"normalize": ["floatPrecision"]` in the manifest for
clusters involving amount parsing.

## Challenge 4: truth.py Was Missing for Python Stacks

Before this reference was written, `regret truth` dispatched to `truth.py`
for Python stacks, but the file didn't exist. This meant agents working with
Python projects could not save KEBENARAN 1 (raw output) and KEBENARAN 2
(fingerprint contracts) independently.

**Solution:** Added `scripts/truth.py` mirroring the functionality of
`scripts/truth.js` for Python stack clusters.

## Challenge 5: Side-Effect Heavy Functions

OCR pipelines often write to filesystem (Excel files, debug images). These
are not pure functions and cannot be directly fingerprinted.

**Solution:** Only cluster pure transformation functions. Leave side-effect
functions (file writing, model loading) outside of Regrets clusters.
For the bank-statement-ocr project, good cluster candidates are:
- `parse_idr()` — pure string → float
- `is_amount()` — pure string → bool
- `is_date_like()` — pure string → bool
- `assign_col_by_xmin()` — pure (float, list) → int
- `assign_col_by_center_of_mass()` — pure (float, float, list) → int
- `find_optimal_vlines()` — pure (list, list) → list
- `vlines_to_col_boundaries()` — pure (list, float, float) → list
- `compute_y_tolerance()` — pure (list) → float
- `group_into_rows()` — pure (list, float) → list

## Challenge 6: Non-Serializable Token Dicts

OCR tokens may contain numpy arrays, cv2 objects, or PIL Image references.
These cannot be JSON-serialized by default.

**Solution:** Regrets' `deep_clone()` already handles bytes → hex and
class instances → dict conversion. For numpy arrays, `_numpy_to_native()`
converts to native Python types. However, if the target code uses custom
types without `to_dict()` or `get_val_d()`, `deep_clone()` falls back to
`repr()` which is lossy. Agents should test that `deep_clone()` produces
deterministic results for their specific data types before relying on it.

# Python Stack Variant — Full Implementation

The ghost proxy pattern maps directly to Python's `unittest.mock.patch` and decorator patterns. This is a complete, production-ready implementation that produces `.regret` files identical to the JS stack.

## Quick Start

1. Add `"stack": "python"` clusters to `regrets/manifest.json`
2. Create `regrets/` folder in your Python project root
3. Run `python scripts/capture.py` to capture fingerprints
4. Run `python scripts/validate.py` to validate (all clusters)
5. Run `python scripts/health.py` for cluster health report

### Fingerprint Mode Support

The Python stack supports all three fingerprint modes:

| Mode | Manifest Field | Supported | Notes |
|------|---------------|-----------|-------|
| Value | `"fingerprintMode": "value"` (default) | ✅ | Full output fingerprint — same as JS |
| Schema | `"fingerprintMode": "schema"` | ✅ | Structural fingerprint only — uses `extract_schema()` |
| Mixed | `"fingerprintMode": "mixed"` | ✅ | Schema + selected `valuePaths` — partial value checking |

During validation, `fingerprintMode` is read from the `.regret` file (takes precedence over manifest), ensuring parity with the JS stack's behavior.

See `references/structural.md` for the full specification of schema and mixed modes.

---

## Equivalent of Ghost Proxy in Python

### Ghost Decorator

Python doesn't have `Proxy` like JavaScript, but `functools.wraps` + closure achieves the same transparent wrapping:

```python
from functools import wraps

recorder = []

def ghost(fn):
    """Transparent recording wrapper — observes without changing behavior."""
    @wraps(fn)
    def wrapper(*args, **kwargs):
        result = fn(*args, **kwargs)
        recorder.append({
            'fn': fn.__name__,
            'args': deep_clone(args),
            'result': deep_clone(result),
        })
        return result  # real flow unchanged
    return wrapper

def deep_clone(val):
    """Deep clone via JSON round-trip."""
    import json
    try:
        return json.loads(json.dumps(val))
    except (TypeError, ValueError):
        return val
```

### Dynamic Module Loading

Instead of JS `import()`, Python uses `importlib.import_module`:

```python
import importlib

# From manifest: { "module": "src.invoice.processor", "pythonPath": "src/" }
import sys
sys.path.insert(0, 'src/')
mod = importlib.import_module('invoice.processor')

# Now access entry function
entry_fn = getattr(mod, 'process_invoice')
```

---

## fingerprint Module — SHA-256 + Base36

The fingerprint algorithm must be **identical** to the JS implementation in `scripts/fingerprint.js`. Same input must produce same 7-char hash.

```python
# fingerprint.py (standalone module)
import hashlib
import json
import re

def stable_dumps(obj):
    """Stable JSON serialization — keys sorted recursively (mirrors JS stableStringify)."""
    return json.dumps(obj, sort_keys=True, separators=(',', ':'), ensure_ascii=False)

def normalize(obj, rules=None):
    """Normalize non-deterministic values before hashing."""
    if rules is None:
        rules = []

    if isinstance(obj, str):
        if 'timestamps' in rules and re.match(r'^\d{4}-\d{2}-\d{2}T[\d:.Z+\-]+$', obj):
            return '<TIMESTAMP>'
        if 'uuids' in rules and re.match(
            r'^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$', obj, re.I
        ):
            return '<UUID>'
        if 'absPaths' in rules and obj.startswith('/'):
            parts = obj.split('/')
            if len(parts) >= 3:
                return '<ROOT>/' + '/'.join(parts[3:])
        if 'dynamicDates' in rules:
            result = re.sub(r'\d{2}\d{4}', '<MMYYYY>', obj)
            result = re.sub(r'(?<!\d)(20\d{2}|19\d{2})(?!\d)', '<YYYY>', result)
            return result
        return obj

    if isinstance(obj, (int, float)):
        if 'epochs' in rules and 1_000_000_000 < obj < 9_999_999_999_999:
            return '<EPOCH>'
        return obj

    if isinstance(obj, list):
        return [normalize(v, rules) for v in obj]

    if isinstance(obj, dict):
        return {k: normalize(v, rules) for k, v in obj.items()}

    return obj

def strip_fields(obj, fields=None):
    """Strip ignored fields from output before hashing."""
    if fields is None:
        fields = []
    if not fields:
        return obj

    if isinstance(obj, list):
        return [strip_fields(v, fields) for v in obj]

    if isinstance(obj, dict):
        return {
            k: strip_fields(v, fields)
            for k, v in obj.items()
            if k not in fields
        }

    return obj

def to_base36(n):
    """Convert integer to base36 string."""
    chars = '0123456789abcdefghijklmnopqrstuvwxyz'
    if n == 0:
        return '0'
    result = ''
    while n:
        result = chars[n % 36] + result
        n //= 36
    return result

def deep_clone(val):
    """Deep clone via JSON round-trip."""
    try:
        return json.loads(json.dumps(val))
    except (TypeError, ValueError):
        return val

def fingerprint(input_data, output_data, rules=None, ignore_fields=None):
    """
    Core fingerprint function — IDENTICAL algorithm to fingerprint.js:
    stableStringify(input) + '|' + stableStringify(output) → sha256 → base36 → first 7 chars
    
    Cross-stack consistency verified:
    - JS:   BigInt('0x' + sha256_hex).toString(36).slice(0, 7)
    - Python: to_base36(int(sha256_hex, 16))[:7]
    - Must produce same result for same input/output pair
    """
    if rules is None:
        rules = []
    if ignore_fields is None:
        ignore_fields = []

    clean_input = strip_fields(normalize(deep_clone(input_data), rules), ignore_fields)
    clean_output = strip_fields(normalize(deep_clone(output_data), rules), ignore_fields)

    combined = stable_dumps(clean_input) + '|' + stable_dumps(clean_output)
    hash_hex = hashlib.sha256(combined.encode('utf-8')).hexdigest()

    big_num = int(hash_hex, 16)
    return to_base36(big_num)[:7]

def fingerprint_sequence(calls, rules=None, ignore_fields=None):
    """Fingerprint an entire call sequence (for fingerprintLevel: 'full' or 'watched')."""
    if rules is None:
        rules = []
    if ignore_fields is None:
        ignore_fields = []

    normalized = []
    for call in calls:
        normalized.append({
            'fn': call['fn'],
            'args': strip_fields(normalize(deep_clone(call['args']), rules), ignore_fields),
            'result': strip_fields(normalize(deep_clone(call['result']), rules), ignore_fields),
        })

    combined = stable_dumps(normalized)
    hash_hex = hashlib.sha256(combined.encode('utf-8')).hexdigest()
    big_num = int(hash_hex, 16)
    return to_base36(big_num)[:7]
```

### Cross-Stack Consistency Check

```
INPUT:  "2025-01-15T00:00:00"
OUTPUT: "15/01/2025"

Python:
  stable_dumps("2025-01-15T00:00:00") → "2025-01-15T00:00:00"
  stable_dumps("15/01/2025")           → "15/01/2025"
  combined = "2025-01-15T00:00:00|15/01/2025"
  sha256 → hex → int(hex, 16) → base36 → first 7 chars
  Result: yju9g9g  ✅ Same as JS cluster format-date

JS:
  stableStringify("2025-01-15T00:00:00") → "2025-01-15T00:00:00"
  stableStringify("15/01/2025")           → "15/01/2025"
  combined = "2025-01-15T00:00:00|15/01/2025"
  sha256 → hex → BigInt('0x' + hex).toString(36).slice(0, 7)
  Result: yju9g9g  ✅ Same as Python
```

---

## Manifest for Python Clusters

```json
{
  "clusters": [
    {
      "id": "process-invoice",
      "entry": "process_invoice",
      "watches": ["normalize_amount", "apply_tax", "format_output"],
      "module": "invoice.processor",
      "pythonPath": "src/",
      "stack": "python",
      "fingerprintLevel": "entry",
      "description": "Transform raw invoice data into processed output",
      "inputs": [
        {"raw_amount": 1000000, "tax_rate": 0.11, "invoice_type": "OUTPUT_TAX"},
        {"raw_amount": 0, "tax_rate": 0, "invoice_type": "INPUT_TAX"}
      ]
    },
    {
      "id": "format-period-python",
      "entry": "format_period",
      "watches": ["format_period"],
      "module": "date_utils",
      "stack": "python",
      "multiArgs": false,
      "normalize": ["dynamicDates"],
      "inputs": [
        "2025_05",
        "2024_01"
      ]
    },
    {
      "id": "build-filename-python",
      "entry": "build_filename",
      "watches": ["build_filename", "sanitize_name"],
      "module": "filename.builder",
      "pythonPath": "src/",
      "stack": "python",
      "multiArgs": true,
      "normalize": ["dynamicDates"],
      "inputs": [
        ["FPK-", "202505", "OUTPUT_TAX"],
        ["DOC-", "2025", "DOC_MANAGEMENT"]
      ]
    }
  ]
}
```

### Python-Specific Manifest Fields

| Field | Required | Description |
|-------|----------|-------------|
| `stack` | ✅ | Must be `"python"` |
| `module` | ✅ | Python module path using **dot notation** (e.g., `src.invoice.processor` → `invoice.processor` if `pythonPath` is `src/`) |
| `pythonPath` | ❌ | Directory to add to `sys.path` before import (relative to project root) |
| `file` | ❌ | File path (used as fallback if `module` not specified) |

---

## capture.py — Full Implementation

```bash
python scripts/capture.py
python scripts/capture.py --cluster process-invoice
```

The full `capture.py` is at `scripts/capture.py`. It imports from the shared `fingerprint.py` module:

1. Reads `regrets/manifest.json`
2. Filters clusters with `"stack": "python"`
3. Adds `pythonPath` to `sys.path` if specified
4. Uses `importlib.import_module` for dynamic module loading
5. Injects ghost decorators on watched functions
6. Runs entry function with provided inputs
7. Computes fingerprint using `from fingerprint import fingerprint, fingerprint_sequence` — **identical algorithm to JS**, single source of truth
8. Writes `.regret` files in the same format as JS output
9. Supports `multiArgs: true` — spreads input as separate arguments
10. Supports all normalization rules: `timestamps`, `uuids`, `epochs`, `absPaths`, `dynamicDates`

> **Note:** The fingerprint functions (`stable_dumps`, `normalize`, `strip_fields`, `to_base36`, `deep_clone`, `fingerprint`, `fingerprint_sequence`) are now in `scripts/fingerprint.py` as a shared module. Both `capture.py` and `validate.py` import from it. Do **NOT** duplicate these functions.

### How It Works

```
┌─────────────────────┐     ┌──────────────────┐     ┌─────────────────┐
│ Read manifest.json   │────▶│ import_module()  │────▶│ ghost() wrap    │
│ Filter stack=python  │     │ Load target mod  │     │ Record I/O      │
└─────────────────────┘     └──────────────────┘     └────────┬────────┘
                                                              │
┌─────────────────────┐     ┌──────────────────┐     ┌───────▼────────┐
│ Write .regret file   │◀────│ fingerprint()    │◀────│ Run entry()    │
│ Same format as JS    │     │ SHA-256 + base36 │     │ With inputs    │
└─────────────────────┘     └──────────────────┘     └────────────────┘
```

### CLI Options

| Flag | Description |
|------|-------------|
| `--cluster <id>` | Only capture specific cluster |
| `--manifest <path>` | Path to manifest.json (default: `regrets/manifest.json`) |

---

## validate.py — Full Implementation

```bash
python scripts/validate.py                              # validate all
python scripts/validate.py --cluster process-invoice    # validate one
python scripts/validate.py --runs 5                     # drift detection
python scripts/validate.py --update process-invoice --reason "tax rate changed to 12%"
python scripts/validate.py --fail-fast                  # stop on first failure
```

The full `validate.py` is at `scripts/validate.py`. It mirrors `validate.js` functionality:

1. Loads all `.regret` files from `regrets/` directory
2. Re-runs entry function with golden input
3. Computes new fingerprint
4. Compares with stored golden hash
5. Outputs: `✅ cluster-name  9jadb  PASS` or `❌ cluster-name  FAIL (expected: 9jadb, got: x3kp1)`

### Validation Modes

| Mode | Command | Description |
|------|---------|-------------|
| **Normal** | `python scripts/validate.py` | Single run, pass/fail |
| **Drift** | `python scripts/validate.py --runs 5` | Run 5×, check for consistency |
| **Update** | `python scripts/validate.py --update <id> --reason "..."` | Safe fingerprint update with audit trail |
| **Fail-fast** | `python scripts/validate.py --fail-fast` | Stop on first failure (CI mode) |

### Update Protocol

Same rules as JS — `--reason` is required, minimum 4 words, must be specific:

```bash
# ✅ Good
python scripts/validate.py --update process-invoice \
  --reason "tax rate updated from 11% to 12% per regulation PMK-03/2025"

# ❌ Bad — too vague
python scripts/validate.py --update process-invoice --reason "behavior changed"
```

The update rewrites the `.regret` file and appends to `regrets/audit.log`:

```
2026-05-30T06:00:00+00:00  UPDATE  process-invoice
  old: 9jadb
  new: x3kp1
  reason: tax rate updated from 11% to 12% per regulation PMK-03/2025
  by: AI refactor session
```

---

## health.py — Cluster Health Report

```bash
python scripts/health.py
python scripts/health.py --sort fragile
python scripts/health.py --sort age
```

The full `health.py` is at `scripts/health.py`. It mirrors `health.js`:

1. Reads `audit.log` → parses UPDATE/DRIFT events per cluster
2. Scores each cluster: 100 - (updates × 15) - (drifts × 25) - (age < 3 days ? 10 : 0) + (age > 30 days ? 5 : 0)
3. Labels: SOLID (≥90), GOOD (≥70), UNSTABLE (≥50), FRAGILE (<50)
4. Outputs formatted health report

Output example:
```
CLUSTER HEALTH REPORT
────────────────────────────────────────────────────────────────────────
cluster                          updates  drifts  age      health
────────────────────────────────────────────────────────────────────────
process-invoice                  0        0       47d      ██████ SOLID
format-period-python             1        0       12d      █████░ GOOD
build-filename-python            0        1       3d       ██░░░░ FRAGILE
────────────────────────────────────────────────────────────────────────

Recommendations:
  build-filename-python       → drift detected, add normalize rules to manifest

Do not touch (SOLID contracts):
  process-invoice
```

---

## Normalization — Python-Specific Patterns

| Non-Deterministic Source | Python Pattern | Normalization Rule | Replacement |
|--------------------------|---------------|-------------------|-------------|
| Current time | `datetime.now()` / `time.time()` | `"timestamps"` / `"epochs"` | `<TIMESTAMP>` / `<EPOCH>` |
| UUID | `uuid.uuid4()` | `"uuids"` | `<UUID>` |
| Random | `random.randint()` / `secrets.token_hex()` | `"ignoreFields"` on that key | — |
| File paths | `os.path.abspath()` / `Path.cwd()` | `"absPaths"` | `<ROOT>/...` |
| Dynamic dates | Period strings in filenames | `"dynamicDates"` | `<MMYYYY>`/`<YYYY>` |

### Example: Normalizing `datetime.now()`

```python
# Before: output contains current time
import time
result = {"processed_at": int(time.time())}
# output: {"processed_at": 1718803200}

# In manifest:
{ "normalize": ["epochs"] }
# After normalization: {"processed_at": "<EPOCH>"}
```

---

## Example `.regret` Output for Python Function

```
cluster: format-period-python
fingerprint: 12d5tvu
captured: 2026-05-30T06:00:00+00:00
watches: [format_period]
entry: format_period
stack: python
fingerprintLevel: entry
module: date_utils
normalize: [dynamicDates]
---
INPUT  "2025_05"
OUTPUT "052025"
HASH   12d5tvu
```

Note: The hash `12d5tvu` matches the JS cluster `format-period` because the same input → same output → same fingerprint algorithm. Cross-stack parity verified.

---

## Pure Logic Extraction in Python

Same principle as JS/TS — extract pure business logic from modules that have side effects:

```python
# ❌ BEFORE — mixed concerns, hard to fingerprint
# invoice_service.py
class InvoiceService:
    def process(self, raw_data):
        # Pure calculation
        total = self._calculate_total(raw_data['items'])
        tax = self._apply_tax(total, raw_data['tax_rate'])

        # Side effects
        db.save_invoice(raw_data['id'], total, tax)
        notification.send(f"Invoice {raw_data['id']} processed")

        return {"total": total, "tax": tax}

# ✅ AFTER — pure logic extracted to separate module
# invoice_logic.py
def calculate_total(items):
    """Pure function — no side effects, easy to fingerprint."""
    return sum(item['amount'] for item in items)

def apply_tax(amount, rate):
    """Pure function — deterministic for same inputs."""
    return int(amount * (1 + rate))

# invoice_service.py — thin shell with side effects only
class InvoiceService:
    def process(self, raw_data):
        from .invoice_logic import calculate_total, apply_tax

        total = calculate_total(raw_data['items'])
        tax = apply_tax(total, raw_data['tax_rate'])

        db.save_invoice(raw_data['id'], total, tax)
        notification.send(f"Invoice {raw_data['id']} processed")

        return {"total": total, "tax": tax}
```

### Manifest for the extracted logic:

```json
{
  "id": "calculate-total",
  "entry": "calculate_total",
  "watches": ["calculate_total"],
  "module": "invoice_logic",
  "stack": "python",
  "inputs": [
    [{"amount": 1000000}, {"amount": 2500000}],
    [{"amount": 0}]
  ]
}
```

### Rules for Python Pure Logic Extraction

1. **Never fingerprint functions that do I/O** — `open()`, `requests.get()`, `db.query()` go in the shell
2. **Never fingerprint functions that use `datetime.now()` or `random`** — pass time/randomness as parameters
3. **Logic modules must have zero imports of**: `os`, `sys` (for paths), `requests`, `httpx`, `sqlalchemy`, `subprocess`, or any I/O library
4. **Logic functions take all data as parameters** — no `self` that hides state, no module-level globals
5. **If a function needs current time** — accept `now: int` as a parameter, let the shell pass `int(time.time())`

---

## NPM Script Equivalents for Python

Add to the target project's `package.json` (if it has one for CI orchestration):

```json
{
  "regret:capture:py": "python3 ../../The-skill/regresion-testing/scripts/capture.py",
  "regret:validate:py": "python3 ../../The-skill/regresion-testing/scripts/validate.py",
  "regret:health:py": "python3 ../../The-skill/regresion-testing/scripts/health.py",
  "regret:drift:py": "python3 ../../The-skill/regresion-testing/scripts/validate.py --runs 5",
  "regret:update:py": "python3 ../../The-skill/regresion-testing/scripts/validate.py --update"
}
```

Or use the unified runner which auto-detects Python clusters from the manifest:

```json
{
  "regret:capture": "node ../../The-skill/regresion-testing/scripts/regret.js capture",
  "regret:validate": "node ../../The-skill/regresion-testing/scripts/regret.js validate",
  "regret:health": "node ../../The-skill/regresion-testing/scripts/regret.js health"
}
```

Or add as Makefile targets:

```makefile
regret-capture-py:
        python3 The-skill/regresion-testing/scripts/capture.py

regret-validate-py:
        python3 The-skill/regresion-testing/scripts/validate.py

regret-health-py:
        python3 The-skill/regresion-testing/scripts/health.py

regret-drift-py:
        python3 The-skill/regresion-testing/scripts/validate.py --runs 5
```

---

## Compatibility with JS Manifest

Python clusters can coexist with JS clusters in the same `manifest.json`. The capture/validate scripts filter by `stack` field:

```json
{
  "clusters": [
    {
      "id": "format-period",
      "entry": "formatPeriod",
      "stack": "js",
      "file": "js/date-utils.js",
      ...
    },
    {
      "id": "format-period-python",
      "entry": "format_period",
      "stack": "python",
      "module": "date_utils",
      ...
    }
  ]
}
```

- `capture.js` only processes `stack: "js"` or `stack: "ts"` clusters
- `capture.py` only processes `stack: "python"` clusters
- `validate.js` validates JS clusters; `validate.py` validates Python clusters
- `health.js` and `health.py` both read the same `audit.log` — health reports cover all stacks

# freezeTime — Deterministic Fingerprinting for Time-Dependent Functions

## The Problem

Many Python libraries call `time.localtime()`, `datetime.now()`, or `time.time()` internally. These functions return different values on each invocation, making their output non-deterministic. When Regrets tries to fingerprint such functions, the hash changes every run — causing false drift detection.

This is extremely common in:
- **Date/time parsing libraries** (e.g., parsedatetime) — which default to "now" when no source time is provided
- **Calendar libraries** — which compute offsets from the current date
- **Scheduling libraries** — which calculate next occurrence based on today
- **Any library with `if sourceTime is None: sourceTime = time.localtime()` pattern**

The parsedatetime library, for example, has **34 separate calls to `time.localtime()`** across its `Calendar` class. Without freezing time, every cluster would drift.

## Solution 1: `freezeTime` in Manifest

Add a `freezeTime` field to your cluster definition:

```json
{
  "id": "calendar-parse",
  "entry": "Calendar",
  "classMethod": "parse",
  "constructor": "Calendar",
  "constructorArgs": [],
  "module": "parsedatetime",
  "stack": "python",
  "freezeTime": "2025-06-14T12:00:00",
  "inputs": ["tomorrow", "next friday", "in 2 weeks"]
}
```

When `freezeTime` is present, Regrets patches the following functions before running capture/validate:

| Patched Function | Replacement |
|-----------------|-------------|
| `time.localtime()` | Returns frozen `struct_time` |
| `time.localtime(seconds)` | Passes through to `time.gmtime(seconds)` (deterministic) |
| `time.time()` | Returns frozen Unix timestamp |
| `datetime.datetime.now()` | Returns frozen `datetime` object |
| `datetime.datetime.utcnow()` | Returns frozen `datetime` object |

### Supported Formats

| Format | Example | Behavior |
|--------|---------|----------|
| ISO 8601 datetime | `"2025-06-14T12:00:00"` | Exact frozen moment |
| Date only | `"2025-06-14"` | Defaults to noon (12:00:00) |
| Unix timestamp | `"1749892800"` | Integer string, converted via `time.gmtime()` |

### Implementation Note: datetime.datetime Patching

`datetime.datetime` is a C-implemented immutable type. You **cannot** use `patch.object(datetime.datetime, 'now', ...)` — it raises `TypeError: cannot set 'now' attribute of immutable type 'datetime.datetime'`.

The solution: replace `datetime.datetime` in the `datetime` module with a subclass (`FrozenDateTime`) that overrides `now()` and `utcnow()`. This is the same approach used by [freezegun](https://github.com/spulec/freezegun).

### How It Works

The `FreezeTime` context manager uses `unittest.mock.patch` to replace the time-dependent functions for the duration of each capture/validate call. After the call completes, the patches are removed, restoring normal behavior.

```python
class FreezeTime:
    """Context manager that freezes time.localtime() and datetime.now()."""

    def __enter__(self):
        # Patch time.localtime, time.time, datetime.now
        ...

    def __exit__(self, *args):
        # Remove all patches
        ...
```

The freeze is stored in the `.regret` file as metadata:

```
cluster: calendar-parse
freezeTime: 2025-06-14T12:00:00
...
```

During validation, the `freezeTime` value is read from the `.regret` file and the same frozen time is applied, ensuring that the same `time.localtime()` calls produce the same results.

## Solution 2: FreezeTime in Entry Wrappers

For complex scenarios where manifest-level `freezeTime` isn't enough, use the `FreezeTime` context manager directly in your entry wrapper:

```python
# regrets/entry_wrappers.py
import sys
sys.path.insert(0, '/path/to/Regrets/scripts')
from freeze_time import FreezeTime
import parsedatetime

def calendar_parse(input_str):
    with FreezeTime("2025-06-14T12:00:00"):
        cal = parsedatetime.Calendar()
        return cal.parse(input_str)
```

## When to Use freezeTime

| Scenario | Use freezeTime? | Alternative |
|----------|----------------|-------------|
| Pure functions (no time dependency) | No | Not needed |
| Functions that accept sourceTime as parameter | No | Pass sourceTime in inputs |
| Functions that default to time.localtime() | **Yes** | Or refactor to require sourceTime |
| Functions that use datetime.now() internally | **Yes** | Or extract pure logic |
| Functions that read from clock/system | **Yes** | No other option |

## Combined with classMethod

`freezeTime` is especially powerful when combined with `classMethod` for Python classes:

```json
{
  "id": "calendar-parse-tomorrow",
  "entry": "Calendar",
  "classMethod": "parse",
  "constructor": "Calendar",
  "constructorArgs": [],
  "module": "parsedatetime",
  "stack": "python",
  "freezeTime": "2025-06-14T12:00:00",
  "inputs": ["tomorrow"],
  "watches": []
}
```

This creates a `Calendar` instance, freezes time, then calls `calendar.parse("tomorrow")` — producing a deterministic result that can be reliably fingerprinted.

## struct_time Serialization

A related improvement: `deep_clone()` in `fingerprint.py` now handles `time.struct_time` objects by converting them to a deterministic list `[year, mon, mday, hour, min, sec, wday, yday, isdst]`. Previously, `struct_time` fell through to `repr()`, which was technically deterministic but produced verbose output like `time.struct_time(tm_year=2025, tm_mon=6, ...)`.

The list format is:
- More compact (fewer characters in the fingerprint input)
- JSON-serializable (no special parsing needed)
- Deterministic (same struct_time always produces the same list)
- Human-readable (easily matches the original struct_time fields)

## Impact on scan.py

When `regret scan` detects time-dependent impurity (calls to `time.localtime()`, `datetime.now()`, etc.), it now:

1. Marks the function as **impure** (previously it would incorrectly mark it as pure)
2. Adds a `freezeTimeHint` to the suggestion: `"Uses localtime, time — add freezeTime to manifest for deterministic fingerprinting"`

This helps agents immediately understand why drift occurs and how to fix it, instead of discovering through trial and error.

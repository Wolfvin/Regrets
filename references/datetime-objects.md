# Datetime Objects in Regrets

## Problem

Libraries that return `datetime`, `date`, `time`, `timedelta`, or `tzinfo` objects
(e.g. **python-dateutil**, **arrow**, **pendulum**, **maya**) present unique
challenges for output-based regression testing:

1. **Not JSON-serializable** — `json.dumps(datetime(2024, 1, 1))` raises `TypeError`
2. **Non-deterministic defaults** — functions like `parse()` or `rrule()` may
   default to `datetime.now()`, making fingerprints change every run
3. **Timezone awareness** — tz-aware and tz-naive datetimes are semantically different
4. **Fold attribute** — Python 3.6+ `datetime.fold` disambiguates repeated times
5. **Unbounded iterators** — `rrule` objects may produce infinite sequences

## Solution: Built-in datetime Serialization

Regrets handles datetime objects automatically in `deep_clone()` via
`_serialize_datetime()`. No manual transformation needed.

### Serialized Forms

| Type | Serialized Form |
|------|----------------|
| `datetime` | `{"__datetime__": "2024-01-15T10:30:00", "fold": 0}` |
| `datetime` (tz-aware) | `{"__datetime__": "2024-01-15T10:30:00+05:00", "fold": 0, "tzname": "IST", "utcoffset": 19800.0}` |
| `date` | `{"__date__": "2024-01-15"}` |
| `time` | `{"__time__": "10:30:00", "fold": 0}` |
| `timedelta` | `{"__timedelta__": 86400.0}` |

## Manifest Configuration

### Option 1: Automatic (recommended)

`deep_clone()` handles datetime objects automatically — no extra config needed.

### Option 2: outputTransform: "isoformat"

For more readable .regret files:

```json
{
  "id": "parse-date",
  "entry": "parse",
  "module": "dateutil.parser",
  "stack": "python",
  "outputTransform": "isoformat",
  "inputs": ["2024-01-15"]
}
```

### Option 3: normalize: ["datetimeNow"]

For functions using `datetime.now()` as default:

```json
{
  "id": "parse-default-now",
  "entry": "parse",
  "module": "dateutil.parser",
  "stack": "python",
  "normalize": ["datetimeNow"],
  "inputs": ["January 15"]
}
```

### maxYields / materializeLimit for unbounded iterators

```json
{
  "id": "rrule-daily",
  "entry": "rrule",
  "module": "dateutil.rrule",
  "stack": "python",
  "materializeOutput": true,
  "maxYields": 10,
  "kwargs": true,
  "inputs": [{"freq": 3, "dtstart": "2024-01-01T00:00:00", "count": 10}]
}
```

`materializeLimit` is an alias for `maxYields` for discoverability.

## Cross-Stack Consistency

`datetimeNow` normalize and `isoformat` outputTransform are implemented in both
Python and JavaScript. Python's `_serialize_datetime()` produces dicts that JS
can normalize via `datetimeNow`.

## Troubleshooting

### Fingerprint changes every run
Add explicit `default`/`dtstart` arguments, or use `normalize: ["datetimeNow"]`.

### rrule capture hangs
Add `materializeOutput: true` and `maxYields` (or `materializeLimit`).

### Timezone mismatch after refactoring
Use `normalize: ["datetimeNow"]` or `outputTransform: "isoformat"`.

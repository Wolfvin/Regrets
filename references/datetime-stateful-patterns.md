# Datetime & Stateful Object Patterns

This reference covers two Regrets features designed for libraries that involve:

1. **Non-deterministic datetime defaults** — functions that call `datetime.now()` internally
2. **Stateful objects with internal mutation** — methods that modify object state as a side effect

These patterns are common in date/time libraries (python-dateutil), scheduler libraries (APScheduler), caching systems, and stateful parsers.

---

## `freezeTime` — Freeze Datetime During Capture/Validate

### Problem

Functions like `rrule(dtstart=None)` and `parser.parse(defaults=None)` default to `datetime.now()` when no value is provided. This makes fingerprinting non-reproducible — the same code produces different output on every run because the current time is embedded in the result.

Without `freezeTime`, drift detection will always flag these clusters as DRIFT because the output changes every second.

### Usage

In `manifest.json`:

```json
{
  "id": "rrule-default-dtstart",
  "entry": "rrule",
  "watches": ["rrule"],
  "module": "dateutil.rrule",
  "stack": "python",
  "freezeTime": "2024-01-15T10:30:00",
  "inputs": [
    {"freq": 0, "count": 5}
  ]
}
```

### How It Works

During capture and validate, Regrets patches `datetime.datetime.now()`, `datetime.datetime.utcnow()`, `datetime.date.today()`, and `time.localtime()` to return the frozen value.

This ensures:
- `rrule(YEARLY, count=5)` always starts from the same `dtstart`
- `parser.parse("March 15")` always interprets the year consistently
- Any function that reads the current time gets a deterministic value

### When to Use

Use `freezeTime` when:
- The function has `datetime.now()` or `time.localtime()` as a default parameter
- The output includes timestamps derived from "now"
- Drift detection keeps failing even after adding `normalize: ["timestamps"]`

Do NOT use `freezeTime` when:
- The function takes an explicit `dtstart` or `now` parameter — instead, provide that parameter in `inputs`
- The output is already deterministic — `freezeTime` adds overhead

### Format

The `freezeTime` value must be an ISO 8601 datetime string without timezone:
- `"2024-01-15T10:30:00"` — January 15, 2024 at 10:30 AM local time
- `"2024-06-01T00:00:00"` — June 1, 2024 at midnight

---

## `maxYields` — Bounded Materialization for Infinite Generators

### Problem

Some functions return infinite generators — `rrule(YEARLY, dtstart=...)` with no `count` or `until` yields dates forever. `materializeOutput: true` with `list()` would hang the process.

### Usage

In `manifest.json`:

```json
{
  "id": "rrule-yearly-infinite",
  "entry": "rrule",
  "watches": ["rrule"],
  "module": "dateutil.rrule",
  "stack": "python",
  "materializeOutput": true,
  "maxYields": 10,
  "inputs": [
    {"freq": 0, "dtstart": "2024-01-01T00:00:00", "count": 5}
  ]
}
```

### How It Works

When `maxYields` is set and `materializeOutput` is true:
1. Regrets calls `itertools.islice(generator, maxYields + 1)` to take the first `maxYields` items
2. If the generator has more items, a sentinel `{"__truncated__": true, "maxYields": N}` is appended
3. The truncated list is fingerprinted — so the contract verifies that the FIRST N items are correct

### Why Not Just Use `count`?

For `rrule`, you could set `count=10` to limit output. But:
1. Not all generators have a `count` parameter
2. `count` changes the function's behavior — it's a different function call
3. `maxYields` verifies the generator's output up to a point WITHOUT changing its semantics

### Sentinel Format

When truncation occurs, the last element of the materialized list is:

```json
{"__truncated__": true, "maxYields": 10}
```

This sentinel is part of the fingerprint, so:
- If the generator starts producing different items (regression), the fingerprint changes → RED
- If the generator becomes finite (unexpected), the sentinel is absent → RED
- If the generator produces the same first N items (safe refactor), the fingerprint matches → GREEN

---

## `trackState` — Object State Mutation Tracking

### Problem

`trackMutation` only checks if the function's INPUT was mutated. But many stateful objects mutate THEMSELVES during method calls:

- `rrule._iter()` sets `self._len` as a side effect of yielding
- `rrulebase.__iter__()` populates `self._cache` lazily
- `GettzFunc.__call__()` updates `self.__instances` cache

After refactoring, if the object's internal state changes at the wrong time or to the wrong value, the behavior may be subtly broken even though the output looks correct.

### Usage

In `manifest.json`:

```json
{
  "id": "rrule-iter-state",
  "entry": "rrule_adapter",
  "watches": ["rrule"],
  "module": "regret_adapters",
  "stack": "python",
  "trackState": ["_len", "_cache_complete"],
  "inputs": [
    {"freq": 0, "dtstart": "2024-01-01T00:00:00", "count": 5}
  ]
}
```

### How It Works

When `trackState` is set to a list of attribute names:

1. **BEFORE** the entry function is called, Regrets snapshots the specified attributes from the object
2. **AFTER** the entry function returns, Regrets snapshots the same attributes again
3. A **state fingerprint** is computed from `(before, after)` using the same hash algorithm
4. The state fingerprint is stored in the `.regret` file as `stateFingerprint`
5. During validation, if the state fingerprint doesn't match, the cluster goes RED with `STATE MISMATCH`

### When to Use

Use `trackState` when:
- The entry function modifies `self.*` attributes as a side effect
- You need to verify that object state transitions happen correctly
- The function is a method on a class that maintains internal caches or counters

### Adapter Pattern for trackState

Since Regrets typically calls the entry function directly, you need an adapter that creates the object and exposes its state:

```python
# regret_adapters.py
from dateutil.rrule import rrule, YEARLY

def rrule_adapter(freq, dtstart, count=None, **kwargs):
    """Adapter that creates an rrule, iterates it, and returns the object for state tracking."""
    r = rrule(freq, dtstart=dtstart, count=count, **kwargs)
    # Iterate to trigger _len mutation
    list(r)
    return r  # Return the object itself — trackState will snapshot its _len, _cache_complete
```

Then in the manifest, set `trackState: ["_len", "_cache_complete"]` to watch those specific attributes.

### Difference from `trackMutation`

| Feature | What it checks | Where it looks |
|---------|---------------|----------------|
| `trackMutation` | Did the function mutate its input? | Input arguments before/after call |
| `trackState` | Did the object's internal state change? | Object attributes (by name) before/after call |

`trackMutation` is about protecting the caller's data. `trackState` is about verifying the callee's internal state transitions.

---

## Combined Example: python-dateutil rrule

Here's a complete manifest for testing `rrule._iter()` with all three features:

```json
{
  "projectName": "python-dateutil",
  "clusters": [
    {
      "id": "rrule-yearly-5",
      "entry": "rrule_iter_bounded",
      "watches": ["rrule"],
      "module": "regret_adapters",
      "stack": "python",
      "pythonPath": "src",
      "materializeOutput": true,
      "maxYields": 10,
      "freezeTime": "2024-01-15T10:30:00",
      "trackState": ["_len"],
      "inputs": [
        {"freq": 0, "dtstart": "2024-01-01T00:00:00", "count": 5}
      ]
    },
    {
      "id": "rrule-monthly-default",
      "entry": "rrule_iter_bounded",
      "watches": ["rrule"],
      "module": "regret_adapters",
      "stack": "python",
      "pythonPath": "src",
      "materializeOutput": true,
      "maxYields": 10,
      "freezeTime": "2024-01-15T10:30:00",
      "inputs": [
        {"freq": 1, "count": 5}
      ]
    }
  ]
}
```

The adapter module:

```python
# regret_adapters.py
import datetime
from dateutil.rrule import rrule, YEARLY, MONTHLY

def rrule_iter_bounded(freq, count=None, dtstart=None, **kwargs):
    """Create rrule, iterate it, return the rrule object for state tracking."""
    if dtstart and isinstance(dtstart, str):
        dtstart = datetime.datetime.fromisoformat(dtstart)
    r = rrule(freq, dtstart=dtstart, count=count, **kwargs)
    # Consume the iterator to trigger _len state mutation
    results = list(r)
    return results  # Return the list of dates as output
```

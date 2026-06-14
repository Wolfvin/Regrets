# Class Method Fingerprinting — Python Stack

## Problem

Regrets' Python capture works by calling `entry_fn(input)` on a module. But many Python projects use classes with methods as their primary API. You can't directly call `Calendar.parse("tomorrow")` as a module-level function through Regrets' import mechanism.

Previously, Python users had to create manual entry wrapper files (see `references/class-based-python.md`). The JS stack already had `classMethod` support, but Python did not.

## Solution: `classMethod` for Python

Add the following fields to a cluster definition (mirrors the JS implementation):

| Field | Required | Description |
|-------|----------|-------------|
| `classMethod` | Yes (for class mode) | Name of the instance method to fingerprint |
| `constructor` | No | Class name to instantiate (default: uses `entry` value) |
| `constructorArgs` | No | Array of arguments for the constructor |
| `setup` | No | Array of `{ method, args }` objects to call before the target method |

When `classMethod` is present in a cluster, Regrets switches to class-based mode:

1. `Constructor(*constructorArgs)` → creates an instance
2. For each `{ method, args }` in `setup`: `instance[method](*args)`
3. `instance[classMethod](input)` → output (fingerprint this)

### Example: parsedatetime

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
  "inputs": ["tomorrow", "next friday", "in 2 weeks"],
  "watches": []
}
```

This creates a `Calendar` instance, then fingerprints `calendar.parse("tomorrow")`, `calendar.parse("next friday")`, etc.

### Example: Calendar.parseDT

```json
{
  "id": "calendar-parse-dt",
  "entry": "Calendar",
  "classMethod": "parseDT",
  "constructor": "Calendar",
  "constructorArgs": [],
  "module": "parsedatetime",
  "stack": "python",
  "freezeTime": "2025-06-14T12:00:00",
  "inputs": ["tomorrow at 3pm", "next monday"],
  "watches": []
}
```

### Example: Calendar.inc

```json
{
  "id": "calendar-inc",
  "entry": "Calendar",
  "classMethod": "inc",
  "constructor": "Calendar",
  "constructorArgs": [],
  "module": "parsedatetime",
  "stack": "python",
  "inputs": [{"month": 1}, {"year": 1}],
  "kwargs": true,
  "watches": []
}
```

## .regret File Format

When `classMethod` is used, the `.regret` file stores additional metadata:

```
cluster: calendar-parse
version: 1
fingerprint: abc1234
captured: 2025-06-14T00:00:00Z
watches: []
entry: Calendar
constructor: Calendar
classMethod: parse
constructorArgs: []
setup: []
stack: python
fingerprintLevel: entry
freezeTime: 2025-06-14T12:00:00
---
INPUT  "tomorrow"
OUTPUT [[2025, 6, 15, 12, 0, 0, 6, 166, -1], ...]
HASH   abc1234
```

## Comparison: classMethod vs Entry Wrappers

| Approach | Pros | Cons |
|----------|------|------|
| `classMethod` in manifest | No extra files needed; declarative; works with freezeTime | Limited to simple constructor + setup + method call pattern |
| Entry wrapper file (see `class-based-python.md`) | Full flexibility; can handle complex init logic | Requires maintaining a separate Python file |

### Use `classMethod` when:
- The class constructor is simple (no complex dependencies)
- You just need to call one method after construction
- Setup is a simple sequence of method calls with static args
- You want to use `freezeTime` (which works seamlessly with classMethod)

### Use entry wrappers when:
- The class requires complex dependency injection
- You need to transform the output before fingerprinting
- You need custom logic between construction and the method call
- The class depends on external resources that need mocking

## Validation

The `classMethod` mode works with all existing validation features:
- `regret validate` — compares fingerprints (reads classMethod from .regret file)
- `regret drift` — runs multiple times for stability
- `regret health` — tracks cluster health
- `regret update` — safe update with audit trail
- `regret chain` — can chain class-based clusters
- `regret truth` — saves raw output from class methods

The .regret file stores `constructor`, `classMethod`, `constructorArgs`, and `setup` so that validation can reproduce the exact same instance state.

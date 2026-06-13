# Class-Based Library Variant

Many real-world JavaScript/TypeScript libraries export **classes** rather than standalone functions. Regrets' `capture.js` works with module exports (functions), so class-based libraries need a **wrapper module** pattern to create fingerprintable entry points.

## The Problem

Regrets' Ghost Proxy wraps exported functions. If a library exports classes like:

```js
export class LongCount {
  static fromMayanDayNumber(mdn) { ... }
  normalise() { ... }
  getPosition() { ... }
}
```

You can't directly set `entry: "LongCount.fromMayanDayNumber"` in the manifest — capture.js expects a single exported function name.

## Solution: Wrapper Module Pattern

Create a `regret-entry.mjs` file in the target project that wraps class methods into standalone exported functions:

```js
import { LongCount } from './lib/index.js';

// Wrapper function — standalone, fingerprintable
export function longCountFromMdn(mayanDayNumber) {
  const lc = LongCount.fromMayanDayNumber(mayanDayNumber);
  return {
    toString: lc.toString(),
    position: lc.getPosition(),
    parts: [...lc.parts]
  };
}
```

Then in `regrets/manifest.json`:

```json
{
  "id": "longcount-from-mdn",
  "entry": "longCountFromMdn",
  "watches": ["longCountFromMdn"],
  "file": "regret-entry.mjs",
  "stack": "js",
  "fingerprintLevel": "entry",
  "inputs": [0, 1872000, 144000]
}
```

## Key Principles

1. **Wrapper functions must be pure**: Same input → same output, no side effects
2. **Return plain objects**: Class instances don't serialize well for fingerprinting. Return JSON-compatible plain objects with the properties you care about
3. **Include meaningful fields**: Return enough data to catch regressions (toString, position, parts — not just one field)
4. **One wrapper per cluster**: Each behavioral contract gets its own exported function
5. **Keep the wrapper thin**: The wrapper should not add logic — just serialize the output

## MultiArgs Pitfall

If your wrapper function accepts an array argument and destructures it:

```js
export function tzolkinShift([dayNumber, shiftAmount]) { ... }
```

Do **NOT** set `"multiArgs": true` in the manifest. The `multiArgs` flag spreads the array into separate arguments, which conflicts with the destructuring pattern. Instead, pass the array as a single argument:

```json
{
  "id": "tzolkin-shift",
  "entry": "tzolkinShift",
  "inputs": [[0, 1], [0, 260]]
}
```

Only use `multiArgs: true` when the function signature accepts separate parameters:

```js
// Use multiArgs: true for this:
export function add(a, b) { return a + b }

// Do NOT use multiArgs for this:
export function addPair([a, b]) { return a + b }
```

## Helper Extraction Pattern

When wrapping multiple class methods that share output serialization logic, extract helper functions to reduce duplication. This was proven safe in the maya-dates proof:

```js
// Shared helpers
function lcSnapshot(obj) {
  return { toString: obj.toString(), position: obj.getPosition(), parts: [...obj.parts] };
}

// Wrapper uses helper
export function longCountFromMdn(mdn) {
  return lcSnapshot(LongCount.fromMayanDayNumber(mdn));
}
```

The refactored wrapper produced **identical fingerprints** to the original — proving that helper extraction is a safe refactor when the behavioral contract is preserved.

## Real-World Case Study: maya-dates

The `@drewsonne/maya-dates` library (Maya Long Count calendar mathematics) was used as a proof-of-concept for class-based library testing:

- **8 clusters** created from class methods (LongCount, DistanceNumber, Tzolkin, Haab, CalendarRound)
- **48 input/output pairs** covering edge cases (epoch dates, negative day numbers, boundary shifts)
- **5-run drift detection**: All PASS+STABLE
- **3-verification refactor proof**: Regrets GREEN + raw output match + fingerprint cross-match
- Refactored wrapper with extracted helpers — zero behavioral change detected

This proves that Regrets works reliably on class-based libraries through the wrapper module pattern.

# Deep-Clone Output Before Fingerprinting — Bug Fix

## Problem

When a function returns an object containing non-serializable properties (functions, circular references, `undefined` values in arrays, etc.), the fingerprint was computed from the raw output while the `.regret` file stored `JSON.stringify(output)` — which drops those non-serializable properties. This created an irreproducible hash: you could not recompute the fingerprint from the `.regret` file's own stored data.

### Example

The `tengwarjs` library's `makeOptions()` function returns an options object that includes a `font` property — a module reference with function methods like `transcribe()`, `transcribeColumn()`, `tehtaForTengwa()`, `makeColumn()`. These functions were included in the fingerprint computation but silently dropped by `JSON.stringify()` when writing the `.regret` file.

**Before the fix:**
- Fingerprint computed from: `{font: {tengwar: {...}, tehtar: {...}, transcribe: [Function], ...}}`
- `.regret` OUTPUT stored: `{font: {tengwar: {...}, tehtar: {...}}}` (functions dropped)
- Result: hash irreproducible from stored data

## Fix

Deep-clone the output **before** fingerprinting in both `capture.js` and `validate.js`. This ensures:

1. The fingerprint is computed from the same serializable data that's stored in the `.regret` file
2. Non-serializable properties are consistently excluded from both the hash and the stored data
3. The `.regret` file's stored OUTPUT can be used to recompute the hash

**After the fix:**
- Fingerprint computed from: `{font: {tengwar: {...}, tehtar: {...}}}` (deepClone'd, functions already dropped)
- `.regret` OUTPUT stored: `{font: {tengwar: {...}, tehtar: {...}}}` (same data)
- Result: hash is reproducible from stored data ✅

## Impact

- **Backward compatibility**: This changes fingerprints for any cluster whose output contains non-serializable properties. For clusters with pure JSON-serializable output, the fingerprint is unchanged (deepClone is a no-op for plain JSON).
- **Action required**: After upgrading, re-run `capture` on all clusters. The new fingerprints will be computed from the deepClone'd output and will match the stored `.regret` file data.

## Discovery

This bug was found during regression testing of the `tengwarjs` library (Tolkien's Tengwar script transcription engine) — a real-world CommonJS library whose `makeOptions()` function returns objects with module references containing function properties.

## Files Changed

- `scripts/capture.js`: Added `deepClone(rawOutput)` before fingerprinting
- `scripts/validate.js`: Added `deepClone(rawOutput)` before fingerprinting

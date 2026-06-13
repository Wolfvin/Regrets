# Case Study: ISBN Utility Library (inventaire/isbn3)

This case study documents the experience of applying Regrets to `isbn3`, a niche JavaScript library for ISBN parsing, validation, formatting, and auditing. The library is a strong test candidate because it processes structured string data with deterministic, pure functions — ideal for fingerprint stability.

## Repository

- **URL**: https://github.com/inventaire/isbn3
- **Stars**: 30
- **Language**: JavaScript (CommonJS modules)
- **Description**: ISBN utils: parse, validate, format, audit
- **Why niche**: ISBN (International Standard Book Number) processing is a specialized domain that few developers interact with directly. The library handles ISBN-10/ISBN-13 conversion, check digit calculation, group/publisher range lookup, and forensic auditing of potentially invalid ISBNs. The data-driven group ranges come from the International ISBN Agency.
- **Active**: Yes — PRs merged in 2025-2026, not archived, MIT licensed

## Challenges Encountered

### 1. CommonJS Module Compatibility

The library uses CommonJS (`module.exports = ...`) while Regrets' capture.js uses ESM `dynamic import()`. When a CJS module is imported via ESM, named exports may not all appear at the top level — some are nested under `mod.default`.

**Solution**: Regrets' existing CJS merge logic in `capture.js` handles this correctly by merging `mod.default` keys into the namespace. No changes were needed.

### 2. Inline Arrow Functions in Entry Module

The main `isbn.js` entry file defines `hyphenate`, `asIsbn13`, and `asIsbn10` as inline arrow functions rather than separate modules. This initially appeared to be a problem for watchability, but since Regrets wraps the module exports (including these functions) via the Ghost Proxy, they work correctly as entry points.

### 3. Functions Returning null

Several functions return `null` for invalid inputs (e.g., `parse('invalid')` returns `null`, `asIsbn10` for 979-prefix ISBNs returns `null`). The fingerprint algorithm handles `null` correctly — it's serialized as the string `"null"` in `stableStringify`.

## Cluster Manifest

```json
{
  "clusters": [
    {
      "id": "parse-isbn",
      "entry": "parse",
      "watches": ["parse"],
      "file": "isbn.js",
      "stack": "js",
      "fingerprintLevel": "entry",
      "description": "Parse an ISBN string and return structured data with group, publisher, article, check digits, and formatted versions",
      "inputs": [
        "978-3-642-38745-6",
        "0-7356-1967-0",
        "9791091146135",
        "0-304-33376-X",
        "978-88-3282-181-9"
      ]
    },
    {
      "id": "audit-isbn",
      "entry": "audit",
      "watches": ["audit"],
      "file": "isbn.js",
      "stack": "js",
      "fingerprintLevel": "entry",
      "description": "Audit an ISBN and return validity status with clues for possible corrections",
      "inputs": [
        "978-3-642-38745-6",
        "9788184890261"
      ]
    },
    {
      "id": "hyphenate-isbn",
      "entry": "hyphenate",
      "watches": ["hyphenate"],
      "file": "isbn.js",
      "stack": "js",
      "fingerprintLevel": "entry",
      "description": "Hyphenate an ISBN string using correct group/publisher/article ranges",
      "inputs": [
        "9783642387456",
        "0735619670",
        "9791091146135"
      ]
    },
    {
      "id": "as-isbn13",
      "entry": "asIsbn13",
      "watches": ["asIsbn13"],
      "file": "isbn.js",
      "stack": "js",
      "fingerprintLevel": "entry",
      "description": "Convert any valid ISBN to ISBN-13 format (plain or hyphenated)",
      "inputs": [
        "0-7356-1967-0",
        "9783642387456",
        "9791091146135"
      ]
    },
    {
      "id": "as-isbn10",
      "entry": "asIsbn10",
      "watches": ["asIsbn10"],
      "file": "isbn.js",
      "stack": "js",
      "fingerprintLevel": "entry",
      "description": "Convert any valid ISBN to ISBN-10 format (returns null for 979-prefix ISBNs)",
      "inputs": [
        "9783642387456",
        "0-7356-1967-0"
      ]
    }
  ]
}
```

## Results

- **Capture**: 5/5 clusters captured successfully
- **Validate**: 5/5 GREEN on first run
- **Drift Detection**: 5/5 STABLE across 5 runs
- **Health**: 5/5 SOLID
- **False Positives**: ZERO — no iteration needed

## Refactoring Performed

1. **Extracted inline functions to dedicated modules**: `hyphenate`, `asIsbn13`, `asIsbn10` were inline arrow functions in `isbn.js` — extracted to `lib/hyphenate.js`, `lib/as_isbn13.js`, `lib/as_isbn10.js` for better cohesion and testability

2. **Renamed `fill.js` to `complete_isbn_data.js`**: The name `fill` was vague and didn't communicate what the module does. The new name clearly describes that it completes ISBN data objects with computed check digits and formatted versions

3. **Extracted `normalize` function from `audit.js`**: The ISBN normalization function was private to audit.js but is useful as a standalone utility — moved to `lib/normalize.js`

4. **Decomposed `audit.js` (118 lines → 30 lines)**: Extracted all clue-generating helper functions to `lib/audit_clues.js`, keeping audit.js as a focused orchestrator

5. **Fixed typo**: `lookForPossibleInvalityCauses` → `lookForPossibleInvalidityCauses`

All 3 verifications passed after refactoring:
1. Regrets validate: All 5 clusters GREEN
2. Direct output comparison: All 15 outputs identical to pre-refactor truth
3. Cross-fingerprint verification: All 5 fingerprints match pre-refactor truth

## Lessons Learned

1. **CJS modules work seamlessly with existing merge logic.** No special handling was needed — the existing `mod.default` merge in `capture.js` correctly surfaces all CJS exports.

2. **Functions returning `null` are safe to fingerprint.** The `stableStringify` function correctly serializes `null`, producing consistent fingerprints even when the function's primary output is a null value for invalid inputs.

3. **Inline arrow functions in entry modules are watchable.** Even though `hyphenate` was defined as `val => { ... }` inside the module export, the Ghost Proxy correctly wraps it because it's an exported property of the module.

4. **ISBN processing is an excellent test target for Regrets.** The domain is pure-function-heavy with deterministic outputs: same ISBN always produces the same parsed data, same check digits, same hyphenated format. Zero non-deterministic values means zero `normalize` rules needed.

5. **Multiple entry points from the same file work perfectly.** All 5 clusters reference the same `isbn.js` file but with different entry functions, and each cluster operates independently with its own ghost proxy instance.

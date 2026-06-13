# Next.js Frontend Project — Regrets Reference Guide

Regression fingerprinting for Next.js frontend applications. Covers the adapter pattern for projects using `noEmit: true`, App Router, Server Components, and path aliases.

## The Challenge with Next.js Projects

Next.js projects typically use `"noEmit": true` in `tsconfig.json` — the framework handles compilation internally. This means there are no compiled `.js` files for Regrets' `capture.js` to import directly. Additionally, Server Components and `'use server'` directives create import chains that cannot be loaded in a plain Node.js context.

## Solution: Adapter Modules

Create standalone `.js` adapter files that contain the pure logic extracted from the TypeScript source. These adapters live inside `regrets/adapters/` and are the bridge between the source and Regrets.

### Directory Structure

```
target-project/
  regrets/
    manifest.json
    adapters/
      format.js         ← pure formatting functions
      lang.js           ← language validation
      location.js       ← location resolution
      guard.js          ← error code mapping
      utils.js          ← utility functions
    truths/
      kebenaran-1-output.json    ← raw output ground truth
      kebenaran-1-raw.mjs       ← script to regenerate raw output
      kebenaran-2-fingerprints.txt ← Regrets fingerprint contracts
    *.regret
```

### Adapter Rules

1. **Source of truth is always the TypeScript source.** Adapters must be updated when source changes.
2. **Only extract pure functions.** Functions that depend on `cookies()`, `headers()`, `'server-only'`, or `fetch()` cannot be adapted.
3. **Fix non-deterministic fallbacks.** If a source function uses `Date.now()` or `new Date()` as a default, the adapter should use a fixed value instead.
4. **Use ES module syntax** (import/export) — Regrets uses dynamic `import()`.
5. **No path aliases.** Adapters cannot use `@/` paths. Use relative imports or self-contained logic.

### Which Functions to Fingerprint

In a Next.js frontend app, focus on:

| Category | Examples | Good for Regrets? |
|----------|----------|-------------------|
| Formatting functions | `formatTime`, `formatDate`, `titleCase` | ✅ Pure, deterministic |
| Validation functions | `toLang`, `isValidEmail` | ✅ Pure, deterministic |
| Data transformation | `resolveDateAndLocation`, `groupByDate` | ✅ Pure (if inputs include all needed data) |
| Error mapping | `messageForCode` | ✅ Pure, deterministic |
| Utility functions | `cn()` (clsx+twMerge) | ✅ Pure, deterministic |
| Server Actions | `generateKundali`, `calculateMatch` | ❌ Requires `'use server'`, SDK calls |
| React components | `KundaliClient`, `PanchangView` | ❌ Requires React runtime, DOM |
| API routes | `/api/cities` | ❌ Requires Next.js server |

### Non-Deterministic Pitfalls

**`todayString()` / `Date.now()`:** Functions that call `new Date()` produce different output each run. In the adapter, replace the non-deterministic fallback with a fixed date string:

```js
// Source: resolveDateAndLocation falls back to todayString()
// Adapter: use fixed date instead
return {
  date: str('date', '2026-01-15'),  // fixed fallback
  ...
};
```

**`toLocaleDateString()`:** Date formatting with locale depends on the ICU data of the Node.js build. It is deterministic for the same Node.js version but may differ across environments. Use `normalize: ["dynamicDates"]` if the output contains date patterns.

### Manifest Configuration

```json
{
  "clusters": [
    {
      "id": "format-time",
      "entry": "formatTime",
      "watches": ["formatTime"],
      "file": "regrets/adapters/format.js",
      "stack": "js",
      "fingerprintLevel": "entry",
      "inputs": ["2026-03-22T06:41:00", "2026-03-22T14:30:00", null, ""]
    }
  ]
}
```

Key settings for Next.js projects:
- `"file"`: Point to the adapter, not the TypeScript source
- `"stack": "js"`: Adapters are plain JS
- `"fingerprintLevel": "entry"`: Only hash the final output (most permissive for refactoring)

### Multi-Args Functions

Functions that take multiple arguments use `"multiArgs": true`:

```json
{
  "id": "format-time-range",
  "entry": "formatTimeRange",
  "multiArgs": true,
  "inputs": [
    ["2026-03-22T06:41:00", "2026-03-22T07:30:00"],
    [null, null]
  ]
}
```

### The Adapter Synchronization Problem

When refactoring the TypeScript source, the adapter may drift from the source. To prevent this:

1. Add a comment at the top of each adapter: `// Source of truth is always src/lib/X.ts`
2. After any refactoring that changes pure function behavior, update the adapter
3. Run `regret:validate` to catch any drift — if the adapter doesn't match the source, the fingerprint will differ from KEBENARAN 1 (raw output)

### Dual Truth Verification

Before refactoring, capture two independent truths:

1. **KEBENARAN 1**: Run all entry functions directly and save raw output
2. **KEBENARAN 2**: Save all Regrets fingerprints (from Phase 1)

After refactoring, verify all three:
1. Regrets clusters still GREEN (fingerprint matches KEBENARAN 2)
2. Raw output matches KEBENARAN 1 exactly
3. Fingerprint from new output matches KEBENARAN 2

### Case Study: jyotish-vedic-astrology-app

A Vedic astrology Next.js 16 app with:
- 8 Regrets clusters (all SOLID, zero false positives)
- Pure functions: `formatTime`, `formatTimeRange`, `formatDate`, `formatDateShort`, `toLang`, `resolveDateAndLocation`, `messageForCode`, `cn`
- Adapter files in `regrets/adapters/` mirroring the pure logic from TypeScript source
- Successful structural refactoring (type extraction, function relocation, component decomposition) with all 3 verifications GREEN

This project demonstrated that Regrets can provide a reliable safety net for refactoring even in Next.js projects where direct TypeScript import is not possible.

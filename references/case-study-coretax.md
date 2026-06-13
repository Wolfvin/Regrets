# Case Study: Coretax-Auto-Downloader — Chrome Extension for Indonesian Tax

## Overview

Coretax-Auto-Downloader is a Chrome extension + Tauri desktop app that automates
Indonesian tax (Coretax) workflows: scraping e-invoice data, downloading PDFs,
OCR processing of bank statements, and exporting data to XLSX/CSV.

This case study documents the patterns discovered during regression testing
that exposed gaps in Regrets' handling of date-dependent output, discriminated
union return types, and multi-strategy filename generation.

## Key Patterns

### Pattern 1: Date-Dependent Output (normalizeNow)

**Problem**: `filenameFallback()` calls `new Date()` to generate filenames
like `"FPK-062026"`. Without normalization, drift detection always fails
because the output changes every month.

**Existing gap**: `dynamicDates` normalizes embedded dates in larger strings,
but doesn't communicate that the ENTIRE output is a time-derived value.
This is a semantic distinction: `dynamicDates` says "there's a date somewhere
in this string", while `normalizeNow` says "this function's output IS a
current-time value".

**Solution**: New `normalizeNow` rule that replaces MMYYYY with `<NOW_MMYYYY>`
and YYYY with `<NOW_YYYY>` — distinct placeholders from dynamicDates so that
audit review can distinguish "date in data" from "date IS the output".

```json
{
  "id": "filename-fallback",
  "entry": "filenameFallback",
  "normalize": ["normalizeNow"],
  "inputs": [["FPK-", "OUTPUT_TAX"]]
}
```

### Pattern 2: Discriminated Union Return Types

**Problem**: `checkDownloadability()` returns either `{ downloadable: true }`
or `{ downloadable: false, reason: "..." }`. The `reason` field contains
Indonesian text that could be rephrased without changing behavior — this
creates false-negative risk.

**Solution**: Use `ignoreFields: ["reason"]` to strip the text field before
fingerprinting. The discriminating key is `downloadable` (boolean), not the
human-readable reason string.

```json
{
  "id": "check-downloadability",
  "entry": "checkDownloadability",
  "ignoreFields": ["reason"],
  "multiArgs": true,
  "inputs": [
    [{"TaxInvoiceStatus": "CREATED"}, "OUTPUT_TAX"],
    [{"DocumentFormAggregateIdentifier": "abc123"}, "OUTPUT_TAX"],
    [{"TaxInvoiceStatus": "CREDITED"}, "OUTPUT_TAX"]
  ]
}
```

### Pattern 3: Multi-Strategy Functions Need Branch Coverage

**Problem**: `generateDynamicFilename()` chains 3 strategies:
1. `filenameFromHint` — use request filter hint
2. `filenameFromData` — extract from data rows
3. `filenameFallback` — current date

Each strategy has sub-branches. A cluster with 1-2 inputs only tests ONE
strategy, leaving the others untested. A refactor that breaks strategy 2
would still show GREEN if the test input always hits strategy 1.

**Solution**: Provide inputs that exercise each strategy path:

```json
{
  "id": "generate-dynamic-filename",
  "entry": "generateDynamicFilename",
  "inputs": [
    {"data": [], "fields": [], "filenameHint": "202505", "source": "OUTPUT_TAX"},
    {"data": [{"TaxInvoiceDate": "2025-05-15T00:00:00"}], "fields": ["TaxInvoiceDate"], "source": "OUTPUT_TAX"},
    {"data": [], "fields": [], "source": "OUTPUT_TAX"}
  ]
}
```

### Pattern 4: Pure Logic Extraction from Chrome Extension

**Already solved**: The project already extracted pure logic into separate
files:
- `subscription-logic.ts` (from `subscription.ts`)
- `rate-limiter-logic.ts` (from `rate-limiter.ts`)
- `payment-poller-logic.ts` (from `payment-poller.ts`)

These are directly fingerprintable with no adaptation needed.

### Pattern 5: God Object Blocking

**Problem**: `sidepanel.ts` (2721 lines) is a God Object that blocks
clustering of its contained functions. The `regret structure` command
identifies this correctly, but no workflow exists for incrementally
extracting clusters from a God Object during refactoring.

**Recommendation**: Future improvement — add `regret structure --extract`
that generates a step-by-step extraction plan for God Objects, including
which functions to extract first and what pure logic modules to create.

## Cluster Manifest (Pre-Refactor)

Based on the target code analysis, the following clusters should be defined:

### Shared Utilities (5 clusters)
- `format-date` → formatDate (3 inputs: ISO date, null, fallback)
- `format-date-time` → formatDateTime (3 inputs)
- `extract-month-year` → extractMonthYear (3 inputs)
- `sanitize-filename` → sanitizeFilename (3 inputs)
- `escape-html` → escapeHtml (3 inputs)

### Exporter (7 clusters)
- `escape-csv` → escapeCSV (4 inputs: normal, comma, quote, newline)
- `format-period` → formatPeriod (5 inputs: YYYY_MM, YYYYMM, MMYYYY, year-only, garbage)
- `filename-from-hint` → filenameFromHint (5 inputs covering all branches)
- `filename-from-data` → filenameFromData (4 inputs)
- `filename-fallback` → filenameFallback (2 inputs, normalizeNow)
- `generate-dynamic-filename` → generateDynamicFilename (3 inputs)
- `check-downloadability` → checkDownloadability (4 inputs, ignoreFields: reason)

### Error Handling (2 clusters)
- `from-http-response` → fromHttpResponse (5 inputs: 401, 403, 429, 500, 418)
- `from-unknown-error` → fromUnknown (3 inputs: FoughtError, Error, string)

### Auth Logic (4 clusters)
- `is-subscription-active` → isSubscriptionActive (3 inputs)
- `fought-error-retryable` → checkRetryable (3 inputs)
- `fought-error-needs-reauth` → checkNeedsReauth (3 inputs)
- `calculate-countdown` → calculateCountdown (3 inputs)

### Rate Limiter (2 clusters)
- `sliding-window-check` → checkSlidingWindow (3 inputs)
- `sliding-window-remaining` → remainingInWindow (3 inputs)

Total: 20 clusters covering all pure functions in the codebase.

## New Normalize Rule: normalizeNow

### Specification

| Rule | Pattern | Replacement |
|------|---------|-------------|
| `normalizeNow` | MMYYYY (valid month 01-12 + 4-digit year) | `<NOW_MMYYYY>` |
| `normalizeNow` | Standalone YYYY (19xx or 20xx) | `<NOW_YYYY>` |

### Difference from dynamicDates

- `dynamicDates`: "There's a date embedded in this string among other data" → `<MMYYYY>`, `<YYYY>`
- `normalizeNow`: "This function's output IS derived from the current time" → `<NOW_MMYYYY>`, `<NOW_YYYY>`

The distinct placeholder names allow audit reviewers to distinguish between
"data that happens to contain a date" vs "output that IS a date", which is
important for understanding refactoring safety.

### Implementation

Added to both `fingerprint.js` and `fingerprint.py` with identical regex patterns:
- JS: `obj.replace(/(0[1-9]|1[0-2])\d{4}/g, '<NOW_MMYYYY>')` + year pattern
- Python: `re.sub(r'(0[1-9]|1[0-2])\d{4}', '<NOW_MMYYYY>', obj)` + year pattern

## Refactoring Targets

1. **sidepanel.ts** (2721 lines) — God Object, needs splitting
2. **exporter.ts** (630 lines) — Multiple responsibilities (filename gen + export logic)
3. **namer.ts** — Clean pure functions, good first target for refactoring practice

# Output Design Fingerprint — Structural Fingerprinting

Not all outputs should be fingerprinted by their values. Some functions produce **structures** — config objects, API response shapes, complex nested data — where the *shape* matters more than the *values*.

## Quick Start

1. Add `"fingerprintMode": "schema"` or `"mixed"` to cluster manifest
2. Run `npm run regret:capture` — schema extraction happens automatically
3. Run `npm run regret:validate` — validates structure, not values
4. Check `.regret` file — you'll see the schema fingerprint, not value fingerprint
5. Use `"mixed"` mode when some values matter and some don't

---

## The Problem with Value-Only Fingerprinting

Consider a config builder function:

```js
buildDownloadConfig("SPT", { retries: 3, format: "pdf" })
// Returns:
{
  headers: { "Content-Type": "application/json", "Authorization": "Bearer abc123" },
  retryPolicy: { maxRetries: 3, backoff: "exponential", baseDelay: 1000 },
  outputPath: "/tmp/downloads/spt-20250530-abc123.pdf",
  filters: ["tax_type=OUTPUT", "period=202505"]
}
```

With `"fingerprintMode": "value"` (default), the fingerprint changes when:
- The authorization token rotates (every hour)
- The output path includes a timestamp
- A filter value changes for a different period

But what we REALLY care about is:
- `headers` object exists and has the right keys
- `retryPolicy.maxRetries` is always a number
- `retryPolicy.backoff` is always a string
- `outputPath` is always a string (value doesn't matter)
- `filters` is always an array of strings

**Structural fingerprint = fingerprint of the SHAPE, not the VALUES.**

---

## Schema Extraction

The `extractSchema(obj)` function produces a schema object from any JSON-serializable value:

### Algorithm

```
extractSchema(obj):
  if obj is null         → "null"
  if obj is undefined    → "undefined"
  if obj is boolean      → "boolean"
  if obj is number       → "number"
  if obj is string       → "string"
  if obj is array:
    if empty             → "array"
    if non-empty         → sample up to 5 elements:
                           collect unique schemas into seen set
                           if all elements share same schema → [schema]
                           if mixed types → [schema1, schema2, ...]  // unique schemas
  if obj is object:
    { key: extractSchema(value) for each key in sorted order }
```

### Example

```js
const config = {
  headers: { "Content-Type": "application/json", "Authorization": "Bearer abc123" },
  retryPolicy: { maxRetries: 3, backoff: "exponential", baseDelay: 1000 },
  outputPath: "/tmp/downloads/spt-20250530.pdf",
  filters: ["tax_type=OUTPUT", "period=202505"],
  enabled: true,
  metadata: null
}

const schema = extractSchema(config)
// Result:
{
  "enabled": "boolean",
  "filters": ["string"],
  "headers": {
    "Authorization": "string",
    "Content-Type": "string"
  },
  "metadata": "null",
  "outputPath": "string",
  "retryPolicy": {
    "backoff": "string",
    "baseDelay": "number",
    "maxRetries": "number"
  }
}
```

### Rules

1. **All values replaced with type name**: `"string"`, `"number"`, `"boolean"`, `"null"`, `"undefined"`
2. **Arrays with elements**: Sample up to 5 elements to detect mixed-type arrays; if all elements share the same schema, return `[schema]`; if mixed types, return array of unique schemas
3. **Empty arrays**: `"array"` — no type information available
4. **Nested objects**: Recurse — keys sorted alphabetically for consistency
5. **Mixed-type arrays**: Each unique schema captured — up to 5 elements sampled to avoid infinite schemas

### Implementation (fingerprint.js)

```js
/**
 * Extract structural schema from a JSON value.
 * All values replaced with their type name for structural fingerprinting.
 * Used by fingerprintMode: "schema" and "mixed".
 *
 * For arrays with mixed types, each unique schema is captured
 * (up to 5 elements to avoid infinite schemas).
 */
export function extractSchema(obj) {
  if (obj === null) return 'null'
  if (obj === undefined) return 'undefined'
  if (Array.isArray(obj)) {
    if (obj.length === 0) return 'array'
    // Sample up to 5 elements to detect mixed-type arrays
    const sampleSize = Math.min(obj.length, 5)
    const schemas = []
    const seen = new Set()
    for (let i = 0; i < sampleSize; i++) {
      const s = extractSchema(obj[i])
      const key = JSON.stringify(s)
      if (!seen.has(key)) {
        seen.add(key)
        schemas.push(s)
      }
    }
    // If all elements share the same schema, return single-element array
    if (schemas.length === 1) return [schemas[0]]
    // Mixed types — return array of unique schemas
    return schemas
  }
  if (typeof obj === 'object') {
    const keys = Object.keys(obj).sort()
    const schema = {}
    for (const k of keys) {
      schema[k] = extractSchema(obj[k])
    }
    return schema
  }
  return typeof obj  // "string", "number", "boolean"
}
```

---

## Fingerprint Modes

### Manifest Field: `fingerprintMode`

| Mode | Field Value | Fingerprint Source | Best For |
|------|------------|-------------------|----------|
| **Value** | `"value"` (default) | Full output JSON | Pure functions, formatters, calculators |
| **Schema** | `"schema"` | Output shape/structure only | Config builders, API response factories, complex object creators |
| **Mixed** | `"mixed"` | Schema + selected value paths | Validators, hybrid outputs where some fields must match exactly |
| **Render** | (stack `react` with `renderMode`) | Rendered HTML string | React components |

### Value Mode (Default — No Change)

Existing clusters work exactly as before. `"fingerprintMode"` defaults to `"value"` if not specified.

```json
{
  "id": "format-period",
  "fingerprintMode": "value",
  "inputs": ["2025_05"]
}
```

Fingerprint = hash(input + output) — full values, existing behavior.

### Schema Mode

Fingerprint = hash(input + schema(output)) — only the structure matters.

```json
{
  "id": "build-download-config",
  "fingerprintMode": "schema",
  "entry": "buildDownloadConfig",
  "watches": ["buildDownloadConfig"],
  "file": "js/config-builder.js",
  "stack": "js",
  "inputs": [
    { "source": "SPT", "options": { "retries": 3, "format": "pdf" } }
  ]
}
```

What gets fingerprinted:
```
INPUT:  {"source":"SPT","options":{"retries":3,"format":"pdf"}}
OUTPUT: {"enabled":"boolean","filters":["string"],"headers":{"Authorization":"string","Content-Type":"string"},"metadata":"null","outputPath":"string","retryPolicy":{"backoff":"string","baseDelay":"number","maxRetries":"number"}}
```

Even if the token, path, or filter values change — as long as the SHAPE stays the same, the fingerprint is stable.

### Mixed Mode

Some values matter, some don't. Mixed mode combines schema with specific value paths.

```json
{
  "id": "api-response-validator",
  "fingerprintMode": "mixed",
  "valuePaths": ["$.status", "$.retryPolicy.maxRetries"],
  "entry": "validateApiResponse",
  "watches": ["validateApiResponse"],
  "file": "js/api-validator.js",
  "stack": "js",
  "inputs": [
    { "endpoint": "/api/invoices", "expectedStatus": 200 }
  ]
}
```

What gets fingerprinted:
```
Schema of full output  +  exact values at $.status and $.retryPolicy.maxRetries
```

The `valuePaths` use JSONPath notation:
- `$.field` — top-level field
- `$.nested.field` — nested field
- `$.array[0].field` — array element field
- `$.headers.*` — all values in headers object

#### Implementation: Mixed Mode Fingerprint

```js
import { JSONPath } from 'jsonpath-plus'

function mixedFingerprint(input, output, config) {
  const schema = extractSchema(output)
  const valuePaths = config.valuePaths || []
  
  // Extract specified values from output
  const selectedValues = {}
  for (const path of valuePaths) {
    const matches = JSONPath({ path, json: output })
    if (matches.length > 0) {
      selectedValues[path] = matches[0]
    }
  }
  
  // Combine: schema + selected values
  const combined = { schema, values: selectedValues }
  
  // Fingerprint input + combined output
  return fingerprint(input, combined, config)
}
```

---

## Manifest Examples — Coretax Project

### Config Builder (Schema Mode)

```json
{
  "id": "build-download-config-schema",
  "fingerprintMode": "schema",
  "entry": "buildDownloadConfig",
  "watches": ["buildDownloadConfig"],
  "file": "js/exporter.js",
  "stack": "js",
  "description": "Download config structure — shape must stay consistent, values may vary",
  "inputs": [
    { "source": "SPT", "options": { "retries": 3, "format": "pdf" } }
  ]
}
```

### Invoice Response Validator (Mixed Mode)

```json
{
  "id": "invoice-response-validator",
  "fingerprintMode": "mixed",
  "valuePaths": ["$.statusCode", "$.data.invoiceType"],
  "entry": "parseInvoiceResponse",
  "watches": ["parseInvoiceResponse"],
  "file": "js/invoice-parser.js",
  "stack": "js",
  "description": "Invoice API response — structure + status code + invoice type must match",
  "inputs": [
    { "statusCode": 200, "body": "{\"invoiceType\":\"OUTPUT_TAX\",\"amount\":500000}" }
  ]
}
```

### Pure Function (Value Mode — Default)

```json
{
  "id": "format-period",
  "entry": "formatPeriod",
  "watches": ["formatPeriod"],
  "file": "js/date-utils.js",
  "stack": "js",
  "description": "Pure date formatter — exact output must match",
  "inputs": ["2025_05", "2024_01"]
}
```

---

## `.regret` File with Fingerprint Mode

The `.regret` file format does NOT change — it still records the actual INPUT and OUTPUT. The `fingerprintMode` field is added to the metadata section:

```
cluster: build-download-config-schema
fingerprint: x7k2m9
captured: 2026-05-30T06:00:00Z
watches: [buildDownloadConfig]
entry: buildDownloadConfig
stack: js
fingerprintLevel: entry
fingerprintMode: schema
normalize: [timestamps, absPaths]
---
INPUT  {"source":"SPT","options":{"retries":3,"format":"pdf"}}
OUTPUT {"headers":{"Content-Type":"application/json","Authorization":"Bearer abc123"},"retryPolicy":{"maxRetries":3,"backoff":"exponential","baseDelay":1000},"outputPath":"/tmp/downloads/spt-20250530.pdf","filters":["tax_type=OUTPUT","period=202505"],"enabled":true,"metadata":null}
HASH   x7k2m9
```

The `OUTPUT` line still contains the raw output (for human readability), but the HASH was computed from the schema, not the raw values.

For mixed mode:
```
fingerprintMode: mixed
valuePaths: [$.statusCode, $.data.invoiceType]
```

---

## Integration with Existing Scripts

### capture.js Enhancement

In `capture.js`, before computing the fingerprint, check `fingerprintMode`:

```js
// In capture.js, after getting output:
let fp
if (cluster.fingerprintMode === 'schema') {
  const schema = extractSchema(output)
  fp = fingerprint(input, schema, { normalize, ignoreFields })
} else if (cluster.fingerprintMode === 'mixed') {
  const schema = extractSchema(output)
  const selectedValues = extractValuePaths(output, cluster.valuePaths || [])
  const combined = { schema, values: selectedValues }
  fp = fingerprint(input, combined, { normalize, ignoreFields })
} else {
  // Default: value mode
  fp = fingerprintLevel === 'entry'
    ? fingerprint(input, output, { normalize, ignoreFields })
    : fingerprintSequence(recorder, { normalize, ignoreFields })
}
```

### validate.js Enhancement

Same logic in `validate.js` — when re-running and comparing hashes, use the same `fingerprintMode` as stored in the `.regret` file:

```js
const mode = regret.fingerprintMode || 'value'
// Apply same schema/mixed transformation before computing live hash
```

### Backward Compatibility

- Existing clusters without `fingerprintMode` → defaults to `"value"` → zero change
- Existing `.regret` files without `fingerprintMode` → validated as `"value"` mode
- New `fingerprintMode` field is optional → no manifest migration needed

---

## When to Use Each Mode

### Decision Tree

```
Does the function produce a complex object?
├── No (returns primitive or simple value)
│   → Use VALUE mode (default)
│
└── Yes (returns config, response, nested structure)
    ├── Do ALL values need to stay exact?
    │   ├── Yes → VALUE mode with normalize rules
    │   └── No → Does the SHAPE need to stay exact but some values can vary?
    │       ├── Yes, some specific values matter
    │       │   → MIXED mode with valuePaths
    │       └── Yes, only the structure matters
    │           → SCHEMA mode
    └── Is it a React component?
        → RENDER mode (stack: react)
```

### Real-World Coretax Examples

| Function | Output | Mode | Why |
|----------|--------|------|-----|
| `formatDate()` | `"15/01/2025"` | value | Simple string, must match exactly |
| `formatPeriod()` | `"052025"` | value | Simple string, must match exactly |
| `escapeCSV()` | `"hello"` | value | Simple string, must match exactly |
| `buildDownloadConfig()` | `{headers, retryPolicy, ...}` | schema | Structure matters, values like tokens/paths are dynamic |
| `parseInvoiceResponse()` | `{statusCode, data, meta}` | mixed | Structure + statusCode must match, meta can vary |
| `InvoiceCard` component | `<div class="...">...</div>` | render | React component, rendered HTML matters |
| `generateDynamicFilename()` | `"FPK-052025"` | value | With `normalize: ["dynamicDates"]`, exact format matters |

---

## FUTURE: Visual Output Fingerprint

For functions that produce visual output (SVG strings, HTML snippets, CSS), a more sophisticated normalization is needed.

### Planned: SVG/HTML Visual Fingerprint

```js
function normalizeVisualOutput(htmlString) {
  return htmlString
    // Strip comments
    .replace(/<!--[\s\S]*?-->/g, '')
    // Collapse whitespace
    .replace(/\s+/g, ' ')
    .replace(/>\s+</g, '><')
    // Normalize dynamic colors (hex → lower, rgb → normalized)
    .replace(/#[0-9a-fA-F]{6}/g, '<COLOR>')
    .replace(/rgb\([^)]+\)/g, '<COLOR>')
    // Normalize computed measurements
    .replace(/\d+(\.\d+)?px/g, '<PX>')
    .replace(/\d+(\.\d+)?%/g, '<PERCENT>')
    .replace(/\d+(\.\d+)?em/g, '<EM>')
    // Strip inline styles with dynamic values
    .replace(/style="[^"]*"/g, 'style="<STYLE>"')
    .trim()
}
```

### When This Would Be Useful

- Chart rendering functions that produce SVG
- Template engines that generate HTML email bodies
- CSS-in-JS that outputs dynamic stylesheets
- PDF generation helpers that produce markup

### Why Not Yet

Visual fingerprinting requires careful consideration of what "same visual output" means. Two SVGs can look identical but have different attribute orders, whitespace, or coordinate precision. The normalization rules above are a starting point but need real-world testing.

If you need visual fingerprinting now, use SCHEMA mode on the parsed DOM/AST instead — this captures the structure without depending on exact string formatting.

---

## Summary

| Mode | Fingerprint of | `.regret` OUTPUT line | Hash source |
|------|---------------|----------------------|-------------|
| `value` | Full output | Raw output | `hash(input + output)` |
| `schema` | Shape only | Raw output (for reading) | `hash(input + schema(output))` |
| `mixed` | Shape + selected values | Raw output (for reading) | `hash(input + {schema, values})` |
| `render` | Rendered HTML string | Normalized HTML | `hash(input + normalizedHTML)` |

All modes produce the same `.regret` file format. All modes use the same fingerprint algorithm. The only difference is *what gets hashed*.

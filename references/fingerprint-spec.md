# Fingerprint Specification

## Core Algorithm

```js
function fingerprint(input, output) {
  const inputStr  = stableStringify(input)
  const outputStr = stableStringify(output)
  const combined  = inputStr + '|' + outputStr
  const hash      = sha256(combined)
  return base36(hash).slice(0, 7)
}

// stableStringify: JSON with keys sorted recursively
// so { b:2, a:1 } and { a:1, b:2 } produce identical strings
function stableStringify(obj) {
  if (Array.isArray(obj)) return '[' + obj.map(stableStringify).join(',') + ']'
  if (obj && typeof obj === 'object') {
    const keys = Object.keys(obj).sort()
    return '{' + keys.map(k => JSON.stringify(k) + ':' + stableStringify(obj[k])).join(',') + '}'
  }
  return JSON.stringify(obj)
}
```

## Handling Non-Deterministic Values

Some outputs contain values that change every run. These must be **normalized** before hashing.

### Timestamps

Problem: `{ "created": "2024-01-15T10:30:00Z" }` changes every run.

Solution: Replace with sentinel before hashing.

```js
function normalizeOutput(obj) {
  // ISO timestamps → "<TIMESTAMP>"
  if (typeof obj === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(obj)) {
    return '<TIMESTAMP>'
  }
  // Unix epoch (10 or 13 digits) → "<EPOCH>"
  if (typeof obj === 'number' && obj > 1000000000 && obj < 9999999999999) {
    return '<EPOCH>'
  }
  if (Array.isArray(obj)) return obj.map(normalizeOutput)
  if (obj && typeof obj === 'object') {
    return Object.fromEntries(Object.entries(obj).map(([k, v]) => [k, normalizeOutput(v)]))
  }
  return obj
}
```

Declare in manifest if a cluster has timestamps:
```json
{ "id": "my-cluster", "normalize": ["timestamps", "epochs"] }
```

### Random IDs / UUIDs

Problem: `{ "id": "a3f7-..." }` is different every time.

Solutions (pick one per cluster):

**Option A — Ignore the field:**
```json
{ "normalize": ["uuids"], "ignoreFields": ["id", "requestId", "traceId"] }
```

**Option B — Seed the random:**
If the code uses `Math.random()` or `crypto.randomUUID()`, wrap with a seeded RNG during test capture. Declare in manifest:
```json
{ "seedRandom": true, "seed": 42 }
```

**Option C — Normalize to sentinel:**
All UUIDs → `<UUID>` before hashing.

### Network Responses

Problem: Live API calls return different data or fail in CI.

Solution: Mock at the boundary layer. Before running capture:
```js
// In capture.js setup
global.fetch = createMockFetch(fixtureMap)
```

Fixture maps live in `regrets/fixtures/` — one JSON file per endpoint.

### Floating-Point Precision (OCR/Financial)

Problem: OCR and parsing pipelines may produce the same logical value as `1500000` or `1500000.0` depending on the parsing path. In financial applications, amounts are semantically identical regardless of float representation.

Solution: Normalize float values before hashing.

```json
{ "normalize": ["floatPrecision"] }
```

This applies three rules:
1. **Whole-value floats → integers**: `1500000.0` → `1500000` (both JS and Python)
2. **Decimal floats → rounded to 2dp**: `3.14159` → `3.14` (normalizes precision differences)
3. **String-encoded floats**: `"1500000.0"` → `"1500000"` (common in OCR text output)

Example where this matters:
```python
# OCR path A produces: {"amount": 1500000.0}
# OCR path B produces: {"amount": 1500000}
# Without floatPrecision, these produce DIFFERENT fingerprints
# With floatPrecision, both normalize to 1500000 → same fingerprint
```

**Relationship to `floatTolerance`:** Both normalization rules can coexist. `floatTolerance` handles floating-point representation differences (e.g., `123456.0` vs `123456.00000001`), while `floatPrecision` handles OCR string cases and integer-float type equivalence. When both are specified, `floatTolerance` is applied first, then `floatPrecision`.

### Non-Finite Numbers: NaN, Infinity, -Infinity

Problem: `JSON.stringify` serializes `NaN`, `Infinity`, and `-Infinity` all to `"null"`. Without special handling this causes two issues:

1. **Misleading `.regret` files** — `OUTPUT null` is written when the function actually returned `NaN`, so a reader can't tell what the function really produced.
2. **Hash collisions** — a refactor that changes `NaN` → `null` (or `Infinity` → `-Infinity`) is undetectable because both serialize to `"null"` and produce the same fingerprint.

Solution: `stableStringify` short-circuits these three values **before** the `JSON.stringify` fallback, mapping them to distinct sentinel strings. This is applied recursively, so a `NaN` nested inside `{ a: NaN, b: [Infinity] }` is also handled.

| Value         | Sentinel              |
|---------------|-----------------------|
| `NaN`         | `"__nan__"`           |
| `Infinity`    | `"__infinity__"`      |
| `-Infinity`   | `"__neg_infinity__"`  |

No manifest-level opt-in is needed — the sentinels are always applied. This is a **breaking change** (issue #322): `.regret` files captured before the fix whose output contained one of these three values will produce a different fingerprint after the fix and must be re-captured.

### File System Paths

Problem: `/home/user/project/...` vs `/home/ci/project/...`

Solution: Strip absolute path prefix, keep relative portion only.

```js
{ "normalize": ["absPaths"] }
// "/home/user/project/src/file.js" → "src/file.js"
```

---

## Multi-Call Clusters

Some clusters involve multiple function calls in sequence. The fingerprint captures ALL of them:

```
Call 1: g(inputA) → outputA
Call 2: g(inputB) → outputB  ← same function, different input
Call 3: h(outputA) → finalOutput
```

Fingerprint = hash of the entire sequence, in order:
```
HASH([
  { fn: 'g', in: inputA, out: outputA },
  { fn: 'g', in: inputB, out: outputB },
  { fn: 'h', in: outputA, out: finalOutput }
])
```

If refactoring splits `g` into `g1` + `g2`, the sequence changes — and that's fine — as long as the FINAL OUTPUT of the cluster entry point stays the same.

Configure which level to fingerprint in manifest:
```json
{ "fingerprintLevel": "entry" }   // only hash entry output (default, most permissive)
{ "fingerprintLevel": "full" }    // hash entire call sequence (strictest)
{ "fingerprintLevel": "watched" } // hash all watched function outputs
```

`"entry"` is recommended for AI-refactor workflows — most permissive, only cares about final contract.

---

## The .regret File in Full

```
cluster: transform-user-data
fingerprint: 9jadb
captured: 2024-01-15T10:30:00Z
watches: [transformUser, normalizeCode, applyRules]
entry: processUser
stack: js
fingerprintLevel: entry
normalize: [timestamps]
---
INPUT  {"user":{"id":1,"name":"Ali","role":"admin"}}
OUTPUT {"code":"ALI-001","normalized":true,"role":"ADMIN"}
HASH   9jadb
```

The `---` separator divides metadata (above) from the human-readable input/output record (below).
Both sections must be present. The HASH line at the bottom is the source of truth for validation.

---

## Collision Probability Analysis

The fingerprint uses 7 base36 characters, giving a total space of:

**N = 36⁷ ≈ 78,364,164,096** possible fingerprints

Using the birthday paradox approximation for collision probability:

**P(collision) ≈ n² / (2 × N)**

where **n** = number of clusters and **N** = total fingerprint space.

| Clusters | Collision Probability | Risk Level |
|----------|----------------------|------------|
| 10 | ~6.4 × 10⁻¹⁶ | Negligible |
| 100 | ~6.4 × 10⁻¹⁴ | Negligible |
| 1,000 | ~6.4 × 10⁻¹² | Negligible |
| 10,000 | ~6.4 × 10⁻¹⁰ | Negligible |
| 100,000 | ~6.4 × 10⁻⁸ | Very Low |
| 1,000,000 | ~6.4 × 10⁻⁶ | Low |
| 10,000,000 | ~6.4 × 10⁻⁴ | Moderate |

### Recommendation

For projects with fewer than 100,000 clusters, collision probability is negligible. If you need more than 1 million clusters, consider extending to 10-char fingerprints (36¹⁰ ≈ 3.6 × 10¹⁵).

### How to Extend Fingerprint Length

- **JavaScript**: change `.slice(0, 7)` to `.slice(0, 10)` in `fingerprint.js`
- **Python**: change `[:7]` to `[:10]` in `fingerprint.py`

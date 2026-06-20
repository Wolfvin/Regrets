# React/JSX Stack Variant

Regression fingerprinting for React components — capture what a component *renders*, not how it works internally.

## Quick Start

1. Add `"stack": "react"` clusters to `regrets/manifest.json`
2. Create `regrets/` folder in your React project root
3. Run `node ../../skills/regresion-testing/scripts/capture_react.mjs` to capture rendered fingerprints
4. Run `node ../../skills/regresion-testing/scripts/validate_react.mjs` to validate
5. All `.regret` files use identical format to JS stack

---

## Two Approaches to React Fingerprinting

### Approach 2a: Component Render Fingerprint

For components that transform data into UI — fingerprint the **rendered HTML output**.

```
INPUT  = { props yang diberikan ke component }
OUTPUT = renderToStaticMarkup(<Component {...props} />)
         → strip whitespace → normalize → stable string → hash
```

Use this when:
- Component has visual output (cards, tables, form fields)
- You want to ensure the rendered structure stays consistent
- Component encapsulates presentation logic (formatting, conditional rendering)

### Approach 2b: Pure Logic Fingerprint

For utility functions used *inside* React (formatters, calculators, transformers) — fingerprint the **return value** directly, same as JS stack.

```
INPUT  = function arguments
OUTPUT = return value (any JSON-serializable type)
```

Use this when:
- Function is a pure utility (no JSX, no hooks)
- Function is exported from a module alongside components
- You want faster, more precise fingerprints

### Decision Table

| What are you fingerprinting? | Approach | Stack field | Render mode |
|------------------------------|----------|-------------|-------------|
| Component that renders UI | 2a | `"react"` | `"renderMode": "static"` |
| Hook that returns data | 2b | `"js"` | n/a |
| Formatter used in component | 2b | `"js"` | n/a |
| Component + its children | 2a | `"react"` | `"renderMode": "static"` |
| Component with dynamic styles | 2a | `"react"` | `"renderMode": "static"`, add `stripAttrs: ["style"]` |

---

## Ghost Wrapper for React

### `createGhostComponent(Component)`

The ghost wrapper records the props passed in and the rendered HTML output. It does NOT modify the component's behavior.

```js
// capture_react.mjs — ghost component wrapper
import { renderToStaticMarkup } from 'react-dom/server.js'
import React from 'react'

/**
 * Create a ghost wrapper around a React component.
 * Records props and rendered output without changing behavior.
 */
export function createGhostComponent(Component) {
  const records = []

  const GhostComponent = (props) => {
    // Render the real component
    const element = React.createElement(Component, props)
    const html = renderToStaticMarkup(element)

    // Record the observation (non-invasive)
    records.push({
      fn: Component.displayName || Component.name || 'Anonymous',
      args: deepClone(props),
      result: normalizeHtml(html),
    })

    // Return original element — behavior unchanged
    return element
  }

  GhostComponent.displayName = `Ghost(${Component.displayName || Component.name || 'Component'})`
  GhostComponent.records = records
  GhostComponent.getRecords = () => [...records]

  return GhostComponent
}

function deepClone(val) {
  try { return JSON.parse(JSON.stringify(val)) }
  catch { return val }
}

/**
 * Normalize rendered HTML for consistent fingerprinting:
 * - Collapse whitespace
 * - Sort attributes alphabetically
 * - Strip specified attributes
 */
function normalizeHtml(html, stripAttrs = []) {
  let normalized = html
    // Collapse multiple whitespace
    .replace(/\s+/g, ' ')
    // Remove whitespace between tags
    .replace(/>\s+</g, '><')
    .trim()

  // Strip specified attributes
  for (const attr of stripAttrs) {
    const regex = new RegExp(`\\s*${attr}="[^"]*"`, 'g')
    normalized = normalized.replace(regex, '')
  }

  return normalized
}
```

---

## Normalization for React

React components produce HTML strings that may contain non-deterministic values. These must be normalized before fingerprinting.

### Attributes to Strip

| Attribute | Why | Strip Rule |
|-----------|-----|-----------|
| `data-testid` | Testing artifact, not visual | Add to `stripAttrs` in manifest |
| `aria-label` | May contain dynamic text | Add to `stripAttrs` if dynamic |
| `key` | React internal, not in rendered HTML | Not needed (not in static markup) |
| `style` | May contain dynamic values (positions, colors) | Add to `stripAttrs` or use `stripStyleValues` |
| `class` | CSS modules generate hashes | Add to `stripAttrs` if using CSS modules |
| `id` | May be auto-generated | Add to `stripAttrs` if dynamic |

### Dynamic Content Normalization

```js
// In capture_react.mjs
const NORMALIZE_PATTERNS = {
  timestamps: /\d{4}-\d{2}-\d{2}T[\d:.Z+-]+/g,
  epochs: (val) => typeof val === 'number' && val > 1e9 && val < 1e13,
  uuids: /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi,
  dynamicDates: {
    mmyyyy: /\d{2}\d{4}/g,
    yyyy: /(?<![0-9])(20\d{2}|19\d{2})(?![0-9])/g,
  },
}
```

These match the same normalization rules used in `fingerprint.js` — applied to the rendered HTML string before hashing.

---

## Manifest Cluster for React

```json
{
  "clusters": [
    {
      "id": "invoice-card-render",
      "entry": "InvoiceCard",
      "watches": ["InvoiceCard"],
      "file": "src/components/InvoiceCard.tsx",
      "stack": "react",
      "renderMode": "static",
      "stripAttrs": ["data-testid", "aria-label"],
      "fingerprintLevel": "entry",
      "description": "Invoice card component — renders invoice amount and status",
      "inputs": [
        { "amount": 1000000, "status": "PAID" },
        { "amount": 0, "status": "PENDING" },
        { "amount": 500000, "status": "OVERDUE" }
      ]
    },
    {
      "id": "tax-summary-row",
      "entry": "TaxSummaryRow",
      "watches": ["TaxSummaryRow"],
      "file": "src/components/TaxSummaryRow.tsx",
      "stack": "react",
      "renderMode": "static",
      "stripAttrs": ["data-testid"],
      "normalize": ["dynamicDates"],
      "inputs": [
        { "period": "2025_05", "taxType": "OUTPUT_TAX", "total": 55000000 }
      ]
    },
    {
      "id": "format-currency-util",
      "entry": "formatCurrency",
      "watches": ["formatCurrency"],
      "file": "src/utils/formatters.ts",
      "stack": "js",
      "fingerprintLevel": "entry",
      "description": "Currency formatting utility used inside React components",
      "inputs": [
        1000000,
        0,
        999999999
      ]
    }
  ]
}
```

### React-Specific Manifest Fields

| Field | Required | Description |
|-------|----------|-------------|
| `stack` | ✅ | Must be `"react"` for render fingerprinting |
| `renderMode` | ✅ for react | `"static"` — uses `renderToStaticMarkup` (no DOM) |
| `stripAttrs` | ❌ | HTML attributes to strip before fingerprinting |
| `stripStyleValues` | ❌ | If `true`, strip inline `style` attribute values |
| `module` | ❌ | ES module path if different from `file` |

---

## Script: `scripts/capture_react.mjs`

```js
#!/usr/bin/env node
// capture_react.mjs — React component render capture
// Uses react-dom/server renderToStaticMarkup (no DOM, no browser needed)
//
// Usage:
//   node scripts/capture_react.mjs
//   node scripts/capture_react.mjs --cluster invoice-card-render

import { readFileSync, writeFileSync, mkdirSync } from 'fs'
import { resolve, join, dirname } from 'path'
import { fileURLToPath, pathToFileURL } from 'url'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server.js'
import { fingerprint, normalize, stableStringify } from './fingerprint.js'

const __dirname = dirname(fileURLToPath(import.meta.url))

// ─── CLI args ─────────────────────────────────────────────────────────────────

const args = process.argv.slice(2)
const clusterFilter = args.includes('--cluster') ? args[args.indexOf('--cluster') + 1] : null
const manifestPath = args.includes('--manifest')
  ? args[args.indexOf('--manifest') + 1]
  : resolve(process.cwd(), 'regrets/manifest.json')

// ─── Load manifest ────────────────────────────────────────────────────────────

let manifest
try {
  manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
} catch {
  console.error(`❌ Could not read manifest: ${manifestPath}`)
  process.exit(1)
}

const clusters = clusterFilter
  ? manifest.clusters.filter(c => c.id === clusterFilter)
  : manifest.clusters.filter(c => c.stack === 'react')

if (!clusters.length) {
  console.log('No React clusters found in manifest.')
  process.exit(0)
}

// ─── HTML normalization ──────────────────────────────────────────────────────

function normalizeHtml(html, stripAttrs = []) {
  let result = html
    .replace(/\s+/g, ' ')
    .replace(/>\s+</g, '><')
    .trim()

  for (const attr of stripAttrs) {
    const regex = new RegExp(`\\s*${attr}="[^"]*"`, 'g')
    result = result.replace(regex, '')
  }

  return result
}

// ─── Capture React clusters ──────────────────────────────────────────────────

const outDir = resolve(process.cwd(), 'regrets')
mkdirSync(outDir, { recursive: true })

let captured = 0
let failed = 0

for (const cluster of clusters) {
  const { id, entry, file, stripAttrs = [], normalize: normRules = [], ignoreFields = [],
          fingerprintLevel = 'entry', inputs } = cluster

  console.log(`\n📡 Capturing React: ${id}`)
  console.log(`   Component: ${entry}`)
  console.log(`   File: ${file}`)

  try {
    const absPath = resolve(process.cwd(), file.replace(/\.(tsx|jsx)$/, '.js'))
    const moduleUrl = pathToFileURL(absPath).href
    const mod = await import(moduleUrl)

    const Component = mod[entry] ?? mod.default?.[entry]
    if (!Component) {
      throw new Error(`Component "${entry}" not found in ${file}`)
    }

    const testInputs = inputs ?? [{}]
    const results = []

    for (const input of testInputs) {
      // Render component to static HTML string
      const element = React.createElement(Component, input)
      const rawHtml = renderToStaticMarkup(element)
      const html = normalizeHtml(rawHtml, stripAttrs)

      // Fingerprint: input props + rendered HTML
      const fp = fingerprint(input, html, { normalize: normRules, ignoreFields })
      results.push({ input, output: html, fp })
    }

    // Use first result as golden
    const { input, output, fp } = results[0]
    const regretPath = join(outDir, `${id}.regret`)
    const timestamp = new Date().toISOString()

    const content = [
      `cluster: ${id}`,
      `fingerprint: ${fp}`,
      `captured: ${timestamp}`,
      `watches: [${entry}]`,
      `entry: ${entry}`,
      `stack: react`,
      `renderMode: static`,
      normRules.length ? `normalize: [${normRules.join(', ')}]` : null,
      stripAttrs.length ? `stripAttrs: [${stripAttrs.join(', ')}]` : null,
      `---`,
      `INPUT  ${JSON.stringify(input)}`,
      `OUTPUT ${JSON.stringify(output)}`,
      `HASH   ${fp}`,
    ].filter(Boolean).join('\n')

    writeFileSync(regretPath, content, 'utf8')
    console.log(`   ✅ Fingerprint: ${fp}`)
    console.log(`   📄 Saved: regrets/${id}.regret`)
    captured++

  } catch (err) {
    console.error(`   ❌ Capture failed: ${err.message}`)
    failed++
  }
}

// ─── Summary ──────────────────────────────────────────────────────────────────

console.log(`\n${'─'.repeat(50)}`)
console.log(`React capture complete: ${captured} captured, ${failed} failed`)

if (failed > 0) {
  process.exit(1)
}
```

---

## Validation for React Clusters

`scripts/validate_react.mjs` is the React-aware validator. It mirrors
`capture_react.mjs`'s rendering pipeline (same module resolution, same
`renderToStaticMarkup` call, same `normalizeHtml` rules) so a `.regret`
captured by `capture_react.mjs` is guaranteed to be re-renderable by
`validate_react.mjs`.

```js
// validate_react.mjs — core re-render path (simplified)
const Component = (await import(moduleUrl))[regret.entry]
const element = React.createElement(Component, regret.input)
const liveHtml = renderToStaticMarkup(element)
const normalizedHtml = normalizeHtml(liveHtml, stripAttrs)
const liveHash = fingerprint(regret.input, normalizedHtml, clusterConfig)
const isMatch = liveHash === regret.goldenHash  // PASS / FAIL
```

The CLI dispatcher in `scripts/regret.js` routes `stack: "react"` clusters
to `validate_react.mjs` for `regret validate`, `regret update`, and
`regret drift` — never to `validate.js`, which cannot render React
components and would silently produce wrong fingerprints.

### CLI flags

```
node scripts/validate_react.mjs                              # validate all React clusters
node scripts/validate_react.mjs --cluster invoice-card-paid  # one cluster
node scripts/validate_react.mjs --manifest ./regrets/manifest.json
node scripts/validate_react.mjs --fail-fast                  # stop on first FAIL
node scripts/validate_react.mjs --runs 5                     # drift detection
node scripts/validate_react.mjs --update invoice-card-paid --reason "..."
node scripts/validate_react.mjs --quiet                      # summary line only
node scripts/validate_react.mjs --verbose                    # per-cluster detail
node scripts/validate_react.mjs --json                       # machine-readable output
```

### End-to-end demo

A complete working example lives at `proof/react_demo/` — two clusters
captured from a real (small) React component, with a script that walks
through PASS / valid-refactor-PASS / breaking-refactor-FAIL / update-with-audit
/ PASS-again. See `proof/react_demo/README.md` and `proof/react_demo/demo.sh`.

---

## Pitfalls — React-Specific

### 1. `Date.now()` in Components

**Problem:** Component calls `Date.now()` or `new Date()` during render → output changes every millisecond.

**Fix:** Mock `Date.now()` BEFORE capture, not after:

```json
{
  "id": "countdown-display",
  "stack": "react",
  "normalize": ["epochs", "timestamps"],
  "inputs": [
    { "targetTime": 9999999999000 }
  ]
}
```

Or better — extract the date logic:

```tsx
// ❌ BAD — non-deterministic render
function CountdownDisplay({ targetMs }) {
  const remaining = targetMs - Date.now()  // different every run!
  return <span>{formatRemaining(remaining)}</span>
}

// ✅ GOOD — pass `now` as prop
function CountdownDisplay({ targetMs, now }) {
  const remaining = targetMs - now
  return <span>{formatRemaining(remaining)}</span>
}

// In manifest:
{ "inputs": [{ "targetMs": 9999999999000, "now": 1718803200000 }] }
```

### 2. `Math.random()` in Components

**Problem:** Component generates random IDs, keys, or colors during render.

**Fix:** Seed the random or extract to a prop:

```tsx
// ❌ BAD
function ColorBadge({ label }) {
  const color = `hsl(${Math.random() * 360}, 70%, 50%)`
  return <span style={{ color }}>{label}</span>
}

// ✅ GOOD — deterministic color from label
function ColorBadge({ label }) {
  const color = deterministicColor(label)  // pure function
  return <span style={{ color }}>{label}</span>
}
```

### 3. `useEffect` During Render

**Problem:** `useEffect` fires after render but `renderToStaticMarkup` does NOT execute effects. If your component relies on effects to set state that affects output, the rendered HTML will be incomplete.

**Fix:** For fingerprinting purposes, either:
- Extract the logic from `useEffect` into a pure function (Approach 2b)
- Or ensure the component renders meaningful output on first pass without effects

```tsx
// ❌ BAD — output depends on useEffect
function InvoiceList() {
  const [invoices, setInvoices] = useState([])
  useEffect(() => { fetchInvoices().then(setInvoices) }, [])
  return <ul>{invoices.map(i => <li key={i.id}>{i.amount}</li>)}</ul>
  // renderToStaticMarkup produces: <ul></ul> (empty!)
}

// ✅ GOOD — accept data as prop
function InvoiceList({ invoices }) {
  return <ul>{invoices.map(i => <li key={i.id}>{i.amount}</li>)}</ul>
}
```

### 4. Context Providers

**Problem:** Component uses `useContext(MyContext)` but the provider is not available during static rendering.

**Fix:** Wrap the component with a mock provider during capture:

```js
// In capture setup
const MockProvider = ({ children }) => React.createElement(MyContext.Provider,
  { value: { theme: 'dark', locale: 'id' } },
  children
)
const wrappedElement = React.createElement(MockProvider, null,
  React.createElement(Component, input)
)
const html = renderToStaticMarkup(wrappedElement)
```

### 5. CSS Modules / Generated Class Names

**Problem:** CSS modules produce hashes like `_button_1a2b3` that change across builds.

**Fix:** Add `"class"` to `stripAttrs`:

```json
{
  "stripAttrs": ["class", "data-testid"]
}
```

This strips all `class="..."` attributes before fingerprinting, focusing on structure not styling.

---

## TypeScript Configuration

For `.tsx` components, ensure your `tsconfig.json` outputs `.js` files that `capture_react.mjs` can import:

```json
{
  "compilerOptions": {
    "jsx": "react-jsx",
    "module": "ESNext",
    "moduleResolution": "node",
    "outDir": "./js"
  }
}
```

Build before capture: `npx tsc -p tsconfig.json`

Then in manifest, point `file` to the compiled output:
```json
{ "file": "js/components/InvoiceCard.js" }
```

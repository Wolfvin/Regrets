# Vue Stack — Regrets Regression Testing

This document explains how to use Regrets with **Vue 3** components. For the
working example, see `proof/vue_demo/`.

## How It Works

The Vue stack follows the same 3-phase workflow as JS/Python/React:

1. **Capture**: Read `regrets/manifest.json`, render each Vue 3 component with
   the specified props via **Server-Side Rendering** (`renderToString` from
   `@vue/server-renderer`), normalize the resulting HTML, compute a fingerprint
   (SHA-256 → base36 → 7 chars), and write a `.regret` file.
2. **Refactor**: Make changes to your Vue components (confident that regression
   contracts exist).
3. **Validate**: Re-render the same components with the same props, recompute
   fingerprints, and compare against the stored HASH → PASS or FAIL.

The fingerprint algorithm is delegated to `scripts/fingerprint.js` — the same
algorithm used by the JS, Python, Go, Rust, and React stacks. Cross-stack
parity is guaranteed: the same input/output pair produces the same 7-char hash
regardless of which stack captured it.

## What Gets Fingerprinted

| Field   | Source                                                |
|---------|------------------------------------------------------|
| INPUT   | Component props (JSON-serializable object from `manifest.inputs`) |
| OUTPUT  | Normalized HTML string from `renderToString`         |
| HASH    | `sha256(stableStringify(input) + '|' + stableStringify(output))` → base36 → first 7 chars |

HTML normalization (via `scripts/ghost.js#normalizeHtml`):
- Collapses whitespace
- Strips optional attributes listed in `stripAttrs` (e.g. `data-testid`)

This mirrors the React stack's approach exactly — Vue SSR produces a clean
HTML string just like React's `renderToStaticMarkup`, so the same
post-processing applies.

## Prerequisites

- Vue 3 (`vue@^3.5.0`) and `@vue/server-renderer@^3.5.0` as devDependencies
  (added automatically when you install Regrets)
- Components authored as **render-function components** in `.js` / `.mjs` files
  (defineComponent with a `setup()` that returns a render function, OR a plain
  component object)

## What's NOT Supported in v1

- **`.vue` Single-File Components** — these require `@vue/compiler-sfc` to
  compile the `<template>` block into a render function. v1 ships without a
  build step. To use SFCs, pre-compile them to `.js` (most Vue projects already
  do this via `vite build` or `vue-tsc`).
- **Client-side hydration / interaction testing** — Regrets fingerprints the
  SSR HTML output, not the hydrated client behavior. This is the same scope
  as the React stack (which uses `renderToStaticMarkup`, not
  `react-dom/client`'s `createRoot`).
- **Composables with side effects** — components that read from `localStorage`,
  `window`, or other browser-only APIs at module-eval time will fail in SSR.
  This is a Vue SSR limitation, not a Regrets limitation.
- **Callee wrapping (ghost proxy) for Vue composables** — Vue's reactivity
  system doesn't expose function calls the same way plain JS modules do, so
  the ghost proxy pattern from `scripts/ghost.js` doesn't apply. Future PR
  could add a `useRegretRecorder()` composable for explicit callee tracking.

## Quick Start

### 1. Author your Vue component

```js
// src/InvoiceCard.js
import { defineComponent, h } from 'vue'

export const InvoiceCard = defineComponent({
  name: 'InvoiceCard',
  props: {
    invoice: { type: Object, required: true },
    customer: { type: Object, required: true },
    status: { type: String, default: 'pending' },
  },
  setup(props) {
    const formattedAmount = `${props.invoice.currency} ${props.invoice.amount.toFixed(2)}`
    return () => h('div', { class: 'invoice-card' }, [
      h('div', { class: 'invoice-amount' }, formattedAmount),
      // ...
    ])
  },
})

export default InvoiceCard
```

### 2. Add a cluster to `regrets/manifest.json`

```json
{
  "clusters": [{
    "id": "invoice-card-render",
    "entry": "InvoiceCard",
    "file": "./src/InvoiceCard.js",
    "stack": "vue",
    "fingerprintLevel": "entry",
    "watches": [],
    "inputs": [
      {
        "invoice": { "id": "INV-2026-001", "amount": 1250.5, "currency": "USD" },
        "customer": { "name": "Alice Anderson", "email": "alice@example.com" },
        "status": "paid"
      }
    ]
  }]
}
```

### 3. Capture + validate

```bash
# Capture fingerprints (writes regrets/invoice-card-render.regret)
node scripts/capture_vue.mjs

# Validate (re-renders, compares hashes)
node scripts/validate_vue.mjs
```

Or via the unified CLI:

```bash
node bin/regret.js capture   # auto-dispatches to capture_vue.mjs for stack:vue clusters
node bin/regret.js validate  # auto-dispatches to validate_vue.mjs for stack:vue clusters
```

## Manifest Fields

| Field              | Required | Description                                                  |
|--------------------|----------|--------------------------------------------------------------|
| `id`               | yes      | Cluster identifier (becomes the `.regret` filename)         |
| `entry`            | yes      | Named export of the Vue component in `file`                  |
| `file`             | yes      | Path to the `.js` / `.mjs` module exporting the component    |
| `stack`            | yes      | Must be `"vue"`                                              |
| `fingerprintLevel` | yes      | Must be `"entry"` (per-component)                            |
| `inputs`           | no       | Array of props objects; first one becomes the golden capture |
| `watches`          | no       | Unused for Vue (kept for schema compatibility)               |
| `stripAttrs`       | no       | HTML attributes to strip before fingerprinting (e.g. `["data-testid"]`) |
| `normalize`        | no       | String normalization rules from `fingerprint.js` (e.g. `["timestamps"]`) |
| `ignoreFields`     | no       | Object fields to strip before fingerprinting                 |
| `fingerprintMode`  | no       | `"value"` (default) / `"schema"` / `"mixed"` — same semantics as React stack |

## .regret File Format

Same as all other stacks:

```
cluster: invoice-card-render
version: 1
fingerprint: 30uqm2n
captured: 2026-06-21T05:07:30.932Z
watches: [InvoiceCard]
entry: InvoiceCard
stack: vue
renderMode: ssr
---
INPUT  {"invoice":{...},"customer":{...},"status":"paid"}
OUTPUT "<div class=\"invoice-card\">...</div>"
HASH   30uqm2n
```

## CLI Flags (validate_vue.mjs)

```
--cluster <id>       Validate only the specified cluster
--manifest <path>    Override manifest path (default: regrets/manifest.json)
--update <id>        Update the .regret file with current hash (requires --reason)
--reason "<text>"    Required with --update; must be at least 4 words
--fail-fast          Stop on first FAIL
--quiet              Summary line only
--verbose            Per-cluster detail (input, output, hashes)
--json               Machine-readable JSON output
--runs <N>           Drift detection: render N times, flag inconsistent hashes
```

## Cross-Stack Parity

The Vue stack produces fingerprints identical to the JS, Python, Go, Rust, and
React stacks for the same input/output pair. This is by construction — Vue
delegates to `scripts/fingerprint.js`, the same module used everywhere else.

You can verify this in the demo:

```bash
cd proof/vue_demo
bash run_demo.sh
```

The demo's final phase explicitly asserts that the Vue fingerprint matches
the JS reference for the same `(input, html)` pair.

## Comparison with the React Stack

The Vue stack is architecturally a sibling of the React stack
(`scripts/capture_react.mjs` + `scripts/validate_react.mjs`). Both:

- Render the component to a static HTML string via SSR
- Normalize the HTML via `scripts/ghost.js#normalizeHtml`
- Compute the fingerprint via `scripts/fingerprint.js`
- Use the same `.regret` file format (only `stack` and `renderMode` differ)
- Support the same CLI flags (`--cluster`, `--update`, `--fail-fast`, etc.)

The only differences:

| Aspect                | React                            | Vue 3                              |
|-----------------------|----------------------------------|------------------------------------|
| Render API            | `renderToStaticMarkup(element)`  | `renderToString(createSSRApp(...))` |
| Component authoring   | Function component returning JSX | `defineComponent({ setup, props })` |
| Source format         | `.js` / `.jsx` (compiled)        | `.js` / `.mjs` (render function)   |
| `renderMode` in .regret | `static`                       | `ssr`                              |

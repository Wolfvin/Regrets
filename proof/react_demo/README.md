# Regrets React Stack — End-to-End Fixture

This directory demonstrates **capture + validate for React components**,
exercising the full Regrets workflow on a real (small) React component
without any build step.

## What's here

```
proof/react_demo/
├── package.json              # deps: react, react-dom (peer-only; no build)
├── src/
│   └── InvoiceCard.js        # Pure presentational React component
├── regrets/
│   └── manifest.json         # Two clusters: paid + overdue invoice
└── README.md                 # This file
```

## Model (what gets fingerprinted)

Regrets fingerprints **input → output of a function call**. For React, the
"function" is the component and the "output" is the **rendered HTML**:

| Phase | What happens |
|-------|--------------|
| Capture | `React.createElement(Component, input)` → `renderToStaticMarkup(element)` → `normalizeHtml(html, stripAttrs)` → `fingerprint(input, normalizedHtml)` → `.regret` file |
| Validate | Read `.regret` → re-render with same INPUT → re-compute fingerprint → compare to golden HASH → PASS/FAIL |

This matches the model defined by `scripts/capture_react.mjs` (already in
the repo). `scripts/validate_react.mjs` (added in this PR) mirrors that
pipeline for validation.

## Run the demo

```bash
cd proof/react_demo

# 1. Install React (one-time)
npm install

# 2. Capture fingerprints
node ../../scripts/capture_react.mjs

# 3. Validate (should PASS — code unchanged)
node ../../scripts/validate_react.mjs
```

## Refactor scenarios

After step 3, the demo supports two refactor scenarios that exercise
validate's PASS and FAIL paths:

### Scenario A — valid refactor (validate stays PASS)

Edit `src/InvoiceCard.js` and change the `formatCurrency` implementation to
a different (but equivalent) approach, e.g. switch the regex separator:

```js
// Before
const withSep = formatted.replace(/\B(?=(\d{3})+(?!\d))/g, ',')

// After — same output, different implementation
const [int, dec] = formatted.split('.')
const withSep = int.replace(/\B(?=(\d{3})+(?!\d))/g, ',') + (dec ? '.' + dec : '')
```

Re-run validate:

```bash
node ../../scripts/validate_react.mjs
# Expected: both clusters PASS (rendered HTML is identical)
```

### Scenario B — breaking refactor (validate FAILs)

Edit `src/InvoiceCard.js` and change the rendered structure — e.g. change
the status label mapping:

```js
// Before
case 'paid': return 'Paid'

// After — breaking: label changed
case 'paid': return 'Settled'
```

Re-run validate:

```bash
node ../../scripts/validate_react.mjs
# Expected: invoice-card-paid FAILs (fingerprint changed)
#           invoice-card-overdue still PASSes (status='overdue' unaffected)
```

### Scenario C — update with audit trail

To accept a deliberate behavior change into the golden contract:

```bash
node ../../scripts/validate_react.mjs \
  --update invoice-card-paid \
  --reason "status label changed from Paid to Settled per new branding"
```

The `.regret` file is rewritten with the new fingerprint and an entry is
appended to `regrets/audit.log` linking old → new hash with the reason and
git provenance.

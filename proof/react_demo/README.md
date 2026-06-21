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
│   └── manifest.json         # Three clusters: paid + overdue + multi-status
├── demo.sh                   # Single-input scenario demo
├── demo_multi_input.sh       # Multi-input (Issue #315 parity) demo
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
the repo). `scripts/validate_react.mjs` mirrors that pipeline for validation.

## Multi-input contract (Issue #315 parity)

When a cluster's manifest declares multiple `inputs`, capture writes an
`INPUTS <json-array>` line to the `.regret` file containing per-input
contracts (`{input, output, hash}`) for inputs[1+]. The first input remains
in the top-level `INPUT`/`OUTPUT`/`HASH` trio (unchanged from single-input
behavior). validate_react.mjs then re-renders EVERY stored input and FAILs
the cluster if ANY hash mismatches — even when the first input still
matches.

This catches **false GREENs** where a refactor breaks only `inputs[1+]`
behavior. Without the INPUTS line, only `inputs[0]` is checked and a
regression on later inputs is invisible.

Backward compatibility:
- Old `.regret` files (no INPUTS line): validate falls back to checking only
  the first input. Old captures still work; re-capture to opt in.
- New `.regret` files with a single input: INPUTS line is omitted (no
  overhead for the common case).
- New `.regret` files with multiple inputs: INPUTS line contains
  `results.slice(1)` — validate compares every hash.

The `invoice-card-multi-status` cluster demonstrates this with 4 inputs
spanning all status values (paid / unpaid / overdue / void).

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

Two end-to-end demo scripts are provided:

```bash
# Single-input scenarios: initial PASS → valid refactor PASS → breaking FAIL → update → PASS
bash demo.sh

# Multi-input scenarios (Issue #315): shows how a refactor that only breaks
# input[3] (status: 'void') is caught by the INPUTS contract
bash demo_multi_input.sh
```

## Refactor scenarios

After step 3, the demo supports several refactor scenarios that exercise
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
# Expected: all clusters PASS (rendered HTML is identical)
```

### Scenario B — breaking refactor on single-input cluster (validate FAILs)

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

### Scenario C — breaking refactor on ONE input of a multi-input cluster

Edit `src/InvoiceCard.js` and change ONLY the `void` label:

```js
// Before
case 'void': return 'Void'

// After — breaking: only the 'void' status label changed
case 'void': return 'Cancelled'
```

Re-run validate:

```bash
node ../../scripts/validate_react.mjs
# Expected: invoice-card-multi-status FAILs with "(+1 input fail)"
#   - input[0] (paid)    still matches golden 3ikakf5
#   - input[3] (void)    golden=2lvul73 live=2qaav34  ← MISMATCH
#   Other clusters still PASS (none of them use status='void')
#
# Without the INPUTS line, this refactor would FALSELY PASS — only input[0]
# would be checked and input[0] is unaffected by the void→Cancelled change.
```

### Scenario D — update with audit trail

To accept a deliberate behavior change into the golden contract:

```bash
node ../../scripts/validate_react.mjs \
  --update invoice-card-paid \
  --reason "status label changed from Paid to Settled per new branding"
```

The `.regret` file is rewritten with the new fingerprint and an entry is
appended to `regrets/audit.log` linking old → new hash with the reason and
git provenance. For multi-input clusters, both the top-level HASH AND the
INPUTS line are refreshed atomically — the next `validate` will PASS again.

```bash
# Multi-input update — refreshes BOTH top-level HASH and INPUTS line
node ../../scripts/validate_react.mjs \
  --update invoice-card-multi-status \
  --reason "status label changed from Void to Cancelled per new branding guideline"
```

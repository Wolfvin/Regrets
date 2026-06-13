---
name: regression-testing
description: >
  Output-based regression testing skill for AI-driven refactoring. Use this skill whenever
  the user wants to safely refactor, simplify, or restructure code without breaking behavior.
  Trigger when user mentions: refactor, simplify, clean up modules, split big files, make
  maintainable, regression test, snapshot test, or "make sure nothing breaks after refactor".
  This skill captures behavioral fingerprints of code clusters BEFORE refactoring, then
  validates them AFTER — so AI can freely restructure internals as long as outputs stay identical.
  Always use this skill before any non-trivial refactor.
---

# Regression Testing — Output Fingerprint Skill

A skill for AI-driven refactoring with zero fear. Capture what code *produces*, not how it works. Refactor freely. Validate outputs match. Green = safe.

**Core Mantra:** Test the contract, not the implementation.

---

## Mental Model

```
BEFORE REFACTOR                    AFTER REFACTOR
─────────────────                  ──────────────
Analyze codebase                   Run all .regret files
Tag clusters to watch         →    Compare fingerprints
Ghost-capture outputs              All green? Ship it.
Save to regrets/                   Any red? Fix code, NOT regrets.
Validate all green ← GATE
```

**The `regrets/` folder is sacred. Never edit `.regret` files after they are green.**

---

## Three Phases

### PHASE 1 — AUDIT (capture truth)
### PHASE 2 — REFACTOR (restructure freely)  
### PHASE 3 — VALIDATE (prove nothing broke)

Read `references/phases.md` for detailed instructions per phase.

---

## The `.regret` File Format

One file per behavioral cluster. Filename = the contract name.

```
regrets/
  transform-user-data.regret
  fetch-invoice.regret
  login-flow.regret
```

Each `.regret` file:

```
cluster: transform-user-data
version: 1
fingerprint: 9jadb
captured: 2024-01-15T10:30:00Z
watches: [g, gHelper]
entry: a
stack: js
---
INPUT  {"user":{"id":1,"name":"Ali"}}
OUTPUT {"transformed":true,"code":"ALI-001"}
HASH   9jadb
```

Rules:
- `version` = file format version (currently `1`). Future format changes will increment this number and include a migration path.
- `fingerprint` = short hash of (INPUT + OUTPUT) deterministically hashed
- `watches` = function names being monitored in this cluster
- `entry` = the top-level caller that triggers the cluster
- One `.regret` = one behavioral unit = one responsibility
- Human readable, AI readable, git-diffable

The `version` field indicates the .regret file format version. Currently `1`. Future format changes will increment this number and include a migration path.

---

## The Ghost Proxy Pattern

The fingerprinter wraps functions **transparently** — real execution is untouched.

```js
// Ghost never modifies behavior. It only observes.
const ghost = new Proxy(targetFn, {
  apply(target, thisArg, args) {
    const result = target.apply(thisArg, args)
    recorder.capture({ fn: target.name, args, result })
    return result  // real flow unchanged
  }
})
```

Read `scripts/fingerprint.js` for the full implementation.

---

## Cluster Manifest

Clusters are defined in `regrets/manifest.json` — placed **inside the target project** being refactored (plug-and-run pattern).

### Plug-and-Run Pattern

The `regrets/` directory lives **inside** the target project, not at the skill level. When you want to refactor a project, its `regrets/` folder appears within it:

```
my-project/
  src/
  regrets/          ← plug-and-run: lives inside target project
    manifest.json
    *.regret
    audit.log
```

This makes regrets portable, self-contained, and version-controlled alongside the code they protect.

### Manifest Format

```json
{
  "clusters": [
    {
      "id": "transform-user-data",
      "entry": "processUser",
      "watches": ["transformUser", "normalizeCode", "applyRules"],
      "file": "src/user/processor.js",
      "stack": "js",
      "fingerprintLevel": "entry",
      "description": "Transform user data with normalization",
      "inputs": [
        {"id": 1, "name": "Ali"},
        null,
        {"id": 0, "name": ""}
      ]
    },
    {
      "id": "compute-total",
      "entry": "computeTotal",
      "watches": ["computeTotal", "applyTax"],
      "file": "src/billing.js",
      "stack": "js",
      "multiArgs": true,
      "normalize": ["dynamicDates"],
      "inputs": [
        [100, 0.11, "OUTPUT_TAX"],
        [0, 0, "INPUT_TAX"]
      ]
    }
  ]
}
```

AI writes this manifest during PHASE 1. It lives in `regrets/` alongside `.regret` files.

### Cluster Fields

| Field | Required | Description |
|-------|----------|-------------|
| `id` | ✅ | Unique cluster identifier (kebab-case) |
| `version` | ❌ | `.regret` file format version (currently `1`) |
| `entry` | ✅ | Function name to call (exported from `file`) |
| `watches` | ✅ | Array of function names to monitor via Ghost Proxy |
| `file` | ✅ | Path to compiled JS module (relative to project root) |
| `stack` | ✅ | Runtime stack: `js`, `ts`, `python`, `rust`, `react`, or `extension` |
| `fingerprintLevel` | ❌ | `entry` (default) or `full` (entire call sequence) |
| `description` | ❌ | Human-readable purpose |
| `inputs` | ❌ | Array of test inputs (all inputs are validated during validate)
| `multiArgs` | ❌ | `true` → each input is spread as separate arguments |
| `normalize` | ❌ | Array of normalization rules for non-deterministic values |
| `ignoreFields` | ❌ | Fields to strip before hashing |
| `fingerprintMode` | ❌ | `value` (default), `schema`, or `mixed` — see Fingerprint Modes |
| `valuePaths` | ❌ | JSONPath selectors for mixed mode (e.g., `"$.status"`) |
| `module` | ❌ | Module path (dot notation for Python, colon notation for Rust) |
| `pythonPath` | ❌ | Directory to add to `sys.path` for Python imports |
| `renderMode` | ❌ | `static` for React (uses `renderToStaticMarkup`) |
| `stripAttrs` | ❌ | HTML attributes to strip before fingerprinting (React) |
| `goPackage` | ❌ | Full Go module import path for Go stack (e.g., `"github.com/user/repo/pkg"`) |
| `goTestPkg` | ❌ | Relative path for `go test` command in Go stack (e.g., `"./pkg/name"`) |
| `goBuildTags` | ❌ | Build tags for `go test -tags` in Go stack |
| `receiver` | ❌ | Constructor function name for struct method calls (Go stack) |

---

## Fingerprint Algorithm

```
INPUT_HASH  = sha256(JSON.stringify(inputs, sortedKeys))
OUTPUT_HASH = sha256(JSON.stringify(outputs, sortedKeys))
FINGERPRINT = base36(INPUT_HASH XOR OUTPUT_HASH).slice(0, 7)
```

Properties:
- **Deterministic** — same data always produces same hash
- **Order-insensitive** — JSON keys sorted before hashing (semantic match)
- **Short** — 7 chars, human memorable (`9jadb`)
- **Opaque** — reveals nothing about internals, only that contract held

### Normalization Rules

Non-deterministic values are normalized before hashing:

| Rule | Pattern | Replacement |
|------|---------|-------------|
| `timestamps` | ISO 8601 datetime strings | `<TIMESTAMP>` |
| `uuids` | UUID v4 format | `<UUID>` |
| `epochs` | Unix epoch numbers (1B–10T) | `<EPOCH>` |
| `absPaths` | Absolute file paths | `<ROOT>/...` |
| `dynamicDates` | Embedded MMYYYY/YYYY in strings | `<MMYYYY>`/`<YYYY>` |

Use `dynamicDates` for functions that produce date-dependent output (e.g. filename generation).

Read `references/fingerprint-spec.md` for edge cases (timestamps, random IDs, etc).

---

## The Golden Rule

```
┌─────────────────────────────────────────────────┐
│  regrets/ files are written ONCE.               │
│  They are validated MANY times.                 │
│  They are NEVER edited after first green pass.  │
│                                                 │
│  If a test is red → fix the CODE.              │
│  Never fix the .regret.                         │
└─────────────────────────────────────────────────┘
```

---

## Quick Reference — AI Workflow

```
1. Read codebase → identify refactor targets
2. For chrome-dependent modules: extract pure logic into *-logic.ts files
3. Build: npm run regret:build (tsc only, preserves individual JS files)
4. Write regrets/manifest.json (clusters + watches)
5. Run: npm run regret:capture → generates .regret files
6. Run: npm run regret:drift → ALL must be green AND stable (5 runs)
7. [GATE] If any red or unstable → fix before proceeding
8. Refactor: simplify, split modules, rename, restructure
9. Run: npm run regret:validate → ALL must still be green
10. If red → fix code, re-run validate, repeat until green
11. Done. Check: npm run regret:health for cluster health score
12. Full build: npm run build (includes bundling + minification)
```

### NPM Scripts (Plug-and-Run)

Add these to the target project's `package.json`:

```json
{
  "regret:build": "npx tsc -p tsconfig.json",
  "regret:capture": "node ../../The-skill/regresion-testing/scripts/regret.js capture",
  "regret:validate": "node ../../The-skill/regresion-testing/scripts/regret.js validate",
  "regret:health": "node ../../The-skill/regresion-testing/scripts/regret.js health",
  "regret:drift": "node ../../The-skill/regresion-testing/scripts/regret.js drift",
  "regret:update": "node ../../The-skill/regresion-testing/scripts/regret.js update",
  "regret:ci": "node ../../The-skill/regresion-testing/scripts/regret.js ci",
  "regret:guard": "node ../../The-skill/regresion-testing/scripts/regret.js guard",
  "regret:test": "node ../../The-skill/regresion-testing/scripts/test.mjs",
  "regret:init": "node ../../The-skill/regresion-testing/scripts/init.js",
  "regret:rollback": "node ../../The-skill/regresion-testing/scripts/regret.js rollback",
  "regret:chain": "node ../../The-skill/regresion-testing/scripts/regret.js chain"
}
```

- `regret:build` — tsc only (no bundle/minify) — preserves individual JS files for capture
- `regret:ci` — fast validation for CI pipelines (fail-fast)
- `regret:guard` — pre-build gate: if regrets fail, block the build
- `regret:test` — run the integration test suite (209 tests)
- `regret:init` — scaffold regrets/ directory with manifest template
- `regret:rollback` — re-capture a specific cluster (undo bad update)
- `regret:chain` — chain testing (multi-step flow validation)
- The unified runner (`regret.js`) auto-detects stack from manifest and dispatches to the right handler. You can also call individual scripts directly (see Decision Tree below).
- Install globally with `npm link` (from the skill directory) to use `regret capture` directly
- Programmatic API: `import { fingerprint, createGhost } from 'regret-testing'`

### Legacy NPM Scripts (Direct Script Access)

If you prefer calling individual scripts directly (per-stack):

```json
{
  "regret:capture:js": "node ../../The-skill/regresion-testing/scripts/capture.js",
  "regret:validate:js": "node ../../The-skill/regresion-testing/scripts/validate.js",
  "regret:capture:py": "python ../../The-skill/regresion-testing/scripts/capture.py",
  "regret:validate:py": "python ../../The-skill/regresion-testing/scripts/validate.py",
  "regret:capture:react": "node ../../The-skill/regresion-testing/scripts/capture_react.mjs",
  "regret:capture:rust": "bash ../../The-skill/regresion-testing/scripts/capture_rust.sh capture",
  "regret:capture:go": "bash ../../The-skill/regresion-testing/scripts/capture_go.sh capture",
  "regret:validate:go": "bash ../../The-skill/regresion-testing/scripts/capture_go.sh validate",
  "regret:health:go": "bash ../../The-skill/regresion-testing/scripts/capture_go.sh health",
  "regret:health": "node ../../The-skill/regresion-testing/scripts/health.js",
  "regret:drift": "node ../../The-skill/regresion-testing/scripts/validate.js --runs 5",
  "regret:drift:py": "python ../../The-skill/regresion-testing/scripts/validate.py --runs 5",
  "regret:update": "node ../../The-skill/regresion-testing/scripts/validate.js --update",
  "regret:update:py": "python ../../The-skill/regresion-testing/scripts/validate.py --update"
}
```

---

## Gap 1 — Safe Update with Audit Trail

When behavior *intentionally* changes (new business rule, updated rate, etc), fingerprint must be updated. But unlike Jest's `--updateSnapshot` (no questions asked), updates here require a reason.

```bash
node scripts/validate.js --update transform-user-data \
  --reason "tax rate updated from 11% to 12% per regulation change"
```

This rewrites the `.regret` file AND appends to `regrets/audit.log`:

```
2024-03-01T09:00:00Z  UPDATE  transform-user-data
  old: 9jadb
  new: x3kp1
  reason: tax rate updated from 11% to 12% per regulation change
  by: AI refactor session
```

Rules:
- `--reason` is **required** — no reason, no update
- Audit log is **append-only** — never overwritten
- AI must supply a specific reason, not a generic one like "behavior changed"
- Each audit.log entry now includes a `chain: <hash>` field that links to the previous entry, creating a tamper-evident hash chain. The first entry uses `chain: 0000000` (genesis).

To undo a bad update: `npm run regret:rollback <cluster-id>` — this re-captures the cluster with current code and validates.

Read `references/update-protocol.md` for full update flow.

---

## Gap 2 — Drift Detection

A fingerprint that changes between runs (without code changes) reveals **hidden non-determinism** — timestamps, random IDs, race conditions, global state leaks.

```bash
node scripts/validate.js --runs 5
```

Runs each cluster 5 times, fingerprints all runs, checks for consistency:

```
✅ transform-user-data    9jadb  × 5   STABLE
❌ fetch-invoice          x7k2m / ff3z / x7k2m  DRIFT DETECTED
```

If drift is detected:
1. Check `fingerprint-spec.md` — likely timestamps or random IDs not normalized
2. Add `normalize` or `ignoreFields` to manifest
3. Re-capture and re-run with `--runs 5`
4. All runs must produce identical hash before GATE passes

**Drift is a code smell, not a test problem.** Fix the non-determinism in the source.

---

## Gap 3 — Cluster Health Score

After multiple refactor cycles, `regrets/` accumulates history. Run health check to see which clusters are stable vs fragile:

```bash
node scripts/health.js
```

Output:

```
CLUSTER HEALTH REPORT
─────────────────────────────────────────────────────
cluster                    updates  drifts  age      health
transform-user-data        0        0       47d      ██████ SOLID
login-flow                 1        0       12d      █████░ GOOD
fetch-invoice              3        2       3d       ██░░░░ FRAGILE
build-request              0        1       31d      ███░░░ UNSTABLE
─────────────────────────────────────────────────────
Recommendation:
  fetch-invoice   → high update rate, consider splitting cluster
  build-request   → drift detected, check for hidden randomness
```

Health score is derived from:
- `updates` — how many times fingerprint was intentionally changed
- `drifts` — how many times drift was detected
- `age` — days since last capture

**SOLID** clusters → don't touch, they represent stable contracts
**FRAGILE** clusters → candidates for deeper refactor or cluster split

---

## Refactor Targets (what AI should push toward)

- No single file over ~200 lines
- No module that imports everything (god object)
- Each function has one job
- Pure functions preferred (easier to fingerprint)
- Side effects isolated to boundary layers
- Naming reflects intent, not implementation

---

## Multi-Args Support

For functions that take multiple arguments, add `"multiArgs": true` to the cluster definition. Each input is then spread as separate arguments:

```json
{
  "id": "filename-from-hint",
  "entry": "filenameFromHint",
  "multiArgs": true,
  "inputs": [
    ["FPK-", "202505", "OUTPUT_TAX"],
    ["DOC-", "2025", "DOC_MANAGEMENT"]
  ]
}
```

This calls `filenameFromHint("FPK-", "202505", "OUTPUT_TAX")` etc.

## Pure Logic Extraction (Chrome Extensions)

When a module depends on `chrome.*` APIs or DOM, extract the pure business logic into a separate module:

```
BEFORE (untestable):
  subscription.ts → isSubscribed() → chrome.storage.local.get(...)

AFTER (testable):
  subscription-logic.ts → isSubscriptionActive(sub, now) → boolean  (pure!)
  subscription.ts       → isSubscribed() → chrome.storage.local.get() → isSubscriptionActive(data, Date.now())
```

The pure module can be fingerprinted directly. The original module delegates to the pure function after handling side effects. See `references/extension.md` for details.

---

## Stack Support

| Stack | Capture method | Fingerprint target | Notes |
|-------|---------------|-------------------|-------|
| JS/TS | Proxy wrapping | Value / Schema / Mixed | Best support |
| Python | Ghost decorator + `importlib` | Value / Schema / Mixed | Full support — see `references/python.md` |
| Rust | Trait wrapping + `cargo test` | Value (default) | **Experimental** — see `references/rust.md` |
| React/JSX | `renderToStaticMarkup` | Rendered HTML / Schema | See `references/react.md` |
| Browser extension | Pure logic extraction + Proxy | Value (default) | See `references/extension.md` |
| Go | Generated test files + `go test` | Value / Schema / Mixed | **Community Preview** — see `references/go.md` |
| TypeScript | Adapter module + compiled JS | Value / Schema / Mixed | See `references/typescript.md` |
| Class-based APIs | Adapter pattern or wrapper module | Value / Schema / Mixed | See `references/class-adapter.md` and `references/class-based.md` |
| Esolang interpreters | Pure logic extraction + adapter | Value (default) | See `references/esoteric-language.md` |

---

## Fingerprint Modes

| Mode | Field | Fingerprint from | Best for |
|------|-------|-----------------|----------|
| Value | `"fingerprintMode": "value"` | Full output JSON | Pure functions, formatters (default) |
| Schema | `"fingerprintMode": "schema"` | Output shape/structure only | Config builders, API response factories |
| Mixed | `"fingerprintMode": "mixed"` | Schema + selected value paths | Validators, hybrid outputs |
| Render | Stack `react` with `renderMode` | Rendered HTML string | React components |

Read `references/structural.md` for the full specification including `extractSchema()`, `valuePaths`, and mode selection decision tree.

---

## Chain Testing — Multi-Step Flow Validation

Single-cluster fingerprints test individual functions. Chain testing validates **sequences of function calls** that form a complete user flow.

### When to Use Chains

- A user flow spans multiple clusters (e.g., login → session → token)
- You need to verify that clusters compose correctly end-to-end
- Business-critical paths must stay intact during refactoring

### Chain File Format

Chains are defined in `regrets/chains.json`:

```json
{
  "chains": [
    {
      "id": "login-flow",
      "steps": [
        { "cluster": "validate-credentials", "input": {"user": "test", "pass": "123"} },
        { "cluster": "build-session", "input": {"userId": 1} },
        { "cluster": "generate-token", "input": {"sessionId": "abc"} }
      ]
    }
  ]
}
```

### Chain Commands

```bash
node scripts/regret.js chain --capture    # Capture chain fingerprints
node scripts/regret.js chain --validate   # Validate against golden
```

Chain fingerprints are stored as `.chain` files in `regrets/chains/`.

Read `references/contest.md` for the full specification.

---

## Visual Fingerprinting

For functions that produce SVG, HTML, or CSS output, use `normalizeVisualOutput()` from `ghost.js`:

```js
import { normalizeVisualOutput } from './ghost.js'

const rawSvg = '<svg width="100px" fill="#FF5500"><!-- comment --><circle r="50%"/></svg>'
const normalized = normalizeVisualOutput(rawSvg)
// Result: '<svg width="<SIZE>" fill="<COLOR>"><circle r="<PERCENT>"/></svg>'
```

Normalization rules:
- Strip HTML comments
- Collapse whitespace
- Hex/RGB colors → `<COLOR>`
- CSS measurements (px, em, rem, vh, vw) → `<SIZE>`
- Percentages → `<PERCENT>`
- Inline styles → `style="<STYLE>"`

Use with `"fingerprintMode": "render"` and `normalize: ["visualOutput"]` in the manifest.

---

## Quick Start — `regret:init`

Scaffold a new regrets/ directory in your project:

```bash
node scripts/init.js          # Create regrets/ with template manifest
node scripts/init.js --force  # Overwrite existing
```

This creates:
- `regrets/` directory
- `regrets/manifest.json` with example cluster template
- `regrets/.gitkeep`

Then edit the manifest to match your project's clusters and run `regret:capture`.

---

## Files in This Skill

```
regression-testing/
├── SKILL.md                    ← you are here
├── package.json                ← npm package (npm install / npm link)
├── index.js                    ← programmatic API entry point
├── bin/
│   └── regret.js               ← CLI binary (regret capture/validate/...)
├── scripts/
│   ├── ghost.js               ← shared Ghost Proxy utilities (createGhost, deepClone, normalizeHtml, normalizeVisualOutput)
│   ├── validate.js             ← compares fingerprints, reports green/red (JS/TS/React)
│   ├── health.js               ← cluster health score report (all stacks)
│   ├── fingerprint.js          ← hashing logic (core algorithm)
│   ├── fingerprint.py          ← hashing logic — Python shared module
│   ├── regret.js               ← unified runner — auto-detect stack, dispatch to handler
│   ├── regret.py               ← unified runner (Python version)
│   ├── capture.py              ← ghost-decorator runner (Python)
│   ├── validate.py             ← regression validator (Python)
│   ├── health.py               ← cluster health report (Python)
│   ├── capture_react.mjs       ← React component render capture
│   ├── capture_rust.sh         ← Rust cluster capture runner (experimental)
│   ├── capture_go.sh           ← Go cluster capture runner (community preview)
│   ├── contest.mjs             ← chain testing MVP (multi-step flow validation)
│   ├── init.js                 ← scaffolding — creates regrets/ directory structure
│   └── test.mjs                ← integration test suite (209 tests)
└── references/
    ├── phases.md               ← detailed per-phase AI instructions
    ├── fingerprint-spec.md     ← edge cases, non-deterministic values, collision probability
    ├── update-protocol.md      ← safe update + audit trail rules (with hash chain)
    ├── python.md               ← Python stack — full implementation
    ├── rust.md                 ← Rust stack — trait wrapping + cargo test
    ├── go.md                   ← Go stack — generated test files + go test (Community Preview)
    ├── react.md                ← React/JSX stack — render fingerprinting
    ├── structural.md           ← Output Design Fingerprint (schema/mixed modes)
    ├── extension.md            ← Browser extension variant
    ├── class-based.md           ← Class-based library wrapper pattern
    ├── esoteric-language.md     ← Esoteric language interpreter testing pattern
    ├── contest.md              ← Chain testing — multi-step flow validation
    ├── TROUBLESHOOTING.md      ← Common problems and solutions
    ├── WALKTHROUGH.md          ← Step-by-step refactoring walkthrough
    ├── braille-encode.md       ← Case study: qntm/braille-encode (binary↔Braille)
    ├── base1.md                ← Case study: qntm/base1 (unary encoding, BigInt)
    ├── stateful-encoding.md    ← Stateful encoding libraries (Baudot, Morse, shift states)
    ├── case-study-ogham.md     ← Case study: evanshortiss/ogham (CJS wrapper pattern)
    ├── esoteric-language.md    ← Esoteric language interpreter testing pattern
    └── single-file-python.md   ← Single-file Python module integration pattern
```

---

## AI Reading Order

**If you are an AI reading this for the first time, follow this order:**

1. **This file (SKILL.md)** — You are here. Read the Mental Model, Three Phases, and Golden Rule.
2. **`references/phases.md`** — Detailed step-by-step instructions for each phase.
3. **`references/fingerprint-spec.md`** — Edge cases, non-deterministic values, multi-call clusters.
4. **`scripts/fingerprint.js`** — The core algorithm. Understanding this is essential for debugging.
5. **Stack-specific reference** — Pick the one you need:
   - JS/TS → built-in (capture.js/validate.js)
   - Python → `references/python.md`
   - Rust → `references/rust.md`
   - React → `references/react.md`
   - Extension → `references/extension.md`
   - Go → `references/go.md`
   - Class-based → `references/class-based.md`

### Decision Tree: Which Script to Use?

```
What stack is the target project?
├── JS/TS
│   ├── Capture → node scripts/capture.js
│   ├── Validate → node scripts/validate.js
│   └── Health → node scripts/health.js
├── Python
│   ├── Capture → python scripts/capture.py
│   ├── Validate → python scripts/validate.py
│   └── Health → python scripts/health.py
├── React/JSX
│   ├── Capture → node scripts/capture_react.mjs
│   ├── Validate → node scripts/validate.js (with React re-render)
│   └── Health → node scripts/health.js
├── Rust
│   ├── Capture → bash scripts/capture_rust.sh capture
│   ├── Validate → bash scripts/capture_rust.sh validate
│   └── Health → bash scripts/capture_rust.sh health
├── Go
│   ├── Capture → bash scripts/capture_go.sh capture
│   ├── Validate → bash scripts/capture_go.sh validate
│   └── Health → bash scripts/capture_go.sh health
└── Browser Extension
    └── Extract pure logic first → then use JS/TS scripts
└── Esolang Interpreter
    └── Extract pure logic + create adapter → then use Python/JS scripts
```

### Manifest Cluster: Complete Example with All Fields

```json
{
  "clusters": [
    {
      "id": "transform-user-data",
      "entry": "processUser",
      "watches": ["transformUser", "normalizeCode", "applyRules"],
      "file": "src/user/processor.js",
      "stack": "js",
      "fingerprintLevel": "entry",
      "fingerprintMode": "value",
      "description": "Transform user data with normalization",
      "inputs": [
        {"id": 1, "name": "Ali"},
        null,
        {"id": 0, "name": ""}
      ],
      "multiArgs": false,
      "normalize": ["timestamps", "dynamicDates"],
      "ignoreFields": ["updatedAt"],
      "valuePaths": [],
      "module": "",
      "pythonPath": "",
      "renderMode": "",
      "stripAttrs": []
    },
    {
      "id": "build-config",
      "entry": "buildConfig",
      "watches": ["buildConfig"],
      "file": "src/config/builder.js",
      "stack": "js",
      "fingerprintMode": "schema",
      "description": "Config builder — structure matters, values may vary",
      "inputs": [{"source": "SPT", "options": {"retries": 3}}]
    },
    {
      "id": "process-invoice",
      "entry": "process_invoice",
      "watches": ["normalize_amount", "apply_tax"],
      "module": "invoice.processor",
      "pythonPath": "src/",
      "stack": "python",
      "description": "Transform raw invoice data into processed output",
      "inputs": [
        {"raw_amount": 1000000, "tax_rate": 0.11}
      ]
    },
    {
      "id": "invoice-card-render",
      "entry": "InvoiceCard",
      "watches": ["InvoiceCard"],
      "file": "src/components/InvoiceCard.tsx",
      "stack": "react",
      "renderMode": "static",
      "stripAttrs": ["data-testid", "aria-label"],
      "inputs": [{"amount": 1000000, "status": "PAID"}]
    },
    {
      "id": "to-valid-bf",
      "entry": "ToValidBF",
      "watches": ["ToValidBF"],
      "file": "lang/readcode/read.go",
      "stack": "go",
      "goPackage": "github.com/example/bfgo/lang/readcode",
      "goTestPkg": "./lang/readcode",
      "description": "Strip non-BF characters from source code string",
      "inputs": ["+++-<>.,[]comment", "hello world"]
    }
  ]
}
```

---

## Testing Pitfalls — Common Mistakes

These are the most common mistakes AI makes when writing regression tests. Read carefully.

### Pitfall 1 — Test too loose (false positive)

```typescript
// WRONG: always passes even if function is broken
it("should return a filename", () => {
  const result = generateDynamicFilename(exportData);
  expect(typeof result).toBe("string"); // any string passes
});

// CORRECT: concrete and will fail if format changes
it("should return filename with correct prefix and date format", () => {
  const result = generateDynamicFilename(exportData);
  expect(result).toMatch(/^FK_\d{2}-\d{4}_.+\.csv$/);
  expect(result).toContain("PT_MAJU");
});
```

### Pitfall 2 — Over-aggressive mocking (test doesn't reflect reality)

```typescript
// WRONG: mock replaces the function being tested
vi.mock("../exporter.js", () => ({
  generateDynamicFilename: () => "FK_01-2025_test.csv",
}));

// CORRECT: only mock external dependencies
vi.mock("../google-auth.js", () => ({
  isAuthenticated: vi.fn().mockResolvedValue(true),
  authFetch: vi.fn(),
}));
// the function being tested runs for real
```

### Pitfall 3 — Snapshot test without semantic validation

```typescript
// DANGEROUS: snapshot could be wrong and still pass
expect(result).toMatchSnapshot();
```

Use snapshots **only** for large output and **always** combine with semantic assertions.

### Pitfall 4 — Tests depending on execution order

```typescript
// WRONG: test B depends on state from test A
it("test A", () => { saveSubscription("tok", 9999); });
it("test B", () => { expect(getSubscriptionData()).not.toBeNull(); });
```

Every test must be **independent** — set up its own state in `beforeEach`.

### Pitfall 5 — Missing edge case tests

Refactoring often breaks these cases:
- Empty / null / undefined input
- Strings with special characters (`/`, `\`, `<`, `>`, `"`)
- Negative numbers or zero
- Empty arrays
- Non-standard date formats

**Always test these edge cases** for every function.

### Pitfall 6 — Not testing error paths

Refactoring often changes which errors are thrown:

```js
// BEFORE: throws TypeError
function parse(input) { return JSON.parse(input) }

// AFTER: throws SyntaxError with custom message
function parse(input) {
  try { return JSON.parse(input) }
  catch (e) { throw new SyntaxError(`Invalid input: ${e.message}`) }
}
```

The ghost proxy now records errors, so error paths are captured in the recorder.
Always include error-case inputs in your cluster's `inputs` array.

---

## Checklist Before Refactor

Follow this **in order**, do not skip any step:

```
[ ] 1. npm run regret:build (tsc only — preserves individual JS files)
[ ] 2. npm run regret:capture (capture all cluster fingerprints)
[ ] 3. npm run regret:drift (5 runs — ensure ALL STABLE)
[ ] 4. If DRIFT detected → add normalize rules to manifest, re-capture
[ ] 5. npm run regret:health — ensure all SOLID
[ ] 6. Perform the refactor
[ ] 7. npm run regret:build (rebuild tsc after refactor)
[ ] 8. npm run regret:validate — all must still be GREEN
[ ] 9. If any RED:
      [ ] Read fingerprint diff — see which input/output changed
      [ ] Do NOT edit .regret files — fix the CODE
      [ ] If behavior intentionally changed → npm run regret:update -- <cluster> --reason "..."
[ ] 10. All green → npm run build → then push
```

---

## CI/CD Integration

A GitHub Actions workflow template is provided at `.github/workflows/regret-ci.yml`:

```bash
# Copy to your project
cp .github/workflows/regret-ci.yml .github/workflows/regret-ci.yml
```

The workflow runs:
- On every push/PR to main: `regret:test` → `regret:build` → `regret:ci` (fail-fast)
- On push to main only: `regret:guard` (blocks deployment if regrets fail)

For other CI systems, the same commands apply:

```bash
npm run regret:test     # 209 integration tests
npm run regret:build    # TypeScript compilation
npm run regret:ci       # Fail-fast validation
```

---

## Project Guide: `fought/extension_source`

This section contains project-specific information for the `fought/extension_source` Chrome Extension project.

### Regret Clusters (21 clusters — all SOLID)

| Module | Function | Cluster | Fingerprint |
|---|---|---|---|
| `shared/date-utils.ts` | `formatDate` | format-date | yju9g9g |
| `shared/date-utils.ts` | `formatDateTime` | format-date-time | 8oa45ft |
| `shared/date-utils.ts` | `extractMonthYear` | extract-month-year | 5ljcbov |
| `shared/filename-utils.ts` | `sanitizeFilename` | sanitize-filename | 3zk4yh3 |
| `shared/filename-utils.ts` | `sanitizeSheetName` | sanitize-sheet-name | 6b2pufc |
| `shared/filename-utils.ts` | `sanitizeToAlphanumeric` | sanitize-alphanumeric | 2mp7ls1 |
| `xhr-mode/exporter.ts` | `escapeCSV` | escape-csv | 4mcbm7s |
| `xhr-mode/exporter.ts` | `formatPeriod` | format-period | 12d5tvu |
| `xhr-mode/exporter.ts` | `filenameFromHint` | filename-from-hint | 32f1unk |
| `xhr-mode/exporter.ts` | `filenameFromData` | filename-from-data | 3bsw7j0 |
| `xhr-mode/exporter.ts` | `filenameFallback` | filename-fallback | 1d34f4w |
| `xhr-mode/exporter.ts` | `generateDynamicFilename` | generate-dynamic-filename | 4p6kjm4 |
| `shared/utils.ts` | `escapeHtml` | escape-html | 9ejfvis |
| `errors.ts` | `fromHttpResponse` | from-http-response | d3k1flx |
| `errors.ts` | `fromUnknown` | from-unknown-error | 2nd7ylr |
| `subscription-logic.ts` | `isSubscriptionActive` | is-subscription-active | wqs3ubz |
| `subscription-logic.ts` | `checkRetryable` | fought-error-retryable | 8kksgs8 |
| `subscription-logic.ts` | `checkNeedsReauth` | fought-error-needs-reauth | 4q3g0n4 |
| `rate-limiter-logic.ts` | `checkSlidingWindow` | sliding-window-check | 1dn8mf4 |
| `rate-limiter-logic.ts` | `remainingInWindow` | sliding-window-remaining | 5vetqyh |
| `payment-poller-logic.ts` | `calculateCountdown` | calculate-countdown | 4upje74 |

### Extracted Pure Logic Modules

```
fought/extension_source/ts/
├── subscription-logic.ts    ← isSubscriptionActive, isCompanyUser, hasFullAccess, checkRetryable, checkNeedsReauth
├── rate-limiter-logic.ts    ← checkSlidingWindow, remainingInWindow
└── payment-poller-logic.ts  ← calculateCountdown, parseExpiryString
```

### Modules NOT Yet Clustered (difficult — need mocking/CDP)

| Module | Reason |
|---|---|
| `sidepanel.ts` (2320 lines) | God object — needs split before clustering |
| `background/*.ts` | Heavily depends on `chrome.*` APIs |
| `content/*.ts` | Depends on specific Coretax DOM |
| `google-auth.ts` | Network-dependent (OAuth flow) |

### Vitest Unit Tests (existing — secondary to regret testing)

```
fought/extension_source/ts/
├── auto-renamer/__tests__/
│   ├── namer.unit.test.ts          ← generateWithholdingFilename, generateEInvoiceFilename
│   └── settings.unit.test.ts       ← settings read/write logic
├── xhr-mode/__tests__/
│   ├── bot-mode.unit.test.ts
│   ├── capture-mode.unit.test.ts
│   ├── csv.property.test.ts
│   ├── downloader.invalid.property.test.ts
│   ├── downloader.property.test.ts
│   ├── downloader.unit.test.ts     ← base64ToBlob
│   ├── exporter.property.test.ts   ← generateDynamicFilename property tests
│   ├── exporter.unit.test.ts       ← escapeCSV unit tests
│   ├── page-context.unit.test.ts
│   ├── postmessage.origin.test.ts
│   └── types.unit.test.ts
```

### Important Notes for AI Agent

1. **Regression test filenames**: Use suffix `.regression.test.ts` to distinguish from existing tests.
2. **Never delete existing tests** — only add, never reduce coverage.
3. **Import with `.js` extension** (not `.ts`) — required by ES modules in this project.
4. **Mock only what's needed** — pure functions need no mocking at all.
5. **Every test must run independently** — use `beforeEach` to reset state.
6. **Minimum tests per function**: 1 happy path + 1 edge case (null/empty/undefined) + 1 format/boundary case.
7. **Don't write tests that always pass** — if unsure, intentionally break the implementation and check if the test fails.

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

### ⚠️ Private Function Limitation

The ghost proxy **cannot wrap functions that start with `_`** (underscore). It only copies public attributes from the module. This means:

- If `entry` starts with `_`, the ghost proxy falls through to the unwrapped function
- With `fingerprintLevel: "full"`, the watch recorder will be empty, producing an **empty-sequence fingerprint** (a hash of `[]`)
- This fingerprint will NOT match the entry-level fingerprint computed during validate

**Workaround:** Always use `fingerprintLevel: "entry"` for clusters whose entry function starts with `_`.

Capture will now warn: `"Entry function '_' starts with underscore. Ghost proxy cannot wrap private functions."`

### Callee Wrapping (Phase 2 — opt-in)

The base Ghost Proxy only intercepts the entry function — it captures the entry's `(input, output)` but does NOT see what happens inside. When an entry function `c(x)` calls `a(x)` and `b(x)`, the parent cluster captures `c`'s output, but `a` and `b`'s individual `(input, output)` contracts are invisible. A refactor that changes `a`'s behavior — but accidentally preserves `c`'s output through compensating changes in `b` — would pass validate silently.

Phase 2 adds **callee wrapping** to make those inner contracts explicit. When a manifest cluster declares `"callees": ["a", "b"]`, capture.js installs a Proxy on each named callee (in addition to the entry ghost) so every call records its args and result. After the entry finishes, each callee that was actually called gets its own `.regret` file at `regrets/<parentClusterId>.calls.<calleeName>.regret`, forming a separate behavioral contract.

```
Before Phase 2:                  After Phase 2 (with "callees": ["a","b"]):
┌──────────────────────┐         ┌──────────────────────┐
│ cluster: c           │         │ cluster: c           │ ← parent contract (unchanged)
│ INPUT  x             │         │ INPUT  x             │
│ OUTPUT <c of x>      │         │ OUTPUT <c of x>      │
└──────────────────────┘         └──────────────────────┘
                                  ┌──────────────────────┐
                                  │ cluster: c.calls.a   │ ← new: callee contract
                                  │ INPUT  x             │
                                  │ OUTPUT <a of x>      │
                                  └──────────────────────┘
                                  ┌──────────────────────┐
                                  │ cluster: c.calls.b   │ ← new: callee contract
                                  │ INPUT  x             │
                                  │ OUTPUT <b of x>      │
                                  └──────────────────────┘
```

**Constraints (by design):**

1. **Opt-in.** When `callees` is absent or empty, capture.js behaves identically to the pre-Phase-2 Ghost Proxy. No new files, no warnings, no overhead.
2. **Depth 1.** Only the named callees are wrapped. If callee `a` itself calls `b`, that nested call is recorded as part of `a`'s execution (it does NOT spawn a `c.calls.a.calls.b` cluster).
3. **Accessible callees only.** The callee must be a top-level function-bearing declaration in one of the supported patterns (see "Supported Callee Patterns" below). Closure-private functions, class methods, and destructured exports are NOT interceptable — `wrapCallees` logs an actionable warning and skips them. The parent cluster is still captured normally. **ESM `export function`, `export async function`, `export function*`, `export const` arrow/function expressions, and CJS bare-name calls are now interceptable** via automatic in-memory source transformation (see "Supported Callee Patterns" below) — when transformation is not possible (e.g. shadowing, parse errors), `wrapCallees` falls back to a warning and skips.
4. **Backward compatible.** The `.regret` file format is unchanged. Callee `.regret` files use the same format with two extra metadata lines (`parent:` and `callee:`). `validate.js` re-validates each `.calls.<callee>` contract explicitly by re-running the callee function with its saved args and comparing the live fingerprint to the golden. This catches callee regressions that would otherwise be invisible — a callee whose behavior changed but whose parent's final output happens to be preserved by a compensating change in a sibling. Use `--skip-callees` to opt out of this phase (also opts out of the missing-callee check below).

   **Callee re-validation phase (#258, #293).** During `regret validate` (default mode), after the main per-cluster loop completes, validate.js runs a second pass over every `regrets/<parent>.calls.<callee>.regret` file. For each callee contract it: (a) imports the parent cluster's live source file, (b) looks up the callee function by name, (c) re-invokes it with the args saved in the callee `.regret`, (d) computes a fresh fingerprint, and (e) compares it against the golden hash. A failing callee contract FAILs the entire validate run — even when the parent cluster's own fingerprint still matches. Output looks like:

   ```
   🔍 Re-validating 2 callee contract(s)...

     ✅ main.calls.add                      1shop5c  PASS (callee)
     ❌ main.calls.mul                      4p17f86 → 5gkdnbw  FAIL (callee)
   ```

   This phase is gated by `!skipCallees && !updateMode && !driftMode`:
   - `--skip-callees` opts out entirely (also disables missing-callee detection).
   - `regret update <parent>` runs the callee *update* path instead (see #284 below), not the re-validation phase.
   - `--drift-mode` skips this phase because drift detection runs each parent multiple times; callee re-validation runs once and isn't meaningful in that mode.

   `regret validate --cluster <parent>` includes the parent's `<parent>.calls.*.regret` files in the regretFiles filter, so the re-validation phase runs for them — single-cluster debugging does not produce false GREENs.

   **Update propagation (#284).** `regret update <parent>` also re-captures and updates all `<parent>.calls.*.regret` files for that parent, so the next `regret validate` does not report stale callee failures after a confirmed behavior change. Direct `regret update <parent>.calls.<callee>` is rejected — callee contracts are derived from the parent's inputs, so update the parent (or re-capture) instead.

   **Missing callee detection (#288).** If a parent declares `callees: [...]` but a `<parent>.calls.<callee>.regret` file is missing (e.g. capture was never run, callee wrapping failed silently, or the file was deleted manually), `regret validate` FAILs the parent with a clear message listing the missing contracts and pointing to `regret capture --cluster <parent>` as the fix. `--skip-callees` opts out of this check too.

### Supported Callee Patterns

The source transformer (`scripts/esm-callee-transform.js` for ESM, `scripts/cjs-callee-transform.js` for CJS) handles these top-level callee declaration shapes. The original source is NEVER modified — the transformed source lives only in a temp file (same directory, deleted after capture).

**ESM patterns (in `.mjs`, or `.js`/`.ts`/`.tsx` with ESM syntax):**

```js
// Pattern 1: bare function declaration + separate export (was already supported)
function add(a, b) { return a + b }
function main(x) { return add(x, 1) }
export { main, add }

// Pattern 2: `export function foo()` — the most common ESM idiom
//            (was silently skipped — issue #262 — now supported)
export function add(a, b) { return a + b }
export function main(x) { return add(x, 1) }

// Pattern 3: `export async function foo()` and `export function* foo()`
//            (now supported)
export async function fetchData(url) { return fetch(url) }
export function* gen() { yield 1 }

// Pattern 4: `export const foo = () => {}` and `export const foo = function() {}`
//            (was claimed to work but actually threw "Cannot assign to read
//            only property" — issue #276 — now supported)
export const add = (a, b) => a + b
export const main = (x) => add(x, 1)
```

**CJS patterns (in `.cjs`, or `.js` with CJS syntax):**

```js
// Pattern 5: bare function declarations + module.exports
//            (was silently invisible — issue #263 — now supported)
function add(a, b) { return a + b }
function main(x) { return add(x, 1) }
module.exports = { main, add }

// Pattern 6: const arrow / function expressions + module.exports
//            (now supported)
const add = (a, b) => a + b
const main = (x) => add(x, 1)
module.exports = { main, add }
```

**Already supported without source transformation:**

```js
// CJS using `module.exports.foo(...)` calls — wrapCallees intercepts
// directly via the live holder mechanism, no transform needed.
function add(a, b) { return a + b }
function main(x) { return module.exports.add(x, 1) }
module.exports = { main, add }
```

**Manifest example:**

```json
{
  "clusters": [
    {
      "id": "main",
      "entry": "main",
      "watches": ["main"],
      "file": "src/api.cjs",
      "stack": "js",
      "callees": ["add", "mul"],
      "inputs": [5, 10, 100]
    }
  ]
}
```

**Subject file pattern (CJS — what works):**

```js
// src/api.cjs — uses module.exports.foo(...) lookup idiom
module.exports.add = function (a, b) { return a + b }
module.exports.mul = function (a, b) { return a * b }
module.exports.main = function (x) {
  return module.exports.add(x, 1) + module.exports.mul(x, 2)
}
```

**Subject file pattern (ESM `export function` — NOW INTERCEPTABLE):**

```js
// src/api.mjs — the most common ESM idiom
// When capture.js detects this pattern AND the cluster declares `callees`,
// it transparently rewrites the source in-memory so internal `add(x, 1)`
// calls route through a mutable `__regretsHolder` object that wrapCallees
// can reassign. The original file is NEVER modified — the transformed
// source lives only in a temp file (same directory, deleted after capture).
export function add(a, b) { return a + b }
export function main(x) { return add(x, 1) }
```

**Subject file pattern (ESM `export const foo = () => {}` — NOW INTERCEPTABLE):**

```js
// src/api.mjs — arrow function exports
// The transformer strips the inline `export` keyword from callee
// declarations (turning `export const add = ...` into `const add = ...`)
// and re-exports them via a trailing `export { ..., __regretsHolder }`
// list. This works around the ESM "Cannot assign to read only property"
// error that would otherwise fire when wrapCallees reassigns the holder
// entry. The user-facing API is unchanged — the module still exports
// `add` — but the binding is resolved via the trailing export list.
export const add = (a, b) => a + b
export const main = (x) => add(x, 1)
```

**Subject file pattern (CJS bare-name calls — NOW INTERCEPTABLE):**

```js
// src/api.cjs — the classic CJS pattern that used to silently fail
// The transformer rewrites bare-name internal calls (`add(x, 1)`) to
// route through `__regretsHolder.add(x, 1)`. The existing
// `module.exports.add(x, 1)` calls (if any) are left unchanged —
// they already work without transformation.
function add(a, b) { return a + b }
function main(x) { return add(x, 1) }
module.exports = { main, add }
```

**When source transform aborts (Approach B fallback):**

The transformer is conservative — it aborts (and `wrapCallees` falls back to
an actionable warning) when any of these safety concerns are detected:

- A callee name is **shadowed** anywhere in the file (parameter name,
  destructuring pattern, or inner `let`/`const` declaration). Rewriting
  calls in that case could change semantics.
- The callee is not a transformable top-level function-bearing declaration
  (e.g. it's a class method, a nested function, or a destructured export).
- The file cannot be parsed by tree-sitter, or the language is unsupported.
- For CJS: there are no bare-name internal calls to rewrite (the user only
  uses `module.exports.foo(...)` calls — those already work without
  transformation, so the transform is a no-op and we skip it).

When the transformer aborts, `wrapCallees` emits a warning like:

```
⚠️  Callee "add" found but module is frozen (no mutable holder available) — could not install proxy
    This means the source transform was aborted (shadowing, parse error, unsupported
    pattern) AND the module's namespace is frozen (ESM) or its internal calls
    resolve to local bindings rather than a holder wrapCallees can intercept.
    Options to enable callee wrapping:
      1. Refactor to a supported pattern (see list above) and ensure the callee
         name is not shadowed anywhere in the file.
      2. For CJS: call the callee via `module.exports.add(...)` instead
         of the bare name — this works without source transformation.
    The callee is skipped; the parent cluster is still captured.
```

For ESM patterns that the transformer doesn't handle, you can also use a
mutable namespace object explicitly:

```js
// src/api.mjs — namespace pattern that IS interceptable without transform
export const fns = {
  add: (a, b) => a + b,
  main: (x) => fns.add(x, 1),
}
// manifest: entry="fns.main", callees=["add"] — but note: wrapCallees currently
// only resolves top-level keys. For dotted-path callees, expose them at the
// top level too (e.g., `export const add = fns.add.bind(fns)` after defining fns).
```

The `wrapCallees` function lives in `scripts/ghost.js` alongside `createGhost`. It returns an idempotent cleanup function that restores the originals — capture.js calls it from a `finally` block so the module is left untouched even when capture throws.

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

#### Stack-specific `file` vs `module` field (issues #274, #279)

**JS/TS clusters** use `file` (a filesystem path relative to the project
root) because `capture.js` resolves it via `pathToFileURL(resolve(cwd, file))`.

**Python clusters** use `module` (a dotted import path) plus an optional
`pythonPath` (the directory to add to `sys.path`). `capture.py` calls
`importlib.import_module(module)`, so a file path like
`src/invoice/processor.py` MUST be declared as:

```json
{
  "id": "process-invoice",
  "entry": "process_invoice",
  "watches": ["normalize_amount", "apply_tax"],
  "module": "invoice.processor",
  "pythonPath": "src",
  "stack": "python",
  "multiArgs": true,
  "inputs": [[1000000, 0.11]]
}
```

A Python file at the project root needs no `pythonPath` — `capture.py`
automatically inserts the cwd into `sys.path`:

```json
{
  "id": "transforms-double",
  "entry": "double",
  "module": "transforms",
  "stack": "python",
  "inputs": [21]
}
```

`regret install --scope <py-file>` produces these fields automatically.
For hand-edited manifests, the rule of thumb is: take the file's path
relative to the project root, drop the `.py` extension, drop any
`__init__` segment, and split the remaining path into `pythonPath`
(the first directory component) + `module` (the rest as dotted notation).

**Backward compatibility.** `capture.py` accepts a legacy `file: "src/foo.py"`
field for Python clusters (auto-converted to the equivalent `module` +
`pythonPath`) so manifests written before issue #279 was fixed continue
to work. New manifests should prefer the explicit `module` form.

AI writes this manifest during PHASE 1. It lives in `regrets/` alongside `.regret` files.

### Cluster Fields

| Field | Required | Description |
|-------|----------|-------------|
| `id` | ✅ | Unique cluster identifier (kebab-case) |
| `version` | ❌ | `.regret` file format version (currently `1`) |
| `entry` | ✅ | Function name to call. For JS/TS: exported from `file`. For Python: defined in `module`. |
| `watches` | ✅ | Array of function names to monitor via Ghost Proxy |
| `file` | JS/TS only | Path to compiled JS module (relative to project root). Required for `js`/`ts`/`react` stacks. **Do NOT use for Python** — use `module` instead. |
| `module` | Python only | Dotted module path (e.g. `"invoice.processor"`) for `importlib.import_module`. Required for `python` stack. May also be used by `rust` (colon notation). |
| `stack` | ✅ | Runtime stack: `js`, `ts`, `python`, `rust`, `react`, or `extension` |
| `fingerprintLevel` | ❌ | `entry` (default) or `full` (entire call sequence) |
| `description` | ❌ | Human-readable purpose |
| `inputs` | ❌ | Array of test inputs (all inputs are validated during validate)
| `multiArgs` | ❌ | `true` → each input is spread as separate arguments |
| `kwargs` | ❌ | `true` → input dict is unpacked as keyword arguments (Python) or passed as single object (JS) |
| `normalize` | ❌ | Array of normalization rules for non-deterministic values |
| `ignoreFields` | ❌ | Fields to strip before hashing |
| `fingerprintMode` | ❌ | `value` (default), `schema`, or `mixed` — see Fingerprint Modes |
| `valuePaths` | ❌ | JSONPath selectors for mixed mode (e.g., `"$.status"`) |
| `pythonPath` | Python only | Directory (relative to project root) to add to `sys.path` so `module` can be imported. Required when the module lives in a subdirectory; omit for root-level modules (cwd is on `sys.path` automatically). |
| `renderMode` | ❌ | `static` for React (uses `renderToStaticMarkup`) |
| `stripAttrs` | ❌ | HTML attributes to strip before fingerprinting (React) |
| `goPackage` | ❌ | Full Go module import path for Go stack (e.g., `"github.com/user/repo/pkg"`) |
| `goTestPkg` | ❌ | Relative path for `go test` command in Go stack (e.g., `"./pkg/name"`) |
| `goBuildTags` | ❌ | Build tags for `go test -tags` in Go stack |
| `receiver` | ❌ | Constructor function name for struct method calls (Go stack) |
| `outputTransform` | ❌ | Transform complex output to fingerprintable form: `str`, `json`, `keys`, `toString`, `toJSON`, `pojo`, `repr`, `len`, `type`, `array_summary` (numpy array shape/stats summary — essential for DSP/scientific computing), `dict`, `dataclass_dict`, or `"module.fn"` for custom (Python & JS) |
| `materializeOutput` | ❌ | `true` → auto-consume generators/iterators into lists before fingerprinting |
| `maxYields` | ❌ | Integer — max items to take from an infinite generator. Only works with `materializeOutput: true`. Appends a `{"__truncated__": true, "maxYields": N}` sentinel if more items exist. Critical for generators that yield forever (e.g., `rrule` with no `count`/`until`). |
| `freezeTime` | ❌ | ISO 8601 datetime string (e.g., `"2024-01-15T10:30:00"`) — freezes `datetime.now()`, `datetime.utcnow()`, `date.today()`, and `time.localtime()` during capture/validate. Essential for functions that default to current time. |
| `trackMutation` | ❌ | `true` → snapshot input state before/after call, detect mutations |
| `resetState` | ❌ | Function name to call before each capture/validate run to reset module-level mutable state (e.g., counters, accumulators). The function must be exported from the same `file`. |
| `deepCloneInput` | ❌ | `true` (default) → deep-clone inputs before each call to prevent mutation. Set `false` only when you explicitly want mutated state to carry across calls. |
| `seed` | ❌ | Integer seed for deterministic `Math.random()` — replaces Math.random with mulberry32 PRNG for the duration of the function call, then restores. Eliminates drift in functions using random numbers. |
| `autoIncrement` | ❌ | Add to `normalize` array to replace auto-incrementing ID patterns: `"b1"` → `"b<ID>"`, small integers (1-9999) → `"<ID>"`. Use when `resetState` alone isn't sufficient. |
| `trackState` | ❌ | Array of attribute names to track on the object before/after the call (e.g., `["_len", "_cache_complete"]`). Detects internal state mutations that `trackMutation` can't see. See `references/datetime-stateful-patterns.md`. |
| `callees` | ❌ | **Phase 2 (opt-in)** — Array of function names to wrap inside the entry function so each callee's `(args, result)` is captured as its own behavioral contract under cluster id `<parentClusterId>.calls.<calleeName>`. Depth 1 only (no recursive wrapping). Accessible callees only — closure-private, class-method, and destructured-export callees are skipped with an actionable warning. Supported declaration patterns (capture.js transparently rewrites source in-memory to route internal calls through a mutable `__regretsHolder`; the original file is never modified): ESM `function foo(){}` / `export function foo(){}` / `export async function foo(){}` / `export function* foo(){}` / `export const foo = () => {}` / `export const foo = function(){}`; CJS `function foo(){}` / `const foo = () => {}` / `const foo = function(){}` (paired with `module.exports = { foo }`). When the source transform aborts (shadowing, parse errors, unsupported patterns), `wrapCallees` falls back to an actionable warning and skips. On `regret validate`, each `.calls.<callee>.regret` is **re-validated explicitly** by re-running the callee with its saved args and comparing the live fingerprint to the golden (see "Callee re-validation phase" above); use `--skip-callees` to opt out. Backward compatible: when omitted or empty, behavior is identical to the pre-Phase-2 Ghost Proxy. |

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
| `normalizeNow` | Current-time-derived output (function calls `new Date()` internally) | `<NOW_MMYYYY>`/`<NOW_YYYY>` |
| `floatTolerance` | Floats rounded to 2dp before hashing | `round(n * 100) / 100` |
| `floatTolerance:N` | Floats rounded to N decimal places | `round(n * 10^N) / 10^N` |
| `floatPrecision` | Whole-value floats → integers, decimal floats → 2dp, string floats stripped | `1500000.0` → `1500000` |
| `autoIncrement` | String IDs with numeric suffix → placeholder, small integers (1-9999) → placeholder | `"b1"` → `"b<ID>"`, `42` → `"<ID>"` |
| `currentYearBound` | Integers equal to current year or current year + 1 → placeholders | `2026` → `<CURRENT_YEAR>`, `2027` → `<CURRENT_YEAR+1>` |
| `tokenOffsets` | Integer values in offset dict keys (start, end, span_start, etc.) → `<OFFSET>` | `{"start": 42}` → `{"start": "<OFFSET>"}` |

Use `dynamicDates` for functions that produce date-dependent output (e.g. filename generation).
Use `normalizeNow` when the function's output IS derived from the current time (e.g., `filenameFallback()` that calls `new Date()` to produce `"FPK-062026"`). Unlike `dynamicDates` which normalizes embedded dates in data, `normalizeNow` signals that the entire output meaning is "the current time expressed as a filename". The distinct placeholders (`<NOW_MMYYYY>` vs `<MMYYYY>`) help audit reviewers distinguish "data contains a date" from "output IS a date".
Use `floatTolerance` for financial/scientific computing where tiny floating-point differences (e.g., `123456.0` vs `123456.00000001`) should not trigger false negatives. `floatTolerance:0` rounds to integers — ideal for IDR amounts.
Use `floatPrecision` for OCR/parsing pipelines where the same value may appear as `1500000` or `1500000.0` depending on the parsing path — common in financial OCR where integer amounts are sometimes stored as floats. Both rules can coexist: `floatTolerance` handles representation differences, `floatPrecision` handles type equivalence and string normalization.
Use `currentYearBound` for code that uses `date.today().year` as a validation boundary (e.g., citation year validators that reject years beyond "this year + 1"). Without this rule, fingerprints would silently change every January — not because behavior regressed, but because the calendar advanced.
Use `tokenOffsets` for NLP/citation parsing libraries where output includes character offset positions (start, end, span_start, etc.). These offsets shift with any change to input text length, but the behavioral contract is about *what* text is identified, not *where* it is at byte offset 42 vs 44.

### dataclass_dict Output Transform

When fingerprinting Python libraries with deep dataclass hierarchies (e.g., citation parsers, NLP libraries, Pydantic models), use `"outputTransform": "dataclass_dict"` to recursively convert dataclass instances into JSON-serializable dicts. This handles:

- Frozen dataclasses (common in immutable value objects)
- Nested dataclasses (e.g., `CitationBase.Metadata` inside `FullCaseCitation`)
- `UserString` subclasses (e.g., Token objects that inherit from `str` but also have dataclass fields like `start`, `end`, `groups`)
- `datetime`/`date` objects → deterministic ISO format strings
- Sequences of dataclass instances → lists of dicts
- Class identity is preserved via `__class__` key (a `FullCaseCitation` and `ShortCaseCitation` with the same fields will produce different fingerprints, which is correct)

```json
{
  "id": "find-citations",
  "entry": "get_citations",
  "watches": ["get_citations"],
  "module": "regret_adapters",
  "stack": "python",
  "outputTransform": "dataclass_dict",
  "normalize": ["currentYearBound", "tokenOffsets"],
  "ignoreFields": ["document"],
  "inputs": ["1 U.S. 1"]
}
```

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
  "regret:chain": "node ../../The-skill/regresion-testing/scripts/regret.js chain",
  "regret:diff": "node ../../The-skill/regresion-testing/scripts/regret.js diff",
  "regret:coverage": "node ../../The-skill/regresion-testing/scripts/regret.js coverage",
  "regret:scan": "node ../../The-skill/regresion-testing/scripts/regret.js scan"
}
```

- `regret:build` — tsc only (no bundle/minify) — preserves individual JS files for capture
- `regret:ci` — fast validation for CI pipelines (fail-fast)
- `regret:guard` — pre-deployment gate: fail-fast validation with explicit pass/fail verdict — use before merging or deploying (see `references/guard-and-drift.md`)
- `regret:drift` — non-determinism detection: validates each cluster 5 times and flags inconsistent fingerprints — use after capture to confirm fingerprints are stable (see `references/guard-and-drift.md`)
- `regret:test` — run the integration test suite (209 tests)
- `regret:init` — scaffold regrets/ directory with manifest template
- `regret:rollback` — re-capture a specific cluster (undo bad update)
- `regret:chain` — chain testing (multi-step flow validation)
- `regret:diff` — show output diff (what changed when a cluster goes RED)
- `regret:coverage` — branch coverage analysis (detects under-covered clusters)
- `regret:scan` — scan project for cluster suggestions (useful for new projects)
- `regret:list` — list all clusters with status, stack, and fingerprints
- `regret:verify-kebenaran` — verify KEBENARAN 1 vs KEBENARAN 2 identity (auto-detects Python vs JS stack)
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

## Gap 4 — Branch Coverage Analysis

A cluster with 1 input for a function that has 5 branches only protects ONE execution path. A refactor that breaks the other 4 branches will **still show GREEN** because the fingerprint was never tested with inputs that exercise those paths.

```bash
node scripts/coverage.js
node scripts/coverage.js --cluster validate-age --verbose
```

Output:

```
BRANCH COVERAGE REPORT
──────────────────────────────────────────────────────────────────────
cluster                    inputs  branches  coverage  status
──────────────────────────────────────────────────────────────────────
validate-age               1       5         20%       🔴 UNDER-COVERED
format-currency            3       3         100%      ✅ WELL-COVERED
──────────────────────────────────────────────────────────────────────

⚠️  Coverage Recommendations:
  validate-age  → add at least 4 more input(s) to cover branches
```

The coverage tool counts decision points (`if/else`, ternary, switch/case, early returns, try/catch, `&&`/`||`) in watched functions and compares against the number of inputs in the manifest.

**Rules:**
- `inputs >= branches` → MINIMUM requirement
- Coverage < 50% → UNDER-COVERED (exits with code 1, CI gate fails)
- Coverage 50-79% → PARTIAL
- Coverage ≥ 80% → WELL-COVERED

### Suggest Inputs

The `--suggest-inputs` flag goes beyond "you need more inputs" — it analyzes each branch condition and generates **concrete input suggestions** that would exercise uncovered branches:

```bash
node scripts/coverage.js --suggest-inputs
node scripts/coverage.js --suggest-inputs --cluster validate-age
```

Output:

```
SUGGESTED INPUTS — Concrete inputs to cover uncovered branches
══════════════════════════════════════════════════════════════════

📦 validate-age (entry: validateAge)
   4 branch(es) detected in validateAge:

   Branch 1 (line 12): if (age < 0) return "invalid: negative"
     → returns: "invalid: negative"
     🆕 Suggested input: {"age": -1}
   Branch 2 (line 13): if (age === 0) return "invalid: zero"
     → returns: "invalid: zero"
     🆕 Suggested input: {"age": 0}
   Branch 3 (line 14): if (age < 18) return "minor"
     → returns: "minor"
     🆕 Suggested input: {"age": 10}
   Branch 4 (line 15): if (age >= 65) return "senior"
     → returns: "senior"
     🆕 Suggested input: {"age": 70}

   ── Manifest inputs snippet ──
   "inputs": [{"age": -1}, {"age": 0}, {"age": 10}, {"age": 70}]
```

This directly addresses the critical gap: **"clusters only fingerprint one execution path; branching functions need inputs covering ALL branches."** Instead of guessing what inputs to add, the tool tells you exactly what values would exercise each branch.

### Scan Command

For new projects, use `regret scan` to discover candidate functions:

```bash
node scripts/scan.js                              # scan entire project
node scripts/scan.js --dir src/lib/               # scan specific directory
node scripts/scan.js --stack python               # filter by stack
node scripts/scan.js --format manifest            # output as manifest.json snippet
```

The scan identifies exported functions, estimates cyclomatic complexity, and suggests clusters prioritized by complexity. It also detects **Zustand store actions** — pure logic buried inside `create()` closures — and suggests extracting them to `*-logic.ts` files before fingerprinting (see `references/zustand-store.md`).

Read `references/branch-coverage.md` for the full specification and branch-map pattern.

---

## Gap 5 — Project Scanner

When approaching an unfamiliar codebase, use `regret scan` to discover candidate functions for clustering:

```bash
node scripts/scan.js
```

This scans the project, identifies exported functions, estimates cyclomatic complexity, and suggests clusters. Use `--format manifest` to generate a starting manifest.json.

The scanner also detects **non-serializable return types** (numpy arrays, openpyxl Workbooks, cv2 images, etc.) and flags them with a `🔴non-serializable-return` warning. These functions need an `outputTransform` in the manifest before they can be fingerprinted.

---

## Gap 6 — Mutation Audit

Many projects — especially OCR pipelines, data enrichment, and validation layers — have functions that **mutate their input arguments in-place** instead of returning new objects. This causes:

1. Fingerprints to differ because mutation-added keys change the output hash
2. `trackMutation` detects the change but doesn't identify which keys were added
3. Agents don't know which keys to add to `ignoreFields`

Use `regret mutate-audit` to detect these functions:

```bash
python3 scripts/mutate_audit.py src/
python3 scripts/mutate_audit.py src/pipeline.py --detailed
python3 scripts/mutate_audit.py src/ --recursive
```

This uses AST analysis to find functions that:
- Assign to subscript of a parameter: `param[key] = value`
- Call mutating methods: `param.append()`, `param.update()`, etc.
- Delete keys from parameters: `del param[key]`

For each mutation, it suggests concrete `ignoreFields` values:

```
⚠️  validate_red_flag (line 12)
   Mutates: transactions
   Keys:    flag, catatan_manual, _suspect_field
   💡 Suggested ignoreFields: ["_suspect_field", "catatan_manual", "flag"]
```

Run this **before** defining clusters to ensure you don't miss mutation-added keys.

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

## Keyword Arguments Support (Python `kwargs`)

For Python functions that accept keyword arguments, add `"kwargs": true` to the cluster definition. Each input dict is then unpacked as keyword arguments:

```json
{
  "id": "hand-value",
  "entry": "estimate_hand_value_serialized",
  "module": "regret_adapters",
  "stack": "python",
  "kwargs": true,
  "inputs": [
    {"tiles": [1, 2, 3, 5, 6, 7, 9, 10, 11, 13, 14, 15, 52], "win_tile": 52}
  ]
}
```

This calls `estimate_hand_value_serialized(tiles=[1,2,3,...], win_tile=52)`.

When `kwargs` is true and the input is a dict, the dict is unpacked using `**kwargs` syntax (Python) or passed as a single object argument (JS). This is especially useful for:

- **Class-based APIs** where the adapter function constructs objects and passes them as kwargs
- **Config-heavy functions** with many optional parameters
- **Adapter pattern wrappers** that bridge class-based libraries to Regrets

See `references/class-adapter.md` and `references/case-study-mahjong.md` for complete examples.

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
| Next.js | Adapter modules (pure logic extraction) | Value (default) | See `references/nextjs.md` |
| Tauri apps | esbuild transpile + adapter modules | Value (default) | See `references/tauri-apps.md` |
| Zustand stores | Pure logic extraction + adapter | Value (default) | See `references/zustand-store.md` — extract pure logic from `create()` closures |
| Color science | Adapter module + dist/index.js import | Value (default) | See `references/colorimetry.md` — handles circular ESM deps + class-based Color objects |
| Python pipeline | Pure logic extraction + adapter | Value / Schema / Mixed | See `references/python-pipeline.md` — OCR, NLP, and data processing pipelines |
| Scientific computing / DSP | Adapter + `array_summary` transform | Array summary / Value / Schema | See `references/scientific-computing.md` — handles numpy arrays, complex numbers, float precision |
| OCR/Parsing pipeline | Pure logic extraction + fixtures | Value (default) | See `references/ocr-parsing-pipeline.md` — handles OCR I/O boundary + float precision |
| Factory pattern | Compiled barrel file + outputTransform | Value / Schema / Mixed | See `references/factory-pattern.md` — mathjs, inversifyJS, etc. |
| Algorithm visualization | Adapter modules + `resetState` + `seed` | Value (default) | See `references/algorithm-visualization.md` — handles mutable globals, input mutation, auto-incrementing IDs |
| Datetime & stateful | `freezeTime` + `maxYields` + `trackState` + adapter | Value (default) | See `references/datetime-stateful-patterns.md` — date/time libs, schedulers, stateful objects |

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

**Python chains:** When the manifest contains Python clusters, `regret chain` automatically uses the Python chain runner (`scripts/contest.py`) instead of the JS runner (`scripts/contest.mjs`). This handles `module` (dot notation) imports correctly for Python stacks.

Read `references/contest.md` for the full specification.

---

## Diff — What Changed When a Cluster Goes RED

When validation fails after refactoring, the only output is "expected X got Y" for the fingerprint hash. The `regret diff` command shows exactly WHAT changed in the output — field by field.

```bash
node scripts/regret.js diff                        # Diff all clusters
node scripts/regret.js diff --cluster my-cluster   # Diff specific cluster
```

Output:
```
❌ my-cluster                              abc1234 → def5678
  ≠ [2].saldo
      golden:  9500000
      live:    9500001
  ≈ [3].debit
      golden:  500000
      live:    500000.0000001
      diff:    1e-07 (within float tolerance)
```

Symbols:
- `≠` value mismatch — likely a real regression
- `≈` float tolerance difference — probably safe, add `floatTolerance` normalize rule
- `+` key added in live output
- `-` key removed from live output

For Python clusters, use `python3 scripts/diff.py`.

Read `references/python-pipeline.md` for diff usage in data pipeline projects.

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

## Branch Map — Auto-Generate Coverage Guidance

The `regret branch-map` command analyzes source code and generates `regrets/branch-map.md`,
which maps every branch in watched functions and suggests inputs to cover each branch.

```bash
node scripts/regret.js branch-map             # Generate from compiled JS
node scripts/regret.js branch-map --ts        # TypeScript mode — resolve .ts source files
node scripts/regret.js branch-map --cluster my-cluster  # Single cluster
```

**Why this matters:** The `regret coverage` command reports coverage percentages, but it doesn't tell you *which* branches are uncovered or *what inputs* to add. The branch-map fills this gap by enumerating every branch with a suggested input that would exercise it.

**TypeScript projects:** Always use `--ts` flag. Without it, the tool analyzes minified JS output, which has no readable branches. With `--ts`, it resolves the TypeScript source files from the manifest's JS paths and generates accurate branch analysis.

Read `references/branch-coverage.md` for the Branch Map Pattern and `references/typescript-projects.md` for the full TypeScript workflow.

---

## TypeScript Projects — Special Considerations

TypeScript projects require a compilation step before Regrets can fingerprint. This creates three gaps that agents must address:

1. **`preBuild` is mandatory** — Without it, Regrets fingerprints stale compiled output
2. **Source vs. compiled paths differ** — The manifest `file` points to `.js`, but analysis must read `.ts`
3. **Minified output is unanalyzable** — Branch coverage and branch-map must use TypeScript source

```json
{
  "preBuild": "npx tsc -p tsconfig.json",
  "clusters": [
    {
      "id": "format-date",
      "entry": "formatDate",
      "file": "js/shared/date-utils.js",
      "stack": "js",
      ...
    }
  ]
}
```

Key workflow:
- Read `.ts` source to understand code → write manifest pointing to `.js` output
- Use `regret branch-map --ts` for branch analysis from TypeScript source
- Use `regret coverage` for quick coverage scoring from compiled JS
- `preBuild` runs before every `capture`, `validate`, `drift`, `chain`, `ci`, `guard`

Read `references/typescript-projects.md` for the complete guide including path mapping patterns and common pitfalls.

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
│   ├── contest.mjs             ← chain testing MVP (multi-step flow validation, JS)
│   ├── contest.py              ← chain testing for Python stack clusters
│   ├── diff.js                 ← output diff — shows what changed when RED
│   ├── diff.py                 ← output diff for Python clusters
│   ├── coverage.js             ← branch coverage analysis (detect under-covered clusters)
│   ├── branch-map.js           ← auto-generate regrets/branch-map.md with input suggestions
│   ├── scan.js                 ← project scanner (suggest clusters from source)
│   ├── scan.py                 ← Python project scanner (suggest clusters + non-serializable detection)
│   ├── mutate_audit.py         ← Mutation audit (detect functions that mutate input args)
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
    ├── nextjs.md                ← Next.js integration — adapter modules for noEmit projects
    ├── factory-pattern.md       ← Factory pattern projects — barrel file + outputTransform
    ├── tauri-apps.md            ← Tauri app integration — esbuild transpile + adapter modules
    ├── zustand-store.md          ← Zustand store — extract pure logic from create() closures
    ├── reexport-hub.md            ← Re-export hub pattern — backward-compatible decomposition
    ├── colorimetry.md           ← Color science library pattern (circular ESM + class Color)
    ├── deepClone-output-before-fingerprint.md ← Bug fix: output reproducibility
    ├── contest.md              ← Chain testing — multi-step flow validation
    ├── dual-truth-verification.md ← Dual-truth verification pattern for rigorous refactoring proof
    ├── python-pipeline.md       ← Python pipeline pattern (OCR, NLP, data processing)
    ├── ocr-pipeline.md          ← OCR pipeline pattern (mutation, LLM non-determinism, spatial data)
    ├── ocr-parsing-pipeline.md ← OCR & parsing pipeline pattern (pure logic extraction + float precision)
    ├── datetime-stateful-patterns.md ← Datetime & stateful object patterns (freezeTime, maxYields, trackState)
    ├── branch-coverage.md     ← branch coverage analysis and branch-map pattern
    ├── typescript-projects.md  ← TypeScript workflow guide (preBuild, source mapping, --ts flag)
    ├── case-study-riimut.md    ← Case study: regression testing a runic alphabet translator
    ├── case-study-pustaka.md    ← Case study: regression testing a calendar library
    ├── case-study-korean-romanizer.md ← Case study: Python class-based API + structural refactor
    ├── case-study-pyenigma.md  ← Case study: pyEnigma (stateful class-based API + roundtrip)
    ├── case-study-lindenmayer.md ← Case study: lindenmayer (L-System, rollup naming collision)
    ├── case-study-gimeltra.md  ← Case study: gimeltra (Semitic script transliteration, 25 scripts)
    ├── TROUBLESHOOTING.md      ← Common problems and solutions
    ├── WALKTHROUGH.md          ← Step-by-step refactoring walkthrough
    ├── braille-encode.md       ← Case study: qntm/braille-encode (binary↔Braille)
    ├── base1.md                ← Case study: qntm/base1 (unary encoding, BigInt)
    ├── stateful-encoding.md    ← Stateful encoding libraries (Baudot, Morse, shift states)
    ├── case-study-ogham.md     ← Case study: evanshortiss/ogham (CJS wrapper pattern)
    ├── esoteric-language.md    ← Esoteric language interpreter testing pattern
    ├── nested-functions.md     ← Nested function watch limitation and workarounds
    ├── single-file-python.md   ← Single-file Python module integration pattern
    ├── case-study-pustaka.md   ← Case study: Javanese Calendar library
    ├── case-study-hebrew.md    ← Case study: Hebrew Gematria library
    ├── case-study-isbn3.md     ← Case study: ISBN utility library
    ├── case-study-korean-romanizer.md ← Case study: korean-romanizer (Python adapter pattern)
    ├── case-study-petungan.md  ← Case study: petungan (Javanese calendar, circular dep)
    ├── case-study-riimut.md    ← Case study: riimut (rune transliteration, dual-truth)
    ├── case-study-shakespearelang.md ← Case study: shakespearelang (esoteric language)
    ├── case-study-coretax.md       ← Case study: Coretax-Auto-Downloader (date-dependent output, discriminated unions, God Object)
    ├── case-study-sdr.md      ← Case study: mhostetter/sdr (DSP/scientific computing, numpy arrays, complex numbers)
    ├── dual-truth-verification.md ← Dual-truth verification pattern
    ├── mapping-transliteration.md ← Mapping/transliteration library guide
    └── guard-and-drift.md        ← guard and drift commands — when to use, output format, drift remediation
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
6. **`references/guard-and-drift.md`** — When and how to use the `guard` and `drift` commands for deployment gating and non-determinism detection.

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
└── Next.js
    └── Extract pure logic into adapter modules → then use JS scripts (see references/nextjs.md)
└── Tauri App
    └── esbuild transpile + adapter modules → then use JS scripts (see references/tauri-apps.md)
└── Zustand Store
    └── Extract pure logic to *-logic.ts → then use JS scripts (see references/zustand-store.md)
└── Color Science Library
    └── Adapter module + dist/index.js import → handles circular ESM deps (see references/colorimetry.md)
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
[ ] 3. npm run regret:coverage (check branch coverage — add inputs if UNDER-COVERED)
[ ] 4. npm run regret:drift (5 runs — ensure ALL STABLE)
[ ] 5. If DRIFT detected → add normalize rules to manifest, re-capture
[ ] 6. npm run regret:health — ensure all SOLID
[ ] 7. Perform the refactor
[ ] 8. npm run regret:build (rebuild tsc after refactor)
[ ] 9. npm run regret:validate — all must still be GREEN
[ ] 10. If any RED:
      [ ] Read fingerprint diff — see which input/output changed
      [ ] Do NOT edit .regret files — fix the CODE
      [ ] If behavior intentionally changed → npm run regret:update -- <cluster> --reason "..."
[ ] 11. All green → npm run build → then push
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

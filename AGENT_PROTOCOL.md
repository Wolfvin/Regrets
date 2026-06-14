# Agent Protocol — Regrets Skill Interaction Contract

How AI agents interact with the Regrets regression-testing skill.
Read this file alone to onboard — no other files required.

---

## 1. Trigger Conditions

MUST invoke BEFORE: refactoring, simplifying, restructuring, splitting files,
extracting functions, changing module boundaries, or any edit altering function output.

MUST NOT invoke for: documentation-only, style-only, or git operations with no code change.

---

## 2. Input — manifest.json

Create `regrets/manifest.json` inside the target project:

```json
{"preBuild":"npx tsc -p tsconfig.json","clusters":[{
  "id":"kebab-name","entry":"fnName","watches":["fn1","fn2"],
  "sideEffectWatches":["db.insert","emailService.sendWelcome"],
  "file":"path/to/compiled.js","stack":"js",
  "fingerprintLevel":"entry",
  "inputs":[{"key":"value"},null],
  "normalize":[],"ignoreFields":[]}]}
```

Required: `id`, `entry`, `watches`, `file` (JS) or `module` (Python), `stack`, `inputs`.
Optional: `sideEffectWatches` — array of dot-notation paths to side-effect functions
(e.g., `"db.insert"` = `rawModule.db.insert`). These functions are wrapped with a
Proxy recorder during capture and validation. Their calls (function name, args,
call count) are included in the fingerprint, so dropped or changed side effects
are detected even when the return value is unchanged.
Python: use `module` + `pythonPath` instead of `file`. React: add `renderMode: "static"`.
Multi-arg: `"multiArgs": true` (inputs become arrays). Kwargs: `"kwargs": true`.
Stack: `js` | `ts` | `css` | `python` | `rust` | `react` | `go` | `php` | `extension`.
CSS uses JS runner (`capture.js` / `validate.js`) — no separate binary needed. Rust supports capture + validate via `cargo test`.

### freezeTime — deterministic Date/Time

Freeze `Date.now()` and `new Date()` to a fixed timestamp during capture and validate.
Critical for functions that default to `Date.now()` or `new Date()`, which would produce
non-deterministic fingerprints otherwise.

```json
{"id":"schedule-event","entry":"createEvent","watches":[],"file":"src/events.js","stack":"js",
 "inputs":[{"name":"meeting"}],"freezeTime":"2024-01-15T10:00:00Z"}
```

Supported formats: ISO 8601 datetime (`"2024-01-15T10:00:00Z"`), date only (`"2024-01-15"`),
Unix timestamp (`"1705312800"`). The `Date` global is monkey-patched before each input run
and always restored via `try/finally` — no leaks between clusters or runs.
Available in both JS (`capture.js` / `validate.js`) and Python (`capture.py` / `validate.py`).

### inputTransform — transform inputs before calling entry

Convert JSON-safe manifest inputs to the actual types a function expects.
Since `manifest.json` can only store JSON-serializable values, `inputTransform`
converts them back before calling the entry function.

```json
{"id":"decode-packet","entry":"decode","watches":[],"file":"src/codec.js","stack":"js",
 "inputs":["0a1b2c","ff00ee"],"inputTransform":"hex_to_bytes"}
```

Supported transforms:
- `"str"` — convert each input to `String(value)`
- `"hex_to_bytes"` — convert hex string to `Buffer` (e.g., `"0a1b"` → `Buffer.from([10, 27])`)
- `"list_to_bytes"` — convert array of ints to `Buffer` (e.g., `[10, 27]` → `Buffer.from([10, 27])`)
- `"module.fn"` — import module and apply function to each input

For `multiArgs` clusters, the transform is applied to each argument individually.

### isolateGlobals — fresh module state per input

When `true`, the module is re-imported with cache-busting (dynamic `import()` with
timestamp query parameter) before each input run. This prevents shared mutable module-level
state from leaking between input runs.

```json
{"id":"accumulate","entry":"addToCounter","watches":["counter"],
 "file":"src/counter.js","stack":"js","inputs":[1,2,3],"isolateGlobals":true}
```

Without `isolateGlobals`, a module like `let total = 0; export function add(n) { return total += n }`
would accumulate state across inputs (1→1, 2→3, 3→6). With `isolateGlobals`,
each input gets a fresh module instance (1→1, 2→2, 3→3).

### outputTransform — post-processing output for fingerprinting

Transform the raw output before fingerprinting. Both JS and Python support these built-in types:

| Transform | JS | Python | Description |
|-----------|:--:|:------:|-------------|
| `"str"` | ✅ | ✅ | `String(output)` / `str(output)` |
| `"json"` | ✅ | ✅ | JSON round-trip (strips non-serializable) |
| `"repr"` | ✅ | ✅ | `JSON.stringify(output)` / `repr(output)` |
| `"len"` | ✅ | ✅ | `.length` / `len(output)` |
| `"type"` | ✅ | ✅ | `typeof` / `type().__name__` |
| `"isoformat"` | ✅ | ✅ | `.toISOString()` / `.isoformat()` |
| `"array_summary"` | ✅ | ✅ | `{ length, first, last }` |
| `"dict"` | ✅ | ✅ | Convert Map/class to plain object |
| `"dataclass_dict"` | ✅ | ✅ | Recursive class-to-dict conversion |
| `"pojo"` | ✅ | — | Recursively strip class identity (JS) |
| `"snapshot"` | — | ✅ | Deep recursive state serialization (Python) |
| `"state"` / `"state_private"` | — | ✅ | Object state with cycle detection (Python) |
| `"hex"` | — | ✅ | `bytes.hex()` (Python) |
| `"keys"` | ✅ | — | `Object.keys()` (JS) |
| `"toString"` | ✅ | — | `.toString()` (JS) |
| `"toJSON"` | ✅ | — | `.toJSON()` (JS) |
| `"module.fn"` | ✅ | ✅ | Custom transform via dynamic import |

### driftRuns — per-cluster drift run count

Override the default 5 drift runs per cluster. Useful for probabilistic functions
that need more runs for confidence, or deterministic functions where 5 is wasteful.

```json
{"id":"my-cluster","driftRuns":10,"entry":"fnName","watches":[],"file":"src/index.js","stack":"js","inputs":[]}
```

Priority: `--runs N` CLI flag (explicit) > `driftRuns` in manifest > default 5 (from `regret drift`).
Backward compatible: clusters without `driftRuns` use the default.

### detectMode — auto-infer execution mode

Set `"detectMode": true` to have capture inspect the module and report the inferred
execution mode. Useful when you are unsure whether a module exports a function,
class, singleton, or store.

```json
{"id":"my-cluster","detectMode":true,"entry":"MyClass","watches":[],"file":"src/index.js","stack":"js","inputs":[]}
```

When `detectMode` is true and no explicit mode field (`classMethod`, `singletonMethod`,
`storeDispatch`) is set, capture inspects the module and prints:

- **Function**: `ℹ️ Auto-detected mode: function-based (entry "fnName" is a function)`
- **Class**: `ℹ️ Auto-detected mode: class-based (entry "MyClass" is a class)` + suggested `classMethod`
- **Singleton**: `ℹ️ Auto-detected mode: singleton (entry "obj" is an object with methods)` + suggested `singletonMethod`
- **Store**: `ℹ️ Auto-detected mode: store dispatch (entry "store" looks like a store)` + suggested `storeDispatch`
- **Unknown**: `ℹ️ Auto-detected mode: unable to infer — entry "x" not found in module`

The detection is informational only — it does not change capture behavior. Add the
suggested field to your manifest to use the detected mode.

### Fingerprint levels

| Level | What gets hashed | When to use | Fallback |
|-------|-----------------|-------------|----------|
| `"entry"` (default) | Final output only | Output is stable, internal calls don't matter | — |
| `"calls"` | `{ fn, count }` pairs — which functions called + how many times | Detect double-call bugs (e.g., `calculateTax` called 2× instead of 1×) while surviving internal refactors that don't change call counts | Falls back to `"entry"` if `watches` is empty, with warning |
| `"full"` | Entire call sequence with args and results per call | Strictest: any internal change detected. Use when every call detail matters | — |

Example — `"calls"` catches a double-taxation bug that `"entry"` misses:

```json
{
  "id": "compute-invoice",
  "entry": "calculateTotal",
  "watches": ["calculateTax", "applyDiscount"],
  "fingerprintLevel": "calls",
  "inputs": [{ "subtotal": 100, "tax": 0.1 }]
}
```

If `calculateTax` is accidentally called twice after a refactor, `"calls"` will FAIL (count changed from 1 to 2) even if the final output happens to be the same. `"entry"` would PASS incorrectly. `"full"` would also detect this but would additionally FAIL for any change to the args/results of `calculateTax`, even legitimate refactors.

### Error path contracts (expectThrow)

Use `__expectThrow` to declare that a specific input MUST cause the function to throw:

```json
"inputs": [
  { "host": "localhost" },
  { "__expectThrow": true, "value": null },
  { "__expectThrow": true, "value": { "port": -1 } }
]
```

- `__expectThrow: true` — marks this input as an error-path test
- `value` — the actual argument sent to the function
- `capture.js` catches the error and fingerprints `{ type, message }` as `ERROR_CONTRACT`
- `validate.js` FAILs if: function stops throwing, error type changes, or error message changes
- Works for sync `throw` and async `Promise.reject` / `async` function throws
- Error messages are normalized: stack traces stripped, line numbers stripped, `normalize` rules applied
- `.regret` file stores `ERROR_CONTRACT` instead of `OUTPUT`, plus `expectThrow: true` in metadata

---

## 3. Output — validate.js stdout

```
  ✅ transform-user-data     9jadb                  PASS       ← single run
  ❌ fetch-invoice           x7k2k → ff33z          FAIL
    side effect dropped: emailService.sendWelcome (was called 1x, now 0x)  ← sideEffectWatches
  ❌ create-order            a1b2c → d4e5f          FAIL
    side effect args changed: db.insert call[0].[0].role "user" → "admin"
  ✅ compute-total           x7k2m  × 5  PASS+STABLE           ← drift mode
  ❌ fetch-invoice           x7k2m / ff3z           DRIFT
  ✅ transform-user-data     9jadb → x3kp1  UPDATED            ← update mode
  ❌ parse-input             a3b2k → m7n4p          FAIL       ← expectThrow: function stopped throwing
    Expected error: TypeError: Invalid input
    Actual: function did NOT throw (error path removed)
```

Summary: `✅ All N tests passed.` = exit 0 (proceed). `❌ N/M FAILED.` = exit 1 (stop).
Parse: `✅` = green, `❌` = red. Format: `{icon} {cluster-id} {hash-info} {status}`.

---

## 4. Decision Tree

### QUICK PATH (recommended for most cases)

```
regret install          → discover + capture entire project
[do your work]
regret validate         → verify all GREEN
regret status           → confirm safe to ship
regret uninstall        → clean up
```

### MANUAL PATH (when you need fine-grained control)

```
START: Agent plans to refactor code
│
├─ regrets/manifest.json exists?
│   NO ── NEW CODEBASE? ──
│   │
│   ├─ regret discover --entry <fn> --file <path>
│   │     Auto-traces call graph, generates draft manifest cluster
│   │     Review watches + inputs, then proceed to GATE 1
│   │
│   ├─ OR: regret init --stack <stack> → edit manifest manually → GATE 1
│   │
│   YES → GATE 1
│
├─ GATE 1: regret check (verify exports exist)
│   FAIL → Fix manifest (wrong entry/file/stack), retry
│
├─ GATE 2: regret capture
│   Entry not found → verify compiled output, fix manifest
│   Watch not function → remove non-function from watches
│
├─ GATE 3: regret validate (single run)
│   Any FAIL → Fix manifest/inputs, re-capture. NEVER edit .regret files.
│   All PASS → GATE 4
│
├─ GATE 4: regret drift (--runs 5)
│   DRIFT → Add normalize rules (timestamps/uuids/epochs/floatTolerance)
│            Re-capture, re-drift. Loop until ALL STABLE.
│
├─ GATE 5: regret health
│   FRAGILE → split cluster or add inputs
│   LOW confidence → add more inputs or wait for capture maturity
│   ALL SOLID + HIGH confidence → GATE 5b
│
├─ GATE 5b: regret coverage [--suggest-inputs]
│   UNDER-COVERED → add inputs for uncovered branches (see suggested inputs)
│   WELL-COVERED → GATE 6
│
├─ GATE 6: regret risk --json
│   HIGH → entry function modified — cluster output WILL change, plan update
│   MEDIUM → watched function modified — cluster output MAY change, verify after refactor
│   UNTRACKED → function has no cluster coverage — consider adding watches
│   NO RISK → PROCEED TO REFACTOR
│
├─ REFACTOR: Edit code freely. NEVER edit regrets/ directory.
│
├─ VERIFY: regret validate
│   All PASS → SHIP
│   Any FAIL → unintentional? → FIX CODE, re-validate
│              intentional? → regret update <id> --reason "specific what+why"
│              NEVER edit .regret files to make tests pass
│
└─ SHIP: All GREEN + SOLID. Push.
```

---

## 5. Error Codes & Recovery

| Error | Recovery |
|-------|----------|
| Entry not found | Check compiled .js (not .ts); use `"entry": "default"` for default exports |
| Watch not a function | Remove non-functions from watches; only function exports are wrappable |
| Entry starts with `_` | Set `fingerprintLevel: "entry"` (Ghost can't wrap private functions) |
| `calls` fallback to `entry` | Add functions to `watches` — `calls` level needs watched functions to count |
| DRIFT | Add `normalize`: timestamps, uuids, epochs, floatTolerance, seed, dynamicDates |
| `--update requires --reason` | Provide 4+ word reason describing WHAT changed + WHY |
| Coverage UNDER-COVERED | Add inputs (use `--suggest-inputs`); aim for inputs >= branches; use `regret coverage` to see uncovered paths |
| preBuild failed | Run build manually, fix compilation errors |
| Python module import error | Verify `module` dot-notation path, add `pythonPath` |
| expectThrow violated | Function stopped throwing — refactoring removed error path; restore or update with reason |
| Error type/message changed | Error behavior changed — if intentional, `regret update <id> --reason "..."` |

---

## 6. Confidence Score

Every cluster gets a confidence label (HIGH / MEDIUM / LOW) computed from existing
metadata — no new files or data required.

### Formula

```
Factor 1 — Input count (from manifest inputs array):
  1 input    → 0.1
  2-3 inputs → 0.4
  4-6 inputs → 0.7
  7+ inputs  → 1.0

Factor 2 — Age of golden capture (from "captured:" in .regret file):
  < 1 day    → 0.5  (too new, unproven)
  1-7 days   → 0.8
  > 7 days   → 1.0

Factor 3 — Drift history (from audit.log entries with type UPDATE or DRIFT):
  Has drift/update → 0.6  (contract changed, less stable)
  Never            → 1.0

Final score = F1 × 0.5 + F2 × 0.2 + F3 × 0.3

Label:
  score >= 0.8  → HIGH
  score >= 0.5  → MEDIUM
  score <  0.5  → LOW
```

### Where confidence appears

| Command | Output |
|---------|--------|
| `regret health` | New "conf" column (HIGH/MEDIUM/LOW) + detail line with input count and age |
| `regret health --json` | `confidence` (label) + `confidenceScore` (0.0–1.0) per cluster |
| `regret validate --json` | `confidence` (label) per cluster result |
| `regret list --json` | `confidence` (label) + `confidenceScore` (0.0–1.0) per entry |

### Interpretation

- **HIGH**: Well-tested cluster — many inputs, mature capture, no drift history. Trust PASS results.
- **MEDIUM**: Partially tested — some inputs, moderate age, or prior drift. Verify manually.
- **LOW**: Insufficient testing — single input, very new capture, or repeated drift. Do not trust PASS alone.

### Example health output

```
CLUSTER HEALTH REPORT
──────────────────────────────────────────────────────────────────────────────────
cluster                     updates  drifts  age       health         conf   detail
──────────────────────────────────────────────────────────────────────────────────
parse-config                       0       0  8d        ██████ SOLID  HIGH   3 inputs, 8 days old
create-user                        1       0  today     ██░░░░ FRAGILE LOW    1 input, 0 days old
```

---

## 7. Checklist Before PR

```
[ ] regret check — all entries found in compiled output
[ ] regret capture — all clusters captured, .regret files written
[ ] regret validate — ALL PASS
[ ] regret drift — ALL STABLE (5 runs, identical hashes)
[ ] regret health — ALL SOLID + no LOW confidence clusters (or plan for LOW clusters)
[ ] regret coverage — all clusters WELL-COVERED (no UNDER-COVERED)
[ ] regret risk — no high-risk clusters, or plan for expected changes
[ ] regrets/ committed (manifest.json + .regret files + audit.log)
[ ] No manual edits to .regret files after first green pass
[ ] Post-refactor: regret validate — ALL PASS again
[ ] Code changes are structural only — no behavioral contract change
```

---

## Quick Command Reference

### ACTIVE COMMANDS

```
INSTALL WORKFLOW:
  regret install [--dir src/] [--dry-run]    Auto-discover + capture entire project
  regret validate                             Verify all GREEN
  regret status [--json]                      Snapshot: safe to refactor?
  regret uninstall [--keep-manifest]          Clean up safety net

MANUAL WORKFLOW:
  regret init --stack <stack>                 Scaffold regrets/
  regret capture [--cluster <id>]             Capture fingerprints
  regret check                                Verify exports exist
  regret drift [--runs N]                     Stability check
  regret update <id> --reason "..."           Update contract intentionally
  regret validate --fail-fast                 CI/CD gate (replaces regret ci + regret guard)

ANALYSIS:
  regret coverage [--suggest-inputs] [--verbose] [--json]   Branch coverage
  regret health [--json]                      Cluster health + confidence
  regret risk [--since HEAD~1] [--json]       Pre-refactor risk signal
  regret discover --entry <fn> --file <path>  Single-function discovery
  regret diff                                 Show diff on FAIL
  regret list [--json]                        List all clusters
  regret analyze [dir] [--json]               Deep structural analysis
```

### DEPRECATED COMMANDS (still work, but use replacement instead)

```
  regret scan          → regret install --dry-run
  regret branches      → regret coverage
  regret audit         → regret status
  regret ci            → regret validate --fail-fast
  regret guard         → regret validate --fail-fast
  regret branch-map    → regret coverage --suggest-inputs
  regret diagnose      → regret discover --entry <fn> --file <path>
  regret structure     → regret analyze
```

All auto-detect stack from manifest. Add `--skip-build` to skip preBuild.
`regret health --json` and `regret list --json` include `confidence` + `confidenceScore` per cluster.
`regret validate --json` includes `confidence` per cluster result.
`regret discover` — runtime call graph tracing for new codebases (before GATE 1). Auto-generates draft manifest with discovered watches.

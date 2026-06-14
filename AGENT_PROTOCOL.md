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
├─ GATE 5b: regret branches
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
| Coverage UNDER-COVERED | Add inputs (use `--suggest-inputs`); aim for inputs >= branches; use `regret branches` to see uncovered paths |
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
[ ] regret branches — all clusters WELL-COVERED (no UNDER-COVERED)
[ ] regret risk — no high-risk clusters, or plan for expected changes
[ ] regret coverage — No cluster UNDER-COVERED
[ ] regrets/ committed (manifest.json + .regret files + audit.log)
[ ] No manual edits to .regret files after first green pass
[ ] Post-refactor: regret validate — ALL PASS again
[ ] Code changes are structural only — no behavioral contract change
```

---

## Quick Command Reference

```
regret init --stack <stack>       regret capture          regret validate
regret check                      regret drift (×5)       regret health [--json]
regret update <id> --reason ".."  regret coverage         regret diff
regret scan [--dir src/]          regret chain            regret truth
regret rollback <id>              regret guard            regret list [--json]
regret branches [--cluster <id>] [--json]  Static branch coverage
regret risk [--since HEAD~1] [--diff file] [--json]
regret discover --entry <fn> --file <path> [--inputs '[...]'] [--out <path>]
```
All auto-detect stack from manifest. Add `--skip-build` to skip preBuild.
`regret health --json` and `regret list --json` include `confidence` + `confidenceScore` per cluster.
`regret validate --json` includes `confidence` per cluster result.
`regret discover` — runtime call graph tracing for new codebases (before GATE 1). Auto-generates draft manifest with discovered watches.

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
  "file":"path/to/compiled.js","stack":"js",
  "fingerprintLevel":"entry",
  "inputs":[{"key":"value"},null],
  "normalize":[],"ignoreFields":[]}]}
```

Required: `id`, `entry`, `watches`, `file` (JS) or `module` (Python), `stack`, `inputs`.
Python: use `module` + `pythonPath` instead of `file`. React: add `renderMode: "static"`.
Multi-arg: `"multiArgs": true` (inputs become arrays). Kwargs: `"kwargs": true`.
Stack: `js` | `ts` | `css` | `python` | `rust` | `react` | `go` | `php` | `extension`.
CSS uses JS runner (`capture.js` / `validate.js`) — no separate binary needed. Rust supports capture + validate via `cargo test`.

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
  ❌ fetch-invoice           x7k2m → ff33z          FAIL
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
│   NO → regret init --stack <stack> → edit manifest → GATE 1
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
│   ALL SOLID → GATE 6
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
| DRIFT | Add `normalize`: timestamps, uuids, epochs, floatTolerance, seed, dynamicDates |
| `--update requires --reason` | Provide 4+ word reason describing WHAT changed + WHY |
| Coverage UNDER-COVERED | Add inputs (use `--suggest-inputs`); aim for inputs >= branches |
| preBuild failed | Run build manually, fix compilation errors |
| Python module import error | Verify `module` dot-notation path, add `pythonPath` |
| expectThrow violated | Function stopped throwing — refactoring removed error path; restore or update with reason |
| Error type/message changed | Error behavior changed — if intentional, `regret update <id> --reason "..."` |

---

## 6. Checklist Before PR

```
[ ] regret check — all entries found in compiled output
[ ] regret capture — all clusters captured, .regret files written
[ ] regret validate — ALL PASS
[ ] regret drift — ALL STABLE (5 runs, identical hashes)
[ ] regret health — ALL SOLID (no FRAGILE/UNSTABLE)
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
regret check                      regret drift (×5)       regret health
regret update <id> --reason ".."  regret coverage         regret diff
regret scan [--dir src/]          regret chain            regret truth
regret rollback <id>              regret guard            regret list
regret risk [--since HEAD~1] [--diff file] [--json]
```
All auto-detect stack from manifest. Add `--skip-build` to skip preBuild.

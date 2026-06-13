# Walkthrough: Complete Refactoring Session

A step-by-step walkthrough showing a full regret-based regression testing cycle using the `fought/extension_source` project's `formatPeriod` function as a real example.

---

## The Target Function

We want to refactor `formatPeriod` in `src/date-utils.ts` (compiled to `xhr-mode/exporter.js`):

```typescript
// src/date-utils.ts
export function formatPeriod(period: string): string {
  return period.replace('_', '')
}
```

This function strips underscores from period strings like `"MASA_01"` → `"MASA01"`. Simple, but it's part of the export pipeline and must not break.

---

## Step 1 — Install and Setup

First, scaffold the `regrets/` directory in the target project:

```bash
$ cd fought/extension_source
$ node ../../The-skill/regresion-testing/scripts/init.js

📁 Created: /home/z/fought/extension_source/regrets
📄 Created: /home/z/fought/extension_source/regrets/manifest.json
📌 Created: /home/z/fought/extension_source/regrets/.gitkeep

✅ regrets/ directory scaffolded successfully!

Next steps:
  1. Edit regrets/manifest.json — replace the example cluster with your actual cluster definitions
  2. Set cluster fields: id, entry, watches, file, stack, inputs
  3. Run: npm run regret:build     (compile TypeScript if needed)
  4. Run: npm run regret:capture   (capture behavioral fingerprints)
  5. Run: npm run regret:drift      (5 runs — ensure all STABLE)
  6. Run: npm run regret:health     (check cluster health scores)
```

Add the npm scripts to `package.json` (if not already present):

```json
{
  "regret:build": "npx tsc -p tsconfig.json",
  "regret:capture": "node ../../The-skill/regresion-testing/scripts/regret.js capture",
  "regret:validate": "node ../../The-skill/regresion-testing/scripts/regret.js validate",
  "regret:health": "node ../../The-skill/regresion-testing/scripts/regret.js health",
  "regret:drift": "node ../../The-skill/regresion-testing/scripts/regret.js drift",
  "regret:ci": "node ../../The-skill/regresion-testing/scripts/regret.js ci",
  "regret:guard": "node ../../The-skill/regresion-testing/scripts/regret.js guard",
  "regret:test": "node ../../The-skill/regresion-testing/scripts/test.mjs"
}
```

---

## Step 2 — Write the Manifest

Edit `regrets/manifest.json` to define the `format-period` cluster:

```json
{
  "clusters": [
    {
      "id": "format-period",
      "entry": "formatPeriod",
      "watches": ["formatPeriod"],
      "file": "xhr-mode/exporter.js",
      "stack": "js",
      "fingerprintLevel": "entry",
      "description": "Strips underscores from period strings like MASA_01 → MASA01",
      "inputs": [
        "MASA_01",
        "MASA_12",
        "NO_UNDERSCORE",
        "",
        "A_B_C_D"
      ]
    }
  ]
}
```

Key decisions:
- **`entry`: `"formatPeriod"`** — the function we call to produce output.
- **`watches`: `["formatPeriod"]`** — we monitor the function itself (for `fingerprintLevel: "full"` this would trace internal calls, but `"entry"` mode only needs the final output).
- **`inputs`**: Multiple test cases covering the happy path, edge cases (empty string, no underscore), and repeated underscores.

---

## Step 3 — Build and Capture

Compile TypeScript first, then capture fingerprints:

```bash
$ npm run regret:build

> npx tsc -p tsconfig.json
# (no errors — compiles cleanly)

$ npm run regret:capture


📡 Capturing: format-period
   File:    xhr-mode/exporter.js
   Entry:   formatPeriod
   Watches: formatPeriod
   ✅ Fingerprint: 12d5tvu
   📄 Saved: regrets/format-period.regret

──────────────────────────────────────────────────
Capture complete: 1 captured, 0 failed

Next: node scripts/validate.js
If all green → you are clear to refactor.
```

---

## Step 4 — Inspect the .regret File

The capture produced `regrets/format-period.regret`:

```
cluster: format-period
fingerprint: 12d5tvu
captured: 2025-03-01T14:30:00Z
watches: [formatPeriod]
entry: formatPeriod
stack: js
fingerprintLevel: entry
---
INPUT  "MASA_01"
OUTPUT "MASA01"
HASH   12d5tvu
```

This is our **golden contract**. The fingerprint `12d5tvu` represents the deterministic hash of the first input and its output. All five inputs were tested during capture, but the `.regret` file stores the first as the representative golden.

---

## Step 5 — Drift Detection (5 Runs)

Before refactoring, confirm the cluster is stable — no hidden non-determinism:

```bash
$ npm run regret:drift


🔍 Drift detection — 5 runs per cluster...

  ✅ format-period                       12d5tvu  × 5  PASS+STABLE

──────────────────────────────────────────────────────────────────
✅ All 1 tests passed (5 runs — stable). Refactor is safe.
```

All 5 runs produced the same fingerprint `12d5tvu`. No drift detected. The cluster is stable and ready for refactoring.

---

## Step 6 — Health Check

Check the overall health of our regrets:

```bash
$ npm run regret:health


CLUSTER HEALTH REPORT
─────────────────────────────────────────────────────
cluster                    updates  drifts  age      health
format-period              0        0       today    ███░░░ UNSTABLE

─────────────────────────────────────────────────────

Recommendations:
  format-period   → monitor closely, 0 update(s), 0 drift(s)
```

The cluster shows `UNSTABLE` only because it's brand new (age < 3 days). Zero updates and zero drifts mean the fingerprint is solid. After 3 days of stability, the score will improve to `GOOD` and eventually `SOLID`.

---

## Step 7 — Perform the Refactor

Now we refactor `formatPeriod`. The current implementation uses `replace('_', '')`, which only removes the **first** underscore. We want a version that removes **all** underscores using a regex, and we also want to make it handle `null`/`undefined` inputs gracefully.

**Before:**

```typescript
// src/date-utils.ts
export function formatPeriod(period: string): string {
  return period.replace('_', '')
}
```

**After:**

```typescript
// src/date-utils.ts
export function formatPeriod(period: string): string {
  if (!period) return ''
  return period.replace(/_/g, '')
}
```

Wait — the existing function only replaces the first underscore. The input `"A_B_C_D"` currently produces `"AB_C_D"` (only the first `_` removed). If we change to `/_/g`, it will produce `"ABCD"` — **this changes the output!**

We have two options:
1. **Match existing behavior** — keep `replace('_', '')` but add the null guard.
2. **Accept the behavior change** — switch to `/_/g` and update the golden with an audit trail.

Let's go with option 1 first (safer — same output for all existing inputs):

```typescript
// src/date-utils.ts
export function formatPeriod(period: string): string {
  if (!period) return ''
  return period.replace('_', '')
}
```

Rebuild after the refactor:

```bash
$ npm run regret:build

> npx tsc -p tsconfig.json
# (clean compile)
```

---

## Step 8 — Validate

Run the validator to confirm the refactor did not change any output:

```bash
$ npm run regret:validate


🔍 Validating 1 cluster(s)...

  ✅ format-period                       12d5tvu                PASS

──────────────────────────────────────────────────────────────────
✅ All 1 tests passed. Refactor is safe.
```

All green. The fingerprint still matches `12d5tvu`. The null guard does not affect any of the existing test inputs, so the contract holds.

---

## Alternative: Accepting a Behavior Change

If we had chosen option 2 (switching to `/_/g`), the validate would have failed:

```bash
$ npm run regret:validate


🔍 Validating 1 cluster(s)...

  ❌ format-period                       12d5tvu → k8m2xpr     FAIL

──────────────────────────────────────────────────────────────────
❌ 1/1 FAILED.

  • format-period
    Expected: 12d5tvu  Got: k8m2xpr
```

In this case, since the behavior change is intentional (removing all underscores is the correct behavior), we update the golden with a documented reason:

```bash
$ npm run regret:update -- format-period --reason "changed to replace all underscores with regex /_/g instead of only the first occurrence per requirements"

🔄 Update mode — cluster: format-period
   Reason: changed to replace all underscores with regex /_/g instead of only the first occurrence per requirements

$ npm run regret:validate


🔍 Validating 1 cluster(s)...

  ✅ format-period                       k8m2xpr                PASS

──────────────────────────────────────────────────────────────────
✅ All 1 tests passed. Refactor is safe.
```

The `audit.log` now records:

```
2025-03-01T15:00:00Z  UPDATE  format-period
  old: 12d5tvu
  new: k8m2xpr
  reason: changed to replace all underscores with regex /_/g instead of only the first occurrence per requirements
  by: AI refactor session
```

---

## Step 9 — All Green, Ship It

Final checklist:

```bash
$ npm run regret:drift

  ✅ format-period                       k8m2xpr  × 5  PASS+STABLE

$ npm run regret:health

CLUSTER HEALTH REPORT
─────────────────────────────────────────────────────
cluster                    updates  drifts  age      health
format-period              1        0       today    ███░░░ UNSTABLE

─────────────────────────────────────────────────────
```

One update (intentional, with audit trail), zero drifts. The `UNSTABLE` label is just because the cluster is new — it will improve over time.

Now do the full production build and push:

```bash
$ npm run build
$ git add regrets/
$ git commit -m "refactor: add null guard to formatPeriod with regret validation"
```

**Ship it.** 🚀

---

## Summary of the Flow

| Step | Command | What It Does |
|------|---------|-------------|
| 1 | `node scripts/init.js` | Scaffold `regrets/` directory |
| 2 | Edit `regrets/manifest.json` | Define clusters and test inputs |
| 3 | `npm run regret:build` | Compile TypeScript to JS |
| 3 | `npm run regret:capture` | Capture golden fingerprints |
| 4 | Inspect `.regret` files | Verify the captured contract |
| 5 | `npm run regret:drift` | 5-run stability check |
| 6 | `npm run regret:health` | Cluster health report |
| 7 | Refactor the code | Make your changes |
| 7 | `npm run regret:build` | Rebuild after refactor |
| 8 | `npm run regret:validate` | Confirm outputs unchanged |
| 9 | `npm run build && git push` | Full build and ship |

**The golden rule:** If validate fails, fix the CODE — never edit `.regret` files. If the behavior change is intentional, use `--update` with a reason to maintain the audit trail.

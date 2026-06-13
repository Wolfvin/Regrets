# Phase Instructions — Regression Testing

## PHASE 1: AUDIT (Never skip this)

### Step 1.1 — Analyze the codebase

Before touching anything, AI reads and maps:
- Entry points (exported functions, event listeners, API handlers)
- Large files (>200 lines = refactor candidate)
- God objects (files that import many others)
- Clusters: groups of functions that work together toward one output

Ask: *"What are the distinct behavioral contracts this code fulfills?"*
Each contract = one future `.regret` file.

### Step 1.2 — Write the manifest

Create `regrets/manifest.json`. For each cluster:

```json
{
  "clusters": [
    {
      "id": "descriptive-kebab-case-name",
      "entry": "topLevelFunctionName",
      "watches": ["fn1", "fn2", "fn3"],
      "file": "relative/path/to/source.js",
      "stack": "js",
      "description": "One sentence: what contract does this cluster fulfill?"
    }
  ]
}
```

Rules for good clusters:
- One cluster = one user-visible behavior or data transformation
- `watches` should include all functions that contribute to the output
- `entry` is the outermost function — the one that kicks off the cluster
- Cluster IDs become `.regret` filenames — name them semantically

### Step 1.3 — Run capture

```bash
node scripts/capture.js
```

This will:
1. Read `regrets/manifest.json`
2. Ghost-wrap all watched functions via Proxy
3. Execute the entry point with representative inputs
4. Record (INPUT, OUTPUT) for each watched function
5. Compute fingerprint
6. Write `regrets/<cluster-id>.regret`

### Step 1.4 — GATE: Validate before proceeding

```bash
node scripts/validate.js
```

**ALL tests must be green before PHASE 2 begins.**

If any are red at this stage, it means the capture failed or inputs were wrong.
Fix the manifest/inputs — not the `.regret` file (there's nothing to protect yet anyway).

---

## PHASE 2: REFACTOR

Now AI has a safety net. Refactor freely.

### What AI should do:

**Split god objects**
- If a file imports 10+ things and orchestrates them all → split it
- Coordinator stays thin, logic moves to dedicated modules

**Break big functions**
- Functions over ~30 lines → candidates for extraction
- Extract pure sub-functions with clear names

**Enforce single responsibility**
- One file = one concept
- No file should need to change for two unrelated reasons

**Rename for intent**
- `processData()` → `normalizeInvoiceAmounts()`
- `helper.js` → `date-formatter.js`

**Isolate side effects**
- Pure logic (transform, calculate, validate) → pure functions
- Side effects (fetch, write, DOM) → boundary layer

### What AI must NOT do during PHASE 2:
- Edit any file inside `regrets/`
- Change the behavioral contract of watched functions
- Remove watched functions without replacing their contract

---

## PHASE 3: VALIDATE

After every refactor batch:

```bash
node scripts/validate.js
```

Output format:
```
✅ transform-user-data     9jadb → 9jadb  PASS
✅ fetch-invoice           x7k2m → x7k2m  PASS  
❌ login-flow              ab91c → ff33z  FAIL
```

### If any test is RED:

1. Read the failing `.regret` — understand what the expected INPUT/OUTPUT was
2. Trace through the refactored code with that input mentally
3. Find where the output diverged
4. Fix the code
5. Re-run validate
6. Repeat until all green

**Never edit the `.regret` file to make a test pass.**
If you're tempted to do that, it means your refactor changed behavior — that's a bug, not a test problem.

### Definition of Done

```
node scripts/validate.js

All 8 tests passed. ✅
Refactor is safe.
```

Every `.regret` fingerprint matches. Ship it.

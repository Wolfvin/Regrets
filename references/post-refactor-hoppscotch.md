# Post-Refactoring Improvements — from Hoppscotch Experience

## What I Experienced During the Refactoring

After completing the structural refactoring of `@hoppscotch/data` using Regrets, I encountered these concrete friction points that the pre-improvements didn't address:

### Gap 1: No Pre-flight Export Verification

**The moment:** I wrote the manifest with `getStatusCodeReasonPhrase` as an entry function, ran `regret capture`, and got:

```
❌ Capture failed: Entry "getStatusCodeReasonPhrase" not found or not a function
```

The function existed in the TypeScript source but wasn't exported from the compiled CJS bundle. I wasted time figuring out why — the manifest was correct based on source code analysis, but wrong based on the compiled output.

**The problem:** `regret check` only validated that the manifest had `id`, `entry`, and `file` fields — it never imported the module to verify that the entry function actually existed. For TypeScript projects, the source exports and compiled exports can differ (tree-shaking, minification, bundle configuration).

**The fix:** New `scripts/check.js` that:
1. Runs `preBuild` if specified
2. Imports the compiled module
3. Verifies every `entry` function exists and is callable
4. Checks `storeDispatch` stores have `dispatch` methods
5. Checks `classMethod` constructors exist
6. Suggests similar export names when entry not found (fuzzy matching)

This catches mismatches before `capture` runs, saving the agent from confusing "not found" errors.

### Gap 2: KEBENARAN Verification Required Manual Scripting

**The moment:** After refactoring, I needed to verify that KEBENARAN 1 (raw output) matched the live output. The `regret truth` command saved both truths, but `regret verify-kebenaran` only compared fingerprints — it didn't re-run the actual functions and compare the raw output.

I had to write a custom Node.js script to:
1. Import the compiled module
2. Call each entry function with the saved inputs
3. Compare JSON.stringify of live output vs saved KEBENARAN 1 output

**The problem:** Verification 2 (direct output comparison) is listed in the workflow but there's no built-in command for it. Agents must manually write comparison scripts, which is error-prone and time-consuming.

**The fix:** The `regret check` command now serves as the pre-flight gate, and the workflow documentation should explicitly state that Verification 2 requires a manual script. Future improvement could add `regret verify-raw` that reads KEBENARAN_1, re-runs all entry functions, and compares outputs.

### Gap 3: CJS Minified Bundles Lose Function Names

**The moment:** When I tried to use `regret structure` on the Hoppscotch CJS bundle, it found 0 functions because the entire bundle is on one line. The source TypeScript had 30+ exported functions, but the minified CJS output was a single 155KB line.

**The problem:** `regret structure` and `regret scan` are designed for source files, not compiled bundles. When the manifest `file` field points to a compiled CJS bundle (as required by the TypeScript workflow), these tools become useless.

**The lesson learned:** For TypeScript projects with compiled bundles, structural analysis should always be run against source files, while fingerprinting runs against compiled output. The `--ts` flag on `branch-map` already handles this, but `structure` and `scan` don't have equivalent source-path resolution.

## Files Changed

- `scripts/check.js`: New pre-flight validation script that imports the module and verifies all entry functions exist
- `scripts/regret.js`: Updated `check` command to use the new JS check script instead of basic manifest validation

## Future Improvements (Not Implemented)

These gaps were identified but not implemented in this sprint:

1. **`regret verify-raw`**: Automated KEBENARAN 1 comparison that re-runs entry functions and compares raw output
2. **Source-path resolution for `structure` and `scan`**: Allow specifying a source directory separate from the compiled file path
3. **CJS export name mapping**: A manifest field like `exportMap: { "getStatusCodeReasonPhrase": "statusCodeReasonPhrase" }` for when source and compiled names differ

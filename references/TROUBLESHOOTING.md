# Troubleshooting Guide

Common issues encountered during regret-based regression testing, with causes and solutions.

---

## Capture failed: Entry not found

**Problem:** Running `npm run regret:capture` produces `❌ Capture failed: Entry "processUser" not found or not a function in src/user/processor.js`.

**Cause:** The `entry` field in your manifest cluster does not match any named export in the target file. This typically happens when: the function is a default export but you used a named reference; the function name was renamed during a refactor; or the compiled JS file uses a different export name than the TypeScript source.

**Solution:**
1. Open the compiled `.js` file (not the `.ts` source) and verify the exact export name: `grep "export" src/user/processor.js`.
2. If the function is a default export, use `"entry": "default"` or check what name the transpiler assigned.
3. Run `npm run regret:build` again if you recently changed the source — the compiled JS might be stale.
4. For TypeScript projects, ensure `"declaration": true` and `"esModuleInterop": true` in `tsconfig.json` so exports are predictable.

---

## Capture failed: Watch target is not a function

**Problem:** Capture errors with `Watch target "helperFn" is not a function` even though the function exists in the module.

**Cause:** The Ghost Proxy can only wrap function exports. If a watch target is a constant, class, or non-function export, the proxy cannot intercept it. This also occurs when a watched function is defined inside another function (closure) and is not a module-level export.

**Solution:**
1. Check that every name in `watches` is a function exported at the module's top level.
2. Remove non-function exports from the `watches` array — only functions can be ghost-proxied.
3. If the function is a closure-internal helper, extract it to the module level and export it so the proxy can wrap it.
4. Use `fingerprintLevel: "entry"` instead of `"full"` if you only need the entry point's output and do not need to trace internal calls.

---

## Drift detected on stable cluster

**Problem:** `npm run regret:drift` reports drift on a cluster that has been stable for weeks — hashes differ across the 5 runs without any code changes.

**Cause:** Hidden non-determinism in the code path. Common culprits include: `Date.now()` or `new Date()` producing different timestamps across runs; `Math.random()` or UUID generation; global mutable state modified by another cluster's test run; or network/API calls that return varying responses.

**Solution:**
1. Add `"normalize": ["timestamps"]` to the cluster in `manifest.json` if the output contains ISO datetime strings.
2. Add `"normalize": ["uuids"]` if the output contains UUID v4 values.
3. Add `"normalize": ["dynamicDates"]` for embedded date patterns like `MMYYYY` in filenames.
4. Use `"ignoreFields": ["updatedAt", "requestId"]` to strip non-deterministic fields before hashing.
5. If the function hits a network endpoint, mock it or extract the pure logic into a separate module.
6. Re-run `npm run regret:capture` after adding normalize rules, then `npm run regret:drift` again.

---

## Fingerprint mismatch after refactor

**Problem:** `npm run regret:validate` shows `❌ FAIL` with different golden vs live hashes after a refactor, but you are certain the output is identical.

**Cause:** The fingerprint algorithm hashes `JSON.stringify` of both input and output. Even a tiny difference — key ordering, trailing whitespace, `undefined` vs `null`, or a numeric precision change — will produce a different hash. Also, if `fingerprintLevel` is `"full"`, the entire call sequence is hashed, and internal restructuring changes the recorded calls even if the final output is the same.

**Solution:**
1. Run `npm run regret:validate` with a single cluster to isolate the failing one: `--cluster my-cluster`.
2. Open the `.regret` file and compare the `INPUT` and `OUTPUT` lines against the live output printed by validate.
3. Check for key ordering differences — the hasher sorts keys, but deeply nested structures may differ.
4. If you changed `fingerprintLevel` from `"entry"` to `"full"` (or vice versa), re-capture to align the golden hash.
5. If the output genuinely changed due to an intentional behavior change, use `npm run regret:update -- <cluster-id> --reason "describe the intentional change"` to update the golden with an audit trail.

---

## Python module import failed

**Problem:** Running capture or validate with `stack: "python"` fails with `ModuleNotFoundError: No module named 'my_module'`.

**Cause:** The Python runner uses `importlib` to dynamically import the target module. The `module` field in the manifest uses dot notation (e.g., `"invoice.processor"`), and the import path must be resolvable from `sys.path`. If `pythonPath` is not set correctly, or the module directory lacks an `__init__.py`, the import will fail.

**Solution:**
1. Ensure the directory containing your module has an `__init__.py` file (even an empty one).
2. Set `"pythonPath"` in the manifest cluster to the directory that should be added to `sys.path` — typically `"src/"` or `"."`.
3. Verify the `module` field uses correct dot notation: `"invoice.processor"` maps to `invoice/processor.py`.
4. Test the import manually: `cd <project-root> && python3 -c "from invoice.processor import process_invoice"`.
5. If using a virtual environment, ensure the regret scripts are invoked with the correct Python interpreter (check the `python3` path).

---

## React component not found

**Problem:** Validating a React cluster fails with `Component "InvoiceCard" not found in src/components/InvoiceCard.tsx`.

**Cause:** The React validator uses dynamic import on the compiled `.js` file, not the `.tsx` source. If TypeScript has not been compiled, or the compiled file is in a different location (e.g., `dist/` instead of `src/`), the import fails. Also, React components using default exports may not match the `entry` name in the manifest.

**Solution:**
1. Run `npm run regret:build` to compile TypeScript before capture/validate.
2. Ensure the `file` field points to the compiled `.js` output, not the `.tsx` source.
3. If the component uses `export default`, set `"entry": "default"` in the manifest.
4. For named exports, verify the exact export name in the compiled JS: look for `exports.InvoiceCard = ...` or `export { InvoiceCard }`.
5. If using path aliases (e.g., `@/components/`), ensure `tsconfig.json` paths are resolved during compilation, or use relative paths in the manifest.

---

## npm run regret:capture fails with module not found

**Problem:** Running any regret npm script fails immediately with `Error: Cannot find module '../../The-skill/regresion-testing/scripts/regret.js'`.

**Cause:** The npm scripts in `package.json` use relative paths to locate the skill's scripts. If the target project is moved, or the skill directory is relocated, these paths break. This also happens if the npm script path does not match the actual directory structure.

**Solution:**
1. Verify the relative path from your project root to the skill directory: `ls ../../The-skill/regresion-testing/scripts/regret.js`.
2. Adjust the npm script paths in `package.json` to match your actual directory layout.
3. Alternatively, use the `--manifest` flag to explicitly specify the manifest location: `node /absolute/path/to/scripts/regret.js capture --manifest ./regrets/manifest.json`.
4. For monorepos, consider using workspace-relative paths or installing the skill as a local dependency.

---

## audit.log grows too large

**Problem:** The `regrets/audit.log` file has grown to several megabytes after many update cycles, slowing down the health check.

**Cause:** Every `--update` and drift event appends to `audit.log` without rotation. Over many refactor sessions with frequent updates and drifts, the file accumulates continuously. The health check reads the entire file each time.

**Solution:**
1. Archive old entries periodically: `cp regrets/audit.log regrets/audit-$(date +%Y%m%d).log` then truncate the active file, keeping only recent entries.
2. To truncate safely, keep the last N blocks: `tail -200 regrets/audit.log > regrets/audit.log.tmp && mv regrets/audit.log.tmp regrets/audit.log`.
3. Add `regrets/audit-*.log` to `.gitignore` so archived logs are not committed.
4. The health score algorithm primarily weights recent events — old archived entries have diminishing impact, so pruning them does not distort scores.
5. Consider adding a log rotation step to your CI pipeline or a pre-commit hook.

---

## .regret file appears corrupted

**Problem:** Validate fails with `SyntaxError: Unexpected token` or `Cannot read property` when parsing a `.regret` file.

**Cause:** The `.regret` file format requires strict structure: metadata lines above a `---` separator, then `INPUT`, `OUTPUT`, and `HASH` lines below. Corruption occurs when: a `--reason` string with newlines was used in update mode (newlines break the key-value format); manual editing introduced syntax errors; or a git merge conflict left conflict markers in the file.

**Solution:**
1. Open the corrupted `.regret` file and inspect for: missing `---` separator, unescaped newlines in metadata values, or git conflict markers (`<<<<<<<`, `=======`, `>>>>>>>`).
2. If the `OUTPUT` line contains broken JSON, the output likely included newlines — fix the source function to not produce newlines in serialized output, then re-capture.
3. Never manually edit `.regret` files. If a file is corrupted, delete it and re-run `npm run regret:capture` to regenerate.
4. The `--reason` flag in update mode sanitizes newlines, but older versions may not have — upgrade to the latest scripts if this is the cause.
5. After re-capturing, always run `npm run regret:drift` to confirm stability before proceeding.

---

## Cross-stack hash mismatch between JS and Python

**Problem:** The same function fingerprinted in both JS and Python produces different hashes for identical input/output data.

**Cause:** The fingerprint algorithm depends on `JSON.stringify` with sorted keys, but JavaScript and Python serialize JSON differently: Python uses `True`/`False`/`None` while JS uses `true`/`false`/`null`; Python may include trailing whitespace or different numeric formatting (e.g., `1.0` vs `1`); and key sorting may handle Unicode or nested structures differently across runtimes.

**Solution:**
1. Both the JS (`fingerprint.js`) and Python (`fingerprint.py`) implementations use `json.dumps(sort_keys=True)` / `JSON.stringify` with key sorting — verify you are using the latest versions of both scripts.
2. Check for boolean/null differences: ensure Python data uses `True`/`False`/`None` and JS uses `true`/`false`/`null` — the serialization layer should handle this automatically.
3. For numeric precision issues (e.g., `1.0` vs `1`), add a normalize rule or round numbers in the function output before fingerprinting.
4. Run the integration test suite (`npm run regret:test`) — it includes cross-stack parity checks that will flag any algorithm divergence.
5. If the mismatch persists, compare the intermediate `INPUT_HASH` and `OUTPUT_HASH` from both stacks to isolate whether the issue is in input serialization or output serialization.

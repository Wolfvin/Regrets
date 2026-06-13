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

---

## Go capture fails: go not found

**Problem:** Running `bash scripts/capture_go.sh capture` produces `⚠️ Go is not installed.`

**Cause:** The Go toolchain (`go` binary) is not installed on the system, or not in the PATH. The Go stack requires the Go compiler and `go test` tool to generate and run capture tests.

**Solution:**
1. Install Go from https://go.dev/dl/ or via your package manager (`apt install golang-go`, `brew install go`, etc.).
2. Verify installation: `go version` should output a version string.
3. Ensure the project's `go.mod` file exists and dependencies are resolved: `go mod tidy`.
4. Re-run capture after installing Go.

---

## Go capture: generated test file has compilation errors

**Problem:** The generated `regret_capture_test.go` file fails to compile with errors like `undefined: ToValidBF` or `cannot import package`.

**Cause:** The generated test file references functions and packages based on the manifest configuration, but the `goPackage` path is incorrect, or the function is unexported (lowercase in Go), or the test file is in the wrong package. Go requires that: the import path matches the `go.mod` module declaration; exported function names start with uppercase letters; and test files in the same package can access unexported functions.

**Solution:**
1. Verify `goPackage` matches the module path in `go.mod` plus the subdirectory: if `go.mod` says `module github.com/user/repo` and the file is at `lang/readcode/read.go`, then `goPackage` should be `"github.com/user/repo/lang/readcode"`.
2. For unexported functions (lowercase first letter), the test file must be in the same Go package (use `package readcode` not `package readcode_test`).
3. Check that the function name in `entry` matches the exact Go function name including case.
4. Run `go build ./...` from the project root to verify all packages compile before running capture.

---

## Go cluster: function has multiple return values

**Problem:** The target Go function returns multiple values (e.g., `func MatchLoopIndices(index int, code string) (int, int, string)`) and the capture fails because the fingerprinter expects a single JSON-serializable value.

**Cause:** The fingerprint algorithm serializes output to JSON. Go's multiple return values are not a single JSON-serializable object by default. They need to be wrapped into a struct.

**Solution:**
1. In the generated test file, wrap the multiple return values into a struct before fingerprinting:
```go
type MatchLoopIndicesResult struct {
    Start int    `json:"start"`
    End   int    `json:"end"`
    Expr  string `json:"expr"`
}
start, end, expr := interpreter.MatchLoopIndices(0, "++[>++<-]")
result := MatchLoopIndicesResult{Start: start, End: end, Expr: expr}
fp := fingerprint(input, result)
```
2. Alternatively, add a `resultWrapper` field to the manifest cluster definition to specify the struct type name.
3. See `references/go.md` for the full multi-return-value handling pattern.

---

## Go cluster: function is a method on a struct

**Problem:** The target function is a method (has a receiver) like `func (ctx *BfContext) EvalExprWithContext(code string)`, but the manifest `entry` field only specifies function names.

**Cause:** Go methods require a receiver instance to call. The capture script needs to know how to construct the receiver before calling the method.

**Solution:**
1. Add the `receiver` field to the manifest cluster to specify the constructor function:
```json
{
  "id": "eval-expr",
  "entry": "EvalExprWithContext",
  "receiver": "NewBfContext",
  "stack": "go"
}
```
2. The capture script generates code that calls `receiver()` to create the struct, then calls `entry()` on it.
3. For methods that modify struct state (like `EvalExprWithContext`), consider extracting the pure logic into a standalone function for easier fingerprinting. See `references/go.md` for pure logic extraction patterns.

---

## Cross-stack hash mismatch between JS and Go

**Problem:** The same function fingerprinted in both JS and Go produces different hashes for identical input/output data.

**Cause:** The fingerprint algorithm depends on stable JSON serialization with sorted keys. Go's `encoding/json` and JS's `JSON.stringify` handle edge cases differently: Go uses `null` for nil pointers, `true`/`false` for booleans; numeric formatting may differ (e.g., `1e+06` vs `1000000`); and `stableStringify` in Go must exactly mirror the JS implementation's handling of types.

**Solution:**
1. Both the JS (`fingerprint.js`) and Go implementations use `stableStringify` with sorted keys — verify you are using the latest versions.
2. Check for type mismatches: Go `int` values may serialize differently than JS `number`. Use `float64` for all numeric values in the Go fingerprint to match JS behavior.
3. For multiple return values, ensure the wrapper struct uses consistent JSON field names and ordering.
4. Run the cross-stack parity test: `go test -run TestCrossStackParity` in the generated test file.
5. Compare the intermediate `combined` string (before hashing) from both stacks to isolate where serialization diverges.

---

## TypeScript project: import pkg from package.json fails

**Problem:** Running capture or validate on a TypeScript project fails with `ERR_IMPORT_ATTRIBUTE_MISSING: Module "file:///path/to/package.json" needs an import attribute of "type: json"`, or similar errors related to importing `package.json` from TypeScript source.

**Cause:** Node.js 22+ (and especially Node.js 24+) enforces import attributes for JSON modules. When a TypeScript source file imports `package.json` (e.g., `import pkg from '../package.json'`), the compiled JS output does not include the required `with { type: 'json' }` import attribute that Node.js demands. This causes the dynamic import in capture.js to fail when loading the module.

**Solution:**
1. **Point manifest `file` to sub-modules instead of the main index.** If the main `index.ts` imports `package.json`, use individual sub-modules that do not have this import issue. For example, instead of `"file": "dist/index.js"`, use `"file": "dist/batur.js"` or `"file": "dist/silpin.js"` where the functions are actually defined.
2. **Use `resolveJsonModule` in `tsconfig.json`.** Ensure `"resolveJsonModule": true` is set, though this alone does not fix the Node.js attribute requirement.
3. **Avoid importing `package.json` in library code.** Extract version information to a separate constant file (e.g., `version.ts` that exports the version string directly) instead of importing from `package.json`.
4. **Use the `--manifest` flag** to explicitly specify the manifest location if path resolution is affected.
5. For Node.js 24+, consider adding `--experimental-json-modules` flag, though this is not a long-term solution.

---

## Async functions returning Promises

**Problem:** Capture or validate on async functions that return `Promise<T>` appears to hang, or the fingerprint is incorrect.

**Cause:** The Ghost Proxy in `ghost.js` handles promises transparently — it awaits resolution before recording the result. However, if the async function never resolves (e.g., a missing `resolve()` call in a manually-constructed Promise), the capture will hang indefinitely. Also, if the function throws inside a Promise constructor without proper rejection, the error may be silently swallowed.

**Solution:**
1. Ensure all async entry functions properly resolve or reject. Avoid the `new Promise((resolve, reject) => { ... })` anti-pattern when `async/await` can be used instead.
2. The ghost proxy correctly handles `Promise` return values — no special manifest configuration is needed for async functions.
3. If capture hangs, add a timeout: `timeout 30s node scripts/capture.js` to identify which cluster is stuck.
4. For functions that wrap synchronous logic in unnecessary Promises (common in older codebases), consider refactoring to use `async/await` instead of `new Promise()` — this makes the code easier to test and debug.
5. The fingerprint is computed on the **resolved** value, not the Promise object itself. The ghost proxy awaits the Promise before recording.

---

## Clustering functions from the same file

**Problem:** Multiple clusters reference the same `file` (e.g., several functions exported from `utils.js`), and capture/validate works for some but not others.

**Cause:** This is fully supported — each cluster independently imports the module and creates its own ghost proxy. However, if functions in the same file share mutable state (global variables, module-level caches), running them sequentially during capture may cause cross-contamination where one cluster's execution affects another's output.

**Solution:**
1. This pattern is fine for pure functions — each cluster gets its own recorder and its own ghost proxy instance.
2. If functions share mutable state, consider using `"fingerprintLevel": "entry"` to only hash the final output, not the internal call sequence.
3. Run drift detection (`--runs 5`) after capture to catch any instability from shared state.
4. If drift is detected, isolate the problematic cluster by running `--cluster <id>` individually and comparing results.
5. For modules with many exports, consider splitting into smaller files with single responsibilities — this also makes refactoring easier.

---

## Working with TypeScript sub-modules (compiled output)

**Problem:** The main `index.ts` barrel file re-exports from sub-modules, but importing it in the manifest fails due to complex dependency chains or package.json imports. You want to test functions defined in sub-modules directly.

**Cause:** TypeScript projects often use barrel files (`index.ts`) that re-export everything from sub-modules. When the barrel file has problematic imports (like `package.json`), the entire module becomes unloadable. However, the individual sub-modules (`batur.js`, `silpin.js`, etc.) may work perfectly fine on their own.

**Solution:**
1. Point the manifest `file` field directly to the compiled sub-module: `"file": "dist/silpin.js"` instead of `"file": "dist/index.js"`.
2. Use the function's exact export name from the sub-module as the `entry` field.
3. When the same function is re-exported from the barrel file with an alias (e.g., `export { cariKurupTaun as cariKurupTahunJawa }`), use the **original** name from the sub-module, not the alias.
4. This approach actually provides better isolation — each cluster only loads what it needs, avoiding side effects from unrelated module initialization.
5. After refactoring, if you extract new functions into their own modules, add new clusters pointing to those modules directly.

---

## Capture failed: BigInt cannot be serialized

**Problem:** Running `npm run regret:capture` produces `TypeError: Do not know how to serialize a BigInt` when capturing a cluster whose entry function returns a BigInt value, or when a watched function accepts/returns BigInt.

**Cause:** The fingerprint algorithm uses `JSON.stringify` (via `stableStringify`) to serialize inputs and outputs. JavaScript's `JSON.stringify` throws a `TypeError` when encountering BigInt values, as there is no standard JSON representation for arbitrary-precision integers.

**Solution:**
1. **Create adapter functions** that wrap the BigInt-based function, converting BigInt inputs/outputs to/from string representations:
   ```js
   // Original: encodeL returns BigInt
   export const encodeL = uint8Array =>
     uint8Array.reduce((l, b) => l * 256n + BigInt(b) + 1n, 0n)

   // Adapter: converts BigInt output to string (JSON-serializable)
   export const encodeLToString = uint8Array => String(encodeL(uint8Array))

   // Adapter: converts string input to BigInt (JSON-serializable)
   export const decodeLFromString = bigintStr => decodeL(BigInt(bigintStr))
   ```
2. Use the adapter functions as the `entry` in your manifest cluster instead of the original BigInt-based functions.
3. The original functions remain unchanged and can still be called directly — the adapters only exist for fingerprint compatibility.
4. See `references/base1.md` for a complete worked example with the qntm/base1 library.

---

## Watched function never called during capture

**Problem:** The capture log shows `⚠️ Watched function(s) never called during capture: someInternalFn` even though the function is clearly called when the entry point runs.

**Cause:** The Ghost Proxy wraps module-level exports. When function A calls function B internally (direct reference within the same module), the call bypasses the proxy because it uses the original function reference, not the proxied one. This is a fundamental limitation of the JavaScript Proxy pattern — proxies only intercept access through the proxy object, not through captured closures or direct internal references.

**Solution:**
1. Use `fingerprintLevel: "entry"` and only list the entry function in `watches` — you don't need to watch internal helpers when you're only fingerprinting the entry output.
2. If you truly need to observe internal calls, refactor to use dependency injection: pass the internal function as a parameter so it can be intercepted.
3. For cross-module calls where function A imports function B from another module, use the re-export pattern documented in `references/braille-encode.md`.
4. Remove internal function names from the `watches` array to eliminate the warning.


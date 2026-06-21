# Issue Verification Batch — 2026-06-21

**Scope:** #261, #268, #270, #271 — four oldest open non-claim issues (excluding Known Gaps from `CONTEXT.md`).

**Method:** Each issue was re-reproduced against current `main` (commit `66cef19`) using the exact commands from the issue body, then mapped to its fix commit/PR and existing regression test. Decisions are recorded below in the format required by the BOS spec (`Fixed` / `Updated` / `Skipped (expired)`).

---

## Updated #261 — `capture.js` crashes with `TypeError` when `watches` field is missing

**Issue (original report):** `capture.js` threw `Cannot read properties of undefined (reading 'join')` at line 253 when a manifest cluster omitted `watches`, because the destructuring had no default. The `watches` field is documented as optional and `install.js` always writes `watches: []`, but manually-authored manifests could trigger the crash.

**Verification (2026-06-21):** Re-ran the exact reproduction from the issue body. `node scripts/capture.js` exits 0 and writes `regrets/main.regret` + `regrets/main.calls.add.regret`. The cluster log line now reads `Watches: ` (empty, from the default) instead of throwing.

**Root cause + fix:** `capture.js:276` now destructures `watches = []` (default empty array). This fix landed in PR #307 (`fix(capture,ghost,validate): close #295 #298 #300 #301 #261`, merged 2026-06-20).

**Regression test:** `tests/capture-ghost-fixes.test.js` — `describe('#261: capture.js defaults missing "watches" to [] (no crash)')` at line 75. The test builds the exact fixture from the issue (no `watches` field) and asserts the capture succeeds.

**Decision:** `Updated` — verified already fixed in `main`. No code change needed; this PR adds the cross-reference doc and the verification log only. Recommend closing the issue as fixed by #307.

---

## Updated #268 — `regret install --scope` produces empty manifest when trivial guard skips all clusters (callees info lost)

**Issue (original report):** When ALL clusters were skipped by the trivial-output guard (e.g. a math library where `[null, {}]` inputs produce `NaN`), `install.js` wrote `{"clusters": []}` to `manifest.json`, discarding all auto-detected `callees` info. The user had to manually recreate the entire manifest, including callees.

**Verification (2026-06-21):** Re-ran the exact reproduction from the issue body with a `math.js` containing `add`/`multiply`/`main` (where `main` calls `add` + `multiply`). Result:

- `install --scope math.js` exits 0
- 2 clusters captured (`math-add`, `math-main`); 1 cluster skipped (`multiply` — `NaN` output)
- `regrets/manifest.json` is written with 2 clusters, and `math-main` correctly has `"callees": ["add", "multiply"]`
- The skipped `multiply` cluster is NOT silently dropped — its definition (with callees) is preserved

When ALL clusters are skipped (the original bug scenario), `install.js` no longer writes an empty manifest. Instead it writes `regrets/install-skipped.txt` containing the full cluster definitions (with auto-detected callees), and prints a clear "Next steps" section pointing the user at editing inputs and running `regret capture`.

**Root cause + fix:** `install.js` was restructured to (a) preserve skipped cluster definitions in `regrets/install-skipped.txt` and (b) refuse to write an empty `manifest.json` when no clusters survived the trivial guard. This fix landed in PR #312 (`fix(install): close red-team #265, #268, #270, #294, #296, #297`, merged 2026-06-20).

**Regression test:** `tests/install-red-team.test.js` — `describe('#268 — all clusters trivial-skipped: no empty manifest, callees preserved')` at line 226. Asserts that `install-skipped.txt` exists, lists all 3 clusters, and contains `"callees":\s*\[\s*"add"\s*\]` for the main cluster.

**Decision:** `Updated` — verified already fixed in `main`. No code change needed. Recommend closing the issue as fixed by #312.

---

## Updated #270 — `install.js` discards analyzer method-call edges for class-based code

**Issue (original report):** `analyzer.js` correctly produced method-call edges like `{from: 'multiply', to: 'add'}` for `this.add(...)` inside a `Calculator.multiply()` method. But `install.js`'s callee-computation loop filtered edges with `e.from === fnName` where `fnName` came from `extractExportedFunctions` (which only sees top-level `module.exports = { Calculator }` — the class name, not the method names). Result: the `Calculator` cluster was created with NO `callees` field, silently dropping the analyzer's work.

The issue listed three fix directions:
1. Per-method cluster generation (with `classMethod` config) — most correct, but a deeper change
2. Surface a warning when method-call edges are detected but the cluster is a class
3. Separate pass that detects `class X { method() { this.other() } }` and emits class-method clusters directly

**Verification (2026-06-21):** Re-ran the exact reproduction from the issue body with `calculator.js` containing `class Calculator { add(...) multiply(...) }` and `module.exports = { Calculator }`.

- `install --scope calculator.js` exits 0
- The Calculator cluster is trivial-skipped (calling `new Calculator(null, {})` is treated as trivial), but its definition (with callees) is preserved in `regrets/install-skipped.txt`
- The skipped log explicitly lists `Callees: add` for the calculator cluster
- The JSON cluster definition in the log includes `"callees": ["add"]`

**Root cause + fix (partial):** `install.js` now detects top-level class declarations and their method names via `detectClassMethods()` (line ~481). When computing callees for a cluster whose `entry` is a class name, it includes edges whose `from` is ANY method of that class — so the `multiply -> add` edge is now surfaced as `callees: ["add"]` on the `Calculator` cluster. This fix landed in PR #312 (same as #268).

**What is NOT done:** Fix direction #1 (per-method cluster generation with `classMethod` config) was deliberately deferred — it would require deeper changes to `capture.js`'s class-method handling. The current behavior attaches method-derived callees to the class-level cluster, which means `regret validate` will re-invoke the class constructor (not the individual methods) — so the callee contracts are written but not automatically re-validated per-method.

**Improvement added in this PR:** A new info message in `install.js` (around line 1260) makes this limitation discoverable. When a class-level cluster has method-derived callees, install now prints:

```
   ℹ️  Cluster "<id>" is a class with method-derived callees [add, ...].
      These are preserved for visibility but NOT auto-re-validated.
      For full callee re-validation, add per-method clusters with "classMethod" config.
```

This addresses fix direction #2 (warning) from the issue. Fix direction #1 (per-method clusters) remains a separate feature request.

**Regression test:** `tests/install-red-team.test.js` — `describe('#270 — class-based code: method-call edges reach cluster callees')` at line 314. Asserts that `install-skipped.txt` lists `add` as a callee of the Calculator cluster, and that install does not crash on various class shapes (Empty, WithStatic, WithExtends).

**Decision:** `Updated` — verified partially fixed in `main` (callees info preserved, but per-method cluster generation is a separate feature). This PR adds the discoverability warning (fix direction #2). The deeper architectural fix (direction #1) is left as a future feature request. Recommend closing #270 with the partial-fix note, or splitting into a new "feat(install): per-method class clusters" issue for direction #1.

---

## Updated #271 — `install.js` regex extractor does not detect `export { foo, bar }` style

**Issue (original report):** `extractExportedFunctions` in `install.js` only matched `export function foo`, `export const foo =`, `export default function foo`, `module.exports.foo =`, and `module.exports = { foo }`. It did NOT match the ESM `export { foo, bar }` re-export form. Files using this style were reported as "0 exported functions" even though `analyzer.js` (AST-based) correctly found the functions.

**Verification (2026-06-21):** Re-ran the exact reproduction from the issue body with `calc.mjs` containing `function square`, `function cube` (with `cube` calling `square`), and `export { square, cube }`.

- `install --scope calc.mjs` exits 0
- Reports `Found 2 exported functions across 1 files`
- `regrets/manifest.json` is written with 2 clusters: `calc-square` and `calc-cube`
- The `calc-cube` cluster correctly has `"callees": ["square"]`

**Root cause + fix:** `extractExportedFunctions` was extended to recognize the `export { name1, name2, ... }` and `export { name1 as alias2, ... }` forms (including `export { default as Name }`). The fix landed in PR #312 (`fix(install): close red-team #265, #268, #270, #294, #296, #297`, merged 2026-06-20) — the same PR that fixed #268 and #270.

**Regression test:** `tests/red-team-fixes.test.js` — `describe('#271: extractExportedFunctions detects export { foo, bar }')` at line 122. Covers simple named export lists, `as` aliases, mixed aliases, `default as Name` re-export, and verifies that `export { }` inside a comment is NOT detected.

**Decision:** `Updated` — verified already fixed in `main`. No code change needed. Recommend closing the issue as fixed by #312.

---

## Summary table

| Issue | Status (verified) | Fixed by | Test file | Decision (this PR) |
|------|-------------------|----------|-----------|----|
| #261 | Fixed             | PR #307  | `tests/capture-ghost-fixes.test.js:75`  | Updated (close) |
| #268 | Fixed             | PR #312  | `tests/install-red-team.test.js:226`    | Updated (close) |
| #270 | Partially fixed   | PR #312 + this PR (warning) | `tests/install-red-team.test.js:314` | Updated (close as partial; split direction #1 into new feature request) |
| #271 | Fixed             | PR #312  | `tests/red-team-fixes.test.js:122`      | Updated (close) |

## Reproduction commands

All reproductions are self-contained and use only `node` + `bash` (no extra toolchains). See the individual issue bodies for the original commands; this document merely confirms each one passes against current `main`.

```
# Setup (once)
cd <regrets-repo>

# #261 — capture without watches field
mkdir -p /tmp/test-261/regrets && cd /tmp/test-261
echo '{"name":"test-261","type":"commonjs"}' > package.json
echo 'function add(a, b) { return a + b }
function main(a, b) { return module.exports.add(a, b) }
module.exports = { add, main }' > math.js
# (write manifest WITHOUT watches — see issue #261 body)
node <regrets-repo>/scripts/capture.js   # exits 0, no TypeError

# #268 — install with all-trivial-skip
mkdir -p /tmp/test-268 && cd /tmp/test-268
echo '{"name":"test-268","type":"commonjs"}' > package.json
echo 'function add(a, b) { return a + b }
function multiply(a, b) { return a * b }
function main(a, b) { return add(a, b) + multiply(a, b) }
module.exports = { add, multiply, main }' > math.js
node <regrets-repo>/scripts/install.js --scope math.js   # writes manifest with 2 clusters + callees

# #270 — class method callees
mkdir -p /tmp/test-270 && cd /tmp/test-270
echo '{"name":"test-270","type":"commonjs"}' > package.json
echo 'class Calculator {
  add(a, b) { return a + b }
  multiply(a, b) { return this.add(a, a) + this.add(b, b) - a - b }
}
module.exports = { Calculator }' > calculator.js
node <regrets-repo>/scripts/install.js --scope calculator.js
# install-skipped.txt preserves Callee: add for Calculator cluster
# (this PR adds the info message about per-method cluster limitation)

# #271 — export { foo, bar } detection
mkdir -p /tmp/test-271 && cd /tmp/test-271
echo '{"name":"test-271","type":"module"}' > package.json
echo 'function square(x) { return x * x }
function cube(x) { return square(x) * x }
export { square, cube }' > calc.mjs
node <regrets-repo>/scripts/install.js --scope calc.mjs   # finds 2 functions, captures both
```

# TypeScript Project Integration

Regrets works with compiled JavaScript. When the target project is written in TypeScript, the fingerprinting pipeline needs a build step before capture/validate.

## Workflow

```
1. Write/modify TypeScript source
2. Compile: npx tsc (produces dist/ directory)
3. Capture: node scripts/capture.js (reads dist/*.js)
4. Validate: node scripts/validate.js (reads dist/*.js)
5. Refactor source → goto step 2
```

## Project Setup

### 1. Compile First

```bash
cd target-project
npx tsc
```

Verify the compiled output exists:
```bash
ls dist/index.js
```

### 2. Adapter Module

If the TypeScript library exports class instances (common with domain models), create an adapter module that bridges the class-based API to plain JSON:

```js
// regret-adapters.mjs (place at project root, NOT in dist/)
import { parseDNA } from './dist/sequence/index.js';

export function adaptParseDNA(input) {
  const result = parseDNA(input);
  if (result.success) {
    return { ok: true, sequence: result.data.sequence };
  }
  return { ok: false, error: result.data };
}
```

Key points:
- The adapter imports from `./dist/` (compiled JS), not `./src/` (TypeScript)
- Place adapters at the project root so `capture.js` can find them
- Adapters are `.mjs` files that use ESM imports (matching the compiled output)

### 3. Manifest Configuration

```json
{
  "clusters": [
    {
      "id": "parse-dna",
      "entry": "adaptParseDNA",
      "watches": ["adaptParseDNA"],
      "file": "regret-adapters.mjs",
      "stack": "js",
      "fingerprintLevel": "entry",
      "inputs": ["ATCG", "atcg", ""]
    }
  ]
}
```

### 4. npm Scripts

Add to `package.json`:

```json
{
  "scripts": {
    "regret:build": "npx tsc",
    "regret:capture": "node /path/to/Regrets/scripts/regret.js capture",
    "regret:validate": "node /path/to/Regrets/scripts/regret.js validate",
    "regret:drift": "node /path/to/Regrets/scripts/regret.js drift",
    "regret:health": "node /path/to/Regrets/scripts/regret.js health"
  }
}
```

### 5. Refactor Cycle

```bash
# After making changes to TypeScript source:
npm run regret:build
npm run regret:validate

# If all green → safe to commit
# If red → fix the TypeScript code, NOT the .regret files
```

## ESM vs CJS

TypeScript projects compiled with `"module": "ES2022"` produce ESM `.js` files with `import/export` syntax. Regrets' `capture.js` uses `dynamic import()` which handles ESM natively.

If the project uses CommonJS (`"module": "CommonJS"`), the adapter module should use `require()` and be named `.js` instead of `.mjs`:

```js
// regret-adapters.js (CommonJS variant)
const { parseDNA } = require('./dist/sequence/index.js');

function adaptParseDNA(input) {
  const result = parseDNA(input);
  // ...
}
module.exports = { adaptParseDNA };
```

## TypeScript Project with Result Monads

Many TypeScript libraries use `Result<T, E>` monads instead of throwing exceptions. These work naturally with Regrets because:

1. `Result.success` → serializes as `{ success: true, data: ... }`
2. `Result.failure` → serializes as `{ success: false, error: ... }`

However, check if the Result implementation uses class instances or plain objects. If it's a class:
```ts
class SuccessResult<T> { constructor(public data: T) {} }
```
Then `JSON.stringify(new SuccessResult(42))` produces `{"data":42}` — the `success` field is lost!

Use an adapter that explicitly converts:
```js
export function adaptParseDNA(input) {
  const result = parseDNA(input);
  if (result.success) {
    return { ok: true, sequence: result.data.sequence };
  }
  return { ok: false, error: result.data };
}
```

## tsconfig.json Requirements

For best results with Regrets, ensure the TypeScript project has:

```json
{
  "compilerOptions": {
    "declaration": true,        // Generates .d.ts files
    "esModuleInterop": true,    // ESM import compatibility
    "outDir": "dist"            // Clean output directory
  }
}
```

The `declaration` flag isn't required by Regrets, but it ensures the compiled output matches the source types.

## CJS Bridge Wrapper Pattern

Many TypeScript projects compile to both ESM and CJS:

```json
{
  "main": "./lib/cjs/index.js",
  "module": "./lib/esm/index.js"
}
```

The ESM output often lacks `.js` import extensions, causing `ERR_MODULE_NOT_FOUND` when Regrets' `capture.js` tries `await import()`. This is a known TypeScript limitation — TS source uses extensionless imports (`import { x } from './utils'`) that compile to the same extensionless form in ESM, which Node.js cannot resolve.

### Solution: CJS Bridge Wrappers

Create thin `.mjs` wrapper files that use `createRequire()` to import from the CJS build:

```js
// regrets/wrappers/us-ssn.mjs
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const ssn = require('../../lib/cjs/us/ssn.js');
export const validate = ssn.validate;
export const format = ssn.format;
export const compact = ssn.compact;
```

### Why This Works

1. `capture.js` uses `await import()` which works with `.mjs` files
2. `createRequire()` bridges from ESM to CJS seamlessly
3. The CJS build has all dependencies bundled with proper `require()` resolution
4. No modifications to the target project's build system needed

### Manifest Configuration

Point the `file` field to the wrapper:

```json
{
  "id": "us-ssn-validate",
  "entry": "validate",
  "watches": ["validate"],
  "file": "regrets/wrappers/us-ssn.mjs",
  "stack": "js",
  "fingerprintLevel": "entry",
  "inputs": ["123-45-6789", "078-05-1120"]
}
```

### Directory Structure

```
target-project/
  regrets/
    manifest.json
    us-ssn-validate.regret
    wrappers/
      us-ssn.mjs          ← CJS bridge wrapper
      id-npwp.mjs
      br-cpf.mjs
      util-checksum.mjs
```

### Important Notes

The wrapper files are created specifically for Regrets testing. They should be committed alongside the `regrets/` directory but are NOT part of the target project's production code.

Only update wrappers if new exported functions are added, the module's export structure changes, or a new module needs to be tested. The wrapper pattern is stable — it simply re-exports what the CJS build provides.

---

## Rebuilding After Refactor

**CRITICAL**: Always rebuild before validating. Regrets reads the compiled `.js` files, not the `.ts` source. If you refactor TypeScript but forget to rebuild, Regrets will validate against the OLD compiled code.

```bash
# WRONG: refactored source but didn't rebuild
vim src/sequence/conversion.ts
node scripts/validate.js  # ← tests OLD compiled code!

# RIGHT: rebuild then validate
vim src/sequence/conversion.ts
npx tsc
node scripts/validate.js  # ← tests NEW compiled code
```

For dual-build projects, rebuild both ESM and CJS:

```bash
npx tsc && npx tsc -p tsconfig-cjs.json
node /path/to/Regrets/scripts/validate.js
```

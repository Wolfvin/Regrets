# TypeScript Project Variant

Applying Regrets to TypeScript projects that compile to both ESM and CJS outputs.
Based on real-world testing against `koblas/stdnum-js`.

---

## The Challenge

Many TypeScript projects compile to both ESM and CJS:

```json
{
  "main": "./lib/cjs/index.js",
  "module": "./lib/esm/index.js"
}
```

The ESM output often lacks `.js` import extensions, causing `ERR_MODULE_NOT_FOUND` when Regrets' `capture.js` tries `await import()`. This is a known TypeScript limitation — TS source uses extensionless imports (`import { x } from './utils'`) that compile to the same extensionless form in ESM, which Node.js cannot resolve.

---

## Solution: CJS Bridge Wrappers

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

---

## Handling Error Objects in ValidateReturn

TypeScript validators often return objects with `error` properties containing `ValidationError` class instances:

```ts
interface ValidateReturn {
  isValid: false;
  error: ValidationError;  // Class instance, not plain object
}
```

When `JSON.stringify()` serializes these, only `{ name: "InvalidComponent" }` is preserved. This is fine for fingerprinting because:
1. The error name is deterministic for the same validation failure
2. The fingerprint captures the structural identity, not the full error stack
3. Both `capture.js` and `validate.js` serialize identically

No special handling needed — Regrets' existing `stableStringify` handles this correctly.

---

## Directory Structure

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
    truths/
      truth1-raw-output.json  ← Ground truth before refactor
      truth2-fingerprint.json ← Fingerprint truth before refactor
```

---

## Build-Capture-Validate Cycle

For TypeScript projects, the cycle becomes:

```bash
# 1. Build TypeScript
npx tsc && npx tsc -p tsconfig-cjs.json

# 2. Capture fingerprints
node /path/to/Regrets/scripts/capture.js

# 3. Validate
node /path/to/Regrets/scripts/validate.js

# 4. Drift test
node /path/to/Regrets/scripts/validate.js --runs 5

# 5. After refactoring, rebuild and re-validate
npx tsc && npx tsc -p tsconfig-cjs.json
node /path/to/Regrets/scripts/validate.js
```

---

## Important Notes

### Wrappers Are Part of the Regrets Contract

The wrapper files are created specifically for Regrets testing. They should be committed alongside the `regrets/` directory but are NOT part of the target project's production code.

### Rebuild After Refactoring

After any TypeScript source change, you MUST rebuild before re-validating:

```bash
npx tsc && npx tsc -p tsconfig-cjs.json
node /path/to/Regrets/scripts/validate.js
```

The wrappers point to the compiled CJS output, so they automatically pick up the latest changes after rebuild.

### When to Update Wrappers

Only update wrappers if:
- New exported functions are added to the target module
- The module's export structure changes
- A new module needs to be tested

The wrapper pattern is stable — it simply re-exports what the CJS build provides.

---

## Case Study: stdnum-js

**Repository**: `koblas/stdnum-js` — National identification number validation for 50+ countries

**Why This Project Was Chosen**:
- Extremely niche domain (national ID validation)
- Pure functions with clear input/output contracts
- Shared `Validator` interface across all country modules
- Rich utility layer (Luhn, Verhoeff, ISO 7064 checksums)
- Active maintenance with comprehensive test suite

**Clusters Created** (7 total):
1. `us-ssn-validate` — US Social Security Number validation
2. `id-npwp-validate` — Indonesian NPWP (VAT) validation
3. `br-cpf-validate` — Brazilian CPF validation
4. `gb-nino-validate` — UK National Insurance Number validation
5. `checksum-luhn` — Luhn checksum validation
6. `checksum-mod97` — ISO 7064 Mod 97,10 validation
7. `checksum-mod11mod10` — ISO 7064 Mod 11,10 validation

**Results**:
- All 7 clusters captured and validated on first attempt
- 5-run drift test: ZERO false positives
- After refactoring (Set optimization + helper extraction): all 3 verifications GREEN
- Full test suite (1605 tests): all passing

**Key Finding**: The `luhnChecksum` and `luhnChecksumValidate` functions in the same module compute the Luhn algorithm differently (one reverses the string, one doesn't). Attempting to refactor `luhnChecksumValidate` to delegate to `luhnChecksum` broke 6 test suites. Regrets caught this immediately — all clusters would have gone RED. This demonstrates Regrets' value in catching subtle behavioral differences that look like they should be equivalent.

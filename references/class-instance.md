# Class Instance Libraries — Adapter Pattern for Regrets

## The Problem

Many TypeScript/JavaScript libraries export **singleton class instances** rather than plain functions:

```typescript
// Library exports singleton instances implementing an interface
export const luhn: CdigitAlgo = new Luhn("luhn", "Luhn Algorithm");
export const verhoeff: CdigitAlgo = new Verhoeff("verhoeff", "Verhoeff Algorithm");
```

Regrets' Ghost Proxy can only wrap **module-level function exports**. When a module exports a class instance, the proxy cannot intercept calls to instance methods like `luhn.compute("123")` because:

1. `createGhost()` wraps function exports by name, but `luhn` is an object, not a function
2. Even if you list `"compute"` in `watches`, the proxy looks for `module.compute` — it doesn't traverse object properties
3. Instance methods have `this` bound to the instance, so extracting `luhn.compute` and calling it directly may lose context

This pattern is extremely common in well-structured TypeScript libraries that use interfaces and dependency injection.

## Solution: Adapter Module

Create a thin adapter module that bridges the class-instance API to standalone functions:

```js
// regret-adapters.mjs (place at project root)
import { luhn, verhoeff, damm, mod97_10, gtin } from './lib/index.js';

// Luhn adapter functions
export function luhnCompute(s) { return luhn.compute(s); }
export function luhnValidate(s) { return luhn.validate(s); }
export function luhnGenerate(s) { return luhn.generate(s); }

// Verhoeff adapter functions
export function verhoeffCompute(s) { return verhoeff.compute(s); }
export function verhoeffValidate(s) { return verhoeff.validate(s); }
```

Each adapter function:
- Is a **standalone module-level export** (not a method on an object)
- Calls through to the real class instance method
- Preserves `this` binding because the call is `instance.method(args)` — the method retains its context

### Manifest Configuration

Point the manifest to the adapter module:

```json
{
  "clusters": [
    {
      "id": "luhn-check-digit",
      "entry": "luhnCompute",
      "watches": ["luhnCompute"],
      "file": "regret-adapters.mjs",
      "stack": "js",
      "fingerprintLevel": "entry",
      "inputs": ["7992739871", "1234567890", "49927398716"]
    }
  ]
}
```

## When to Use

| Library Pattern | Example | Regrets Strategy |
|----------------|---------|-----------------|
| Plain function exports | `export function add(a, b)` | Direct — no adapter needed |
| Class with static methods | `export class Math { static add() {} }` | Adapter wraps static calls |
| Singleton class instances | `export const algo = new Algo()` | **This pattern** — adapter needed |
| Factory functions | `export function createAlgo()` | Adapter wraps factory output |

## Full Example: cdigit (Check Digit Algorithms)

The [cdigit](https://github.com/LiosK/cdigit) library exports 11 algorithm instances implementing the `CdigitAlgo` interface. Each instance has `compute()`, `validate()`, `generate()`, and `parse()` methods.

```js
// regret-adapters.mjs
import {
  luhn, verhoeff, damm,
  mod11_2, mod37_2, mod97_10, mod661_26, mod1271_36,
  mod11_10, mod27_26, mod37_36,
  gtin
} from './lib/index.js';

// Digit-only algorithms (Luhn, Verhoeff, Damm, GTIN)
export function luhnCompute(s) { return luhn.compute(s); }
export function luhnValidate(s) { return luhn.validate(s); }
export function luhnGenerate(s) { return luhn.generate(s); }

export function verhoeffCompute(s) { return verhoeff.compute(s); }
export function verhoeffValidate(s) { return verhoeff.validate(s); }

export function dammCompute(s) { return damm.compute(s); }
export function dammValidate(s) { return damm.validate(s); }

// ISO 7064 algorithms
export function mod97_10Compute(s) { return mod97_10.compute(s); }
export function mod97_10Validate(s) { return mod97_10.validate(s); }
export function mod97_10Generate(s) { return mod97_10.generate(s); }

export function mod11_2Compute(s) { return mod11_2.compute(s); }
export function mod11_2Validate(s) { return mod11_2.validate(s); }

export function mod37_36Compute(s) { return mod37_36.compute(s); }
export function mod37_36Validate(s) { return mod37_36.validate(s); }

// GTIN algorithms
export function gtinCompute(s) { return gtin.compute(s); }
export function gtinValidate(s) { return gtin.validate(s); }
export function gtinGenerate(s) { return gtin.generate(s); }
```

This adapter enables full Regrets fingerprinting of every algorithm in the library, including both `compute()` (returns check digit) and `validate()` (returns boolean) contracts.

## Important Notes

- The adapter module imports from the **compiled** output (e.g., `./lib/index.js`), not the TypeScript source
- Place adapters at the project root so `capture.js` can find them via `pathToFileURL()`
- Adapters are `.mjs` files using ESM imports (matching the compiled output format)
- Each adapter function is a thin wrapper — no logic added, just rebinding from instance method to standalone export
- The adapter module should be committed alongside the `regrets/` directory but is NOT part of the target project's production code

## Difference from CJS Bridge Wrappers

The CJS Bridge Wrapper pattern (see `references/typescript.md`) solves a different problem: ESM/CJS module compatibility. The Class Instance Adapter pattern solves the problem of API shape: converting instance methods into standalone function exports.

| Pattern | Problem Solved | When to Use |
|---------|---------------|-------------|
| CJS Bridge Wrapper | ESM can't import CJS without extensions | Project has dual ESM/CJS build |
| Class Instance Adapter | Ghost Proxy can't wrap instance methods | Library exports class instances/objects |
| Combined | Both problems | Class instances + CJS build |

If a library both exports class instances AND uses CJS, combine both patterns:

```js
// regrets/wrappers/check-digit.mjs
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const cdigit = require('../../lib/cjs/index.js');  // CJS bridge

// Class instance adapter on top
export function luhnCompute(s) { return cdigit.luhn.compute(s); }
```

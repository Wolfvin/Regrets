# Case Study: lindenmayer (L-System Library)

A complete proof-of-concept demonstrating Regrets on a niche, class-based L-System library with wrapper modules, rollup-bundled dist files, and meaningful structural refactoring.

## Target Repository

- **Repo**: [nylki/lindenmayer](https://github.com/nylki/lindenmayer)
- **Description**: Feature-complete L-System (Lindenmayer system) library for JavaScript — supports classic, stochastic, parametric, and context-sensitive L-Systems
- **Why niche**: L-Systems are esoteric formal grammars used to model plant growth and fractals. The most complete JS implementation, renderer-agnostic.
- **Status**: Not archived, accepts PRs, active (pushed 2025-06-17), 197 stars, MIT licensed

## Challenge: Class-Based Library with Rollup Bundled Dist

The library exports a single `LSystem` class as its default export. The source code uses ES module imports, but the published package ships rollup-bundled dist files. This creates two challenges for Regrets:

1. **Class-based API**: Regrets expects exported functions, not class constructors
2. **Rollup bundling**: Function names may be renamed during bundling (e.g., `matchContextPattern` → `matchContextPattern$1`)

## Solution: Wrapper Module Pattern

Created `regrets/lindenmayer-wrappers.js` with pure wrapper functions:

```js
import LSystem from '../dist/lindenmayer.esm.js';

export function iterateKochCurve(iterations = 1) {
  return iterateClassic({ axiom: 'F++F++F', productions: { 'F': 'F-F++F-F' }, iterations });
}

export function iterateClassic({ axiom, productions, iterations = 1 }) {
  const lsys = new LSystem({ axiom, productions });
  const result = lsys.iterate(iterations);
  return typeof result === 'string' ? result : lsys.getString();
}

export function transformCSProduction(production) {
  const result = LSystem.transformClassicCSProduction(production);
  return { predecessor: result[0], production: result[1] };
}

export function matchContext({ axiom, index, direction, match, branchSymbols, ignoredSymbols }) {
  const lsys = new LSystem({ axiom, branchSymbols, ignoredSymbols });
  return lsys.match({ index, direction, match, branchSymbols, ignoredSymbols });
}
```

## Clusters Created (8 total)

| Cluster | Entry Function | Type | Inputs | Fingerprint |
|---------|---------------|------|--------|-------------|
| koch-curve | iterateKochCurve | Classic string | 1, 2, 3 iterations | 3dqgl2w |
| sierpinski-triangle | iterateSierpinski | Multi-production | 1, 2 iterations | 45u4xvt |
| dragon-curve | iterateDragonCurve | Multi-symbol | 1, 2, 3 iterations | 43bcrro |
| parametric-lsystem | iterateParametric | Object-based axiom | 1 config | 1oerlbj |
| branching-lsystem | iterateBranching | Branch symbols [] | 1 config | 4iqkkb1 |
| cs-transform | transformCSProduction | Static transformer | 3 productions | 2s7oovi |
| parametric-syntax-detect | testParametricSyntax | Static detector | 3 strings | 2n215ib |
| context-match | matchContext | Context matching | 2 configs | 4jttncu |

## Phase 1: Trust Building

- Captured all 8 clusters successfully
- Ran 5-run drift detection: **All PASS+STABLE**
- Health check: All clusters SOLID
- **Zero false positives** — L-System string output is inherently deterministic (no timestamps, no random IDs)

## Phase 2: Two Truths Saved

- **KEBENARAN 1**: Raw actual output of all entry functions for every input
- **KEBENARAN 2**: All 8 fingerprints from .regret files
- Cross-verification: Fingerprints computed from KEBENARAN 1 match KEBENARAN 2 exactly

## Phase 3: Structural Refactoring

### Refactoring Performed

The main `lindenmayer.js` (439 lines) was decomposed into focused modules:

1. **axiom-utils.js** — Axiom initialization and string representation (extracted from LSystem class)
2. **context-matcher.js** — Context-sensitive neighbor matching logic (extracted from LSystem.match method)
3. **production-evaluator.js** — Production condition checking and successor evaluation (extracted from LSystem.getProductionResult)

### Naming Improvements

| Old Name | New Name | Why |
|----------|----------|-----|
| `getRaw()` | `getAxiomRaw()` | Clarifies what "raw" means |
| `getString()` | `getStringRepresentation()` | More explicit about the conversion |
| `setFinal()` | `setFinalFunction()` | Distinguishes from "final" iteration |
| `setFinals()` | `setFinalFunctions()` | Plural consistency |
| `final()` | `executeFinals()` | Verb clarifies action vs adjective |
| `applyProductions()` | `applyProductionsOnce()` | Clarifies single-step nature |

All old names kept as `@deprecated` aliases for backward compatibility.

### Bug Found and Fixed

During refactoring, discovered that rollup bundling renames imported functions when there's a naming conflict. The `matchContextPattern` function imported into `lindenmayer.js` was renamed to `matchContextPattern$1` in the bundle, causing a `ReferenceError: matchContextPattern is not defined` at runtime.

**Fix**: Use alias imports to prevent name collisions:
```js
import { matchContextPattern as resolveContextPattern } from './context-matcher.js';
```

### 3 Verifications — All GREEN

| Verification | Result |
|-------------|--------|
| V1: Regrets validate | ✅ All 8 clusters GREEN |
| V2: Raw output vs KEBENARAN 1 | ✅ All outputs identical |
| V3: Fingerprints vs KEBENARAN 2 | ✅ All fingerprints match |
| Drift detection (5 runs) | ✅ PASS+STABLE |
| Existing test suite (30 tests) | ✅ All passing |

## Key Learnings for Regrets

1. **Rollup naming conflicts**: When wrapper modules import from rollup-bundled dist files, use aliased imports to prevent function name collisions in the bundle output
2. **Class-based libraries work well**: The wrapper module pattern is reliable — pure functions wrapping class instances produce stable, deterministic fingerprints
3. **L-Systems are ideal for Regrets**: String rewriting is inherently deterministic, making it an excellent test domain with zero non-determinism issues
4. **Deprecated aliases are safe**: Renaming methods while keeping old names as `@deprecated` aliases preserves backward compatibility and passes Regrets validation because the behavioral contract is unchanged

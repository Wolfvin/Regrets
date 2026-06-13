# Combinatorics & Discrete Mathematics Variant

Regression fingerprinting for combinatorial and discrete math libraries — capturing behavioral contracts in counting algorithms, tiling problems, graph enumeration, and integer sequence computation.

## Why Combinatorics Code Needs Regrets

Combinatorial computing has unique characteristics that make it both an excellent and challenging target for regression testing:

1. **Exact integer results**: Unlike floating-point code where minor rounding differences may be tolerable, combinatorial counting produces exact integers. Any difference in output — even by 1 — indicates a genuine behavioral regression. There is no room for approximation.
2. **BigInt overflow**: For large inputs, results exceed `Number.MAX_SAFE_INTEGER`. Libraries often provide both integer and BigInt variants, and the BigInt variant must produce identical results to the integer variant for small inputs. This cross-variant consistency is a critical contract.
3. **Exponential growth**: The number of valid configurations grows exponentially with input size. A 20×20 domino tiling has over 10^42 valid arrangements. This makes manual verification impossible — automated fingerprinting is essential.
4. **Pure functions by nature**: Combinatorial computations are deterministic and stateless — same input always produces same output. This makes them ideal candidates for Regrets fingerprinting.

## Case Study: Domino Tiling Solver

The `dawidrylko/domino-tiling` library computes the number of ways to tile an m×n grid with 2×1 dominoes using profile dynamic programming with bitmask state representation.

### Why This Repo Is Unusual

Domino tiling is a problem from combinatorial mathematics (OEIS sequence A004003). Most developers have never encountered it. The algorithm uses bit manipulation, dynamic programming, and recursive search — all hallmarks of competitive programming, not typical web development. Testing such a library with Regrets proves the skill works beyond typical encoding/decoding libraries.

### Challenges Encountered

#### 1. CommonJS with `__main__()` Anti-Pattern

The original code calls `__main__()` at the top level, which makes it impossible to `import()` the module without triggering CLI execution. This is a common pattern in competitive-programming-style JavaScript.

**Solution**: Create an ESM adapter module using `createRequire()` to import the CJS module. After refactoring the solver to use `require.main === module` guard, the adapter can import directly.

```js
// regret-adapters.mjs
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const solver = require('./dominoTilingSolver.js');

export function calculateTilings(input) {
  return solver.calculateTotalTilingCombinations(input);
}
```

#### 2. BigInt Return Values

The BigInt solver returns `bigint` values, which `JSON.stringify()` cannot serialize (it throws `TypeError: Do not know how to serialize a BigInt`). Regrets' fingerprint algorithm relies on JSON serialization.

**Solution**: Convert BigInt to string in the adapter before returning. This preserves the exact value while making it JSON-serializable:

```js
export function calculateTilingsBigInt(input) {
  return solver.calculateTotalTilingCombinations(input).toString();
}
```

The string representation is deterministic for the same BigInt value, so fingerprints remain stable.

#### 3. Dual-Variant Consistency Testing

The library provides two variants (integer and BigInt) that should produce identical results for small inputs where both are valid. This is a natural cross-check: `calculateTilings({rowCount:4, colCount:4})` should equal `Number(calculateTilingsBigInt({rowCount:4, colCount:4}))`.

With Regrets, both variants get separate clusters with separate fingerprints. If a refactor breaks one variant but not the other, the affected cluster will fail independently.

### Cluster Manifest

```json
{
  "clusters": [
    {
      "id": "calculate-tilings",
      "entry": "calculateTilings",
      "watches": ["calculateTilings"],
      "file": "regret-adapters.mjs",
      "stack": "js",
      "fingerprintLevel": "entry",
      "description": "Counts domino tilings of an m×n grid using integer arithmetic",
      "inputs": [
        { "rowCount": 1, "colCount": 2 },
        { "rowCount": 2, "colCount": 2 },
        { "rowCount": 4, "colCount": 4 },
        { "rowCount": 6, "colCount": 6 },
        { "rowCount": 8, "colCount": 8 }
      ]
    },
    {
      "id": "calculate-tilings-bigint",
      "entry": "calculateTilingsBigInt",
      "watches": ["calculateTilingsBigInt"],
      "file": "regret-adapters.mjs",
      "stack": "js",
      "fingerprintLevel": "entry",
      "description": "Counts domino tilings using BigInt arithmetic for large grids",
      "inputs": [
        { "rowCount": 1, "colCount": 2 },
        { "rowCount": 2, "colCount": 2 },
        { "rowCount": 4, "colCount": 4 },
        { "rowCount": 10, "colCount": 10 },
        { "rowCount": 12, "colCount": 12 }
      ]
    }
  ]
}
```

Key decisions:
- **Separate clusters for integer and BigInt variants**: Each has different input/output types and different overflow boundaries
- **Object inputs with named fields**: `{rowCount, colCount}` is clearer than positional arguments
- **Progressive input sizes**: Start from trivial (1×2) to substantial (8×8 or 12×12)
- **No `normalize` rules needed**: Pure integer computation is inherently deterministic

### Results

| Metric | Result |
|--------|--------|
| Capture | 2/2 clusters captured |
| Validate | 2/2 GREEN |
| Drift (5 runs) | 2/2 PASS+STABLE |
| False positives | ZERO |

### Refactoring Performed

1. **Renamed `canSkipTwoBits` → `canPlaceHorizontalDomino`**: The original name described *how* (skip two bits), the new name describes *why* (placing a horizontal domino). This is a naming-for-intent refactor.

2. **Renamed `searchTileArrangements` → `explorePlacements`**: More descriptive — the function explores all valid placement options for a given row profile.

3. **Replaced `__main__()` with `require.main === module` guard**: The `__main__()` pattern prevents importing the module. Using the Node.js standard guard allows the module to be both imported as a library and executed as a CLI script.

4. **Added `module.exports`**: The original code had no exports — all functions were file-scoped. Now the core computation functions are exported for reuse.

5. **Added comprehensive JSDoc documentation**: Every function now has documentation explaining parameters, return values, and algorithm details.

6. **Separated `explorePlacements` from `explorePlacementsBigInt`**: Made the naming explicit — the BigInt variant has a distinct name to avoid confusion about which arithmetic type is being used.

### Three Verifications After Refactoring

| Verification | Result |
|-------------|--------|
| VERIFICATION 1: Regrets clusters | ✅ Both GREEN (114pecz, qo9sy8d) |
| VERIFICATION 2: Direct output vs Truth 1 | ✅ All 10 outputs match exactly |
| VERIFICATION 3: Fingerprints vs Truth 2 | ✅ Both fingerprints match |

## Generalizing to Other Combinatorics Libraries

This pattern applies to any combinatorial or discrete mathematics library:

| Domain | Example | Key Functions |
|--------|---------|---------------|
| Tiling problems | Domino tiling, pentomino packing | Count valid arrangements |
| Graph enumeration | Spanning tree count, graph isomorphism | Count or classify structures |
| Permutation/combination | Catalan numbers, Stirling numbers | Compute exact integer sequences |
| Number theory | Prime counting, divisor functions | Exact integer results |
| Game theory | Nim-value computation, Sprague-Grundy | Exact game state evaluation |
| Cryptography | Hash functions, encoding | Exact byte matching |

### Input Selection Strategy

When choosing inputs for combinatorics clusters, cover these categories:

| Category | Example | Why |
|----------|---------|-----|
| Minimum viable | `{rowCount:1, colCount:2}` | Smallest valid input |
| Symmetric square | `{rowCount:2, colCount:2}` | Small symmetric case |
| Medium square | `{rowCount:4, colCount:4}` | Non-trivial result (36 tilings) |
| Large square | `{rowCount:8, colCount:8}` | Stress test for integer variant |
| Overflow boundary | `{rowCount:12, colCount:12}` | Tests BigInt requirement |
| Non-square | `{rowCount:2, colCount:6}` | Asymmetric dimensions |

### BigInt Handling Checklist

When fingerprinting libraries that return BigInt values:

1. ✅ Convert BigInt to string in the adapter: `result.toString()`
2. ✅ String representation is deterministic for the same value
3. ✅ JSON serialization works with strings but not BigInt
4. ✅ Fingerprint is computed on the string, which is stable
5. ❌ Do NOT use `Number(bigIntValue)` — loses precision for large values

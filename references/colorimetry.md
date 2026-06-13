# Color Science Library Pattern — colorimetry-ts

This reference documents the patterns learned from applying Regrets to `dylanraga/colorimetry-ts`, a CIE colorimetry library with complex class-based color spaces and circular ESM dependencies.

---

## The Problem

Color science libraries like `colorimetry-ts` present three challenges for Regrets:

1. **Class-based Color objects**: The `Color` class wraps color space values with methods like `toSpace()`. `JSON.stringify()` on a `Color` instance loses the class identity.
2. **Circular ESM dependencies**: Space modules (CIELAB, Oklab, XYZ) register conversions during construction, creating circular imports between `ColorSpace`, individual spaces, and the `conversion.ts` module.
3. **Console.log side effects**: The `conversion.ts` module contains `console.log(path.map(p => p.id))` which outputs during color space resolution but doesn't affect return values.

---

## Solution: Adapter Module Pattern

Create a single `regret-adapters.mjs` file at the project root that:

1. **Imports from `dist/index.js`** — the barrel file handles circular dependency resolution correctly
2. **Wraps class-based APIs** — converts Color instances to plain JSON objects
3. **Re-exports pure utility functions** — no adapter needed for functions that already take/return plain JSON

```js
// regret-adapters.mjs
import {
  quantize, dequantize, roundHTE, hexFromArray, minv, mmult3331,
  color, spaces, diffs, curves,
} from './dist/index.js';

// Re-export pure functions directly (no adapter needed)
export { quantize, dequantize, roundHTE, hexFromArray, minv, mmult3331 };

// Adapter: class-based Color → plain JSON
export function adaptSrgbToLab(input) {
  const c = color(spaces.srgb(), input);
  const lab = c.toSpace(spaces.lab());
  return { L: lab.values[0], a: lab.values[1], b: lab.values[2] };
}
```

### Key Design Rules

1. **Always import from `dist/index.js`** — sub-module imports fail with `ReferenceError: Cannot access 'ColorSpace' before initialization` due to circular ESM dependencies.
2. **Spread tuple returns to arrays** — functions returning `[number, number, number]` tuples should be spread with `[...fn()]` if fingerprinting expects regular arrays.
3. **Normalize class outputs to plain objects** — `{ L, a, b }` is better than `[L, a, b]` for readability and fingerprinting.
4. **Namespace space names with underscores** — `srgb-linear` becomes `srgb_linear` in the `spaces` object. Check `Object.keys(spaces)` to verify.

---

## Manifest Configuration

```json
{
  "clusters": [
    {
      "id": "srgb-to-lab-conversion",
      "entry": "adaptSrgbToLab",
      "watches": ["adaptSrgbToLab"],
      "file": "regret-adapters.mjs",
      "stack": "js",
      "fingerprintLevel": "entry",
      "description": "Convert sRGB [R,G,B] to CIELAB {L,a,b}",
      "inputs": [[1,0,0], [0,1,0], [0,0,1], [0.5,0.5,0.5], [0,0,0], [1,1,1]]
    },
    {
      "id": "quantize-float-to-int",
      "entry": "quantize",
      "watches": ["quantize"],
      "file": "regret-adapters.mjs",
      "stack": "js",
      "fingerprintLevel": "entry",
      "multiArgs": true,
      "description": "Quantize float value to bitDepth bits",
      "inputs": [[0.5, 8, "full", false], [0.0, 8, "full", false], [1.0, 8, "full", false]]
    }
  ]
}
```

---

## Console.log Side Effects

The `conversion.ts` module in colorimetry-ts contains:

```ts
console.log(path.map((p) => p.id));
```

This outputs to stdout during color space conversion path resolution. It does NOT affect function return values, so Regrets fingerprints remain stable. However, it can be confusing during capture/validate runs.

**Recommendation**: If the target library has console.log statements, they can be safely ignored as long as:
1. The return values are deterministic
2. The drift detection passes (5 runs × all clusters = stable)

---

## Verifying Space Names

Color science libraries often expose color spaces with names that differ from common convention. Always verify the available space names before writing adapters:

```js
import { spaces } from './dist/index.js';
console.log('Available spaces:', Object.keys(spaces));
// Output: ['acescc', 'acescg', 'argb98', 'bt2020_linear', 'bt2100_hlg',
//          'bt2100_pq', 'display_p3', 'p3_d65', 'p3_d65_linear', 'p3_dci',
//          'prophoto', 'rec2020', 'rec709', 'rgb', 'srgb', 'srgb_linear',
//          'xyz', 'xyz_n', 'lab', 'lab_d50', 'lch', 'luv', 'yxy', 'ictcp',
//          'itp', 'itp_lch', 'jzazbz', 'jzczhz', 'oklab', 'oklch', ...]
```

Note: `srgb-linear` → `srgb_linear` (dash replaced with underscore).

---

## Refactoring Color Science Libraries

Colorimetry-ts has a typical structure where `common/util.ts` becomes a "god module" containing:
- Matrix operations (minv, mmult, mmult3331, mmult3333)
- Quantization (quantize, dequantize)
- Hex color conversion (hexFromArray, arrayFromHex)
- Rounding (roundHTE)
- Memoization (memoize)
- Graph search (bfsPath)
- Misc utilities (evenFn, withProps, lerp, clamp, rad2deg, deg2rad)

This can be safely split into domain-specific modules:
- `common/matrix.ts` — matrix operations
- `common/quantization.ts` — quantize/dequantize
- `common/rounding.ts` — roundHTE
- `common/hex-color.ts` — hex conversion
- `common/memoize.ts` — memoization
- `common/graph-search.ts` — BFS path finding
- `common/functional.ts` — misc utilities

With `common/util.ts` re-exporting everything for backward compatibility.

**Verification**: All 11 Regrets clusters remained GREEN after this split, with zero fingerprint changes.

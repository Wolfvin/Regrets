# Scientific Computing & Color Science Variant

Regression fingerprinting for numerical/scientific libraries — capturing behavioral contracts in matrix math, color space conversions, and floating-point computations.

## Why Scientific Code Needs Regrets

Scientific computing code has unique characteristics that make it both an excellent and challenging target for regression testing:

1. **Floating-point sensitivity**: Tiny algorithmic changes can cascade into different rounding results. A refactor that inlines a function may change operation order, producing different results in the least significant bits.
2. **Matrix transformations**: Color space conversions (RGB↔LMS↔XYZ), coordinate transforms, and signal processing involve matrix multiplications where every coefficient matters.
3. **Clamping and rounding**: Scientific code often includes sanitization steps (clamp to [0,255], round to nearest integer) that create behavioral boundaries.
4. **Pure functions by nature**: Scientific computations are typically stateless — same input always produces same output. This makes them perfect candidates for Regrets fingerprinting.

## Lessons from Testing a Color Blindness Simulator

The `@bjornlu/colorblind` library (RGB→LMS color space transformation + deficiency simulation matrices) revealed several insights:

### 1. multiArgs is Essential for Multi-Parameter Functions

Scientific functions often take a data input + a configuration parameter:

```js
// simulate(rgb, deficiency) — two separate arguments
export function simulate(rgb, deficiency) { ... }
```

In the manifest, use `multiArgs: true` with array inputs:

```json
{
  "id": "simulate-deuteranopia",
  "entry": "simulate",
  "multiArgs": true,
  "inputs": [
    [{"r":255,"g":0,"b":0}, "deuteranopia"],
    [{"r":0,"g":255,"b":0}, "deuteranopia"]
  ]
}
```

Without `multiArgs`, Regrets passes the entire input as a single object argument, which fails for functions expecting separate parameters.

### 2. Bundle Multi-File Libraries into a Single Module

TypeScript libraries with multiple source files (`index.ts`, `util.ts`, `sim-matrix.ts`) need compilation before Regrets can import them. However, the compiled output may still use relative imports that don't resolve correctly via dynamic `import()`.

**Solution**: Create a single-file bundle that inlines all dependencies:

```js
// colorblind-bundle.mjs — single file, no relative imports
const rgbToLmsMatrix = [0.31399022, 0.63951294, 0.04649755, ...]

export function simulate(rgb, deficiency) { ... }
export { convertRgbToLms, sanitizeRgb }
```

This eliminates import resolution issues and makes the target module self-contained for fingerprinting.

### 3. Boundary Conditions Deserve Their Own Clusters

Scientific code has edge cases at numerical boundaries. Create dedicated clusters for sanitization/clamping functions:

```json
{
  "id": "sanitize-rgb-boundaries",
  "entry": "sanitizeRgb",
  "inputs": [
    {"r":-50,"g":0,"b":300},
    {"r":0.5,"g":127.7,"b":255},
    {"r":-0.1,"g":0,"b":0}
  ]
}
```

This catches regressions in clamping logic that might not be triggered by normal-range inputs in the main simulation clusters.

### 4. Matrix Transformation Clusters Verify Core Math

Isolate the core mathematical transformation into its own cluster:

```json
{
  "id": "convert-rgb-lms-roundtrip",
  "entry": "convertRgbToLms",
  "inputs": [
    {"r":255,"g":0,"b":0},
    {"r":128,"g":128,"b":128},
    {"r":255,"g":255,"b":255}
  ]
}
```

This verifies that the matrix coefficients haven't been accidentally modified during refactoring — a critical concern in scientific code where coefficients come from published research papers.

### 5. Floating-Point Output Requires Exact Match

Unlike web APIs where `timestamps` and `uuids` need normalization, scientific output should match EXACTLY. The default `fingerprintMode: "value"` is correct for scientific code because:

- Floating-point arithmetic is deterministic for the same operations on the same hardware
- Any difference in output indicates a genuine behavioral change
- Do NOT use `"normalize": ["timestamps"]` or similar rules on pure computational output

The only exception: if the computation involves `Math.random()`, `Date.now()`, or platform-dependent operations (like GPU computation), add appropriate normalization.

### 6. Refactoring Scientific Code Safely

The 3-phase refactoring approach works exceptionally well for scientific code:

**What can be safely refactored:**
- Inlining trivial wrapper functions (e.g., `convertLmsToMatrix(lms)` → `[lms.l, lms.m, lms.s]`)
- Renaming variables for clarity (e.g., `simRgbMetrix` typo → `simRgbVec`)
- Replacing intermediate conversion functions with direct computation
- Adding `dotProduct3` helper to replace `multiplyMatrix3x1And3x1`

**What Regrets will catch if broken:**
- Changed matrix coefficients (fingerprint will differ)
- Different operation order in floating-point arithmetic (fingerprint will differ)
- Removed or modified clamping/rounding steps (fingerprint will differ)
- Missing sanitization on input or output (fingerprint will differ)

### 7. The Typo Test: Did Refactoring Fix or Preserve Bugs?

During the colorblind refactoring, we found `simRgbMetrix` — clearly a typo for "simRgbMatrix". The question: should we fix it?

Since it's just a variable name (not a functional bug), renaming to `simRgbVec` is safe — Regrets confirms the output is identical. But if the typo had been in a matrix coefficient, Regrets would catch the change immediately.

## Manifest Template for Color Science Projects

```json
{
  "clusters": [
    {
      "id": "simulate-deficiency-type",
      "entry": "simulate",
      "watches": ["simulate", "simulateDichromatic", "convertRgbToLms", "convertLmsToRgb", "sanitizeRgb"],
      "file": "js/colorblind-bundle.mjs",
      "stack": "js",
      "fingerprintLevel": "entry",
      "multiArgs": true,
      "inputs": [
        [{"r":255,"g":0,"b":0}, "deuteranopia"],
        [{"r":0,"g":255,"b":0}, "deuteranopia"],
        [{"r":0,"g":0,"b":255}, "deuteranopia"]
      ]
    },
    {
      "id": "sanitize-boundaries",
      "entry": "sanitizeRgb",
      "watches": ["sanitizeRgb"],
      "file": "js/colorblind-bundle.mjs",
      "stack": "js",
      "fingerprintLevel": "entry",
      "inputs": [
        {"r":-50,"g":0,"b":300},
        {"r":0.5,"g":127.7,"b":255}
      ]
    },
    {
      "id": "color-space-transform",
      "entry": "convertRgbToLms",
      "watches": ["convertRgbToLms"],
      "file": "js/colorblind-bundle.mjs",
      "stack": "js",
      "fingerprintLevel": "entry",
      "inputs": [
        {"r":255,"g":0,"b":0},
        {"r":0,"g":255,"b":0},
        {"r":255,"g":255,"b":255}
      ]
    }
  ]
}
```

## Applicable Domains

This pattern applies to any scientific computing library:

| Domain | Example | Key Functions |
|--------|---------|---------------|
| Color science | Color blindness simulation, color space conversion | Matrix transforms, clamping |
| Signal processing | FFT, filtering, convolution | Window functions, coefficient arrays |
| Geometry | Coordinate transforms, projection matrices | Matrix multiplication, normalization |
| Statistics | Distribution functions, hypothesis testing | Accumulation, rounding |
| Physics | Unit conversion, equation solving | Constants, precision handling |
| Cryptography | Hash functions, encoding | Bit operations, exact byte matching |

# Walkthrough: Color Blindness Simulator with Regrets

A complete walkthrough of using Regrets on `@bjornlu/colorblind` — a color blindness simulation library. This demonstrates Regrets on a scientific computing domain, which differs significantly from typical web/API use cases.

## The Target Library

`@bjornlu/colorblind` simulates four types of color vision deficiency:
- **Protanopia** — no red cone cells
- **Deuteranopia** — no green cone cells
- **Tritanopia** — no blue cone cells
- **Achromatopsia** — total color blindness (monochrome)

The core algorithm:
1. Convert RGB to LMS color space (3×3 matrix × 3×1 vector)
2. Apply deficiency simulation matrix
3. Convert simulated LMS back to RGB
4. Sanitize (clamp and round to 0–255)

Total code: 165 lines, zero dependencies, pure functions.

## Step 1 — Prepare the Bundle

The library is TypeScript with multiple files. Regrets' `capture.js` needs a single importable module. Solution: create a self-contained bundle.

```bash
# Compile TypeScript
npx tsc -p tsconfig.compile.json

# Or create a single-file bundle manually
# This inlines all imports and exports everything Regrets needs
```

**Key insight**: The bundle must export all watched functions as named exports, including internal helpers that the manifest lists in `watches`.

## Step 2 — Write the Manifest

Six clusters covering the full behavioral surface:

```json
{
  "clusters": [
    {
      "id": "simulate-deuteranopia",
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
    }
  ]
}
```

**Why `multiArgs: true`**: The `simulate(rgb, deficiency)` function takes two arguments. Without `multiArgs`, Regrets would call `simulate({"r":255,"g":0,"b":0}, undefined)` — missing the deficiency type.

## Step 3 — Capture

```bash
$ node /path/to/Regrets/scripts/capture.js

📡 Capturing: simulate-deuteranopia
   File:    js/colorblind-bundle.mjs
   Entry:   simulate
   Watches: simulate, simulateDichromatic, convertRgbToLms, convertLmsToRgb, sanitizeRgb
   ✅ Fingerprint: 4ust3nw
   📄 Saved: regrets/simulate-deuteranopia.regret
```

All 6 clusters captured successfully. The `.regret` file for the deuteranopia cluster:

```
cluster: simulate-deuteranopia
version: 1
fingerprint: 4ust3nw
captured: 2026-06-13T15:12:05.809Z
watches: [simulate, simulateDichromatic, convertRgbToLms, convertLmsToRgb, sanitizeRgb]
entry: simulate
stack: js
fingerprintLevel: entry
multiArgs: true
---
INPUT  [{"r":255,"g":0,"b":0},"deuteranopia"]
OUTPUT {"r":84,"g":84,"b":0}
HASH   4ust3nw
```

## Step 4 — Drift Detection

```bash
$ node /path/to/Regrets/scripts/validate.js --runs 5

🔍 Drift detection — 5 runs per cluster...

  ✅ simulate-deuteranopia               4ust3nw  × 5  PASS+STABLE
  ✅ simulate-protanopia                 3h0enpo  × 5  PASS+STABLE
  ✅ simulate-tritanopia                 33youny  × 5  PASS+STABLE
  ✅ simulate-achromatopsia              50gmh8z  × 5  PASS+STABLE
  ✅ sanitize-rgb-boundaries             5gqof57  × 5  PASS+STABLE
  ✅ convert-rgb-lms-roundtrip           198glwz  × 5  PASS+STABLE

✅ All 6 tests passed (5 runs — stable). Refactor is safe.
```

Zero drift across 5 runs. Scientific code with pure functions is inherently stable — no timestamps, no randomness, no network calls.

## Step 5 — Save Two Truths

Before refactoring, save two independent records:

**Truth 1 — Raw Output**: Run all entry functions directly, save the exact return values.

```json
{
  "simulate-deuteranopia": {
    "outputs": [
      {"r":84,"g":84,"b":0},
      {"r":171,"g":171,"b":7},
      {"r":0,"g":0,"b":255}
    ]
  }
}
```

**Truth 2 — Regrets Fingerprints**: The fingerprint hash for each cluster.

```json
{
  "simulate-deuteranopia": { "fingerprint": "4ust3nw" },
  "simulate-protanopia": { "fingerprint": "3h0enpo" }
}
```

**Cross-verification**: Both truths must be semantically identical. If the raw output matches what Regrets captured, there are no false negatives.

## Step 6 — Refactor

The following changes were made:

1. **Inlined trivial converters**: `convertLmsToMatrix(lms)` → `[lms.l, lms.m, lms.s]` directly in the calling function
2. **Fixed typo**: `simRgbMetrix` → `simRgbVec` (variable naming)
3. **Added `dotProduct3` helper**: Replaced `multiplyMatrix3x1And3x1(arr1, arr2)[0]` with cleaner `dotProduct3(arr1, arr2)`
4. **Inlined conversion steps in `simulateDichromatic`**: Instead of calling `convertRgbToLms` then `convertLmsToMatrix`, directly build the vector and do the matrix multiply
5. **Renamed constants**: `rgbToLmsMatrix` → `RGB_TO_LMS`, `lmsToRgbMatrix` → `LMS_TO_RGB` (convention for constants)
6. **Renamed helper**: `sanitizeRgbProperty` → `clampByte` (more descriptive)

## Step 7 — 3-Way Verification

After refactoring:

**Verification 1 — Regrets**:
```
✅ All 6 tests passed. Refactor is safe.
```

**Verification 2 — Direct Output vs Truth 1**:
```
✅ VERIFICATION 2 PASSED: All direct outputs match Truth 1 exactly
```

**Verification 3 — Fingerprints vs Truth 2**:
```
✅ VERIFICATION 3 PASSED: All new fingerprints match Truth 2
```

All three verifications green. The refactored code produces identical output to the original — proven by independent methods.

## Key Takeaway

Scientific computing code is an excellent target for Regrets because:

1. **Pure functions** → zero drift, no normalization needed
2. **Exact output matching** → floating-point determinism means any regression is caught
3. **Boundary conditions** → dedicated clusters for clamping/rounding catch edge case regressions
4. **Matrix coefficients** → fingerprints detect even a single changed decimal in a transformation matrix
5. **Multi-argument functions** → `multiArgs: true` handles the common pattern of `(data, config)` function signatures

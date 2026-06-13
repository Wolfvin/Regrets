# Case Study: Javanese Calendar Library (kalenderjawa/pustaka)

This case study documents the experience of applying Regrets to `@kalenderjawa/pustaka`, a niche JavaScript/TypeScript library for computing the Javanese calendar. The library is a particularly challenging target because it involves cultural domain knowledge, async functions with unnecessary Promise wrapping, and a barrel file that imports `package.json`.

## Repository

- **URL**: https://github.com/kalenderjawa/pustaka
- **Stars**: 45
- **Language**: TypeScript (compiled to ES2022 modules)
- **Description**: JavaScript library for Javanese Calendar computation, conversion, and dating
- **Why niche**: The Javanese calendar is a complex lunar calendar system used primarily in Indonesia, with a 5-day pasaran cycle alongside the 7-day week, an 8-year windu cycle, and two kurup (epoch) systems. Function names are in Javanese (e.g., `cariRumusAbadiAwalBulanTahunJawa`). Very few people outside Java would even know this exists.

## Challenges Encountered

### 1. Barrel File with package.json Import

The main `index.ts` imports `package.json` for version information:
```typescript
import pkg from '../package.json';
```

This causes Node.js 24 to throw `ERR_IMPORT_ATTRIBUTE_MISSING` because the compiled JS doesn't include `with { type: 'json' }`. **Solution**: Point manifest clusters directly to sub-modules (`dist/batur.js`, `dist/silpin.js`) instead of the barrel file.

### 2. Async Functions Wrapping Synchronous Logic

Several functions use the `new Promise()` anti-pattern:
```typescript
async function konversiHari(h: number, dn: number): Promise<DintenType | string> {
  // ... pure computation ...
  return new Promise((resolve, reject) => {
    // ... lookup in registry ...
  });
}
```

The ghost proxy handles this transparently — it awaits the Promise before fingerprinting. No special manifest configuration needed. **However**, this made the refactoring target clear: extract the pure computation and keep the async wrapper for backward compatibility.

### 3. Multiple Clusters from Same File

The `silpin.ts` module exports 6 different functions. We created 5 clusters from this single file (excluding `konversiHariPasaran` which is a composite). This worked perfectly because each cluster gets its own ghost proxy instance and recorder.

### 4. multiArgs with Mixed Types

The `cariRumusWulanTaun` function takes a string key and an object query. Using `"multiArgs": true` with input `[["rom_alip", {"wulan": "romadon", "taun": 1900}]]` worked correctly.

## Cluster Manifest

```json
{
  "clusters": [
    {
      "id": "periksa-batasan",
      "entry": "periksaBatasan",
      "watches": ["periksaBatasan"],
      "file": "dist/batur.js",
      "stack": "js",
      "fingerprintLevel": "entry",
      "description": "Validates Javanese year is within scope (1867-2106)",
      "inputs": [1900, 1867, 2106, 100, 2107, 1955]
    },
    {
      "id": "konversi-hari",
      "entry": "konversiHari",
      "watches": ["konversiHari"],
      "file": "dist/silpin.js",
      "stack": "js",
      "fingerprintLevel": "entry",
      "multiArgs": true,
      "description": "Converts day offset + base day number to Javanese day name",
      "inputs": [[3, 2], [1, 1], [7, 5], [0, 3], [6, 2], [4, 7]]
    },
    {
      "id": "konversi-pasaran",
      "entry": "konversiPasaran",
      "watches": ["konversiPasaran"],
      "file": "dist/silpin.js",
      "stack": "js",
      "fingerprintLevel": "entry",
      "multiArgs": true,
      "description": "Converts pasaran offset + base pasaran to Javanese pasaran name",
      "inputs": [[2, 3], [1, 1], [5, 4], [0, 2], [4, 1], [3, 5]]
    },
    {
      "id": "cari-wulan-registry",
      "entry": "cariWulanRegistry",
      "watches": ["cariWulanRegistry"],
      "file": "dist/silpin.js",
      "stack": "js",
      "fingerprintLevel": "entry",
      "description": "Looks up Javanese month data by name",
      "inputs": ["romadon", "mukarom", "sapar", "sawal", "dulkijah"]
    },
    {
      "id": "cari-taun-registry",
      "entry": "cariTaunRegistry",
      "watches": ["cariTaunRegistry"],
      "file": "dist/silpin.js",
      "stack": "js",
      "fingerprintLevel": "entry",
      "description": "Looks up Javanese year type from the windu cycle",
      "inputs": ["alip", "ehe", "dal", "wawu", "jimakir"]
    },
    {
      "id": "cari-rumus-wulan-taun",
      "entry": "cariRumusWulanTaun",
      "watches": ["cariRumusWulanTaun"],
      "file": "dist/silpin.js",
      "stack": "js",
      "fingerprintLevel": "entry",
      "multiArgs": true,
      "description": "Looks up the eternal formula for a month-year combination",
      "inputs": [
        ["rom_alip", {"wulan": "romadon", "taun": 1900}],
        ["sapar_ehe", {"wulan": "sapar", "taun": 1908}],
        ["sawal_dal", {"wulan": "sawal", "taun": 1991}]
      ]
    }
  ]
}
```

## Results

- **Capture**: 6/6 clusters captured successfully
- **Validate**: 6/6 GREEN on first run
- **Drift Detection**: 6/6 STABLE across 5 runs
- **Health**: 6/6 SOLID
- **False Positives**: ZERO — no iteration needed

## Refactoring Performed

1. **Extracted pure computation helpers** (`hitungDino`, `hitungPasaran`) from async wrappers in `silpin.ts`
2. **Extracted correction functions** (`koreksiDino`, `koreksiPasaran`) from `index.ts` into new `koreksi.ts` module
3. **Moved `BATASAN_TYPE` interface** from `batur.ts` to shared `types.ts` (renamed to `BatasanType`)
4. **Exported bounds constants** (`MIN_TAHUNJAWA`, `MAX_TAHUNJAWA`) from `batur.ts`
5. **Improved documentation** — added JSDoc comments explaining Javanese calendar concepts

All 3 verifications passed after refactoring:
1. ✅ Regrets validate: All 6 clusters GREEN
2. ✅ Direct output comparison: All outputs identical to pre-refactor truth
3. ✅ Cross-fingerprint verification: All fingerprints match pre-refactor truth

## Lessons Learned

1. **Sub-module clustering is a valid pattern.** When barrel files have problematic imports, cluster individual modules directly. This is actually better for isolation.

2. **Async functions work seamlessly.** The ghost proxy's Promise handling is robust. No special configuration needed.

3. **Pure function extraction is the ideal refactoring target.** Extracting `hitungDino`/`hitungPasaran` from the async wrappers made the code more testable without changing any output.

4. **Cultural domain libraries are excellent test targets.** The Javanese calendar has deterministic, pure functions with well-defined contracts — perfect for fingerprint-based regression testing.

5. **Zero false positives on first attempt.** This library's pure function design made it an ideal candidate. Functions with no side effects, no random state, and no time dependency produce stable fingerprints by nature.

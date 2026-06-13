# Tauri App Integration — Regrets Reference Guide

Tauri applications combine a Rust backend with a web frontend (typically React/TypeScript). This guide covers how to set up regression testing for the TypeScript frontend of Tauri apps, where the pure functions live.

---

## Why Tauri Apps Are a Good Fit

Tauri frontends are essentially web applications. They use standard JavaScript/TypeScript patterns — React components, utility functions, state management — making them naturally compatible with Regrets' JavaScript capture/validate pipeline. The Rust backend is not directly testable with Regrets (see `references/rust.md` for Rust-specific guidance), but the frontend pure functions are ideal candidates.

---

## Key Challenge: TypeScript Compilation

Tauri frontends are written in TypeScript but Regrets needs importable `.js` files. Most Tauri projects use Vite as the bundler, and their `tsconfig.json` has `noEmit: true` (no compiled JS output). The solution is to use **esbuild** to transpile specific files.

### Step 1: Install esbuild

```bash
npm install -g esbuild
# or as dev dependency
pnpm add -D esbuild
```

### Step 2: Transpile Target Files

```bash
# Transpile all pure function modules
esbuild src/lib/utils.ts --bundle --format=esm --outfile=dist/lib/utils.js --platform=neutral --external:clsx --external:tailwind-merge
esbuild src/lib/query-node-utils.ts --bundle --format=esm --outfile=dist/lib/query-node-utils.js --platform=neutral
esbuild src/components/utils.ts --bundle --format=esm --outfile=dist/components/utils.js --platform=neutral
```

Key flags:
- `--bundle`: Inlines local imports (resolves relative paths)
- `--format=esm`: Output ES modules (required for Regrets `import()`)
- `--platform=neutral`: Avoids Node.js-specific shims
- `--external`: Excludes npm packages from the bundle (they'll be resolved from `node_modules` at runtime)

### Step 3: Create Adapter Modules for Higher-Order Functions

Functions that accept function arguments (e.g., `filterEligible(values, value, compareFn)`) cannot be directly fingerprinted because functions aren't JSON-serializable. Create adapter modules:

```js
// regrets/adapters/filter-eligible.mjs
import { filterEligible } from '../../dist/lib/utils.js';

export function filterEligibleAdapter(input) {
  const { eligibleValues, value, compareType } = input;
  let compare;
  if (compareType === 'equality') compare = (a, b) => a === b;
  else if (compareType === 'lessThan') compare = (a, b) => a < b;
  return filterEligible(eligibleValues, value, compare);
}
```

Point the manifest at the adapter, not the original function:

```json
{
  "id": "filter-eligible-adapter",
  "entry": "filterEligibleAdapter",
  "watches": ["filterEligibleAdapter"],
  "file": "regrets/adapters/filter-eligible.mjs",
  "stack": "js",
  "fingerprintLevel": "entry",
  "inputs": [
    {"eligibleValues": [1, 2, 3], "value": 2, "compareType": "equality"}
  ]
}
```

---

## Case Study: annimate (ANNIS Match Exporter)

**Target:** `matthias-stemmler/annimate` — A Tauri desktop app for exporting linguistic corpus annotation matches. The TypeScript frontend has pure functions for text positioning, collection manipulation, and serialization.

### Clusters Captured

| Cluster | Entry | File | Fingerprint |
|---------|-------|------|-------------|
| format-percentage | `formatPercentage` | dist/lib/utils.js | 5dpznlq |
| line-column-to-char-index | `lineColumnToCharacterIndex` | dist/lib/utils.js | 1qx5rtj |
| column-idx-cp-to-graphemes | `columnIndexCodePointsToGraphemes` | dist/lib/utils.js | 5x6smi8 |
| filter-eligible-adapter | `filterEligibleAdapter` | regrets/adapters/filter-eligible.mjs | 4fg6q1w |
| group-by-adapter | `groupByAdapter` | regrets/adapters/group-by-adapter.mjs | 1gc5xws |
| uniq | `uniq` | dist/lib/utils.js | 1xru3hd |
| find-eligible-query-node | `findEligibleQueryNodeRefIndex` | dist/lib/query-node-utils.js | 1k0r3ut |
| anno-key-to-value | `annoKeyToValue` | dist/columns/utils.js | 5lj6cen |
| value-to-anno-key | `valueToAnnoKey` | dist/columns/utils.js | 5kcmm42 |
| edge-type-to-value | `edgeTypeToValue` | dist/columns/utils.js | gnnpg5z |
| value-to-edge-type | `valueToEdgeType` | dist/columns/utils.js | 68h0bi9 |

All 11 clusters were SOLID with zero false positives and zero drift across 5 runs.

### Refactoring Performed

1. **Decomposition of `utils.ts` (75 lines → 3 domain modules + re-export hub)**:
   - `text-position/index.ts` — Text cursor/position calculation (code points ↔ graphemes)
   - `collection/index.ts` — Array/collection transformation helpers (groupBy, uniq, filterEligible)
   - `formatting/index.ts` — Value display formatting (formatPercentage)
   - `utils.ts` — Re-export hub + `cn()` (UI-specific function)

2. **Naming improvements in `columns/utils.ts`**:
   - `annoKeyToValue` → `serializeAnnoKey` (clear intent: serialization)
   - `valueToAnnoKey` → `deserializeAnnoKey` (clear intent: deserialization)
   - `edgeTypeToValue` → `serializeEdgeType`
   - `valueToEdgeType` → `deserializeEdgeType`
   - Old names kept as aliases for backward compatibility

3. **Documentation**: Each module now has comprehensive JSDoc explaining purpose, parameters, and edge cases.

### 3-Way Verification After Refactoring

| Verification | Result |
|---|---|
| Regrets validate (11 clusters) | ✅ All GREEN |
| Raw output vs KEBENARAN 1 (42 I/O pairs) | ✅ All identical |
| Fingerprint vs KEBENARAN 2 (11 clusters) | ✅ All match |

---

## Adapter Pattern for Higher-Order Functions

### The Problem

Functions like `groupBy(items, getKey)` or `filterEligible(values, value, compareFn)` take function arguments that cannot be serialized in JSON. When Regrets tries to fingerprint these, the function arguments become `null` or are silently dropped, producing incorrect fingerprints.

### The Solution: Adapter Modules

Create a thin wrapper that accepts a serializable description of the function behavior and converts it to the actual function:

```js
// regrets/adapters/group-by-adapter.mjs
import { groupBy } from '../../dist/lib/utils.js';

export function groupByAdapter(input) {
  const { items, keyType } = input;
  let getKey;
  if (keyType === 'mod2') getKey = (x) => x % 2;
  else if (keyType === 'firstChar') getKey = (s) => s[0];
  else if (keyType === 'identity') getKey = (x) => x;
  return groupBy(items, getKey);
}
```

The adapter pattern is also useful for:
- Functions with `Date` parameters → adapter accepts ISO string, converts to Date
- Functions with `RegExp` parameters → adapter accepts pattern string, constructs RegExp
- Functions with `Intl` formatters → adapter accepts locale string, constructs formatter
- Functions with callback parameters → adapter accepts callback type descriptor

### When to Use Adapters vs. Normalize Rules

- **Adapter**: When the function signature itself includes non-serializable types (function args, Date, RegExp, TypedArray)
- **Normalize**: When the function output includes non-deterministic values (timestamps, UUIDs, paths)

---

## Tauri Project Structure Tips

Most Tauri projects follow this structure:

```
my-tauri-app/
  src-tauri/          # Rust backend (not testable with JS Regrets)
    src/
      main.rs
      api.rs
  src/                # TypeScript frontend (testable with JS Regrets)
    lib/
      utils.ts
      store.ts
    components/
  dist/               # Compiled JS (create this for Regrets)
    lib/
      utils.js
  regrets/
    manifest.json
    adapters/
      filter-eligible.mjs
```

Always point the manifest `file` field to the `dist/` directory (compiled JS), never to the `src/` directory (TypeScript source). Regrets uses `import()` which only works with `.js` files.

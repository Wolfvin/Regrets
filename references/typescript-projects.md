# TypeScript Projects — Regrets Workflow Guide

## The Problem

Regrets was designed for JavaScript projects where source files are directly executable.
TypeScript projects add a compilation step: `.ts` source → `.js` output. This creates a gap
that agents frequently miss, leading to:

1. **Manifest pointing to compiled output** — Fingerprints are computed against minified JS, not readable TS source
2. **Stale fingerprints** — If TS source changes but the project isn't rebuilt, Regrets validates against stale output
3. **Inaccurate coverage** — The JS coverage tool analyzes minified output, not the TypeScript source with its type annotations and actual control flow
4. **Wrong file references** — The manifest `file` field points to `js/` or `dist/`, but the agent reads `ts/` or `src/` to understand the code

## Solution: The preBuild + Source Mapping Pattern

### Step 1: Use `preBuild` in manifest.json

Regrets already supports a `preBuild` field that runs before capture/validate:

```json
{
  "preBuild": "npx tsc -p tsconfig.json",
  "clusters": [...]
}
```

This ensures the compiled JS is always fresh before fingerprinting.

**Critical**: Do NOT skip this. Without `preBuild`, you may be fingerprinting stale output.

### Step 2: Map compiled paths to source paths

When writing the manifest, the `file` field must point to the **compiled** JS output
(because that's what Regrets imports and executes). But for analysis (reading code,
writing branch maps, understanding logic), you must read the **TypeScript source**.

Common path mappings:
| Manifest `file` | Actual source | Pattern |
|---|---|---|
| `js/shared/date-utils.js` | `ts/shared/date-utils.ts` | `js/` → `ts/` |
| `dist/utils.js` | `src/utils.ts` | `dist/` → `src/` |
| `build/index.js` | `src/index.ts` | `build/` → `src/` |
| `out/module.js` | `src/module.ts` | `out/` → `src/` |

### Step 3: Use `--ts` flag for branch-map

The `regret branch-map --ts` command automatically resolves TypeScript source files
from the manifest's JS paths. It generates `regrets/branch-map.md` from the actual
source code, not the minified output.

```bash
node scripts/regret.js branch-map --ts
```

This is essential for accurate branch analysis. Minified JS has:
- No line breaks (entire file is one line)
- Renamed variables (unreadable conditions)
- No type information (can't distinguish union types)

### Step 4: Analyze TS source, fingerprint JS output

The workflow for TypeScript projects:

```
1. Read .ts source files        → Understand the code, find clusters
2. regret scan --ts             → Suggest clusters from TS source
3. Write manifest.json          → file: points to compiled .js
4. regret branch-map --ts       → Generate branch map from TS source
5. Add inputs to manifest       → Based on branch-map suggestions
6. regret capture               → preBuild runs tsc, then fingerprints compiled .js
7. regret validate              → Rebuilds and validates
8. regret drift                 → Ensures stability across builds
9. regret health                → All SOLID?
```

## Common TypeScript Project Structures

### Chrome Extension (TypeScript → minified JS)

```
project/
  extension_source/     ← TypeScript source
    ts/
      shared/
        date-utils.ts
      xhr-mode/
        exporter.ts
  extension_package/    ← Compiled + minified output
    js/
      shared/
        date-utils.js   (1 line, minified)
      xhr-mode/
        exporter.js     (1 line, minified)
```

Manifest `file`: `js/shared/date-utils.js` (relative to extension_source/)
Source for analysis: `ts/shared/date-utils.ts`

**The Regrets manifest lives in `extension_source/regrets/`** because that's where
the compiled JS output is referenced from.

### Tauri App (TypeScript → bundled)

```
project/
  src/                  ← TypeScript source
    utils/
      format.ts
  dist/                 ← Bundled output
    utils/
      format.js
```

Manifest `file`: `dist/utils/format.js`
preBuild: `npm run build`

### Next.js (TypeScript → compiled)

```
project/
  src/                  ← TypeScript source
    lib/
      calculate.ts
  .next/                ← Build output (not typically used)
```

For Next.js, use the source `.ts` files directly with `stack: "ts"` and
set `preBuild` to `npx tsc --noEmit` for type checking only.

## Warning Signs

If you see these in your Regrets workflow, you're hitting the TypeScript gap:

- **Fingerprint changes on every capture** (even without code changes) → Minifier output is non-deterministic. Add `normalize` rules or use a stable build.
- **Coverage report shows 0 branches** → You're analyzing minified JS. Use `--ts` flag.
- **"Entry not found" errors** → TypeScript `export` syntax doesn't compile to the expected JS export pattern. Check compiled output with `console.log(Object.keys(await import('./file.js')))`.

## Case Study: Coretax-Auto-Downloader

The `fought/extension_source/` project uses TypeScript compiled to minified JavaScript
for a Chrome extension. The manifest references `js/shared/date-utils.js` (1 line, minified),
but the actual source is at `ts/shared/date-utils.ts` (86 lines, readable).

Key findings:
1. The compiled JS files are 1-line minified → impossible to analyze branches
2. The `preBuild` field was missing from the manifest → risk of stale fingerprints
3. Branch coverage analysis was meaningless against minified output
4. The `regret branch-map --ts` command was needed to generate meaningful analysis

This led to the creation of:
- `scripts/branch-map.js` with `--ts` flag for TypeScript-aware branch map generation
- This reference document for future agents working with TypeScript projects

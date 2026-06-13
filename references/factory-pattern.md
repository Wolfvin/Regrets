# Factory Pattern Projects — Regrets Integration Guide

## Overview

Many large JavaScript/TypeScript libraries use a **factory pattern** for dependency injection and modular composition. In this pattern, individual functions are not directly exported — instead, **factory functions** are exported, which must be called with a dependency scope to produce the actual callable function.

**Example: mathjs**

```js
// src/function/arithmetic/add.js — individual file exports a FACTORY, not a function
export const createAdd = factory('add', ['typed', 'addScalar', 'matrix'], ({ typed, addScalar, matrix }) => {
  return typed('add', { 'any, any': addScalar, ... })
})
```

The exported `createAdd` is NOT callable as `createAdd(2, 3)` — it needs its dependencies resolved first. The actual `add` function is created when all factories are instantiated together.

## The Problem for Regrets

Regrets' default workflow assumes you can point `file` at a source file and `entry` at an exported function. For factory-pattern projects:

1. **Individual source files export factories** (`createAdd`), not callable functions (`add`)
2. **Calling `createAdd(2, 3)` will fail** — it expects a dependency scope object, not numeric arguments
3. **The `scan` command detects factory exports** and warns you not to use them directly

## The Solution: Use the Compiled Barrel File

Factory-pattern projects typically have a **compiled barrel file** that instantiates all factories and exports the resulting functions:

```
lib/esm/index.js       ← Exports instantiated functions: add, multiply, sin, etc.
lib/esm/number.js      ← Exports a lighter subset (number-only functions)
lib/cjs/index.js       ← CommonJS version
```

### Manifest Configuration

```json
{
  "preBuild": "npm run build",
  "clusters": [
    {
      "id": "arithmetic-add",
      "entry": "add",
      "watches": ["add"],
      "file": "lib/esm/index.js",
      "stack": "js",
      "outputTransform": "pojo",
      "inputs": [
        [2, 3],
        [0, 0],
        [-1, 5.5]
      ],
      "multiArgs": true
    }
  ]
}
```

Key differences from a typical manifest:

| Field | Typical Value | Factory-Pattern Value |
|-------|--------------|----------------------|
| `file` | `src/add.js` | `lib/esm/index.js` (compiled barrel) |
| `entry` | `add` | `add` (instantiated, not `createAdd`) |
| `outputTransform` | (not needed) | `"pojo"` or `"toString"` |
| `preBuild` | (not needed) | `"npm run build"` |

### Why `outputTransform: "pojo"`?

Factory-pattern libraries often return **custom class instances** instead of plain JavaScript values:

- `math.add(math.complex(2,3), math.complex(-4,1))` returns a `Complex` object
- `math.unit('5 cm')` returns a `Unit` object
- `math.matrix([[1,2],[3,4]])` returns a `Matrix` object
- `math.bignumber('3.14159')` returns a `BigNumber` object

These custom objects can't be directly fingerprinted because `deepClone` loses class identity and `JSON.stringify` may produce incomplete output. The `"pojo"` transform recursively converts class instances to plain objects using their `.toJSON()` methods when available, or by walking own enumerable properties.

Available `outputTransform` options for factory-pattern projects:

| Transform | Use Case |
|-----------|----------|
| `"pojo"` | Deep conversion of class instances to plain objects (recommended for mathjs) |
| `"toString"` | String representation — good when output is always a simple value or string |
| `"toJSON"` | Call `.toJSON()` on objects — works for libraries that implement it |
| `"json"` | Force JSON round-trip — strips non-serializable values |

### Why `preBuild`?

Since the manifest points to **compiled output** (`lib/esm/`), you must ensure the project is built before Regrets can import it. The `preBuild` field in the manifest tells Regrets to run a build command before capture/validate:

```json
{
  "preBuild": "npm run build",
  "clusters": [...]
}
```

This is especially important for:
- TypeScript projects that compile to JS
- Factory-pattern projects that need compilation to produce the barrel file
- Projects with rollup/webpack bundles needed for the barrel export

## Scanning Factory-Pattern Projects

When you run `regret scan` on a factory-pattern project, Regrets now detects:

1. **Barrel files** — re-export aggregators that collect factory outputs
2. **Factory pattern files** — source files using the `factory()` pattern
3. **Warnings** — that factory exports (`createAdd`) are not directly callable

Example output:

```
📡 Scanning project for cluster suggestions...

📦 Barrel files detected (re-export aggregators):
  lib/esm/index.js (200+ exports)
    Exports: add, subtract, multiply, sin, cos, ...

🏭 Factory pattern detected in 677 file(s).
   ⚠️  Factory exports are NOT directly callable — they need dependency injection first.
   Use the compiled barrel file (e.g., lib/esm/index.js) as the entry point instead.
```

## Cluster Grouping

For large projects with hundreds of functions, organize clusters using the manifest's optional `groups` field:

```json
{
  "groups": [
    { "id": "arithmetic", "description": "Basic arithmetic operations" },
    { "id": "trigonometry", "description": "Trigonometric functions" },
    { "id": "matrix", "description": "Matrix operations" },
    { "id": "algebra", "description": "Symbolic algebra" }
  ],
  "clusters": [
    { "id": "arithmetic-add", "group": "arithmetic", ... },
    { "id": "arithmetic-subtract", "group": "arithmetic", ... },
    { "id": "trig-sin", "group": "trigonometry", ... }
  ]
}
```

The `group` field on each cluster is optional and purely for organizational purposes. Use `regret validate --group arithmetic` to validate only clusters in a specific group.

## Multi-Args for Math Functions

Math functions typically take multiple arguments. Use `multiArgs: true` and provide inputs as arrays:

```json
{
  "id": "arithmetic-add",
  "entry": "add",
  "multiArgs": true,
  "inputs": [
    [2, 3],
    [0, 0],
    [-1, 5.5]
  ]
}
```

Without `multiArgs`, the entire input array would be passed as a single argument: `add([2, 3])` instead of `add(2, 3)`.

## trackMutation for Mutable Operations

Some library functions may mutate their inputs (e.g., matrix operations that modify arrays in-place). Enable `trackMutation: true` to detect this:

```json
{
  "id": "matrix-subset",
  "entry": "subset",
  "trackMutation": true,
  "inputs": [...]
}
```

If a mutation is detected during capture, Regrets will warn:

```
⚠️  Input MUTATION detected in cluster matrix-subset! Function modified its input.
```

This is important because mutation during refactoring can silently break behavior that fingerprint-based tests might miss if the output is the same but the input was modified as a side effect.

## Example: Full mathjs Manifest

```json
{
  "preBuild": "npm run build",
  "projectName": "mathjs",
  "groups": [
    { "id": "arithmetic", "description": "Arithmetic operations" },
    { "id": "trigonometry", "description": "Trigonometric functions" },
    { "id": "matrix", "description": "Matrix operations" },
    { "id": "algebra", "description": "Algebra and symbolic math" },
    { "id": "expression", "description": "Expression parser" }
  ],
  "clusters": [
    {
      "id": "arithmetic-add",
      "group": "arithmetic",
      "entry": "add",
      "watches": ["add"],
      "file": "lib/esm/index.js",
      "stack": "js",
      "multiArgs": true,
      "outputTransform": "pojo",
      "inputs": [[2, 3], [0, 0], [-1, 5.5], [1e10, 1e-10]]
    },
    {
      "id": "trig-sin",
      "group": "trigonometry",
      "entry": "sin",
      "watches": ["sin"],
      "file": "lib/esm/index.js",
      "stack": "js",
      "outputTransform": "pojo",
      "normalize": ["floatTolerance:6"],
      "inputs": [0, 1.5707963267948966, 3.141592653589793, -1]
    },
    {
      "id": "matrix-det",
      "group": "matrix",
      "entry": "det",
      "watches": ["det"],
      "file": "lib/esm/index.js",
      "stack": "js",
      "outputTransform": "pojo",
      "inputs": [[[1,2],[3,4]], [[5]], [[0,0],[0,0]]]
    }
  ]
}
```

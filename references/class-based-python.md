# Class-Based Python Libraries — Regrets Integration Guide

## Overview

Many Python libraries expose their API through class instances rather than module-level functions. Examples include computational geometry libraries (trimesh), scientific computing (scipy.spatial), and game engines. Regrets' Python capture and validate scripts support `classMethod` mode to fingerprint instance methods, matching the existing JS `classMethod` support.

## The Problem

When a library's primary API is a class like `Trimesh`, you can't just call `trimesh.area()` as a module-level function. You need to:

1. **Instantiate** the class with constructor arguments
2. **Call methods** on the instance (which may access `self` state)
3. **Handle cached properties** (`@property` + `@cache_decorator` patterns)

Without `classMethod` support, you'd have to write adapter functions for every method — which is fragile and defeats the purpose of behavioral testing.

## Manifest Format

```json
{
  "clusters": [
    {
      "id": "mesh-area",
      "entry": "Trimesh",
      "module": "trimesh.base",
      "stack": "python",
      "classMethod": "area",
      "constructor": "Trimesh",
      "constructorArgs": [
        {"vertices": [[0,0,0],[1,0,0],[0,1,0]], "faces": [[0,1,2]]}
      ],
      "watches": [],
      "fingerprintLevel": "entry",
      "normalize": ["numpySummary"],
      "description": "Compute total surface area of a triangle mesh"
    }
  ]
}
```

### Key Fields

| Field | Type | Description |
|-------|------|-------------|
| `classMethod` | string | The method name to call on the instance. This is what gets fingerprinted. |
| `constructor` | string | The class name to instantiate. Defaults to `entry` if not specified. |
| `constructorArgs` | array | Arguments to pass to the class constructor. Each input is used to construct a fresh instance. |
| `setup` | string | Optional method name to call after construction but before the entry method. |
| `instanceMethods` | object | Optional mapping of class names to method names for ghost wrapping. |

### How It Works

1. **Capture**: For each input, a fresh class instance is created via `ClassName(*constructorArgs)`. The entry method is called on the instance, and the output is fingerprinted.
2. **Validate**: The same instantiation process is repeated, and the live fingerprint is compared against the golden `.regret` file.
3. **Instance isolation**: Each input gets its own fresh instance to prevent state leakage between runs.

## Constructor Inputs

There are two patterns for providing constructor arguments:

### Pattern 1: constructorArgs + entry input

The `constructorArgs` creates the instance, then the entry method is called with the `inputs` value:

```json
{
  "id": "mesh-contains",
  "entry": "Trimesh",
  "module": "trimesh.base",
  "stack": "python",
  "classMethod": "contains",
  "constructor": "Trimesh",
  "constructorArgs": [[0,0,0,1,0,0,0,1,0], [[0,1,2]]],
  "inputs": [[[0.25, 0.25, 0.0]]],
  "multiArgs": true,
  "description": "Test if point is inside mesh"
}
```

Flow: `mesh = Trimesh([0,0,0,1,0,0,0,1,0], [[0,1,2]])` then `mesh.contains([0.25, 0.25, 0.0])`

### Pattern 2: constructorArgs only (no method input)

For property access or zero-argument methods:

```json
{
  "id": "mesh-volume",
  "entry": "Trimesh",
  "module": "trimesh.base",
  "stack": "python",
  "classMethod": "volume",
  "constructor": "Trimesh",
  "constructorArgs": [[0,0,0,1,0,0,0,1,0], [[0,1,2]]],
  "inputs": [null],
  "description": "Compute mesh volume"
}
```

Flow: `mesh = Trimesh(...)` then `mesh.volume`

## numpySummary Normalize Rule

Class-based geometry/scientific libraries often return large numpy arrays. Including the full array data in fingerprints creates massive `.regret` files and is fragile (tiny float differences cause false negatives).

The `numpySummary` normalize rule replaces large numpy arrays with a statistical summary before fingerprinting:

```json
{
  "normalize": ["numpySummary"]
}
```

**Behavior**: Arrays with more than 16 elements are replaced with:
```json
{
  "__numpy_summary__": true,
  "shape": [1000, 3],
  "dtype": "float64",
  "min": -1.0,
  "max": 1.0,
  "mean": 0.0023,
  "sum": 6.9
}
```

**Custom threshold**: Use `"numpySummary:100"` to only summarize arrays with more than 100 elements.

**Small arrays** (≤ threshold): Converted to lists for normal value-mode fingerprinting.

**This is a Python-only rule** — JS stacks will not encounter numpy arrays, so the rule is a no-op in JS.

## Properties vs Methods

Python `@property` descriptors are not callable — they're accessed as attributes. The `classMethod` mode works with regular methods (callable). For properties, use `outputTransform: "dict"` or write an adapter:

```python
# Adapter for property access
def get_mesh_bounds(mesh):
    return mesh.bounds  # property, not method
```

Then use this adapter as the entry function in a regular (non-classMethod) cluster.

## Watch List for Instance Methods

The `watches` field in a `classMethod` cluster refers to method names on the instance. The ghost wrapper replaces these methods on the instance object with recording wrappers:

```json
{
  "classMethod": "is_watertight",
  "watches": ["merge_vertices", "fix_normals"],
  "constructor": "Trimesh",
  "constructorArgs": [...]
}
```

This instruments `instance.merge_vertices` and `instance.fix_normals` to record their calls while `instance.is_watertight` is the entry point being fingerprinted.

## Common Patterns in Geometry Libraries

| Library | Class | Key Methods | Normalize |
|---------|-------|-------------|-----------|
| trimesh | `Trimesh` | `area`, `volume`, `is_watertight`, `contains` | `numpySummary`, `floatTolerance` |
| open3d | `TriangleMesh` | `get_surface_area`, `get_volume` | `numpySummary` |
| pymesh | `Mesh` | `volume`, `surface_area`, `is_manifold` | `numpySummary` |

## Troubleshooting

### Constructor fails with missing dependency

Some classes import optional C extensions in `__init__`. If the dependency isn't installed, capture will fail with `ImportError`. Install the dependency or use a simpler constructor.

### Property not callable error

If `classMethod` targets a `@property`, you'll get `"X" is not callable`. Use an adapter function instead, or target the underlying method (e.g., `_get_X`).

### Huge .regret files from numpy arrays

Add `"normalize": ["numpySummary"]` to the cluster definition. This replaces large arrays with statistical summaries.

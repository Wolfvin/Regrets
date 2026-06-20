# C# Stack — Regrets Capture + Validate

## Overview

This directory contains a working example of Regrets capture + validate for C#.

## Files

| File | Purpose |
|------|---------|
| `src/MathUtils.cs` | Simple math library with 4 functions (Add, Multiply, ReverseString, IsPrime) |
| `MathLib.csproj` | .NET project file |
| `manifest.json` | Regrets manifest with 3 clusters (math-add, math-reverse, math-isprime) |
| `verify_csharp.sh` | End-to-end verification script |

## .regret File Format

C# .regret files use the same format as JS/Python/Go:

```
cluster: math-add
version: 1
fingerprint: <7-char base36>
captured: 2026-06-20T12:00:00Z
stack: csharp
fingerprintLevel: entry
---
INPUT  [1,2]
OUTPUT 3
HASH   <7-char base36>
```

## Fingerprint Algorithm

Identical to JS/Python/Go:
1. `stableStringify(input) + "|" + stableStringify(output)` — deterministic JSON with sorted keys
2. SHA-256 hash of the combined string
3. Convert to base36 (lowercase)
4. Take first 7 characters

## Running the Example

```bash
# From the Regrets repo root:
cd proof/csharp
bash verify_csharp.sh
```

This will:
1. Create a temp C# project
2. Capture all 3 clusters → generates .regret files
3. Validate → should PASS (no code change)
4. Break MathUtils.Add (change + to -)
5. Validate → should FAIL for math-add
6. Revert the change
7. Validate → should PASS again

## Requirements

- .NET SDK 8.0+ (`dotnet` command available)
- Bash
- Node.js (for manifest.json parsing — used by capture_csharp.sh and validate_csharp.sh)

## Manifest Schema for C# Clusters

```json
{
  "id": "math-add",
  "entry": "MathUtils.Add",
  "csharpClass": "MathLib.MathUtils",
  "file": "src/MathUtils.cs",
  "stack": "csharp",
  "fingerprintLevel": "entry",
  "inputs": [[1, 2], [10, 20]],
  "multiArgs": true
}
```

### C#-specific fields:
- `csharpClass`: Full class name including namespace (e.g., `MathLib.MathUtils`)
- `multiArgs`: When `true`, array inputs are spread as individual function arguments (e.g., `[1, 2]` → `Add(1, 2)`). When `false`/omitted, the entire input is passed as a single argument.

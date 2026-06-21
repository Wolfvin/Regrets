# Regrets C# Demo — `proof/csharp-demo/`

This directory is a working end-to-end example of the Regrets C# (.NET) capture + validate cycle.

It demonstrates that the C# implementation produces **fingerprints byte-for-byte identical** to the JS / Python / Go implementations, so a C# cluster can live alongside any other stack in the same Regrets workspace.

## Layout

```
proof/csharp-demo/
├── src/
│   └── Calculator.cs                  # the "real" code under contract
├── variants/
│   ├── Calculator_refactored.cs       # behavior-preserving refactor (validate should PASS)
│   └── Calculator_broken.cs           # intentionally broken (validate should FAIL)
├── regrets/
│   ├── manifest.json                  # 5 clusters, each pointing at Calculator.<method>
│   ├── calc-add.regret                # golden contracts (capture output)
│   ├── calc-multiply.regret
│   ├── calc-reverse.regret
│   ├── calc-fizzbuzz.regret
│   └── calc-parse-positive.regret
├── verify_demo.sh                     # end-to-end demo script (3 scenarios)
└── README.md                          # this file
```

## Prerequisites

- **.NET SDK 8+** on `PATH` (or set `DOTNET_CMD=/path/to/dotnet`).
  - On Debian/Ubuntu: `curl -sSL https://dot.net/v1/dotnet-install.sh | bash -s -- --channel 8.0`
  - On macOS: `brew install --cask dotnet-sdk`
  - On Windows: install from https://dot.net

## Quick start

From this directory:

```bash
# Capture → write .regret files
bash ../../scripts/capture_csharp.sh

# Validate → re-run every input, compare hashes
bash ../../scripts/validate_csharp.sh

# End-to-end demo (capture + validate + refactor PASS + breaking FAIL + restore)
bash verify_demo.sh
```

## The five clusters

| Cluster              | Method              | Inputs                                   | Fingerprint |
|----------------------|---------------------|------------------------------------------|-------------|
| `calc-add`           | `Calculator.Add`    | `[2,3]`, `[10,20]`, `[-5,7]`, `[0,0]`, `[100,200]` | `13mxb0z` |
| `calc-multiply`      | `Calculator.Multiply` | `[3,4]`, `[12,12]`, `[-3,9]`           | `1udz6ou`   |
| `calc-reverse`       | `Calculator.ReverseString` | `"hello"`, `"Regrets"`, `"racecar"`, `""` | `5nssd6s` |
| `calc-fizzbuzz`      | `Calculator.FizzBuzz` | `5`, `15`, `1`                         | `v43ye6z`   |
| `calc-parse-positive`| `Calculator.ParsePositiveInt` | `"42"`, `"100"`                | `1f74s4r`   |

(Fingerprint shown is for the cluster's first input — see the `.regret` file for the per-input hashes via the `INPUTS` line.)

## The C# Regrets contract

A C# method is Regrets-eligible if it has the signature:

```csharp
public static object? MethodName(System.Text.Json.JsonElement input)
```

- Takes a **single `JsonElement`** parameter (whatever was in the manifest's `inputs` array for that cluster — primitive, array, or object).
- Returns any **JSON-serializable value** (primitive, list, dictionary, POCO, `null`).
- May **throw** — the exception's type + message is captured as the `OUTPUT` (an `ERROR_CONTRACT` line is written instead of `OUTPUT`).

This matches the model "function(input) → output, both JSON-able" that Regrets already uses for JS / Python.

## Manifest schema

```jsonc
{
  "clusters": [
    {
      "id": "calc-add",                       // → regrets/calc-add.regret
      "entry": "Add",                          // public static method name
      "class": "RegretDemo.Calculator",        // fully-qualified type name
      "stack": "csharp",                       // REQUIRED: must be "csharp"
      "fingerprintLevel": "entry",
      "watches": ["Add"],                      // optional, informational
      "description": "Add two integers.",       // optional, informational
      "inputs": [                              // 1+ JSON values
        [2, 3],
        [10, 20]
      ]
    }
  ]
}
```

The first input becomes the cluster's top-level `INPUT / OUTPUT / HASH` lines.
Subsequent inputs are stored in an `INPUTS` JSON array (issue #315 pattern),
and `validate_csharp.sh` re-runs every input and compares every hash.

## The `.regret` file format

Identical to the JS / Python / Go implementation:

```
cluster: calc-add
version: 1
fingerprint: 13mxb0z
captured: 2026-06-20T18:00:15.160129+00:00
watches: [Add]
entry: Add
stack: csharp
fingerprintLevel: entry
class: RegretDemo.Calculator
env: {"runtime":"dotnet","version":"8.0.28"}
---
INPUT  [2,3]
OUTPUT 5
HASH   13mxb0z
INPUTS [{"input":[10,20],"output":30,"hash":"560s4tf","threw":false}, ...]
```

## The fingerprint algorithm (cross-stack identical)

```
combined  = stableStringify(input)  + "|" + stableStringify(output)
hash      = sha256(combined)        // 64-char lowercase hex
num       = BigInt("0x" + hash)     // positive big integer
b36       = num.toString(36)        // base-36, lowercase
fp        = b36.slice(0, 7)         // first 7 chars
```

`stableStringify` matches `scripts/fingerprint.js` exactly:
- Object keys sorted lexicographically (`Object.keys(obj).sort()` semantics)
- Arrays preserve order
- `NaN` / `±Infinity` → sentinel strings (`"__nan__"`, `"__infinity__"`, `"__neg_infinity__"`)
- Numbers serialized as integers when whole, minimal-digit floats otherwise

Verification: the Python reference and the C# implementation produce **identical** 7-char fingerprints for every input in this demo (verified by hand — see PR description for the comparison table).

## Scenarios covered by `verify_demo.sh`

1. **Capture baseline** — write 5 `.regret` files using the original `Calculator.cs`.
2. **Validate baseline** — every cluster must PASS (no code change).
3. **Refactor** — swap `src/Calculator.cs` ← `variants/Calculator_refactored.cs`. The implementations are different (e.g. `Multiply` via repeated addition, `ReverseString` via LINQ, `FizzBuzz` via build-then-split), but the behavior is identical. Validate must still PASS for every cluster.
4. **Breaking** — swap `src/Calculator.cs` ← `variants/Calculator_broken.cs`. Each method has a subtle bug (off-by-one in `Add`, `+a` in `Multiply`, uppercased first char in `ReverseString`, `"Fizz Buzz"` instead of `"FizzBuzz"`, `<= 0` instead of `< 0`). Validate must FAIL with a clear diff showing golden vs. live hash and golden vs. live output.
5. **Restore** — swap back to the original `Calculator.cs`. Validate must PASS again.

## What's intentionally NOT in scope (see issue #350)

- Callee wrapping (Phase 2) — would need a C# source-rewriting / IL-weaving approach; deferred to a follow-up PR.
- Generic methods (type-erasure handling is non-trivial).
- `async Task<T>` return values (need sync-over-async handling).
- ASP.NET / application framework integration (too many side effects).

These limits are documented in the issue and in `scripts/capture_csharp.sh`.

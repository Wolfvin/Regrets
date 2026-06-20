# C# Stack Variant

Regression fingerprinting for C# / .NET 8+ projects using reflection-based capture and `dotnet` runner.

## Status: Working

C# stack support is **working** end-to-end — both `capture` and `validate` are fully implemented with the same fingerprint algorithm as JS/Python/PHP/Go. Tested against a real C# example in `proof/csharp-example/`.

---

## Quick Start

1. Install .NET 8+ SDK from <https://dot.net>
2. Build your C# project: `dotnet build` (produces the `.dll` to fingerprint)
3. Run `node scripts/regret.js init --stack csharp` to scaffold `regrets/manifest.json`
4. Edit `regrets/manifest.json` with your cluster definitions (see Manifest Schema below)
5. Run `node scripts/regret.js capture` to capture fingerprints
6. Run `node scripts/regret.js validate` to validate

For a complete working example, see `proof/csharp-example/` — a `MorseCode.Encode()` pure function that is captured, validated (PASS for valid refactor, FAIL for breaking change).

---

## How C# Capture Works

Unlike JS (Proxy-based ghost) and Python (function wrapping), C# uses **reflection-based invocation**:

1. `capture_csharp.sh` dispatches to `dotnet run` on `scripts/regret_csharp/`
2. `RegretRunner.cs` reads `regrets/manifest.json` from the project root
3. For each C# cluster:
   - Loads the compiled `.dll` via `Assembly.LoadFrom`
   - Resolves the type via `assembly.GetType(class)` (with fallback to simple-name match)
   - Resolves the method via `type.GetMethod(entry, BindingFlags)`
   - Converts the JSON input to the method's parameter type
   - Invokes the method (creating an instance first if it's an instance method)
   - Computes the fingerprint: `sha256(stableStringify(input) + "|" + stableStringify(output)) → base36 → first 7 chars`
4. Writes the `.regret` file to `regrets/<cluster-id>.regret`

Validate is symmetric — it reads the `.regret` file, re-invokes the function with the same input, recomputes the fingerprint, and compares.

---

## Manifest Schema

C# clusters use these fields:

| Field | Required | Description |
|-------|----------|-------------|
| `id` | Yes | Cluster identifier (used as filename for `.regret`) |
| `entry` | Yes | Public method name to invoke |
| `watches` | Yes | List of method names to instrument (informational only in v1 — same as `entry`) |
| `stack` | Yes | Must be `"csharp"` |
| `assembly` | Yes | Path to compiled `.dll` (relative to project root or absolute) |
| `class` | Optional | Fully-qualified class name (default: `"Program"`). Resolved via `GetType`; falls back to simple-name match across all types in assembly. |
| `fingerprintLevel` | Optional | Must be `"entry"` (only level supported in v1) |
| `description` | Optional | Human-readable description |
| `inputs` | Yes | Array of inputs. Each input can be a primitive (string/number/boolean), array, or object. The first input is captured (multi-input support is TODO). |

### Example manifest

```json
{
  "clusters": [
    {
      "id": "morse-encode",
      "entry": "Encode",
      "watches": ["Encode"],
      "stack": "csharp",
      "assembly": "bin/Debug/net8.0/RegretExample.dll",
      "class": "RegretExample.MorseCode",
      "fingerprintLevel": "entry",
      "description": "Encode text to International Morse Code",
      "inputs": [
        "SOS",
        "HELLO WORLD",
        "test 123",
        ""
      ]
    }
  ]
}
```

---

## `.regret` File Format

Identical to JS/Python/PHP/Go — the format is the cross-stack contract:

```
cluster: morse-encode
version: 1
fingerprint: 1nm9yky
captured: 2026-06-20T18:04:26.8055541+00:00
entry: Encode
stack: csharp
class: RegretExample.MorseCode
assembly: bin/Debug/net8.0/RegretExample.dll
fingerprintLevel: entry
---
INPUT  "SOS"
OUTPUT "... --- ..."
HASH   1nm9yky
```

The `class` and `assembly` fields are C#-specific metadata — they allow validate to find the right method on subsequent runs.

---

## Fingerprint Algorithm

The fingerprint algorithm is **identical** across all stacks. Given the same `(input, output)` pair, JS, Python, PHP, Go, and C# all produce the same 7-char base36 hash.

Implementation in `scripts/regret_csharp/Fingerprint.cs`:

1. `stableStringify(input)` — deterministic JSON with sorted keys recursively
2. `stableStringify(output)` — same
3. `combined = input + "|" + output`
4. `hash = sha256(combined)` (hex string, lowercase)
5. `bigInt = parse(hex)` as BigInteger
6. `base36 = bigInt.toString(36)` (lowercase, no leading zeros stripped)
7. `fingerprint = base36.slice(0, 7)`

**Cross-stack verification**: the C# implementation has been tested against the JS implementation with input `"SOS"` and output `"... --- ..."` — both produce `1nm9yky`.

---

## What C# Capture Supports

| Pattern | Supported | Notes |
|---------|-----------|-------|
| `public static` method with 0 parameters | ✅ | |
| `public static` method with 1 parameter (primitive/string/array/object) | ✅ | JSON deserialized to parameter type |
| `public static` method with multiple parameters | ✅ | Input must be array of matching length |
| `public` instance method (non-static) | ✅ | Runner instantiates the class via parameterless constructor |
| Method returning primitive/string/array/object | ✅ | Output serialized via reflection |
| Method returning `null` / empty | ⏭️ | Skipped (Trivial Output Guard) |
| Method throwing exception | ❌ | Reported as failure |
| `async`/`Task<T>` returning methods | ❌ | Out of scope for v1 |
| `ref`/`out` parameters | ❌ | Out of scope for v1 |
| Generic methods with type parameters | ❌ | Out of scope for v1 |
| Multi-input capture (one `.regret` per input) | ❌ | TODO — currently only first input is captured |

---

## Building the `.dll` Before Capture

C# capture needs the compiled `.dll`. Always run `dotnet build` before `regret capture`:

```bash
cd your-csharp-project
dotnet build
node scripts/regret.js capture
```

If you change the source code (e.g., refactor), rebuild before validate:

```bash
dotnet build
node scripts/regret.js validate
```

The manifest's `assembly` field should point to the build output. For a typical `dotnet build`, this is `bin/Debug/net8.0/<YourProject>.dll`.

---

## CLI Commands

All commands are invoked via the standard Regrets CLI (`node scripts/regret.js`):

```bash
# Scaffold regrets/ with C# manifest template
node scripts/regret.js init --stack csharp

# Capture all C# clusters
node scripts/regret.js capture

# Validate all C# clusters
node scripts/regret.js validate

# Capture/validate a single cluster
node scripts/regret.js capture --cluster morse-encode
node scripts/regret.js validate --cluster morse-encode

# Update a cluster after intentional behavior change
node scripts/regret.js update morse-encode --reason "changed letter separator from space to slash"
```

The CLI auto-detects C# clusters by reading `stack: "csharp"` from the manifest and dispatches to `scripts/capture_csharp.sh` / `scripts/validate_csharp.sh`, which in turn call `dotnet run` on `scripts/regret_csharp/`.

---

## Direct Invocation (Without CLI)

If you want to bypass the JS CLI and run capture/validate directly:

```bash
# Capture (run from your project root)
bash scripts/capture_csharp.sh capture

# Validate
bash scripts/capture_csharp.sh validate
# or equivalently:
bash scripts/validate_csharp.sh

# Single cluster
bash scripts/capture_csharp.sh capture --cluster morse-encode

# Update with reason
bash scripts/capture_csharp.sh update --update morse-encode --reason "..."
```

The shell script sets `REGRET_PROJECT_ROOT` to the caller's cwd so the runner can find `regrets/manifest.json` even though `dotnet run` changes cwd to the project directory.

---

## Limitations & Future Work

1. **Single-input capture only**: Only the first input in the manifest's `inputs` array is captured. Multi-input support (one `.regret` per input, matching JS/Python behavior) is TODO — see the comment in `RegretRunner.InvokeCluster`.

2. **No callee wrapping**: Unlike JS/Python ghost proxy, C# does not wrap callee functions to record intermediate calls. The `.calls.*.regret` callee contract is not supported for C# in v1.

3. **No drift / ci / guard / chain support**: Only `capture`, `validate`, `update`, and `list` commands are implemented for C#. Other commands (drift, ci, guard, chain) will fall through to JS runner — they will not pick up C# clusters. This matches the current state of Go and Rust stacks.

4. **Instance method instantiation**: Instance methods are invoked via `Activator.CreateInstance(type)`, which requires a parameterless constructor. Constructors with required arguments are not supported.

5. **Numeric type coercion**: The runner attempts `Convert.ChangeType` for numeric conversions, falling back to JSON round-trip. Edge cases (e.g., `BigInteger`, custom numeric types) may not work.

6. **`dotnet run` startup overhead**: Each invocation of `capture_csharp.sh` runs `dotnet run`, which has ~1-2s startup time. For repeated runs, consider publishing the runner as a single-file executable (`dotnet publish -c Release`) and updating the shell script to invoke it directly.

---

## Cross-Stack Fingerprint Verification

To verify the C# fingerprint matches the JS fingerprint for the same input/output:

```bash
# JS:
node -e "import('./scripts/fingerprint.js').then(({fingerprint}) => console.log(fingerprint('SOS', '... --- ...')))"

# C# (within proof/csharp-example/ after capture):
cat regrets/morse-encode.regret | grep "^fingerprint:"
```

Both should print `1nm9yky`. This is the contract: **the same `(input, output)` pair MUST produce the same 7-char hash across all stacks**. The C# implementation has been verified against JS for the MorseCode example.

---

## See Also

- [`proof/csharp-example/`](../proof/csharp-example/) — working end-to-end example
- [`references/fingerprint-spec.md`](./fingerprint-spec.md) — fingerprint algorithm specification
- [`references/go.md`](./go.md) — Go stack variant (similar shell-dispatch pattern)
- [`references/rust.md`](./rust.md) — Rust stack variant

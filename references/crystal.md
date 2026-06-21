# Crystal Stack Guide

Regression fingerprinting for **Crystal** codebases — pure functions, module methods, and class methods.

Crystal clusters use the **bash + Crystal interpreter** runner (`scripts/capture_crystal.sh` + `scripts/validate_crystal.sh`). No Node.js dependency for the actual capture/validate logic — only the bash driver uses Node to template the per-cluster runner .cr file.

---

## Why Crystal Needs Regression Testing

Crystal is a compiled, statically-typed language with Ruby-like syntax. Its pure functions (string processing, math, encoding, parsing) are natural fingerprint targets. Common scenarios where Regrets catches regressions:

- **Shard refactors**: Renaming or reorganizing a public method changes the call signature but not the behavior — Regrets ensures the output is still identical.
- **Algorithm rewrites**: Replacing `each_byte { |b| sum += b }` with `each_char.sum { |c| c.ord }` should produce the same output. Regrets proves it does.
- **Performance optimizations**: Caching, memoization, or precomputed lookup tables must not change observable behavior.
- **Luhn/checksum/encoding libraries**: Any pure transformation library where output stability is a public contract.

---

## Quick Start

1. Install Crystal (https://crystal-lang.org/install/) — version 1.10+ recommended
2. Write your Crystal source file with a top-level `def` or module/class method
3. Create `regrets/manifest.json` with your cluster definitions
4. Run `bash scripts/capture_crystal.sh` to capture fingerprints
5. Run `bash scripts/capture_crystal.sh validate` (or `bash scripts/validate_crystal.sh`) to validate

---

## Manifest for Crystal Clusters

Crystal clusters use `"stack": "crystal"` and follow the same manifest format as JS/Python/PHP clusters.

```json
{
  "clusters": [
    {
      "id": "reverse",
      "entry": "reverse",
      "watches": ["reverse"],
      "file": "src/strings.cr",
      "stack": "crystal",
      "fingerprintLevel": "entry",
      "inputs": ["hello", "regrets", "level"]
    },
    {
      "id": "module-method",
      "entry": "MyModule.process",
      "watches": ["process"],
      "file": "src/my_module.cr",
      "stack": "crystal",
      "inputs": ["input1", "input2"]
    }
  ]
}
```

### Crystal-Specific Manifest Fields

| Field | Required | Description |
|-------|----------|-------------|
| `stack` | Yes | Must be `"crystal"` |
| `file` | Yes | Path to the .cr source file (relative to project root) |
| `entry` | Yes | Function name (`"foo"`) or module/class method (`"Mod.foo"` / `"Class.foo"`) |
| `watches` | Yes | Array of function names (informational; Crystal has no callee wrapping in v1) |
| `fingerprintLevel` | No | `"entry"` only (default) |
| `inputs` | Yes | Array of input values (JSON-compatible: String, Int, Float, Bool, Array, Hash) |
| `multiArgs` | No | `false` (default). When `true`, array inputs are spread as positional args. **Warning:** limited support due to Crystal's static typing. |
| `normalize` | No | Normalization rules (same as JS) |
| `ignoreFields` | No | Fields to exclude from fingerprint (same as JS) |

---

## Pattern 1: Top-Level Function

The simplest pattern — a top-level `def` in a .cr file.

```crystal
# src/strings.cr
def reverse(s : String) : String
  s.reverse
end

def count_vowels(s : String) : Int32
  s.count("aeiouAEIOU")
end
```

### Manifest

```json
{
  "id": "reverse",
  "entry": "reverse",
  "watches": ["reverse"],
  "file": "src/strings.cr",
  "stack": "crystal",
  "inputs": ["hello", "regrets"]
}
```

---

## Pattern 2: Module Method

Methods on a module/class are accessed via the `Mod.foo` or `Class.foo` syntax in the `entry` field.

```crystal
# src/my_module.cr
module MyModule
  def self.process(input : String) : String
    input.upcase
  end
end
```

### Manifest

```json
{
  "id": "module-process",
  "entry": "MyModule.process",
  "watches": ["process"],
  "file": "src/my_module.cr",
  "stack": "crystal",
  "inputs": ["hello", "world"]
}
```

---

## Pattern 3: Function with Non-String Input

Crystal is statically typed — the runner unwraps JSON input as `String` by default. For functions that take `Int64`, `Float64`, `Bool`, or `JSON::Any` directly, write a thin wrapper that accepts `String` and converts internally:

```crystal
# src/calculator.cr
def double_raw(n : Int64) : Int64
  n * 2
end

# Wrapper for Regrets fingerprinting
def double(input : String) : Int64
  double_raw(input.to_i64)
end
```

```json
{
  "id": "double",
  "entry": "double",
  "watches": ["double"],
  "file": "src/calculator.cr",
  "stack": "crystal",
  "inputs": ["1", "5", "100"]
}
```

---

## Fingerprint Algorithm

The Crystal fingerprint (`scripts/crystal/fingerprint.cr`) produces IDENTICAL output to `scripts/fingerprint.js`:

```
fingerprint(input, output) = base36(sha256(stableStringify(input) + "|" + stableStringify(output)))[0..6]
```

Where `stableStringify` is a deterministic JSON serialization with sorted keys (matches JS `stableStringify`).

### Cross-Stack Parity (verified)

| Input | Output | JS reference | Crystal |
|-------|--------|--------------|---------|
| `"hello"` | `"olleh"` | `5nssd6s` | `5nssd6s` ✅ |
| `"hello"` | `2` | `5izc285` | `5izc285` ✅ |
| `"abc"` | `294` | `2i99lkw` | `2i99lkw` ✅ |

---

## .regret File Format

Standard format (identical to JS/Python/PHP/Go/Lua stacks):

```
cluster: reverse
version: 1
fingerprint: 5nssd6s
captured: 2026-06-21T05:43:30Z
watches: [reverse]
entry: reverse
stack: crystal
fingerprintLevel: entry
file: src/strings.cr
---
INPUT  "hello"
OUTPUT "olleh"
HASH   5nssd6s
INPUTS [{"hash":"5nssd6s","input":"hello","output":"olleh"},{"hash":"5hnum9u","input":"regrets","output":"sterger"}]
```

The `INPUTS` line lists every input→hash pair for multi-input clusters, enabling drift detection across all inputs (not just the first).

---

## Full Workflow Example

```bash
# 1. Capture
bash scripts/capture_crystal.sh
#   or with a specific cluster:
bash scripts/capture_crystal.sh --cluster reverse

# 2. Validate (no refactor yet — should PASS)
bash scripts/capture_crystal.sh validate
#   or equivalently:
bash scripts/validate_crystal.sh

# 3. Refactor freely — re-validate after each change
bash scripts/capture_crystal.sh validate --fail-fast

# 4. Update golden fingerprint (if behavior intentionally changed)
bash scripts/capture_crystal.sh --update reverse --reason "reverse now preserves unicode combining marks"

# 5. Drift detection (5 runs, checks for non-determinism)
bash scripts/validate_crystal.sh --runs 5
```

---

## Compatibility with Other Stacks

Crystal clusters coexist with JS, TypeScript, Python, PHP, Go, Rust, etc. in the same `manifest.json`. The capture/validate scripts dispatch by `stack` field.

Currently Crystal is NOT wired into the unified `regret.js` CLI dispatcher (it's a TODO — see issue #408). To capture/validate Crystal clusters, invoke the bash scripts directly:

```bash
bash scripts/capture_crystal.sh
bash scripts/capture_crystal.sh validate
```

---

## Real-World Use Cases

### Luhn Checksum Validation

```crystal
def luhn_valid(num_str : String) : Bool
  sum = 0
  n = num_str.size
  n.times do |i|
    ch = num_str[i]
    d = ch - '0'
    from_right = n - i - 1
    if from_right % 2 == 1
      d = d * 2
      d -= 9 if d > 9
    end
    sum += d
  end
  sum % 10 == 0
end
```

### ASCII Sum (Encoding)

```crystal
def ascii_sum(s : String) : Int32
  sum = 0
  s.each_byte { |b| sum += b }
  sum
end
```

### Slug Generation

```crystal
def slugify(s : String) : String
  s.downcase.gsub(/[^a-z0-9]+/, "-").gsub(/^-|-$/, "")
end
```

All of these are pure functions with deterministic output — ideal fingerprint targets.

---

## Limitations

1. **No callee wrapping** (v1): only the entry function is fingerprinted. Callee wrapping (like JS `ghost.js`) would require Crystal macros or AST manipulation — possible future work.
2. **Static typing constraints**: the entry function must accept `String` (or `JSON::Any`) input. For other input types, write a thin String-accepting wrapper.
3. **multiArgs support is limited**: Crystal's compile-time type checking makes arity dispatch tricky. For multi-arg functions, prefer writing a single-arg wrapper that takes a JSON string and parses it.
4. **No drift detection via manifest**: drift detection via `--runs N` re-runs validate N times (good for catching RNG / time-based non-determinism). For more sophisticated sampling, use the JS stack.

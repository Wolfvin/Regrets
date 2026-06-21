# jq Stack — Regrets Support

## Overview

Regrets supports **jq** as a stack for output-fingerprint regression testing. jq functions defined via `def` blocks can be captured and validated using the same `.regret` file format as all other stacks.

## Fingerprint Model

Since jq is a JSON query language (not a general-purpose programming language), the fingerprint model is:

| Element | Value |
|---------|-------|
| **Input** | JSON value piped to jq (for zero-arg functions) OR argument values (for multi-arg functions) |
| **Output** | JSON result of the jq function invocation |
| **Function** | A `def funcname: ...` (zero-arg) or `def funcname(a;b): ...` (multi-arg) block in a `.jq` file |
| **Fingerprint** | `sha256(stableStringify(input) + "|" + stableStringify(output))` → base36 → first 7 chars (identical to JS/Python/Bash/Make) |

### What this captures
- ✅ JSON output changes (e.g., `"Hello, World!"` → `"Hello, World!!!"` = breaking)
- ✅ Multi-argument function calls (`addtwice(3; 4)`)
- ✅ Zero-arg functions that transform the piped input (`. | slugify`)
- ✅ Comment-only changes (non-breaking — comments don't affect jq execution)

### What this does NOT capture (known gaps)
- ❌ Module imports (`import "module" as M;`) — out of scope, only local `def` blocks via `include`
- ❌ Streaming mode (`--seq`, `--stream`) — out of scope, only standard JSON I/O
- ❌ Side effects (`debug`, `input`, `inputs`) — only the JSON output is fingerprinted

## Manifest Schema

```json
{
  "clusters": [
    {
      "id": "jq-slugify",
      "entry": "slugify",
      "file": "../functions.jq",
      "stack": "jq",
      "description": "Convert a string to a URL-friendly slug",
      "inputs": ["Hello World", "Goodbye, World!"],
      "multiArgs": false
    }
  ]
}
```

### Fields

| Field | Required | Description |
|-------|----------|-------------|
| `id` | ✅ | Unique cluster identifier |
| `entry` | ✅ | The `def` function name to call |
| `file` | ✅ | Path to the `.jq` file (relative to manifest dir) |
| `stack` | ✅ | Must be `"jq"` |
| `inputs` | ✅ | Array of input values |
| `multiArgs` | ❌ | If `true`, each input is an array spread across function args (jq uses `;` as separator) |
| `description` | ❌ | Human-readable description |

## CLI Usage

### Capture

```bash
bash scripts/capture_jq.sh --manifest regrets/manifest.json
bash scripts/capture_jq.sh --manifest regrets/manifest.json --cluster jq-slugify
```

### Validate

```bash
bash scripts/validate_jq.sh --manifest regrets/manifest.json
bash scripts/validate_jq.sh --manifest regrets/manifest.json --cluster jq-slugify
bash scripts/validate_jq.sh --manifest regrets/manifest.json --fail-fast
```

## Technical Approach

### Function Invocation

jq functions are invoked via `jq -c 'include "functions"; funcname'` with the input piped via stdin:

```bash
# Zero-arg function (input piped via `.`)
echo '"World"' | jq -c -L <dir> 'include "functions"; greet'

# Multi-arg function (args passed explicitly)
echo 'null' | jq -c -L <dir> 'include "functions"; addtwice(3; 4)'
```

The `.jq` file is sourced via jq's `include` directive with `-L` setting the module search path.

### Cross-Stack Parity

The fingerprint algorithm is identical to `fingerprint.js`:
1. `stableStringify(input)` — canonical JSON with sorted keys
2. `stableStringify(output)` — same
3. `sha256(input_str + "|" + output_str)` — full 256-bit hash
4. `BigInt(hex).toString(36).slice(0, 7)` — base36, first 7 chars

Verified: jq hash == JS hash == Make hash for identical input/output pairs.

## Working Example

See `proof/jq_slugify/` for a complete working example with 6 clusters:
- `greet` — simple string formatting (zero-arg)
- `slugify` — text normalization (zero-arg)
- `to_lower` — case conversion (zero-arg)
- `addtwice` — arithmetic (multi-arg)
- `is_numeric` — type checking (zero-arg)
- `count_vowels` — string analysis (zero-arg)

```bash
cd proof/jq_slugify
bash run-demo.sh
```

# Make Stack — Regrets Support

## Overview

Regrets supports **GNU Make** as a stack for output-fingerprint regression testing. Make functions defined via `define`/`endef` blocks can be captured and validated using the same `.regret` file format as all other stacks.

## Fingerprint Model

Since Make is a build tool (not a programming language with "function calls" in the traditional sense), the fingerprint model is:

| Element | Value |
|---------|-------|
| **Input** | Arguments passed to `$(call funcname, arg1, arg2, ...)` |
| **Output** | String result of the `$(call funcname, ...)` expansion |
| **Function** | A `define funcname ... endef` block in a `.mk` file |
| **Fingerprint** | `sha256(stableStringify(input) + "|" + stableStringify(output))` → base36 → first 7 chars (identical to JS/Python/Bash/Perl) |

### What this captures
- ✅ String output changes (e.g., `Hello, World!` → `Hello, World!!!` = breaking)
- ✅ Multi-argument function calls (`$(call join_with, -, a b c)`)
- ✅ Pure Make functions (no `$(shell)`) AND functions that use `$(shell)` for text processing
- ✅ Comment-only changes (non-breaking — comments don't affect `$(call)` expansion)

### What this does NOT capture
- ❌ Recipe execution (shell commands inside rules) — only `$(call)` expansion is fingerprinted
- ❌ Side effects (file writes, `$(eval)`) — only the string output is captured
- ❌ Automatic variables (`$@`, `$<`, `$^`) — these are only meaningful inside recipes, not `$(call)` functions

## Manifest Schema

```json
{
  "clusters": [
    {
      "id": "make-slugify",
      "entry": "slugify",
      "file": "../slugify.mk",
      "stack": "make",
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
| `entry` | ✅ | The `define` function name to call via `$(call entry, ...)` |
| `file` | ✅ | Path to the `.mk` file (relative to manifest dir) |
| `stack` | ✅ | Must be `"make"` |
| `inputs` | ✅ | Array of input values (each input is used with `$(call entry, input)`) |
| `multiArgs` | ❌ | If `true`, each input is an array spread across `$(call)` args |
| `description` | ❌ | Human-readable description |

## CLI Usage

### Capture

```bash
bash scripts/capture_make.sh --manifest regrets/manifest.json
bash scripts/capture_make.sh --manifest regrets/manifest.json --cluster make-slugify
```

### Validate

```bash
bash scripts/validate_make.sh --manifest regrets/manifest.json
bash scripts/validate_make.sh --manifest regrets/manifest.json --cluster make-slugify
bash scripts/validate_make.sh --manifest regrets/manifest.json --fail-fast
```

## Technical Approach

### Function Invocation

Make functions are invoked via a temporary Makefile that uses `$(error ...)` to capture the expansion:

```makefile
include slugify.mk
$(error $(call slugify,Hello World))
```

`$(error)` outputs its argument to stderr and exits make with a non-zero code. The capture script parses stderr to extract the expansion result (between `*** ` and `. Stop.`).

### Cross-Stack Parity

The fingerprint algorithm is identical to `fingerprint.js`:
1. `stableStringify(input)` — canonical JSON with sorted keys
2. `stableStringify(output)` — same
3. `sha256(input_str + "|" + output_str)` — full 256-bit hash
4. `BigInt(hex).toString(36).slice(0, 7)` — base36, first 7 chars

Verified: Make hash == JS hash for identical input/output pairs.

## Working Example

See `proof/make_slugify/` for a complete working example with 5 clusters:
- `slugify` — text normalization via `$(shell)` + `tr`/`sed`
- `greet` — simple string formatting
- `join_with` — multi-arg function joining words with a separator
- `to_lower` — case conversion via `$(shell)` + `tr`
- `is_numeric` — pure Make function using `$(filter)`

```bash
cd proof/make_slugify
bash run-demo.sh
```

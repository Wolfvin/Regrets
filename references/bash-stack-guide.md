# Bash Stack Guide

Regression fingerprinting for Bash shell functions — ops scripts, CI helpers, build utilities, CLI wrappers, and any pure shell function that takes input arguments and writes output to stdout.

Bash clusters use the **Bash runner** (`capture_bash.sh` / `validate_bash.sh`) with a shared `fingerprint_bash.sh` module. The fingerprint algorithm is byte-identical to the JS/Python/PHP/Perl/Ruby/Go/Rust implementations — cross-stack parity is a Regrets contract.

---

## Why Bash Needs Regression Testing

Bash functions are deceptively fragile. A "simple refactor" that renames a variable, swaps `tr` for `${var,,}`, or reorders pipe stages can silently alter output. Common regression scenarios:

- **Slugifiers / string normalizers**: Functions that lowercase, strip punctuation, collapse whitespace. A refactor that changes the character class or trim order produces different slugs → broken URLs.
- **Path manipulators**: Functions that resolve symlinks, normalize `./` and `../`, or compute relative paths. Off-by-one in a `while` loop or wrong `${var#prefix}` direction → wrong paths.
- **Build helpers**: Functions that compute version strings, generate checksums, or assemble CLI flags. A flag reorder or missing dash → broken builds.
- **CI glue**: Functions that parse `git log`, extract PR numbers, or format commit messages. A regex tweak or `sed` substitution change → mis-parsed CI state.
- **Config generators**: Functions that emit JSON/YAML/TOML from shell variables. A quoting bug or missing escape → invalid config.

Bash is universal in CI/ops, but it has no native test framework for "did my function's output change?". Regrets fills that gap with the same fingerprint contract used for compiled languages.

---

## Quick Start

1. Write your bash function in a `.sh` file (sourced, not executed)
2. Create `regrets/manifest.json` with a `stack: "bash"` cluster
3. Run `node scripts/regret.js capture` to capture fingerprints
4. Run `node scripts/regret.js validate` to validate

```bash
# Project layout
my-project/
├── lib/
│   └── slugify.sh           # your bash function
├── regrets/
│   └── manifest.json        # regret config
└── ...                      # .regret files auto-generated
```

---

## Manifest for Bash Clusters

Bash clusters use `"stack": "bash"` and require these fields:

```json
{
  "clusters": [
    {
      "id": "slugify",
      "entry": "slugify",
      "file": "lib/slugify.sh",
      "stack": "bash",
      "fingerprintLevel": "entry",
      "description": "Convert string to URL-safe slug",
      "inputs": [
        "Hello World!",
        "Multi   Spaces Here",
        " leading-trailing "
      ]
    },
    {
      "id": "slugify-join",
      "entry": "slugify_join",
      "file": "lib/slugify.sh",
      "stack": "bash",
      "fingerprintLevel": "entry",
      "multiArgs": true,
      "description": "Slugify each arg, join with hyphens",
      "inputs": [
        ["Hello", "World"],
        ["API", "v2", "Docs"]
      ]
    }
  ]
}
```

### Required fields

| Field | Description |
|-------|-------------|
| `id` | Cluster identifier (used as `.regret` filename) |
| `entry` | Bash function name (must be defined in `file`) |
| `file` | Path to `.sh` source file (relative to project root) |
| `stack` | Must be `"bash"` |
| `inputs` | Array of test inputs. Each element is either a single value (passed as `$1`) or, with `multiArgs: true`, an array (passed as `$1 $2 $3 ...`) |

### Optional fields

| Field | Default | Description |
|-------|---------|-------------|
| `fingerprintLevel` | `"entry"` | Only `"entry"` is supported for Bash (callee wrapping is Phase 2, not yet implemented) |
| `multiArgs` | `false` | When `true`, each input element is treated as an array of args |
| `description` | `""` | Human-readable description (informational) |

---

## How Capture Works

1. Read `regrets/manifest.json`, filter clusters with `stack: "bash"`
2. For each cluster:
   - Source the `file` (defines the function)
   - Take the **first input** from `inputs[]` (canonical input)
   - Invoke the function with that input via `bash -c "source file; entry $args"`
   - Capture stdout (stderr is discarded)
   - Apply **trivial input guard**: empty output → cluster is SKIPPED (no `.regret` written)
   - Compute fingerprint: `sha256(stableStringify(input) + "|" + stableStringify(output))` → base36 → first 7 chars
   - Write `regrets/<cluster-id>.regret` with the standard format

### `.regret` file format (Bash)

```
cluster: slugify
version: 1
fingerprint: 2o600q3
captured: 2026-06-21T04:51:00.396491+00:00
entry: slugify
stack: bash
file: lib/slugify.sh
fingerprintLevel: entry
---
INPUT  "Hello World!"
OUTPUT hello-world
HASH   2o600q3
```

This format is **identical** to the JS/Python/PHP/Perl/Ruby/Go/Rust `.regret` files — only the `stack:` field differs. Cross-stack validation works because the fingerprint algorithm produces byte-identical hashes for the same input→output pair.

---

## How Validate Works

1. Read each `.regret` file, parse `entry`, `file`, `INPUT`, `OUTPUT`, `HASH`
2. For each cluster:
   - Source the `file` (current code, possibly refactored)
   - Re-invoke the function with the stored `INPUT`
   - Capture fresh stdout
   - Take first line of output (matches capture behavior)
   - Compute fresh fingerprint
   - Compare with stored `HASH`
   - **PASS**: hashes match → exit 0
   - **FAIL**: hashes differ → exit 1, print stored vs fresh values

### CLI flags

```bash
# Validate all bash clusters
bash scripts/validate_bash.sh

# Validate specific cluster
bash scripts/validate_bash.sh --cluster slugify

# Stop on first failure (CI mode)
bash scripts/validate_bash.sh --fail-fast

# Update a .regret file after intentional behavior change
bash scripts/validate_bash.sh --update slugify --reason "switched to uppercase output"

# Quiet (only summary)
bash scripts/validate_bash.sh --quiet

# Verbose (print input/output/hash per cluster)
bash scripts/validate_bash.sh --verbose
```

---

## Bash Function Requirements

For a bash function to be Regrets-compatible:

1. **Pure function**: Takes args via `$1`, `$2`, ..., returns output via `printf`/`echo` to stdout. No side effects (file writes, env exports, subshell mutations).

2. **Self-contained in one file**: The `file` field in the manifest points to a single `.sh` file that defines the function. Sourcing this file must define the function without running anything else.

3. **No `exit` calls**: The function must not call `exit` — that would kill the subshell. Use `return` for early exits.

4. **Stdout = output, stderr = discarded**: Only stdout is captured. Use stderr for diagnostics (it's silently dropped).

5. **Single-line output preferred**: Multi-line output is captured, but only the first line is stored in the `.regret` file (OUTPUT is single-line by convention). Future enhancement: support multi-line via escape sequences.

### Example: pure function ✓

```bash
# lib/slugify.sh
slugify() {
  local input="$1"
  local result="${input,,}"          # lowercase
  result="${result// /-}"            # spaces → hyphens
  result="${result//[^a-z0-9-]/}"    # strip non-alphanum
  printf '%s' "$result"
}
```

### Example: impure function ✗ (won't work)

```bash
# lib/bad_example.sh
bad_slugify() {
  local input="$1"
  echo "$input" > /tmp/last_input    # ← side effect, not captured
  export LAST_PROCESSED="$input"      # ← env mutation, not captured
  exit 0                              # ← kills subshell, returns no output
}
```

---

## Fingerprint Parity

Bash fingerprints are byte-identical to JS/Python/PHP/Perl/Ruby/Go/Rust for the same input→output pair. The algorithm:

```
combined = stableStringify(input) + "|" + stableStringify(output)
hash_hex = sha256(combined)
hash_base36 = BigInt("0x" + hash_hex).toString(36)
fingerprint = hash_base36.slice(0, 7)  # first 7 chars, lowercase
```

Bash delegates the BigInt→base36 conversion to `python3` (universally available wherever bash is used for CI/ops) because bash cannot natively handle 256-bit integers.

### Verified parity (6 cases)

| Case | Input | Output | Hash |
|------|-------|--------|------|
| 1 | `"hello"` | `world` | `67cq6s6` |
| 2 | `"café"` | `thé` | `388dbwa` |
| 3 | `123` (number) | `456` | `826dglz` |
| 4 | `["a","b","c"]` (array) | `abc` | `1ed7rhd` |
| 5 | `"emoji 🎉"` | `party 🎊` | `1xzw5q2` |
| 6 | `"line1\nline2"` (newline) | `out` | `5b944ng` |

All 6 hashes match JS `fingerprint.js` byte-for-byte.

---

## What's NOT Supported (Future Work)

These features exist in the JS/Python implementations but are not yet in Bash:

- **Callee wrapping** (`.calls.<callee>.regret` files): Phase 2 enhancement. Bash callee analysis would require AST parsing of bash scripts (via tree-sitter-bash or similar).
- **Multi-input `.regret` files**: Currently, only the first input is captured as the canonical pair. Multi-input support would write multiple `INPUTS` lines (matching JS implementation pattern).
- **Multi-line OUTPUT**: Currently only the first line of function output is stored. Future: support escaped newlines.
- **`fingerprintLevel: "full"` or `"watched"`**: Only `"entry"` level is supported.
- **`normalize` rules**: No support for stripping timestamps/IDs from output (JS/Python support this).
- **`ignoreFields` / `ignorePaths`**: Not applicable to bash string output.

---

## Working Example

See `proof/bash_slugify/` for a complete working example:

```bash
cd proof/bash_slugify
bash run_demo.sh
```

The demo:
1. Verifies fingerprint parity (6 cases vs JS)
2. Creates a temp bash project with `slugify` + `slugify_join` functions
3. Captures fingerprints (`.regret` files written)
4. Validates baseline (PASS)
5. Breaks the function (uppercase instead of lowercase) → validate FAIL
6. Refactors non-breakingly (rename vars, use `tr` instead of `${var,,}`) → validate PASS
7. Tests `--cluster` filter and `--fail-fast` flag

---

## Troubleshooting

### "Source file not found"

The `file` field in the manifest is relative to **PROJECT_DIR** (the directory where you run `regret capture`). If your project is at `/path/to/my-project/` and your function is at `/path/to/my-project/lib/slugify.sh`, the manifest should say `"file": "lib/slugify.sh"`.

### "Function returned empty output"

The function call succeeded but stdout was empty. Common causes:
- Function uses `echo` without `-n` and produces only a newline → considered empty
- Function `exit`s before reaching the `printf` → no output captured
- Function writes to stderr instead of stdout → stderr is discarded

### "Trivial output — skipping"

The **trivial input guard** skips clusters whose output is empty (matches JS behavior). If your function legitimately returns empty output for some inputs, use a different input that produces non-empty output as the canonical test case.

### Fingerprint mismatch on identical output

Check for trailing whitespace or newlines. `$(func)` strips trailing newlines, but `printf '%s'` without `\n` is the safest pattern. If your function uses `echo` (which adds `\n`), the captured output is the same as `printf '%s\n'` because `$(...)` strips the trailing newline.

### `python3: command not found`

The fingerprint helper requires `python3` (used for BigInt→base36 conversion). Python 3 is universally available on CI/ops systems where bash is used. If your environment lacks it, install via `apt install python3` / `yum install python3` / `brew install python`.

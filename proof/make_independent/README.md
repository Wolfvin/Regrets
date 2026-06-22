# Make Stack — Independent Verification Fixture

This directory is the **independent verification fixture** for the Make stack,
intentionally different from `proof/make_slugify/` to exercise Make patterns
the PR author's fixture does not cover.

## Why this fixture exists

Per CONTEXT.md's "Lesson Learned" warning about confirmation bias:

> Test count tinggi (388-512 tests) TIDAK menjamin fitur benar-benar bekerja —
> red team menemukan callee wrapping GAGAL untuk pattern paling umum meski
> semua unit test pass, karena test ditulis dengan pattern yang sama dengan
> implementasi (confirmation bias).

The original `proof/make_slugify/slugify.mk` fixture uses these functions:
- `slugify`, `greet`, `join_with`, `to_lower`, `is_numeric`

It exercises these Make patterns:
- `$(shell ...)` with `tr`, `sed`
- `$(strip)`, `$(subst)`, `$(if)`, `$(filter)`

This independent fixture (`string_utils.mk`) exercises patterns NOT in slugify.mk:
- `rev` (string reverse via pipeline)
- `printf '%.0s'` + `seq` (string repeat)
- `printf '%*s'` (POSIX width-spec left-pad)
- `wc -c` (character count)
- `tr '[:lower:]' '[:upper:]'` (uppercase — complement to slugify.mk's to_lower)

## Functions

| Function | Args | Description |
|----------|------|-------------|
| `reverse` | `$1 = string` | Reverse a string character-by-character via `rev` |
| `repeat` | `$1 = string, $2 = count` (multiArgs) | Repeat a string N times via `printf` + `seq` |
| `pad_left` | `$1 = string, $2 = width` (multiArgs) | Left-pad a string to a given width via `printf '%*s'` |
| `count_chars` | `$1 = string` | Count characters in a string via `wc -c` |
| `upper` | `$1 = string` | Convert a string to uppercase via `tr` |

## Usage

```bash
# Capture (writes .regret files)
bash scripts/capture_make.sh --manifest proof/make_independent/regrets/manifest.json

# Validate
bash scripts/validate_make.sh --manifest proof/make_independent/regrets/manifest.json

# Run end-to-end demo
bash proof/make_independent/run-demo.sh
```

## Clusters

5 clusters are defined in `regrets/manifest.json`:

| Cluster ID | Function | multiArgs | Input count |
|------------|----------|-----------|-------------|
| `make-reverse` | reverse | no | 3 |
| `make-repeat` | repeat | yes | 3 |
| `make-pad-left` | pad_left | yes | 3 |
| `make-count-chars` | count_chars | no | 3 |
| `make-upper` | upper | no | 3 |

## Cross-stack parity

All 5 clusters produce the same 7-char base36 hash as the JS `fingerprint()` function
for the same input/output pairs. This is verified in `run-demo.sh` Step 9.

| Cluster | Input | Output | Make hash | JS hash |
|---------|-------|--------|-----------|---------|
| make-reverse | "hello" | "olleh" | 5nssd6s | 5nssd6s ✅ |
| make-repeat | ["ab",3] | "ababab" | itbg8ye | itbg8ye ✅ |
| make-pad-left | ["42",5] | "   42" | 3np1pbd | 3np1pbd ✅ |
| make-count-chars | "hello" | "5" | 3kz7h58 | 3kz7h58 ✅ |
| make-upper | "hello" | "HELLO" | 67q5v7m | 67q5v7m ✅ |

## .regret file format

Standard format compatible with all other stacks:

```
cluster: make-reverse
version: 1
fingerprint: 5nssd6s
captured: 2026-06-21T07:40:38.320418+00:00
entry: reverse
stack: make
file: ../string_utils.mk
INPUTS 5nssd6s 451m53h 1a5d31q
---
INPUT  "hello"
OUTPUT "olleh"
HASH   5nssd6s
```

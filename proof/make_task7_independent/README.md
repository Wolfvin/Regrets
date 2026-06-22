# Task 7 — Make stack independent verification (text_format.mk)

This is a **third independent fixture** for the Make stack, added by Task 7 to
provide an additional layer of verification on top of:

- `proof/make_slugify/slugify.mk` (original PR #459 author fixture)
- `proof/make_independent/string_utils.mk` (PR #470/#477 independent verify fixture)

## Why a third fixture?

Per `CONTEXT.md`'s "Lesson Learned" about confirmation bias: verification is
more credible when the fixture is written by someone other than the implementor
and exercises **different code paths** than any prior fixture.

The two prior fixtures cover these Make patterns:
- `slugify.mk`: `tr`, `sed`, `tr ' ' '-'`, `$(strip)`, `$(subst)`, `$(empty)`
- `string_utils.mk`: `rev`, `printf + seq`, `printf '%*s'`, `wc -c`, `tr '[:lower:]' '[:upper:]'`

This Task 7 fixture (`text_format.mk`) covers **completely new patterns**:

| Function | Pattern | Used by prior fixtures? |
|----------|---------|-------------------------|
| `truncate` | `cut -c1-N` for character slicing | ❌ new |
| `truncate` | `$(if $(shell ...))` conditional ellipsis | ❌ new |
| `sanitize` | `tr -d '[:cntrl:]'` (delete control chars) | ❌ new |
| `sanitize` | `tr -cd '[:print:]'` (delete non-printable) | ❌ new |
| `wrap` | `fold -w N` for line wrapping | ❌ new |
| `count_words` | `wc -w` for word counting | ❌ new |
| `title_case` | `awk` with `toupper`/`tolower`/`substr`/`NF` | ❌ new |

## Manifest summary

5 clusters (mix of single-arg and multiArgs):

| Cluster | Args | Inputs | Patterns exercised |
|---------|------|--------|---------------------|
| `make-truncate` | multiArgs | 4 | `cut -c1-N`, conditional `$(if $(shell))` |
| `make-sanitize` | single-arg | 3 | `tr -d '[:cntrl:]'`, `tr -cd '[:print:]'` |
| `make-wrap` | multiArgs | 3 | `fold -w N` |
| `make-count-words` | single-arg | 3 | `wc -w` |
| `make-title-case` | single-arg | 3 | `awk` with `toupper`/`tolower`/`substr` |

## Cross-stack parity (Make hash === JS `fingerprint()`)

All 5 clusters produce hashes that match the JS `fingerprint()` function byte-for-byte:

| Cluster | Sample input | Sample output | Make hash | JS hash |
|---------|--------------|---------------|-----------|---------|
| `make-truncate` | `["Hello World", 5]` | `"Hello..."` | `4t0zo7f` | `4t0zo7f` ✅ |
| `make-sanitize` | `"hello world"` | `"hello world"` | `1hgg9kv` | `1hgg9kv` ✅ |
| `make-wrap` | `["abcdefghij", 4]` | `"abcd efgh ij"` | `2p2hh9f` | `2p2hh9f` ✅ |
| `make-count-words` | `"hello world"` | `"2"` | `1m29nxw` | `1m29nxw` ✅ |
| `make-title-case` | `"hello world"` | `"Hello World"` | `4am2hvn` | `4am2hvn` ✅ |

Note: `make-wrap`'s output `"abcd efgh ij"` contains **spaces**, not newlines.
This is because Make's `$(shell ...)` function strips newlines from command
output and replaces them with spaces. The .regret `OUTPUT` field captures
exactly what `$(call ...)` returns, so the hash reflects this Make-specific
behavior.

## Usage

```bash
# Capture all 5 clusters (writes .regret files)
bash scripts/capture_make.sh --manifest proof/make_task7_independent/regrets/manifest.json

# Validate all 5 clusters (PASS if no behavior changed)
bash scripts/validate_make.sh --manifest proof/make_task7_independent/regrets/manifest.json

# Filter to a single cluster
bash scripts/validate_make.sh --manifest proof/make_task7_independent/regrets/manifest.json --cluster make-truncate

# Update the golden hash for a cluster (after intentional behavior change)
bash scripts/validate_make.sh --manifest proof/make_task7_independent/regrets/manifest.json \
  --update make-title-case --reason "spec v2: uppercase whole word"

# Run the full 10-step end-to-end demo
bash proof/make_task7_independent/run-demo.sh
```

## What the demo verifies (10 steps)

1. **Capture** — 5 clusters captured with novel Make patterns
2. **Baseline validate** — 5/5 PASS (no behavior change)
3. **`.regret` format compliance** — all 7 required fields present (cluster/version/fingerprint/captured/INPUT/OUTPUT/HASH)
4. **INPUTS line** — present for `multiArgs: true` clusters, absent for single-arg
5. **Breaking change** — `truncate`'s `cut -c1-$(2)` → `cut -c1-3` causes FAIL (exit 1, hash mismatch + output diff)
6. **Valid refactor** — comment-only change keeps all hashes stable (PASS, exit 0)
7. **`--cluster` filter** — isolates a single cluster
8. **Cross-stack parity** — Make hash === JS `fingerprint()` for all 5 clusters (5/5 match)
9. **`--update` mode** — writes new hash + `audit.log` entry with chain hash; validate PASSes afterward
10. **Unified runner dispatch** — `node scripts/regret.js validate` and `python3 scripts/regret.py validate` both invoke `validate_make.sh` correctly

## Files

```
proof/make_task7_independent/
├── README.md                              (this file)
├── text_format.mk                         (5 Make function definitions)
├── run-demo.sh                            (10-step end-to-end demo)
└── regrets/
    ├── manifest.json                      (5 clusters, 16 total inputs)
    ├── audit.log                          (generated by --update mode, gitignored)
    ├── make-truncate.regret               (4 inputs, multiArgs)
    ├── make-sanitize.regret               (3 inputs, single-arg)
    ├── make-wrap.regret                   (3 inputs, multiArgs)
    ├── make-count-words.regret            (3 inputs, single-arg)
    └── make-title-case.regret             (3 inputs, single-arg)
```

## Test coverage

Tests in `tests/make-stack-task7.test.js` cover:
- Capture writes 5 .regret files
- All .regret files have required fields
- INPUTS line present for multiArgs clusters
- INPUTS line absent for single-arg clusters
- Baseline validate PASSES (5/5)
- Breaking change to `truncate` → FAIL (exit 1)
- Breaking change to `title_case` → FAIL (exit 1)
- Comment-only change → PASS (exit 0)
- `--cluster` filter isolates a single cluster
- Cross-stack parity: Make hash === JS `fingerprint()` for all 5 clusters

# Awk Stack Variant

Regression fingerprinting for awk programs using a "whole-program I/O
contract" model — the awk program IS the function, input is stdin,
output is stdout.

## Status: Working (v1)

Capture + validate are both implemented and verified end-to-end against
`proof/awk/`. Cross-stack fingerprint parity with JS/Python is verified
by `proof/awk/verify-parity.mjs` — the awk stack produces byte-identical
7-char base36 hashes to `fingerprint.js` for the same (input, output) pair.

**Scope of v1:**
- ✅ Capture: spawn `awk -f <file>` with the cluster's INPUT as stdin,
  capture stdout, compute fingerprint, write `.regret` file.
- ✅ Validate: re-spawn awk with the same INPUT, compare hash, report
  PASS/FAIL with non-zero exit on failure.
- ✅ Cross-stack parity: identical 7-char base36 fingerprint for the same
  (input, output) pair.
- ✅ Trivial-input guard: empty/whitespace stdout → skip cluster. awk
  non-zero exit → skip (matching JS "throws" guard).
- ✅ POSIX awk compatibility — works with mawk, nawk, and gawk.
- ❌ Callee wrapping (depth-1 contract chaining) — not implemented.
- ❌ Awk function-call mode (rather than whole-program) — could be v2
  with a generated caller snippet.
- ❌ Auto-discovery via `regret install` — manifest must be hand-written.

---

## The "Whole-Program I/O Contract" Model

Awk has no runtime reflection, no FFI, and no easy way to call a specific
function from outside. The natural unit of work in awk is the **program**,
not the function. So Regrets treats the entire awk program as the
"function":

- **Input**: stdin (a string — passed as-is to awk)
- **Function**: the awk program (specified by `file` in manifest)
- **Output**: stdout (a string — captured and fingerprinted)

This matches how awk is used in practice: pipeline text processing where
you care that the output stays the same after refactoring the script.

### Comparison with C/C++ adapter pattern

| Aspect | C/C++ stack | Awk stack |
|---|---|---|
| Function unit | Single function via `dlsym` | Whole program via `awk -f file` |
| Input | JSON string passed to adapter | Text passed via stdin |
| Output | JSON string returned by adapter | Text captured from stdout |
| Adapter boilerplate | Required (per cluster) | None (program IS the function) |
| Fingerprint parity | ✅ JS / Python / C / C++ | ✅ JS / Python / C / C++ / awk |

The awk model is simpler (no adapter to write) but less granular (you
fingerprint the entire program's I/O, not a single function's).

---

## Quick Start

```bash
# 1. Write your awk program (e.g., my_program.awk)
# 2. Add an awk cluster to regrets/manifest.json (see schema below)
# 3. Capture
node scripts/capture_awk.mjs
# 4. Validate (after refactoring)
node scripts/validate_awk.mjs
```

Or via the unified CLI (auto-detects `stack: "awk"` clusters):

```bash
regret capture
regret validate
```

---

## Manifest Schema for Awk Clusters

```json
{
  "clusters": [
    {
      "id": "sum-column",
      "stack": "awk",
      "file": "sum_column.awk",
      "entry": "sum_column.awk",
      "fingerprintLevel": "entry",
      "watches": [],
      "inputs": ["1\n2\n3\n4\n5\n"],
      "description": "Sum the first column of input lines"
    }
  ]
}
```

### Awk-Specific Manifest Fields

| Field | Required | Description |
|-------|----------|-------------|
| `stack` | ✅ | Must be `"awk"` |
| `file` | ✅ | Path to the `.awk` file (relative to manifest's parent dir, or absolute) |
| `entry` | ✅ | Same as `file` (kept for cross-stack consistency) |
| `inputs` | ✅ | Array of input strings. v1 uses the FIRST input only. |
| `watches` | ❌ | Informational only — no callee contracts in v1. |
| `fingerprintLevel` | ❌ | Always `"entry"` in v1. |
| `args` | ❌ | Array of extra command-line args to pass to awk (e.g., `["-v", "key=value"]`). |
| `preserveNewlines` | ❌ | If `true`, do not strip trailing newline from stdout. Default `false` (strip one trailing `\n`). |

### Awk-Specific Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `AWK_BIN` | ❌ | awk interpreter to use (default: `awk`, which resolves to mawk/nawk/gawk on PATH). Set to `gawk` to force GNU awk. |

---

## How It Works

### Architecture

```
scripts/capture_awk.mjs    ← Node.js orchestrator (capture mode)
scripts/validate_awk.mjs   ← Node.js orchestrator (validate mode)
```

Both orchestrators are pure Node.js — no awk harness file. They spawn
`awk -f <file>` as a subprocess and capture stdout/stderr.

### Capture Flow

1. Read `regrets/manifest.json`, filter clusters with `stack: "awk"`.
2. For each cluster:
   - Resolve the `.awk` file path relative to the manifest's parent dir.
   - Spawn `awk -f <file>` with `LC_ALL=C` for deterministic locale.
   - Write the cluster's INPUT (from `inputs[0]`) to the child's stdin.
   - Capture stdout.
   - Apply trivial-input guard: empty/whitespace stdout → skip cluster.
     Non-zero awk exit → skip (matching JS "throws" guard).
   - Strip ONE trailing newline from stdout (unless `preserveNewlines: true`).
     This normalizes `print x` (adds `\n`) vs `printf "%s", x` (no `\n`)
     so refactors that switch between them don't cause false FAILs.
   - Compute `fingerprint(input, output)` using the same algorithm as
     `fingerprint.js`:
     `sha256(stableStringify(input) + "|" + stableStringify(output))` →
     `BigInt(hex, 16).toString(36).slice(0, 7)`.
   - Write `<id>.regret` in the standard format.

### Validate Flow

1. Read manifest + each `.regret` file.
2. For each cluster:
   - Parse `INPUT`, `OUTPUT`, `HASH` from the existing `.regret` file.
   - Re-spawn awk with the parsed INPUT.
   - Apply the same trailing-newline normalization.
   - Recompute the fingerprint.
   - Compare to golden `HASH` — report PASS or FAIL with diff.
3. Exit with non-zero status if ANY cluster fails or is missing its
   `.regret` file.

---

## Fingerprint — Cross-Stack Parity

The awk implementation produces identical fingerprints to the JS/Python
implementations for the same (input, output) pair. Verified by
`proof/awk/verify-parity.mjs`:

```
$ node proof/awk/verify-parity.mjs
Comparing JS fingerprint() vs awk-produced HASH from .regret files:

✅ sum-column         JS=19la9jf  awk=19la9jf
✅ fibonacci          JS=68xugix  awk=68xugix
✅ reverse-lines      JS=33ruhb3  awk=33ruhb3
✅ word-count         JS=4b58rkf  awk=4b58rkf
✅ csv-field-count    JS=5w898ft  awk=5w898ft
✅ max-value          JS=ergyfa1  awk=ergyfa1
```

For awk, both INPUT and OUTPUT are JSON-encoded strings (e.g.,
`"1\n2\n3\n4\n5\n"` and `"15"`). The fingerprint algorithm hashes the
string contents, so the same input/output pair produces the same hash
regardless of which stack produced it.

---

## `.regret` File Format (Identical to JS/Python/C/C++)

```
cluster: sum-column
version: 1
fingerprint: 19la9jf
captured: 2026-06-21T05:19:40.700Z
watches: []
entry: sum_column.awk
stack: awk
file: sum_column.awk
fingerprintLevel: entry
---
INPUT  "1\n2\n3\n4\n5\n"
OUTPUT "15"
HASH   19la9jf
```

All mandatory fields from the user contract are present:
`cluster`, `version`, `fingerprint`, `captured`, `INPUT`, `OUTPUT`, `HASH`.

---

## Pure Logic Extraction in Awk

Awk programs are often a mix of pure transformation and I/O. To make
them suitable for regression fingerprinting:

1. **Avoid `srand()`** — `srand()` seeds the random number generator from
   current time, making output non-deterministic. Either remove it or
   call `srand(0)` for a fixed seed.
2. **Avoid `system()` and `getline cmd`** — these run shell commands
   whose output may vary.
3. **Avoid reading files via `getline <file`** — file contents may change.
   Pass all input via stdin instead.
4. **Don't depend on `PROCINFO["sorted_in"]`** (gawk-specific) — use
   explicit sorting via `asorti` or manual index arrays for portability.
5. **Don't depend on `strftime()`** — it returns current time. If you
   need date formatting, pass the timestamp as input.

### Example: pure awk program

```awk
# sum_column.awk — pure transformation
{ sum += $1 }
END { print sum }
```

### Example: impure awk program (do NOT fingerprint)

```awk
# bad_example.awk — has time/randomness, NOT suitable for fingerprinting
BEGIN { srand(); print int(rand() * 100) }
```

---

## Running the Working Example

```bash
$ cd proof/awk
$ node ../../scripts/capture_awk.mjs

📡 Capturing awk cluster: sum-column
   ✅ Fingerprint: 19la9jf
   📄 Saved: regrets/sum-column.regret
...
Captured: 6  Skipped: 0  Failed: 0

$ node ../../scripts/validate_awk.mjs

🔍 Validating awk cluster: sum-column
   ✅ PASS  (hash 19la9jf)
...
Passed: 6  Failed: 0  Missing: 0

$ node ../verify-parity.mjs   # cross-stack parity check
$ bash demo-refactor-flow.sh  # end-to-end PASS/FAIL demo
```

### The 6 demo clusters

| ID | Input | Output | Hash | Notes |
|---|---|---|---|---|
| `sum-column` | `1\n2\n3\n4\n5\n` | `15` | `19la9jf` | Sum first column |
| `fibonacci` | `10` | `55` | `68xugix` | Uses awk user-defined function `fib()` |
| `reverse-lines` | `Hello\nWorld\n` | `dlroW\nolleH` | `33ruhb3` | Reverse line order AND each line |
| `word-count` | `the quick brown fox\njumps over\n` | `6` | `4b58rkf` | Count whitespace-separated words |
| `csv-field-count` | `"hello, world",42,"quoted, field"` | `3` | `5w898ft` | Manual CSV parser (POSIX awk) |
| `max-value` | `3\n1\n4\n1\n5\n9\n2\n6\n` | `9` | `ergyfa1` | Find max in first column |

---

## POSIX Awk Compatibility

The demo programs use only POSIX awk features (no gawk extensions). This
means they work with:

- ✅ mawk (default on Debian/Ubuntu)
- ✅ nawk (BSD/macOS default)
- ✅ gawk (GNU awk, default on Fedora/RHEL)
- ✅ busybox awk (embedded systems)

To force a specific interpreter, set `AWK_BIN`:

```bash
AWK_BIN=gawk node scripts/capture_awk.mjs
AWK_BIN=mawk node scripts/validate_awk.mjs
```

### gawk-specific features NOT used in v1

If you want to use gawk extensions (e.g., `gensub`, `patsplit`, `PROCINFO`,
`asorti`), set `AWK_BIN=gawk` in your environment. The harness does not
validate which awk interpreter is used — it just spawns whatever `AWK_BIN`
points to.

---

## Dependencies

- **Node.js 16+** — for the orchestrator scripts (`capture_awk.mjs`,
  `validate_awk.mjs`). Already required by Regrets.
- **Any POSIX awk** — mawk, nawk, gawk, or busybox awk. Available on
  every Unix system by default.

No additional libraries needed.

---

## Limitations & Non-Goals (v1)

- **Callee wrapping** — there is no Ghost Proxy equivalent in awk. The
  `watches` field is informational only; callee `.regret` files are NOT
  generated.
- **Function-call mode** — v1 treats the whole awk program as the
  "function". A v2 could generate a caller snippet that invokes a
  specific awk function (similar to the C/C++ adapter pattern, but
  generating awk code instead of using dlsym).
- **Auto-discovery** — `regret install` does not yet detect awk programs.
  Manifest must be hand-written.
- **Multiple inputs** — v1 captures only the first input from `inputs[]`.
  The JS stack supports per-input `.regret` contracts (issue #315); this
  could be added to awk in a follow-up.
- **`regret update`** — not yet wired for awk. To refresh a golden
  contract, delete the `.regret` file and re-capture.
- **Non-text output** — awk output is always treated as a string. If your
  awk program prints JSON, the `.regret` file will contain the JSON as a
  string (e.g., `"[1,2,3]"`), not as a parsed JSON value. This is fine
  for fingerprinting but means the OUTPUT line in the `.regret` file is
  double-encoded.
- **Locale sensitivity** — the harness sets `LC_ALL=C` for deterministic
  sorting, but awk programs that use `sprintf("%g", ...)` may produce
  locale-dependent output. Test with `LC_ALL=C` in production.

---

## CI Integration

`regret validate` exits non-zero on any failure. For GitHub Actions:

```yaml
- name: Capture regret contracts
  run: regret capture
- name: Validate after refactor
  run: regret validate
```

Awk is pre-installed on every GitHub Actions runner (ubuntu-latest,
macos-latest), so no extra setup is needed.

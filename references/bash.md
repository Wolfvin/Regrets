# Bash Stack Support

Regrets supports **Bash** as a first-class stack via `capture_bash.sh` and
`validate_bash.sh`. The `.regret` file format is identical to JS/Python/PHP/Perl,
so a Bash cluster's `.regret` file can be validated by any stack's validator
(cross-stack compatible).

## Quick Start

```bash
# 1. Create a bash file with a function
mkdir -p my-project/lib my-project/regrets
cat > my-project/lib/slugify.sh <<'EOF'
slugify() {
  local out="${1,,}"
  out=$(printf '%s' "$out" | sed -E 's/[^a-z0-9]+/-/g')
  out="${out#-}"; out="${out%-}"
  printf '%s' "$out"
}
EOF

# 2. Create a manifest
cat > my-project/regrets/manifest.json <<'EOF'
{
  "clusters": [{
    "id": "slugify",
    "entry": "slugify",
    "file": "lib/slugify.sh",
    "stack": "bash",
    "inputs": ["Hello World", "Multiple   Spaces"]
  }]
}
EOF

# 3. Capture
cd my-project
bash ../scripts/capture_bash.sh

# 4. Validate
bash ../scripts/validate_bash.sh

# 5. Refactor freely — re-run validate to confirm contract is preserved
```

## Manifest Cluster Fields

| Field         | Required | Description |
|---------------|----------|-------------|
| `id`          | ✓        | Cluster identifier (becomes `<id>.regret` filename) |
| `entry`       | ✓        | Bash function name to invoke (e.g. `"slugify"`) |
| `file`        | ✓*       | Bash file to `source` (relative to project root) |
| `sourceFiles` | ✓*       | Array of bash files to `source` (in order). Use this instead of `file` when the function depends on multiple files. |
| `stack`       | ✓        | Must be `"bash"` |
| `inputs`      | ✓        | Array of input values (each invoked separately) |
| `multiArgs`   |          | If `true`, each input is treated as an array of positional args. Default: `false` (single positional arg). |
| `watches`     |          | Informational only (no callee wrapping in v1) |
| `description` |          | Informational only |

\* Either `file` or `sourceFiles` is required.

## What Gets Captured

For each input in `inputs`:

1. Spawn a clean subshell
2. `source` the file(s) listed in `file` / `sourceFiles`
3. Invoke the entry function with the input as positional args
4. Capture stdout (stderr is ignored)
5. Compute the fingerprint: `sha256(stableStringify(input) + "|" + stableStringify(output)) → base36 → first 7 chars`
6. Write the `.regret` file with the standard format

The first input is the "golden" — its fingerprint goes on the `fingerprint:`
line and the `HASH` line. Additional inputs are recorded in an `INPUTS` line
so `validate_bash.sh` re-checks ALL of them (mirrors `validate.js` issue #315).

## What Gets Validated

For each cluster:

1. Read the `.regret` file
2. Parse `INPUT`, `OUTPUT`, `HASH`, and `INPUTS` (if present)
3. Re-`source` the file(s)
4. Re-invoke the entry function with the stored `INPUT`
5. Recompute the fingerprint
6. Compare against `HASH` — report PASS or FAIL
7. If `INPUTS` is present, repeat for each saved input (any mismatch FAILs)

## Cross-Stack Parity

The fingerprint algorithm is IDENTICAL across all stacks:

| Stack    | Implementation |
|----------|----------------|
| JS       | `BigInt('0x' + sha256_hex).toString(36).slice(0, 7)` |
| Python   | `to_base36(int(sha256_hex, 16))[:7]` |
| PHP      | `to_base36(gmp_init(sha256_hex, 16))[:7]` |
| Perl     | `Math::BigInt->new("0x$hex")->bstr(36)` |
| **Bash** | `python3 -c "..."` (bignum helper) + `sha256sum` |

**Verified parity** — see `scripts/parity_test_bash.sh` for the test vectors.
A `.regret` file produced by `capture_bash.sh` can be validated by `validate.js`,
`validate.py`, or any other stack's validator.

## Multi-Input Contracts (INPUTS line)

When a cluster has multiple inputs, `capture_bash.sh` writes an `INPUTS` line
containing a JSON array of `{input, output, hash}` for inputs 1..N (the first
input is already in INPUT/OUTPUT/HASH). `validate_bash.sh` re-runs ALL of them
and FAILs if any hash mismatches — this matches `validate.js` issue #315.

Example `.regret` file with multiple inputs:

```
cluster: bash-slugify
version: 1
fingerprint: 2m64ijm
captured: 2026-06-21T04:57:28Z
watches: []
entry: slugify
stack: bash
fingerprintLevel: entry
file: lib/slugify.sh
---
INPUT  "Hello World"
OUTPUT "hello-world"
HASH   2m64ijm
INPUTS  [{"input":"Hello, World!","output":"hello-world","hash":"615ytfn"},{"input":"Multiple   Spaces   Here","output":"multiple-spaces-here","hash":"3oviqyr"}]
```

## CLI Dispatch

`regret capture` and `regret validate` auto-detect `stack: "bash"` in the
manifest and dispatch to the right script:

```bash
node scripts/regret.js capture          # → bash scripts/capture_bash.sh
node scripts/regret.js validate         # → bash scripts/validate_bash.sh
python3 scripts/regret.py capture       # same dispatch
python3 scripts/regret.py validate      # same dispatch
```

Other commands (drift, ci, guard, truth, update) also dispatch to
`validate_bash.sh` for the `bash` stack. Drift detection prints a skip
message (Bash output is deterministic by default — no `Math.random` /
`Date.now()` nondeterminism like in JS).

## Limitations (v1)

These are known limitations of the v1 Bash stack implementation. Each is
documented here so users know what to expect; they may be addressed in
future PRs.

### No Callee Wrapping (Phase 2)

`capture_bash.sh` does NOT support `callees: [...]` in the manifest. The
fingerprint is computed at the `entry` level only (`fingerprintLevel: entry`).
Phase 2 callee wrapping (`.calls.<callee>.regret` files) is not implemented
for Bash — it's a significant design challenge because Bash has no equivalent
of JS Proxy / Python monkey-patching that works across function boundaries.

Workaround: declare each callee as its own cluster with its own inputs.

### Inputs Cannot Contain Newlines

Inputs are passed to the entry function via a temp file (one arg per line).
If an input contains a newline, it will be split into multiple args. This is
a known limitation of the v1 implementation.

Workaround: base64-encode inputs containing newlines before passing them,
and decode inside the function. (We may add `inputTransform: "base64"` in v2.)

### No `--update` Audit Log

`validate_bash.sh` does not support `--update <id> --reason "..."` with
audit.log writing. The `regret update` command dispatches to
`validate_bash.sh` for Bash clusters, but audit logging is silently skipped.

Workaround: manually edit the `.regret` file's `captured:` timestamp and
re-capture. (Audit log support is planned for v2.)

### No Drift Detection

Bash output is deterministic by default (no `Math.random`, `Date.now`, or
network nondeterminism). `regret drift` prints a skip message for the
`bash` stack. If a Bash function IS nondeterministic (e.g. uses `$RANDOM`
or `date`), drift detection would be needed — but the user must declare
this in the manifest and the function should be refactored to be
deterministic first.

### No `--fail-fast` Difference

`--fail-fast` is accepted by `validate_bash.sh` for CLI compatibility, but
since each cluster is validated in sequence and the script exits 1 on the
first failure, `--fail-fast` is effectively always on. The flag is a no-op.

## Dependencies

`capture_bash.sh` and `validate_bash.sh` require:

- **bash 4.0+** (for `${var,,}` lowercase parameter expansion)
- **jq** (for stable JSON stringify — already a Regrets dependency)
- **sha256sum** (coreutils — universally available)
- **python3** (for base36 bignum conversion — universally available)

All four are pre-installed on macOS (via Homebrew), Linux, and Windows
(via WSL or Git Bash).

## Verification

To verify the Bash stack is working correctly:

```bash
# 1. Run the parity test (must pass — verifies cross-stack fingerprint parity)
bash scripts/parity_test_bash.sh

# 2. Run the proof demo (must pass — verifies capture+validate+refactor flow)
cd proof/bash_slugify && bash run_demo.sh
```

Both should print `✅ ALL STEPS PASSED`.

## See Also

- `references/fingerprint-spec.md` — fingerprint algorithm specification
- `proof/bash_slugify/` — working example with real bash functions
- `scripts/parity_test_bash.sh` — cross-stack parity verification
- Issue #384 — original feature request and scope

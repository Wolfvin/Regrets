# Bash Slugify Proof

This directory is a working proof that the Bash stack for Regrets works
end-to-end:

- `lib/slugify.sh` — real bash functions (`slugify`, `greet`)
- `regrets/manifest.json` — manifest with two clusters
- `regrets/*.regret` — generated golden contract files
- `run_demo.sh` — walkthrough: capture → validate PASS → break → FAIL →
  refactor → PASS

## Quick Run

```bash
# From this directory:
bash run_demo.sh
```

The demo runs all 6 steps and prints `✅ ALL STEPS PASSED` at the end.

## What the Demo Verifies

1. **capture_bash.sh produces correct .regret files** — two clusters are
   captured (`bash-slugify` with 5 inputs, `bash-greet` with 1 input).
2. **validate_bash.sh PASSES on unchanged code** — the golden hashes match.
3. **validate_bash.sh FAILs on breaking refactor** — when `slugify` is
   modified to use underscores instead of hyphens, the hash mismatches.
4. **validate_bash.sh PASSes on valid refactor** — when `slugify` is
   rewritten using pure bash (no `sed`), the output behavior is preserved
   so the hashes match.

## Cross-Stack Parity

The fingerprints produced by `capture_bash.sh` are identical to what
`fingerprint.js` would produce for the same input/output pairs. Run
`bash scripts/parity_test_bash.sh` from the repo root to verify.

This means a `.regret` file produced by `capture_bash.sh` can be
validated by `validate.js`, `validate.py`, or any other stack's
validator — cross-stack compatible.

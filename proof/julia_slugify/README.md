# proof/julia_slugify — Julia stack working example

End-to-end demo that the Julia capture+validate stack is functional.

## What's here

```
proof/julia_slugify/
├── README.md                    ← this file
├── verify-parity.mjs            ← cross-stack fingerprint parity check
├── run_demo.sh                  ← end-to-end PASS/FAIL demo script
├── lib/
│   └── slugify.jl               ← pure-function Julia source (2 functions)
└── regrets/
    ├── manifest.json            ← 2 Julia clusters (slugify, slugify_batch)
    ├── slugify.regret           ← captured contract
    └── slugify-batch.regret     ← captured contract
```

The capture target is `slugify` / `slugify_batch`, two top-level functions in
`lib/slugify.jl`. Pure functions — no I/O, no globals, no random. Ideal
regret cluster: behavior is fully determined by the input string, so the
captured fingerprint is stable across runs.

## Running the demo

```bash
# Requires: Julia 1.11+ on PATH (or set JULIA=/path/to/julia)
# Optional: JULIA_PROJECT=/path/to/env (defaults to ~/.julia/environments/regrets)

# 1. Capture (writes/regenerates all .regret files)
bash ../../scripts/capture_julia.sh

# 2. Validate (should PASS — code unchanged since capture)
bash ../../scripts/validate_julia.sh

# 3. Cross-stack parity check (Julia hash == JS hash == Nim hash)
node verify-parity.mjs

# 4. End-to-end refactor flow (valid refactor PASSes, breaking FAILs)
bash run_demo.sh
```

## Verified contract

- ✅ capture writes `.regret` files with the standard format (cluster/version/fingerprint/captured/INPUT/OUTPUT/HASH)
- ✅ validate PASSes baseline (exit 0)
- ✅ validate PASSes after a valid refactor (output preserved, hash unchanged)
- ✅ validate FAILs after a breaking refactor (output changed, exit non-zero)
- ✅ Cross-stack fingerprint parity: Julia HASH === JS `fingerprint(input, output)` === Nim HASH

## Cross-stack parity table

| Cluster | Julia hash | JS hash | Nim hash | Match |
|---|---|---|---|---|
| slugify | 615ytfn | 615ytfn | 615ytfn | ✅ |
| slugify-batch | 2tph9ny | 2tph9ny | 2tph9ny | ✅ |

Julia produces byte-identical 7-char base36 hashes to JS and Nim for the same
(input, output) pairs. The slugify implementations in Julia and Nim are
deliberately identical (same algorithm: downcase → collapse non-alnum → strip
edges) so cross-stack parity is verifiable end-to-end.

## Why slugify

Same fixture domain as `proof/nim_slugify/` (Nim) and `proof/ruby_slugify/`
(Ruby) — chosen so cross-stack fingerprint parity can be verified directly.
Any input that produces the same string output across stacks must produce the
same fingerprint hash.

## Run via CLI dispatcher

You can also invoke capture/validate through the unified CLI:

```bash
# Via regret.js (Node CLI)
node ../../scripts/regret.js capture
node ../../scripts/regret.js validate

# Via regret.py (Python CLI)
python3 ../../scripts/regret.py capture
python3 ../../scripts/regret.py validate
```

Both CLIs auto-detect `stack: "julia"` in the manifest and dispatch to
`capture_julia.sh` / `validate_julia.sh`.

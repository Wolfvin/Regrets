# proof/nim_slugify — Regrets working example for the Nim stack

This directory demonstrates the full Regrets capture → validate cycle on a small,
realistic Nim source file (`lib/slugify.nim`).

## What's here

```
proof/nim_slugify/
├── README.md           (this file)
├── PARITY.md           (cross-stack fingerprint parity: Nim vs Python, 11/11 match)
├── lib/
│   └── slugify.nim     (the source under contract — two exported procs)
├── manifest.json       (2 clusters: slugify, slugify-batch)
├── regrets/
│   ├── slugify.regret       (golden contract for slugify cluster)
│   └── slugify-batch.regret (golden contract for slugify-batch cluster)
└── run_demo.sh         (end-to-end demo: baseline → valid refactor → breaking refactor)
```

## The source

`lib/slugify.nim` defines two pure functions:

```nim
proc slugify*(text: string): string
proc slugifyBatch*(texts: seq[string]): seq[string]
```

`slugify` converts a string to a URL-safe slug: downcase, collapse non-alphanumeric
runs to a single hyphen, strip leading/trailing hyphens. `slugifyBatch` applies
`slugify` to every string in a seq.

## The manifest

Two clusters, both with `stack: "nim"`:

- `slugify` — single-string slug, 8 inputs (ASCII, Unicode, empty, symbols-only).
- `slugify-batch` — array of strings → array of slugs, 3 inputs.

Only the first input is captured as the golden contract (matches Ruby/PHP adapter
behavior). The other inputs are documented for human reviewers and serve as
additional test cases that could be added later.

## Running the demo

Prerequisites: Nim 2.0+ on PATH (or set `NIM=/path/to/nim`).

```bash
# From the repo root:
bash proof/nim_slugify/run_demo.sh

# Or from this directory:
cd proof/nim_slugify
bash run_demo.sh
```

The demo walks through 4 phases:

1. **Phase 0 — baseline**: Re-capture golden contracts from the current source.
   Validate must PASS.
2. **Phase 1 — valid refactor**: Apply a refactor that renames internal vars
   and extracts a helper proc. Behavior unchanged. Validate must PASS.
3. **Phase 2 — breaking refactor**: Change the slug separator from `-` to `_`.
   Behavior changes. Validate must FAIL (golden contract catches the regression).
4. **Final sanity**: Restore the original source. Validate must PASS again.

If all 4 phases produce the expected outcome, the demo exits 0.

## Expected output (excerpt)

```
═══ Phase 0: baseline capture + validate ═══
📡 Capturing: slugify
   ✅ Fingerprint: 615ytfn
   📄 Saved: regrets/slugify.regret
📡 Capturing: slugify-batch
   ✅ Fingerprint: 2tph9ny
   📄 Saved: regrets/slugify-batch.regret
✅ Phase 0 PASS — baseline green

═══ Phase 1: apply VALID refactor (rename var, extract helper) ═══
✅ slugify-batch                       2tph9ny                PASS
✅ slugify                             615ytfn                PASS
✅ Phase 1 PASS — valid refactor is green

═══ Phase 2: apply BREAKING refactor (hyphen → underscore) ═══
❌ slugify-batch                       2tph9ny → <new_hash>   FAIL
❌ slugify                             615ytfn → 2jd5eik      FAIL
✅ Phase 2 PASS — breaking refactor correctly detected

═══ All phases passed ═══
  Phase 0 (baseline)            ✅ PASS
  Phase 1 (valid refactor)      ✅ PASS — Regrets stayed green
  Phase 2 (breaking refactor)   ✅ FAIL — Regrets caught the regression
```

## Cross-stack parity

The fingerprints produced by the Nim adapter (`615ytfn`, `2tph9ny`, etc.) are
**byte-identical** to what the Python, Ruby, PHP, and JS adapters would produce
for the same input/output pair. See `PARITY.md` for the full 11-case parity
verification table.

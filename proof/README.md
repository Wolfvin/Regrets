# Proof Artifacts

This directory contains verification artifacts from real-world case studies
where Regrets was used to regression-test refactoring on external projects.

Each subdirectory represents one case study and contains:

| File | Purpose |
|------|---------|
| `manifest.json` | Cluster definitions used during testing |
| `KEBENARAN_1_raw_output.json` | Raw output baseline (ground truth #1) |
| `KEBENARAN_2_fingerprints.json` | Fingerprint baseline (ground truth #2) |
| `README.md` | Proof documentation with 3-way verification results |

> **KEBENARAN** is Indonesian/Malay for "truth" — these files represent the
> two independent truths captured before refactoring. If both truths are
> preserved after refactoring, the behavioral contract is proven intact.

## Available Proofs

| Directory | Target Library | Domain | Stack |
|-----------|---------------|--------|-------|
| `ogham/` | evanshortiss/ogham | Ancient Irish Ogham transliteration | JS (CJS wrapper) |
| `puzpy/` | alexdej/puzpy | Crossword puzzle parser | Python |
| `pyluach/` | simlist/pyluach | Hebrew calendar computation | Python |
| `python-baudot/` | xvillaneau/python-baudot | Baudot teleprinter encoding | Python |

## How to Use These Proofs

To reproduce a verification:

1. Clone the target library
2. Install Regrets alongside it
3. Copy the `manifest.json` into the target project's `regrets/` directory
4. Run `node scripts/validate.js --manifest regrets/manifest.json`
5. Compare output with the KEBENARAN baselines

# proof/scala_slugify — Scala Regrets Stack Proof of Concept

This directory demonstrates the **Scala stack** for the Regrets regression-testing framework. It contains a real pure function (`Slugify.slugify`), a manifest defining two clusters, captured `.regret` files, and a self-contained demo script.

## Files

| File | Purpose |
|------|---------|
| `Slugify.scala` | Pure Scala function — `object Slugify { def slugify(args: Array[Object]): Any }`. Entry point for Regrets. |
| `regrets/manifest.json` | Two clusters: `slugify` (single-arg) and `slugify-multiargs` (multi-arg). |
| `regrets/slugify.regret` | Captured golden contract for the single-arg cluster. |
| `regrets/slugify-multiargs.regret` | Captured golden contract for the multi-arg cluster. |
| `parity_check.mjs` | JS-side parity check — runs the JS fingerprint on every captured INPUT/OUTPUT pair and asserts byte-identical match. |
| `run_demo.sh` | End-to-end walkthrough: capture → validate PASS → parity check → break → validate FAIL → restore → validate PASS. |

## Running the Demo

```bash
cd proof/scala_slugify
bash run_demo.sh
```

Requirements:
- `scala-cli` on PATH (https://scala-cli.virtuslab.org/install)
- `node` on PATH (for manifest parsing + parity check)

## What the Demo Proves

1. **Capture works** — `bash scripts/capture_scala.sh capture` writes valid `.regret` files
2. **Validate PASSes for clean code** — current `Slugify.scala` matches the captured fingerprint
3. **Cross-stack parity** — JS and Scala produce identical fingerprints for the same input/output pairs (8/8 cases verified)
4. **Validate FAILs for breaking change** — modifying `Slugify.scala` to prefix output with `_` causes validate to exit 1 with `failures=6/6`
5. **Validate PASSes again after restore** — back to green

## Captured Fingerprints (verified to match JS)

| Input | Output | Fingerprint |
|-------|--------|-------------|
| `"Hello, World!"` | `"hello-world"` | `615ytfn` |
| `"Hello, World! This is a TEST."` | `"hello-world-this-is-a-test"` | `2gaag5y` |
| `"  multiple   spaces  "` | `"multiple-spaces"` | `47iw4ku` |
| `"already-slugified"` | `"already-slugified"` | `2r8ubcm` |
| `"Mix3d C4se AND Symbols!@#"` | `"mix3d-c4se-and-symbols"` | `1hgst4y` |
| `""` | `""` | `5oge4st` |
| `["Hello World","ignored second arg"]` | `"hello-world"` | `4nsxacg` |
| `["TEST Input",42]` | `"test-input"` | `tdx2q0f` |

All 8 fingerprints are byte-identical when computed by JS `fingerprint.js` or Scala `regret_fingerprint.scala`. This is the cross-stack parity contract.

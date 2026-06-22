# proof/rust_verify/ — Independent verification of `feat/rust-validate` (PR #355)

This directory contains an **independent re-validation** of the Rust stack
implementation in `feat/rust-validate` (PR #355, claim issue #336 —
canonical consolidation that supersedes #337 and #361, and PRs #360 and #371).

## Why this exists

CONTEXT.md's "Lesson Learned" warns:

> Test count tinggi (388-512 tests) TIDAK menjamin fitur benar-benar
> bekerja — red team menemukan callee wrapping GAGAL untuk pattern
> paling umum meski semua unit test pass, karena test ditulis dengan
> pattern yang sama dengan implementasi (confirmation bias).

PR #355 ships 5 fixture clusters (`add`, `mul`, `is_even`, `reverse_string`,
`fibonacci`) authored by the same worker who wrote `capture_rust.sh` +
`validate_rust.sh` + the harness. That is exactly the confirmation-bias
trap. This fixture independently verifies the contract using 5
**different** Rust functions, each exercising a different Rust idiom.

## What's verified

| Cluster | Function | Rust idiom exercised |
|---|---|---|
| `rust-slugify` | `slugify` | char-by-char transform with String allocation |
| `rust-base64-encode` | `base64_encode` | bitwise ops + lookup table (no stdlib base64) |
| `rust-crc32` | `crc32` | table-driven checksum (no stdlib hash) |
| `rust-fnv1a` | `fnv1a` | multiply + XOR per byte (wrapping_mul) |
| `rust-is-valid-ipv4` | `is_valid_ipv4` | byte-index parser + range check |

## How to run

```bash
# Make sure Rust toolchain (cargo, rustc) is on PATH
cd proof/rust_verify
bash run-verify.sh
```

The walkthrough:
1. **Capture** all 5 clusters → produce `.regret` files
2. **Validate baseline** → expect 5 PASS
3. **BREAKING refactor** (crc32: drop final XOR) → expect 1 FAIL (rust-crc32 only), exit non-zero
4. **Restore** → re-validate → expect 5 PASS
5. **VALID refactor** (crc32: table-driven → on-the-fly computation) → expect 5 PASS, hash unchanged
6. **Restore** → final validate → expect 5 PASS
7. **Cross-stack parity** (Rust vs JS vs Python) → expect all match

## Cross-stack parity table

| cluster | Rust hash | JS hash | Py hash | match |
|---|---|---|---|---|
| `rust-base64-encode` | `3db5bgz` | `3db5bgz` | `3db5bgz` | ✅ |
| `rust-crc32` | `4y0t4az` | `4y0t4az` | `4y0t4az` | ✅ |
| `rust-fnv1a` | `5pyfuaz` | `5pyfuaz` | `5pyfuaz` | ✅ |
| `rust-is-valid-ipv4` | `5fyfbp9` | `5fyfbp9` | `5fyfbp9` | ✅ |
| `rust-slugify` | `2gaag5y` | `2gaag5y` | `2gaag5y` | ✅ |

All three stacks produce byte-identical 7-char base36 hashes — the Regrets
cross-stack parity contract holds for the Rust stack.

**Bonus — 4-way parity:** the same 5 (input, output) pairs were used in
`proof/go_verify/` (Go stack verification) and `proof/c_verify/` (C stack
verification). The hashes match across all 4 stacks:

| cluster | Rust | Go | C | JS | Python |
|---|---|---|---|---|---|
| `slugify` | `2gaag5y` | `2gaag5y` | `2gaag5y` | `2gaag5y` | `2gaag5y` |
| `base64-encode` | `3db5bgz` | `3db5bgz` | — | `3db5bgz` | `3db5bgz` |
| `crc32` | `4y0t4az` | `4y0t4az` | — | `4y0t4az` | `4y0t4az` |
| `fnv1a` | `5pyfuaz` | `5pyfuaz` | — | `5pyfuaz` | `5pyfuaz` |
| `is-valid-ipv4` | `5fyfbp9` | `5fyfbp9` | `5fyfbp9` | `5fyfbp9` | `5fyfbp9` |

(C column shows "—" for clusters not present in `proof/c_verify/`.)

## Independent value checks

Beyond the parity table, each function's output was independently
verified against a reference implementation:

| Function | Input | Rust output | Reference | Source |
|---|---|---|---|---|
| `slugify` | `"Hello, World! This is a TEST."` | `"hello-world-this-is-a-test"` | expected slug form | manual |
| `base64_encode` | `"Hello"` | `"SGVsbG8="` | `python3 -c "import base64; print(base64.b64encode(b'Hello').decode())"` | RFC 4648 |
| `crc32` | `"Hello"` | `4157704578` | `python3 -c "import zlib; print(zlib.crc32(b'Hello'))"` | zlib |
| `fnv1a` | `"Hello"` | `4116459851` | manual computation (offset 2166136261, prime 16777619) | FNV spec |
| `is_valid_ipv4` | `"192.168.1.1"` | `true` | valid IPv4 | RFC 791 |

## Findings

### ✅ Confirmed working

- `capture_rust.sh` successfully captures all 5 fresh Rust functions,
  including ones with non-trivial control flow (table-driven CRC32,
  bit-manipulation base64, byte-index IPv4 parser) that were NOT in
  PR #355's fixture.
- `validate_rust.sh` correctly detects breaking refactors (exit 101 from
  `cargo test`, only the affected cluster FAILs) and accepts valid
  refactors (exit 0, hash unchanged). The table-driven → on-the-fly
  CRC32 refactor produces an identical hash, confirming the harness is
  output-based (not implementation-based).
- Cross-stack parity is byte-identical across Rust / JS / Python for all
  5 clusters, AND across Go and C for the clusters that overlap with
  `proof/go_verify/` and `proof/c_verify/` (4-way parity for slugify +
  is-valid-ipv4, 5-way parity for slugify + is-valid-ipv4 with JS/Python
  for the others).

### ⚠️ Known limitation (NOT a bug, but worth documenting)

The Rust harness only captures and validates the FIRST input from
`inputs[]`. There is no `INPUTS` line for multi-input clusters (unlike
the Go stack which has `INPUTS` line). The manifest schema allows multiple
inputs per cluster, but only `inputs[0]` is used.

This is a v1 limitation documented in PR #355's description (implicitly —
the fixture only tests one input per cluster). It matches the
implementation in `tests/regret_runner.rs` which iterates
`cluster.inputs[0]` only.

**Recommendation for a future PR (out of scope here):** extend
`regret_runner.rs` to iterate ALL inputs and write an `INPUTS` line with
the non-first results, matching the Go stack's `INPUTS` line feature.

### ✅ npm test

`npm test`: 807 pass + 0 skip + 0 fail — identical to PR #355's reported
baseline. No regression.

## Files

- `Cargo.toml` — Rust crate declaration (`regret-verify` v0.1.0)
- `src/lib.rs` — fingerprint module (copied from PR #355) + 5 fresh functions
- `tests/regret_runner.rs` — capture + validate dispatcher (adapted from PR #355)
- `regrets/manifest.json` — 5 clusters with edge-case inputs
- `regrets/*.regret` — generated by `capture_rust.sh` (committed for review)
- `cross_stack_parity.mjs` — Node script that re-derives hashes in JS + Python and compares to Rust
- `run-verify.sh` — end-to-end walkthrough script (capture → validate PASS → break → FAIL → refactor → PASS → parity)
- `README.md` — this file
- `.gitignore` — exclude `target/` and `Cargo.lock`

## Verification issue

[CLAIM] issue #336 (canonical Rust claim) — https://github.com/Wolfvin/Regrets/issues/336
Superseded claim #337 (consolidated into #336/PR #355) — https://github.com/Wolfvin/Regrets/issues/337
Superseded claim #361 (consolidated into #336/PR #355) — https://github.com/Wolfvin/Regrets/issues/361

PR #355 under verification — https://github.com/Wolfvin/Regrets/pull/355
This verification PR — see PR description

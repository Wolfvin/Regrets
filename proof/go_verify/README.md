# proof/go_verify/ — Independent verification of `feat/go-validate-consolidated` (PR #399)

This directory contains an **independent re-validation** of the Go stack
implementation in `feat/go-validate-consolidated` (PR #399, claim issue
#400 — supersedes #338, #335 and PRs #345, #364).

## Why this exists

CONTEXT.md's "Lesson Learned" warns:

> Test count tinggi (388-512 tests) TIDAK menjamin fitur benar-benar
> bekerja — red team menemukan callee wrapping GAGAL untuk pattern
> paling umum meski semua unit test pass, karena test ditulis dengan
> pattern yang sama dengan implementasi (confirmation bias).

PR #399 ships 5 fixture clusters (`Add`, `Multiply`, `Reverse`,
`CountVowels`, `IsPalindrome`) authored by the same worker who wrote
`capture_go.sh` + the harness. That is exactly the confirmation-bias
trap. This fixture independently verifies the contract using 5
**different** Go functions, each exercising a different Go idiom.

## What's verified

| Cluster | Function | Go idiom exercised |
|---|---|---|
| `slugify` | `conv.Slugify` | rune-by-rune transform + strings.Builder |
| `base64-encode` | `conv.Base64Encode` | bitwise ops + lookup table (no stdlib) |
| `crc32` | `hashing.CRC32` | unsigned arithmetic + table-driven checksum |
| `fnv1a` | `hashing.FNV1a` | multiply + XOR per byte |
| `is-valid-ipv4` | `validation.IsValidIPv4` | multi-delimiter parser + range check |

## How to run

```bash
# Make sure Go 1.24+ is on PATH
cd proof/go_verify
bash run-verify.sh
```

The walkthrough:
1. **Capture** all 5 clusters → produce `.regret` files (with `INPUTS` line for multi-input clusters)
2. **Validate baseline** → expect 5 PASS (+ all INPUTS entries PASS)
3. **BREAKING refactor** (CRC32: drop final XOR) → expect 1 FAIL (crc32 only), exit 1
4. **Restore** → re-validate → expect 5 PASS
5. **VALID refactor** (CRC32: manual table → stdlib `crc32.ChecksumIEEE`) → expect 5 PASS, hash unchanged
6. **Restore** → final validate → expect 5 PASS
7. **Cross-stack parity** (Go vs JS vs Python) → expect all match

## Cross-stack parity table

| cluster | Go hash | JS hash | Py hash | match |
|---|---|---|---|---|
| `base64-encode` | `3db5bgz` | `3db5bgz` | `3db5bgz` | ✅ |
| `crc32` | `4y0t4az` | `4y0t4az` | `4y0t4az` | ✅ |
| `fnv1a` | `5pyfuaz` | `5pyfuaz` | `5pyfuaz` | ✅ |
| `is-valid-ipv4` | `5fyfbp9` | `5fyfbp9` | `5fyfbp9` | ✅ |
| `slugify` | `2gaag5y` | `2gaag5y` | `2gaag5y` | ✅ |

All three stacks produce byte-identical 7-char base36 hashes — **15/15
(input, output) pairs match** across Go/JS/Python (5 clusters × ~3 inputs
per cluster). The Regrets cross-stack parity contract holds for the Go
stack.

Bonus observation: `slugify` (`2gaag5y`) and `is-valid-ipv4` (`5fyfbp9`)
hashes are also identical to the C stack's hashes for the same
(input, output) pairs (from the prior C stack verification in
`proof/c_verify/`). This is a 4-way parity: Go == C == JS == Python.

## Independent value checks

Beyond the parity table, each function's output was independently
verified against a reference implementation:

| Function | Input | Go output | Reference | Source |
|---|---|---|---|---|
| `Slugify` | `"Hello, World! This is a TEST."` | `"hello-world-this-is-a-test"` | expected slug form | manual |
| `Base64Encode` | `"Hello"` | `"SGVsbG8="` | `python3 -c "import base64; print(base64.b64encode(b'Hello').decode())"` | RFC 4648 |
| `CRC32` | `"Hello"` | `4157704578` | `python3 -c "import zlib; print(zlib.crc32(b'Hello'))"` | zlib |
| `FNV1a` | `"Hello"` | `4116459851` | manual computation (offset 2166136261, prime 16777619) | FNV spec |
| `IsValidIPv4` | `"192.168.1.1"` | `true` | valid IPv4 | RFC 791 |

## Findings

### ✅ Confirmed working

- `capture_go.sh` successfully captures all 5 fresh Go functions,
  including ones with non-trivial control flow (table-driven CRC32,
  bit-manipulation base64, multi-delimiter IPv4 parser) that were NOT
  in PR #399's fixture.
- `validate` correctly detects breaking refactors (exit 1, only the
  affected cluster FAILs) and accepts valid refactors (exit 0, hash
  unchanged). The manual-table → stdlib `crc32.ChecksumIEEE` refactor
  produces an identical hash, confirming the harness is output-based
  (not implementation-based).
- The `INPUTS` line feature works correctly: each cluster with multiple
  inputs has its non-first inputs validated too (12 additional pairs
  verified on top of the 5 golden pairs).
- Cross-stack parity is byte-identical across Go / JS / Python for all
  15 (input, output) pairs.

### ⚠️ Known limitation (NOT a bug, but worth documenting)

The harness's `adaptArg` function in `regret_helpers_test.go` (auto-generated
by `capture_go.sh`) handles float64↔int conversions but does NOT handle
`[]interface{}` → `[]byte` (Go byte slice) conversions. JSON arrays are
parsed as `[]interface{}` by Go's `encoding/json`, and the reflect-based
`adaptArg` returns the error `cannot convert []interface {} to []uint8`
when a function takes a `[]byte` argument.

**Workaround used in this fixture:** functions that conceptually take
byte sequences (`Base64Encode`, `CRC32`, `FNV1a`) accept a `string`
argument and convert it to `[]byte` internally. This is idiomatic Go
(the stdlib `hash/crc32.ChecksumIEEE` takes `[]byte`, but most callers
pass `[]byte(s)` from a string).

**Recommendation for a future PR (out of scope here):** extend
`adaptArg` to handle `[]interface{}` → `[]byte` conversion when the
target type is `[]uint8`. This would let functions like
`func F(data []byte) T` be captured directly without a string-wrapper
adapter.

This limitation was NOT caught by PR #399's own fixture because none
of its 5 functions take a `[]byte` argument — they all take `int`,
`string`, or `(int, int)`. This is exactly the confirmation-bias
scenario CONTEXT.md warns about.

### ✅ npm test

`npm test`: 811 pass + 0 skip + 0 fail — identical to PR #399's reported
baseline. No regression.

## Files

- `go.mod` — Go module declaration (`github.com/regrets/proof-go-verify`)
- `conv/conv.go` — `Slugify` + `Base64Encode` (string transformations)
- `hashing/hashing.go` — `CRC32` + `FNV1a` (table-driven checksums)
- `validation/validation.go` — `IsValidIPv4` + `HexColor` struct + `FormatHexColor` method
- `regrets/manifest.json` — 5 clusters with edge-case inputs (3-4 inputs each)
- `regrets/*.regret` — generated by `capture_go.sh` (committed for review)
- `cross_stack_parity.mjs` — Node script that re-derives hashes in JS + Python and compares to Go
- `run-verify.sh` — end-to-end walkthrough script (capture → validate PASS → break → FAIL → refactor → PASS → parity)
- `README.md` — this file
- `.gitignore` — exclude auto-generated `regret_*_test.go`

## Verification issue

[CLAIM] issue #400 (consolidation claim) — https://github.com/Wolfvin/Regrets/issues/400
Original claim #338 (superseded) — https://github.com/Wolfvin/Regrets/issues/338
Original claim #335 (superseded) — https://github.com/Wolfvin/Regrets/issues/335

PR #399 under verification — https://github.com/Wolfvin/Regrets/pull/399
This verification PR — see PR description

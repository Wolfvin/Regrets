# proof/ruby_verify/ — Independent runtime verification of PR #354 (Ruby stack)

This directory contains an **independent runtime re-validation** of the
Ruby stack implementation in `feat/ruby-stack` (PR #354, claim issue #339)
on a fresh Ruby codebase, per v2 worker protocol's REVIEW-SINGLE target
track.

## Why this exists

CONTEXT.md's "Lesson Learned" warns:

> Test count tinggi (388-512 tests) TIDAK menjamin fitur benar-benar
> bekerja — red team menemukan callee wrapping GAGAL untuk pattern
> paling umum meski semua unit test pass, karena test ditulis dengan
> pattern yang sama dengan implementasi (confirmation bias).

PR #354 ships 2 fixture clusters (`slugify`, `slugify_batch`) authored by
the same worker who wrote `capture_ruby.rb` + `validate_ruby.rb` + the
harness. The second-worker [REVIEW] pass on #339 did static analysis +
cross-stack fingerprint parity but **could not run the runtime end-to-end
because the worker sandbox did not have `ruby` installed**:

> Worker sandbox TIDAK punya `ruby` installed. Saya tidak bisa run
> end-to-end `bash proof/ruby_slugify/run_demo.sh` sendiri. Verifikasi
> saya relied on cross-stack fingerprint parity + static analysis + npm
> test + dispatch verification.
> Boss disarankan juga run `bash proof/ruby_slugify/run_demo.sh` di
> environment dengan `ruby` installed untuk verify runtime behavior sebelum
> [SUCCESS].

This PR fills that gap:

1. **Installs Ruby 3.3.0** (compiled from source — environment had no ruby
   and no root access).
2. **Runs PR #354's own demo end-to-end** (`proof/ruby_slugify/run_demo.sh`)
   — confirms the worker's own fixture runtime-PASSes (all 3 phases:
   baseline + valid refactor + breaking refactor).
3. **Writes a fresh Ruby fixture** with 5 functions NOT in PR #354's
   fixture, each exercising a different Ruby idiom — to avoid the
   confirmation-bias trap.

## What's verified

| Cluster | Function | Ruby idiom exercised |
|---|---|---|
| `ruby-verify-crc32` | `crc32` | table-driven checksum with Array.new(256) (no `Zlib.crc32` builtin) |
| `ruby-verify-base64-encode` | `base64_encode` | bitwise ops + lookup table (no `Base64.encode64` builtin) |
| `ruby-verify-levenshtein` | `levenshtein` | 2D DP matrix with two rolling rows |
| `ruby-verify-is-valid-ipv4` | `is_valid_ipv4` | multi-delimiter parser + range check (byte-index) |
| `ruby-verify-fnv1a` | `fnv1a` | multiply + XOR per byte (Bignum masking) |

## How to run

```bash
# Make sure Ruby 3.0+ is on PATH.
cd proof/ruby_verify
bash run-verify.sh
```

The walkthrough:
- **Step 0**: Run PR #354's own demo (`proof/ruby_slugify/run_demo.sh`) —
  fills the [REVIEW] gap (previous verifier had no ruby installed).
- **Step 1**: Capture all 5 fresh clusters → produce `.regret` files
- **Step 2**: Validate baseline → expect 5 PASS
- **Step 3**: BREAKING refactor (crc32: drop final XOR) → expect 1 FAIL
  (ruby-verify-crc32 only), exit 1
- **Step 4**: Restore → re-validate → expect 5 PASS
- **Step 5**: VALID refactor (crc32: table-driven → on-the-fly computation)
  → expect 5 PASS, hash unchanged
- **Step 6**: Restore → final validate → expect 5 PASS
- **Step 7**: Cross-stack parity (Ruby vs JS vs Python) → expect all match

## Cross-stack parity table

| cluster | Ruby hash | JS hash | Py hash | match |
|---|---|---|---|---|
| `ruby-verify-base64-encode` | `3db5bgz` | `3db5bgz` | `3db5bgz` | ✅ |
| `ruby-verify-crc32` | `4y0t4az` | `4y0t4az` | `4y0t4az` | ✅ |
| `ruby-verify-fnv1a` | `5pyfuaz` | `5pyfuaz` | `5pyfuaz` | ✅ |
| `ruby-verify-is-valid-ipv4` | `5fyfbp9` | `5fyfbp9` | `5fyfbp9` | ✅ |
| `ruby-verify-levenshtein` | `tu16lpe` | `tu16lpe` | `tu16lpe` | ✅ |

All three stacks produce byte-identical 7-char base36 hashes — the Regrets
cross-stack parity contract holds for the Ruby stack.

**Bonus — 7-way cross-stack parity:** the same 5 (input, output) pairs
were used in `proof/java_verify/` (Java), `proof/php_verify/` (PHP),
`proof/rust_verify/` (Rust), `proof/go_verify/` (Go), and
`proof/c_verify/` (C). The hashes match across all 7 stacks:

| cluster | Ruby | Java | PHP | Rust | Go | C | JS | Python |
|---|---|---|---|---|---|---|---|---|
| `base64-encode` | `3db5bgz` | `3db5bgz` | `3db5bgz` | `3db5bgz` | `3db5bgz` | — | `3db5bgz` | `3db5bgz` |
| `crc32` | `4y0t4az` | `4y0t4az` | `4y0t4az` | `4y0t4az` | `4y0t4az` | — | `4y0t4az` | `4y0t4az` |
| `fnv1a` | `5pyfuaz` | `5pyfuaz` | `5pyfuaz` | `5pyfuaz` | `5pyfuaz` | — | `5pyfuaz` | `5pyfuaz` |
| `is-valid-ipv4` | `5fyfbp9` | `5fyfbp9` | `5fyfbp9` | `5fyfbp9` | `5fyfbp9` | `5fyfbp9` | `5fyfbp9` | `5fyfbp9` |
| `levenshtein` | `tu16lpe` | `tu16lpe` | — | `tu16lpe` | `tu16lpe` | — | `tu16lpe` | `tu16lpe` |

(PHP column shows "—" for `levenshtein` because the PHP verification
fixture used a different `levenshtein` input. C column shows "—" for
clusters not present in `proof/c_verify/`.)

## Independent value checks

Beyond the parity table, each function's output was independently
verified against a reference implementation:

| Function | Input | Ruby output | Reference | Source |
|---|---|---|---|---|
| `crc32` | `"Hello"` | `4157704578` | `python3 -c "import zlib; print(zlib.crc32(b'Hello'))"` | zlib |
| `base64_encode` | `"Hello"` | `"SGVsbG8="` | `python3 -c "import base64; print(base64.b64encode(b'Hello').decode())"` | RFC 4648 |
| `levenshtein` | `["kitten","sitting"]` | `3` | classic textbook value | Wikipedia |
| `is_valid_ipv4` | `"192.168.1.1"` | `true` | valid IPv4 | RFC 791 |
| `fnv1a` | `"Hello"` | `4116459851` | manual computation (offset 2166136261, prime 16777619) | FNV spec |

## Findings

### ✅ Confirmed working (runtime, not just static)

- **PR #354's own demo (`proof/ruby_slugify/run_demo.sh`) runtime-PASSes**
  with Ruby 3.3.0 installed. All 3 phases pass: baseline capture+validate,
  valid refactor (rename + regex split + constant removal) PASSes, breaking
  refactor (hyphen → underscore) FAILs. This fills the gap from the
  previous [REVIEW] comment which could only do static analysis.
- `capture_ruby.rb` successfully captures all 5 fresh Ruby functions,
  including ones with non-trivial control flow (table-driven CRC32 with
  `Array.new(256)`, bit-manipulation base64, 2D-DP levenshtein, byte-index
  IPv4 parser) that were NOT in PR #354's fixture.
- `validate_ruby.rb` correctly detects breaking refactors (exit 1, only
  the affected cluster FAILs) and accepts valid refactors (exit 0, hash
  unchanged). The table-driven → on-the-fly CRC32 refactor produces an
  identical hash, confirming the harness is output-based (not
  implementation-based).
- Cross-stack parity is byte-identical across Ruby / JS / Python for all
  5 clusters, AND across Java, PHP, Rust, Go, and C for the clusters that
  overlap (7-way parity for all 5 clusters where the same (input, output)
  pairs were used).

### ✅ npm test

`npm test`: 821 pass + 0 skip + 0 fail — identical to PR #354's reported
baseline (which already includes the 14 new tests added by the
second-worker [REVIEW] pass). No regression.

## Files

- `lib/verify_lib.rb` — 5 pure Ruby functions (top-level methods)
- `regrets/manifest.json` — 5 clusters with edge-case inputs
- `regrets/*.regret` — generated by `capture_ruby.rb` (committed for review)
- `cross_stack_parity.mjs` — Node script that re-derives hashes in JS + Python and compares to Ruby
- `run-verify.sh` — end-to-end walkthrough script (step 0 = PR #354's own demo, then fresh fixture capture → validate PASS → break → FAIL → refactor → PASS → parity)
- `README.md` — this file
- `.gitignore` — placeholder (no build artifacts; Ruby is interpreted)

## Verification issue

[CLAIM] issue #339 (Ruby stack) — https://github.com/Wolfvin/Regrets/issues/339
PR #354 (Ruby stack implementation, open) — https://github.com/Wolfvin/Regrets/pull/354
This verification PR — see PR description

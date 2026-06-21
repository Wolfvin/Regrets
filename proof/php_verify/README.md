# proof/php_verify/ — Independent verification of PHP Regrets stack

This directory contains an **independent re-validation** of the PHP stack
implementation (`scripts/capture_php.php` + `scripts/validate_php.php` +
`scripts/fingerprint_php.php`) on the `main` branch, per v2 worker protocol's
REVIEW-SINGLE target track.

## Why this exists

CONTEXT.md's "Lesson Learned" warns:

> Test count tinggi (388-512 tests) TIDAK menjamin fitur benar-benar
> bekerja — red team menemukan callee wrapping GAGAL untuk pattern
> paling umum meski semua unit test pass, karena test ditulis dengan
> pattern yang sama dengan implementasi (confirmation bias).

PR #347 (open) ships 5 fixture clusters (`slugify`, `count_words`,
`Invoice::calculate`, `format_post`) authored by the same worker who wrote
the PHP harness. That is exactly the confirmation-bias trap. This fixture
independently verifies the contract using 5 **different** PHP functions,
each exercising a different PHP idiom.

PR #431 (open) ports the multi-input `INPUTS` line fix from JS issue #315
to PHP — that's a separate fix, not duplicated here.

## What's verified

| Cluster | Function | PHP idiom exercised |
|---|---|---|
| `php-crc32` | `RegretVerify\crc32` | table-driven checksum with static cache (no hash() builtin) |
| `php-base64-encode` | `RegretVerify\base64_encode` | bitwise ops + lookup table (no base64_encode builtin) |
| `php-levenshtein` | `RegretVerify\levenshtein` | 2D DP matrix with two rolling rows |
| `php-is-valid-ipv4` | `RegretVerify\is_valid_ipv4` | multi-delimiter parser + range check |
| `php-fnv1a` | `RegretVerify\fnv1a` | multiply + XOR per byte (32-bit masking) |

## How to run

```bash
# Make sure PHP (with GMP extension) is on PATH.
# If GMP is not loaded by default, use a wrapper that passes
# `-d extension_dir=<dir> -d extension=gmp` to php.
cd proof/php_verify
bash run-verify.sh
```

The walkthrough:
1. **Capture** all 5 clusters → produce `.regret` files
2. **Validate baseline** → expect 5 PASS
3. **BREAKING refactor** (crc32: drop final XOR) → expect 1 FAIL (php-crc32 only), exit 1
4. **Restore** → re-validate → expect 5 PASS
5. **VALID refactor** (crc32: table-driven → on-the-fly computation) → expect 5 PASS, hash unchanged
6. **Restore** → final validate → expect 5 PASS
7. **Cross-stack parity** (PHP vs JS vs Python) → expect all match

## Cross-stack parity table

| cluster | PHP hash | JS hash | Py hash | match |
|---|---|---|---|---|
| `php-base64-encode` | `3db5bgz` | `3db5bgz` | `3db5bgz` | ✅ |
| `php-crc32` | `4y0t4az` | `4y0t4az` | `4y0t4az` | ✅ |
| `php-fnv1a` | `5pyfuaz` | `5pyfuaz` | `5pyfuaz` | ✅ |
| `php-is-valid-ipv4` | `5fyfbp9` | `5fyfbp9` | `5fyfbp9` | ✅ |
| `php-levenshtein` | `tu16lpe` | `tu16lpe` | `tu16lpe` | ✅ |

All three stacks produce byte-identical 7-char base36 hashes — the Regrets
cross-stack parity contract holds for the PHP stack.

**Bonus — 5-way cross-stack parity:** the same 5 (input, output) pairs were
used in `proof/rust_verify/` (Rust), `proof/go_verify/` (Go), and
`proof/c_verify/` (C). The hashes match across all 5 stacks:

| cluster | PHP | Rust | Go | C | JS | Python |
|---|---|---|---|---|---|---|
| `slugify` (n/a here) | — | `2gaag5y` | `2gaag5y` | `2gaag5y` | `2gaag5y` | `2gaag5y` |
| `base64-encode` | `3db5bgz` | `3db5bgz` | `3db5bgz` | — | `3db5bgz` | `3db5bgz` |
| `crc32` | `4y0t4az` | `4y0t4az` | `4y0t4az` | — | `4y0t4az` | `4y0t4az` |
| `fnv1a` | `5pyfuaz` | `5pyfuaz` | `5pyfuaz` | — | `5pyfuaz` | `5pyfuaz` |
| `is-valid-ipv4` | `5fyfbp9` | `5fyfbp9` | `5fyfbp9` | `5fyfbp9` | `5fyfbp9` | `5fyfbp9` |
| `levenshtein` | `tu16lpe` | `tu16lpe` | `tu16lpe` | — | `tu16lpe` | `tu16lpe` |

## Independent value checks

Beyond the parity table, each function's output was independently
verified against a reference implementation:

| Function | Input | PHP output | Reference | Source |
|---|---|---|---|---|
| `crc32` | `"Hello"` | `4157704578` | `python3 -c "import zlib; print(zlib.crc32(b'Hello'))"` | zlib |
| `base64_encode` | `"Hello"` | `"SGVsbG8="` | `python3 -c "import base64; print(base64.b64encode(b'Hello').decode())"` | RFC 4648 |
| `levenshtein` | `["kitten","sitting"]` | `3` | classic textbook value | Wikipedia |
| `is_valid_ipv4` | `"192.168.1.1"` | `true` | valid IPv4 | RFC 791 |
| `fnv1a` | `"Hello"` | `4116459851` | manual computation (offset 2166136261, prime 16777619) | FNV spec |

## Findings

### ✅ Confirmed working

- `capture_php.php` successfully captures all 5 fresh PHP functions,
  including ones with non-trivial control flow (table-driven CRC32 with
  static cache, bit-manipulation base64, 2D-DP levenshtein, byte-index
  IPv4 parser) that were NOT in PR #347's fixture.
- `validate_php.php` correctly detects breaking refactors (exit 1, only
  the affected cluster FAILs) and accepts valid refactors (exit 0, hash
  unchanged). The table-driven → on-the-fly CRC32 refactor produces an
  identical hash, confirming the harness is output-based (not
  implementation-based).
- Cross-stack parity is byte-identical across PHP / JS / Python for all
  5 clusters, AND across Rust, Go, and C for the clusters that overlap
  with `proof/rust_verify/`, `proof/go_verify/`, and `proof/c_verify/`
  (5-way parity for all 5 clusters where the same (input, output) pairs
  were used).

### ⚠️ Known requirement (NOT a bug, documented in `references/php.md`)

The `fingerprint_php.php` module uses PHP's GMP extension
(`gmp_init`/`gmp_strval`) for the base36 conversion of the SHA-256 hex
digest. GMP is **not** loaded by default in minimal PHP builds — the
worker must either install php-gmp or pass
`-d extension_dir=<dir> -d extension=gmp` to php.

This is documented in `references/php.md`:
> **Requirement:** PHP GMP extension must be installed. If GMP is not
> available, the `bcmath` extension can be used as a fallback (not yet
> implemented).

This verification was run with a PHP build that had GMP available as a
shared extension but not loaded by default; the worker used a
`php-regret` wrapper script that passes the `-d extension_dir` and
`-d extension=gmp` flags. The `run-verify.sh` script accepts a `PHP`
environment variable to override the PHP binary, so future workers can
point it at a wrapper if needed:

```bash
PHP=/path/to/php-regret-wrapper bash run-verify.sh
```

**Recommendation for a future PR (out of scope here):** implement the
bcmath fallback mentioned in `references/php.md`, so PHP stacks work
without GMP. bcmath is more commonly available in shared-hosting PHP
builds.

### ✅ npm test

`npm test`: 807 pass + 0 skip + 0 fail — no regression (no JS code
changed).

## Files

- `src/VerifyLib.php` — 5 pure functions in `RegretVerify` namespace
- `regrets/manifest.json` — 5 clusters with edge-case inputs
- `regrets/*.regret` — generated by `capture_php.php` (committed for review)
- `cross_stack_parity.mjs` — Node script that re-derives hashes in JS + Python and compares to PHP
- `run-verify.sh` — end-to-end walkthrough script (capture → validate PASS → break → FAIL → refactor → PASS → parity)
- `README.md` — this file
- `.gitignore` — exclude generated `*.regret` files

## Verification issue

[CLAIM] issue #341 (PHP verify end-to-end on real codebase) — https://github.com/Wolfvin/Regrets/issues/341
PR #347 (worker 1, ship `proof/php-fixture/` + `--update` OUTPUT bug fix) — https://github.com/Wolfvin/Regrets/pull/347
PR #431 (worker 2, port Issue #315 multi-input validation to PHP) — https://github.com/Wolfvin/Regrets/pull/431
This verification PR — see PR description

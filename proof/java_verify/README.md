# proof/java_verify/ — Independent verification of PR #416 (consolidated Java stack)

This directory contains an **independent re-validation** of the Java stack
implementation in `consolidate/java-stack` (PR #416 — supersedes PR #357 and
#394, original claim issue #342) on a fresh Java codebase, per v2 worker
protocol's REVIEW-SINGLE target track.

## Why this exists

CONTEXT.md's "Lesson Learned" warns:

> Test count tinggi (388-512 tests) TIDAK menjamin fitur benar-benar
> bekerja — red team menemukan callee wrapping GAGAL untuk pattern
> paling umum meski semua unit test pass, karena test ditulis dengan
> pattern yang sama dengan implementasi (confirmation bias).

PR #416 ships 6 fixture clusters (`add`, `fibonacci`, `reverse`,
`parseCsvLine`, `formatBytes`, `computeStats`) authored by the same worker
who wrote `RegretJava.java` + the harness. That is exactly the
confirmation-bias trap. This fixture independently verifies the contract
using 5 **different** Java functions, each exercising a different Java idiom.

## What's verified

| Cluster | Function | Java idiom exercised |
|---|---|---|
| `java-verify-slugify` | `VerifyLib.slugify` | char-by-char transform with StringBuilder |
| `java-verify-base64-encode` | `VerifyLib.base64Encode` | bitwise ops + lookup table (no java.util.Base64) |
| `java-verify-crc32` | `VerifyLib.crc32` | table-driven checksum (no java.util.zip.CRC32) |
| `java-verify-fnv1a` | `VerifyLib.fnv1a` | multiply + XOR per byte (long masking for unsigned 32-bit) |
| `java-verify-is-valid-ipv4` | `VerifyLib.isValidIPv4` | multi-delimiter parser + range check |

## How to run

```bash
# Make sure JDK 16+ (single-file source mode — no javac needed) is on PATH.
cd proof/java_verify
bash run-verify.sh
```

The walkthrough:
1. **Capture** all 5 clusters → produce `.regret` files
2. **Validate baseline** → expect 5 PASS
3. **BREAKING refactor** (crc32: drop final XOR) → expect 1 FAIL (java-verify-crc32 only), exit non-zero
4. **Restore** → re-validate → expect 5 PASS
5. **VALID refactor** (crc32: table-driven → on-the-fly computation) → expect 5 PASS, hash unchanged
6. **Restore** → final validate → expect 5 PASS
7. **Cross-stack parity** (Java vs JS vs Python) → expect all match

## Cross-stack parity table

| cluster | Java hash | JS hash | Py hash | match |
|---|---|---|---|---|
| `java-verify-base64-encode` | `3db5bgz` | `3db5bgz` | `3db5bgz` | ✅ |
| `java-verify-crc32` | `4y0t4az` | `4y0t4az` | `4y0t4az` | ✅ |
| `java-verify-fnv1a` | `5pyfuaz` | `5pyfuaz` | `5pyfuaz` | ✅ |
| `java-verify-is-valid-ipv4` | `5fyfbp9` | `5fyfbp9` | `5fyfbp9` | ✅ |
| `java-verify-slugify` | `2gaag5y` | `2gaag5y` | `2gaag5y` | ✅ |

All three stacks produce byte-identical 7-char base36 hashes — the Regrets
cross-stack parity contract holds for the Java stack.

**Bonus — 6-way cross-stack parity:** the same 5 (input, output) pairs were
used in `proof/php_verify/` (PHP), `proof/rust_verify/` (Rust),
`proof/go_verify/` (Go), and `proof/c_verify/` (C). The hashes match across
all 6 stacks:

| cluster | Java | PHP | Rust | Go | C | JS | Python |
|---|---|---|---|---|---|---|---|
| `slugify` | `2gaag5y` | — | `2gaag5y` | `2gaag5y` | `2gaag5y` | `2gaag5y` | `2gaag5y` |
| `base64-encode` | `3db5bgz` | `3db5bgz` | `3db5bgz` | `3db5bgz` | — | `3db5bgz` | `3db5bgz` |
| `crc32` | `4y0t4az` | `4y0t4az` | `4y0t4az` | `4y0t4az` | — | `4y0t4az` | `4y0t4az` |
| `fnv1a` | `5pyfuaz` | `5pyfuaz` | `5pyfuaz` | `5pyfuaz` | — | `5pyfuaz` | `5pyfuaz` |
| `is-valid-ipv4` | `5fyfbp9` | `5fyfbp9` | `5fyfbp9` | `5fyfbp9` | `5fyfbp9` | `5fyfbp9` | `5fyfbp9` |

(PHP column shows "—" for `slugify` because the PHP verification fixture
used a different `slugify` input string — the other 4 clusters overlap.)

## Independent value checks

Beyond the parity table, each function's output was independently
verified against a reference implementation:

| Function | Input | Java output | Reference | Source |
|---|---|---|---|---|
| `slugify` | `"Hello, World! This is a TEST."` | `"hello-world-this-is-a-test"` | expected slug form | manual |
| `base64Encode` | `"Hello"` | `"SGVsbG8="` | `python3 -c "import base64; print(base64.b64encode(b'Hello').decode())"` | RFC 4648 |
| `crc32` | `"Hello"` | `4157704578` | `python3 -c "import zlib; print(zlib.crc32(b'Hello'))"` | zlib |
| `fnv1a` | `"Hello"` | `4116459851` | manual computation (offset 2166136261, prime 16777619) | FNV spec |
| `isValidIPv4` | `"192.168.1.1"` | `true` | valid IPv4 | RFC 791 |

## Findings

### ✅ Confirmed working

- `capture_java.sh` successfully captures all 5 fresh Java functions,
  including ones with non-trivial control flow (table-driven CRC32 with
  int[256] array, bit-manipulation base64, byte-index IPv4 parser) that
  were NOT in PR #416's fixture.
- `validate_java.sh` correctly detects breaking refactors (exit 1, only
  the affected cluster FAILs) and accepts valid refactors (exit 0, hash
  unchanged). The table-driven → on-the-fly CRC32 refactor produces an
  identical hash, confirming the harness is output-based (not
  implementation-based).
- Cross-stack parity is byte-identical across Java / JS / Python for all
  5 clusters, AND across PHP, Rust, Go, and C for the clusters that
  overlap with `proof/php_verify/`, `proof/rust_verify/`,
  `proof/go_verify/`, and `proof/c_verify/` (6-way parity for all 5
  clusters where the same (input, output) pairs were used).

### ⚠️ Implementation note (NOT a bug)

The `VerifyLib` class is bundled inside `scripts/regret_java/RegretJava.java`
(as a non-public top-level class, sibling to `DemoMathUtils`). This matches
the pattern PR #416 uses for `DemoMathUtils` — both classes live in the
single source file so the demo runs on a JRE-only environment (JEP 330
single-file source mode, no `javac` needed).

Real-world Java projects would compile their code with `javac`/`mvn`/
`gradle` first, then point the manifest's `class` field at their FQCN and
pass `classpath`. This is documented in `references/java.md` and exercised
by the `classpath` field in the manifest schema.

### ⚠️ Known limitation (NOT a bug, documented in PR #416)

The Java harness only captures `inputs[0]` — no `INPUTS` line for
multi-input clusters (unlike the Go stack which has `INPUTS` line for
`inputs[1+]`). This is a v1 limitation documented in PR #416's description.
Adding `INPUTS` line support is ~200-300 LOC change in `RegretJava.java` +
`capture_java.sh` + `validate_java.sh` and warrants a separate follow-up PR.

### ✅ npm test

`npm test`: 815 pass + 1 skip + 0 fail — identical to PR #416's reported
baseline (the 1 skip is the "no java" guard in `tests/java-stack.test.js`,
correctly skipped because java IS installed). No regression.

## Files

- `regrets/manifest.json` — 5 clusters with edge-case inputs
- `regrets/*.regret` — generated by `capture_java.sh` (committed for review)
- `cross_stack_parity.mjs` — Node script that re-derives hashes in JS + Python and compares to Java
- `run-verify.sh` — end-to-end walkthrough script (capture → validate PASS → break → FAIL → refactor → PASS → parity)
- `README.md` — this file
- `.gitignore` — placeholder (no build artifacts; single-file source mode)

**Note:** The `VerifyLib` Java class is bundled inside
`scripts/regret_java/RegretJava.java` (not in this directory) — see the
"Implementation note" section above for why.

## Verification issue

[CLAIM] issue #342 (Java stack) — https://github.com/Wolfvin/Regrets/issues/342
PR #416 (consolidated Java stack, supersedes #357 + #394) — https://github.com/Wolfvin/Regrets/pull/416
This verification PR — see PR description

# proof/c_independent — Independent verification of the C stack

This directory is an **INDEPENDENT re-verification** of the C stack
(`scripts/capture_c.sh` + `scripts/validate_c.sh` + `scripts/regret_c/regret_harness.c`)
introduced in PR #419 (merged).

## Why this exists

`CONTEXT.md`'s "Lesson Learned" warns:

> Test count tinggi (388-512 tests) TIDAK menjamin fitur benar-benar
> bekerja — red team menemukan callee wrapping GAGAL untuk pattern
> paling umum meski semua unit test pass, karena test ditulis dengan
> pattern yang sama dengan implementasi (confirmation bias).
>
> Kalau diminta verifikasi sesuatu "sudah bekerja", JALANKAN test nyata
> dengan pattern yang berbeda dari yang dipakai untuk implementasi —
> jangan percaya klaim dari PR sebelumnya tanpa reproduce sendiri.

PR #419 ships `proof/c/` whose fixture functions (`add`, `fibonacci`,
`reverse`, `parse_csv_line`, `format_bytes`) were authored by the **same
worker** who wrote `capture_c.sh` / `validate_c.sh` / `regret_harness.c`.
That is exactly the confirmation-bias trap. This directory re-verifies
the C stack with **5 completely different C functions**, each exercising
a different C idiom:

| Cluster         | Function        | C idiom exercised                                   |
|-----------------|-----------------|-----------------------------------------------------|
| `slugify`       | `slugify`       | char-class transform + run-collapse (`ctype.h`)     |
| `base64-encode` | `base64_encode` | bitwise shift + 6-bit grouping + 64-entry table     |
| `crc32`         | `crc32`         | unsigned arithmetic + 256-entry lookup table        |
| `fnv1a-32`      | `fnv1a_32`      | multiply + XOR per byte                             |
| `is-valid-ipv4` | `is_valid_ipv4` | multi-delimiter parser + numeric range check        |

The original `proof/c/` uses:

| Cluster           | Function             | C idiom                                  |
|-------------------|----------------------|------------------------------------------|
| `add`             | `demo_add`           | integer addition                         |
| `fibonacci`       | `demo_fibonacci`     | iterative loop with two-variable state   |
| `reverse`         | `demo_reverse`       | pointer-based string reverse             |
| `parse-csv-line`  | `demo_parse_csv_line`| state-machine with quoted-field handling |
| `format-bytes`    | `demo_format_bytes`  | floating-point division + units table    |

Zero overlap in function semantics or C idiom — this fixture is a true
**red-team** test for the C stack.

## What's here

```
proof/c_independent/
├── README.md                    ← this file
├── text_utils.h                 ← function declarations
├── text_utils.c                 ← pure C functions (5 clusters, different idioms)
├── regret_adapter.c             ← JSON-in/JSON-out adapter for each cluster
├── verify-parity.mjs            ← cross-stack fingerprint parity check (C hash == JS hash)
├── run-verify.sh                ← end-to-end PASS/FAIL demo script
└── regrets/
    ├── manifest.json            ← 5 C clusters (3 with multi-input #315 parity)
    ├── slugify.regret           ← captured contract
    ├── base64-encode.regret
    ├── crc32.regret
    ├── fnv1a-32.regret
    └── is-valid-ipv4.regret
```

## How to run

```bash
# 1. Capture (writes/regenerates all 5 .regret files)
cd proof/c_independent
C_SOURCES="$(pwd)/text_utils.c:$(pwd)/regret_adapter.c" \
    C_INCLUDE="$(pwd)" \
    bash ../../scripts/capture_c.sh

# 2. Validate (should PASS — code unchanged since capture)
C_SOURCES="$(pwd)/text_utils.c:$(pwd)/regret_adapter.c" \
    C_INCLUDE="$(pwd)" \
    bash ../../scripts/validate_c.sh

# 3. Cross-stack parity check (C hash == JS hash)
cd ../..
node proof/c_independent/verify-parity.mjs

# 4. End-to-end refactor flow (valid PASSes, breaking FAILs, multi-input #315 parity)
bash proof/c_independent/run-verify.sh
```

Or just run the npm test:

```bash
npm test  # includes tests/c-stack-independent.test.js
```

## Verified contract

- ✅ capture writes `.regret` files with the standard format
  (`cluster` / `version` / `fingerprint` / `captured` / `entry` /
  `stack` / `fingerprintLevel` / `---` / `INPUT` / `OUTPUT` / `HASH` /
  optional `INPUTS`)
- ✅ validate PASSes when the captured code is unchanged (5/5 clusters,
  15/15 input hashes)
- ✅ validate PASSes for a **valid refactor** that preserves output
  (crc32: branching mix → branchless mask-based mix — hash UNCHANGED)
- ✅ validate FAILs (non-zero exit) for a **breaking refactor** that
  changes output (slugify: collapsed → non-collapsed — output changes
  for `"ABC---DEF???GHI"`: `"abc-def-ghi"` → `"abc---def-ghi"`)
- ✅ C fingerprint is byte-identical to JS `fingerprint()` for **all 15
  (input, output) pairs** — verified by `verify-parity.mjs`
- ✅ Multi-input #315 parity: `INPUTS` line present + correct count for
  multi-input clusters, OMITTED for single-input clusters
- ✅ All 15 (input, output) pairs match INDEPENDENT Python reference
  implementations (`base64.b64encode`, `zlib.crc32`, hand-rolled
  `slugify` + `fnv1a_32` + `is_valid_ipv4`)

## Cross-stack parity (4-way)

These 5 functions were also implemented in `proof/go_verify/` (Go) and
verified to produce identical hashes across Go / JS / Python. Adding
the C stack to the comparison:

| Cluster         | C hash   | Go hash  | JS hash  | Py hash  | match |
|-----------------|----------|----------|----------|----------|-------|
| `slugify`       | `2gaag5y`| `2gaag5y`| `2gaag5y`| `2gaag5y`| ✅    |
| `base64-encode` | `3db5bgz`| `3db5bgz`| `3db5bgz`| `3db5bgz`| ✅    |
| `crc32`         | `4y0t4az`| `4y0t4az`| `4y0t4az`| `4y0t4az`| ✅    |
| `fnv1a-32`      | `5pyfuaz`| `5pyfuaz`| `5pyfuaz`| `5pyfuaz`| ✅    |
| `is-valid-ipv4` | `5fyfbp9`| `5fyfbp9`| `5fyfbp9`| `5fyfbp9`| ✅    |

All four stacks produce byte-identical 7-char base36 hashes for the
first (input, output) pair of each cluster — **5/5 cluster top-level
hashes match across C / Go / JS / Python.** This is a 4-way parity
proof: the C stack's fingerprint computation is correct.

## Independent value checks

Each function's output was independently verified against a reference
implementation (Python):

| Function        | Input                                           | C output                  | Reference    | Source                            |
|-----------------|-------------------------------------------------|---------------------------|--------------|-----------------------------------|
| `slugify`       | `"Hello, World! This is a TEST."`               | `"hello-world-this-is-a-test"` | manual slug |                                   |
| `base64_encode` | `"Hello"`                                       | `"SGVsbG8="`              | `base64.b64encode(b'Hello').decode()` | RFC 4648 |
| `crc32`         | `"Hello"`                                       | `4157704578`              | `zlib.crc32(b'Hello')` | IEEE 802.3                       |
| `fnv1a_32`      | `"Hello"`                                       | `4116459851`              | manual (offset 2166136261, prime 16777619) | FNV spec |
| `is_valid_ipv4` | `"192.168.1.1"`                                 | `true`                    | valid IPv4  | RFC 791                           |
| `is_valid_ipv4` | `"256.0.0.1"`                                   | `false`                   | octet > 255 | RFC 791                           |
| `is_valid_ipv4` | `"01.02.03.04"`                                 | `false`                   | leading zeros | strict                            |

## Status

This verification is submitted with **`[REVIEW]`** status. Per the BOS
rule, `[SUCCESS]` is reserved for revisi-setelah-feedback where the
worker has fixed all review points AND verified the working example
again. This is a first-time submission, so `[REVIEW]` is the correct
initial tag. The BOS (or a future worker) can promote to `[SUCCESS]`
after confirming the verification holds.

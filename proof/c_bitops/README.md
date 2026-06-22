# proof/c_bitops — C stack independent verification (bit-manipulation domain)

End-to-end independent verification that the C capture+validate stack
(`scripts/capture_c.sh` + `scripts/validate_c.sh` + `scripts/regret_c/`)
works correctly on a fixture whose domain is **bit-manipulation** — distinct
from the prior C-stack fixtures which used math, string-transform, CSV-parsing,
slugify, levenshtein, ipv4, base64, and crc32 domains.

This follows CONTEXT.md's "Lesson Learned": high test counts don't guarantee
features actually work — verify with patterns that share NO implementation
grammar with the code under test.

## Why this fixture exists

The canonical C stack PR (#419, merged to main) ships `proof/c/` with 5
clusters (`add`, `fibonacci`, `reverse`, `parse-csv-line`, `format-bytes`)
authored by the same worker who wrote `capture_c.sh` + `validate_c.sh` +
the harness — exactly the confirmation-bias trap. An earlier independent
verification (PR #393, also merged into #419) added 5 fresh clusters
(`slugify`, `levenshtein`, `is_valid_ipv4`, `base64_encode`, `crc32`) using
a string-transform / DP / parser / encoding / checksum grammar.

This third fixture (`proof/c_bitops/`) exercises a completely different
grammar — unsigned arithmetic, bitwise shifts, mask-and-shift dances, and
Brian-Kernighan-style loop idioms — to provide yet another independent
witness that the C stack's contract holds.

## What's here

```
proof/c_bitops/
├── README.md                    ← this file
├── bitops.c                     ← 5 pure C functions (count_set_bits, reverse_bits, rotate_left, rotate_right, next_power_of_two)
├── bitops.h                     ← header
├── regret_adapter.c             ← JSON-in/JSON-out adapter for each cluster
├── verify-parity.mjs            ← cross-stack fingerprint parity check (C hash == JS hash, 27 cases)
├── demo-refactor-flow.sh        ← end-to-end PASS/FAIL demo script
└── regrets/
    ├── manifest.json            ← 5 C clusters (27 total (input, output) pairs across multi-input contracts)
    ├── count-set-bits.regret    ← captured contract (6 inputs)
    ├── reverse-bits.regret      ← captured contract (5 inputs)
    ├── rotate-left.regret       ← captured contract (5 inputs, multiArgs)
    ├── rotate-right.regret      ← captured contract (5 inputs, multiArgs)
    └── next-power-of-two.regret ← captured contract (6 inputs)
```

## The 5 clusters

| Cluster | Function | Input shape | # inputs | multiArgs | Description |
|---|---|---|---|---|---|
| `count-set-bits` | `bitops_count_set_bits` | `uint32` | 6 | no | Brian Kernighan popcount |
| `reverse-bits` | `bitops_reverse_bits` | `uint32` | 5 | no | 32-bit reversal via mask-and-shift |
| `rotate-left` | `bitops_rotate_left` | `[uint32, uint32]` | 5 | yes | Left rotate (mod 32) |
| `rotate-right` | `bitops_rotate_right` | `[uint32, uint32]` | 5 | yes | Right rotate (mod 32) |
| `next-power-of-two` | `bitops_next_power_of_two` | `uint32` | 6 | no | Hacker's Delight §3-2 round-up |

The 5 clusters cover:
- Single-arg functions (`count-set-bits`, `reverse-bits`, `next-power-of-two`)
- Multi-arg functions with `multiArgs: true` (`rotate-left`, `rotate-right`)
- Multi-input contracts (Issue #315 parity) — 4–6 inputs per cluster, 27 total
  (input, output) pairs verified

## Running the demo

```bash
# 1. Capture (writes/regenerates all 5 .regret files)
cd proof/c_bitops
C_SOURCES="$(pwd)/bitops.c:$(pwd)/regret_adapter.c" \
    C_INCLUDE="$(pwd)" \
    bash ../../scripts/capture_c.sh

# 2. Validate baseline (expect 5/5 PASS)
C_SOURCES="$(pwd)/bitops.c:$(pwd)/regret_adapter.c" \
    C_INCLUDE="$(pwd)" \
    bash ../../scripts/validate_c.sh

# 3. Cross-stack fingerprint parity (27 cases, C hash == JS hash)
node verify-parity.mjs

# 4. End-to-end PASS/FAIL demo (capture → baseline PASS → valid refactor PASS → breaking FAIL)
bash demo-refactor-flow.sh
```

## What the demo verifies

`demo-refactor-flow.sh` runs four phases against the live C toolchain:

1. **Capture** — writes 5 `.regret` files in the standard format (cluster,
   version, fingerprint, captured, INPUT, OUTPUT, HASH, plus INPUTS line for
   multi-input contracts).
2. **Baseline validate** — 5/5 PASS, all 27 (input, output) hashes match.
3. **Valid refactor** — `rotate_left` is rewritten from `mod+branch` to a
   branchless `shift-mask` form. Output is preserved for all 5 captured
   inputs → validate still 5/5 PASS (hash unchanged).
4. **Breaking refactor** — `count_set_bits` is initialized with `count = 1`
   instead of `count = 0` (off-by-one). Every output shifts by +1 → validate
   FAILs (1 cluster FAIL, 4 PASS, exit 1, hash drift correctly detected).

The demo's cleanup trap restores `bitops.c` on exit, so the working tree
is left clean.

## Toolchain requirements

Same as the canonical C stack:
- `gcc` (or any C11 compiler)
- `libcrypto` (OpenSSL) — for SHA-256
- `libjson-c` — for JSON parsing in the adapter
- `libdl` (glibc) — for `dlsym(RTLD_DEFAULT, ...)` entry-symbol lookup

Verified on:
- Debian 13 with gcc 14.2.0, libssl-dev 3.5.6, libjson-c-dev 0.18

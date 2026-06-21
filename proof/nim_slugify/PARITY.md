# Cross-Stack Fingerprint Parity — Nim vs Python

This document verifies that the Nim adapter produces **byte-identical fingerprints**
to the Python reference implementation for the same input/output pair.

## Methodology

1. Compute expected hashes using Python's `hashlib.sha256` + a clean `to_base36` implementation
   (script: `/home/z/my-project/scripts/verify_parity.py`).
2. Run the Nim parity check (`/home/z/my-project/scripts/parity_check.nim`) which calls
   `fingerprint_nim.fingerprint()` directly on the same 11 input/output pairs.
3. Compare hashes — all 11 must match exactly.

## Algorithm

Both stacks implement the same contract:

```
combined = stable_dumps(input) + "|" + stable_dumps(output)
hash_hex = sha256(combined.encode('utf-8')).hexdigest()
b36      = to_base36(int(hash_hex, 16))
return   b36[:7]
```

Where:
- `stable_dumps(obj)` = JSON serialization with sorted keys, compact separators (`","` and `":"`), UTF-8 preserved (no ASCII escaping).
- `to_base36(n)` = lowercase base36 conversion (chars `0-9a-z`).
- `sha256` = SHA-256 hash function. Nim 2.2.0 stdlib does not include `std/sha256`, so `fingerprint_nim.nim` ships a clean-room FIPS 180-4 implementation.

## Test Cases

These mirror the Ruby slugify example, ensuring cross-stack parity with Ruby as well
(Ruby adapter produced the same 11 hashes — see `proof/ruby_slugify/PARITY.md`).

| # | Input | Output | Expected Hash (Python) | Nim Hash | Match |
|---|-------|--------|------------------------|----------|-------|
| 1 | `"Hello, World!"` | `"hello-world"` | `615ytfn` | `615ytfn` | ✓ |
| 2 | `"  Multiple   Spaces  "` | `"multiple-spaces"` | `5o04ufw` | `5o04ufw` | ✓ |
| 3 | `"Café résumé"` | `"caf-r-sum"` | `3jchbor` | `3jchbor` | ✓ |
| 4 | `"foo_bar baz"` | `"foo-bar-baz"` | `3ybjhna` | `3ybjhna` | ✓ |
| 5 | `"---trailing---"` | `"trailing"` | `41kkr7q` | `41kkr7q` | ✓ |
| 6 | `""` | `""` | `5oge4st` | `5oge4st` | ✓ |
| 7 | `"!!!"` | `""` | `27z7zta` | `27z7zta` | ✓ |
| 8 | `"Mix3d C4se & Symbols!!!"` | `"mix3d-c4se-symbols"` | `4xlwrkf` | `4xlwrkf` | ✓ |
| 9 | `["Hello, World!","Café résumé","---trailing---"]` | `["hello-world","caf-r-sum","trailing"]` | `2tph9ny` | `2tph9ny` | ✓ |
| 10 | `["","!!!","a"]` | `["","","a"]` | `1aduf3p` | `1aduf3p` | ✓ |
| 11 | `["Mix3d C4se & Symbols!!!","  Multiple   Spaces  "]` | `["mix3d-c4se-symbols","multiple-spaces"]` | `1tetuj0` | `1tetuj0` | ✓ |

**Result: 11/11 hashes match.** Cross-stack parity is verified.

## Reproduction

```bash
# 1. Compute Python reference hashes
python3 /home/z/my-project/scripts/verify_parity.py

# 2. Run Nim parity check
export PATH="/path/to/nim/bin:$PATH"
cd /path/to/Regrets/scripts
nim c -d:release --path:. -o:/tmp/parity_check /home/z/my-project/scripts/parity_check.nim
/tmp/parity_check

# Both should print the same 11 hashes.
```

## What This Means

A `.regret` file captured by the Nim adapter is **interchangeable** with a `.regret`
file captured by the Ruby, PHP, JS, or Python adapter, as long as:
- The input JSON is byte-identical (same value, same key order if object — but `stableDumps` sorts keys, so this is handled).
- The output JSON is byte-identical (same caveat).

This means a Nim cluster can be replaced with a Ruby cluster (or vice versa) without
breaking the golden contract.

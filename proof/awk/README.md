# proof/awk — awk stack working example

End-to-end demo that the awk capture+validate stack is functional.

## What's here

```
proof/awk/
├── README.md                    ← this file
├── sum_column.awk               ← sum the first column of input
├── fibonacci.awk                ← 10th Fibonacci number (uses awk user-defined function)
├── reverse_lines.awk            ← reverse line order AND each line
├── word_count.awk               ← count whitespace-separated words
├── csv_field_count.awk          ← count CSV fields (POSIX awk, no gawk extensions)
├── max_value.awk                ← find max value in first column
├── verify-parity.mjs            ← cross-stack fingerprint parity check (awk hash == JS hash)
├── demo-refactor-flow.sh        ← end-to-end PASS/FAIL demo script
└── regrets/
    ├── manifest.json            ← 6 awk clusters
    ├── sum-column.regret        ← captured contract
    ├── fibonacci.regret
    ├── reverse-lines.regret
    ├── word-count.regret
    ├── csv-field-count.regret
    └── max-value.regret
```

## Running the demo

```bash
# 1. Capture (writes/regenerates all 6 .regret files)
node ../../scripts/capture_awk.mjs

# 2. Validate (should PASS — code unchanged since capture)
node ../../scripts/validate_awk.mjs

# 3. Cross-stack parity check (awk hash == JS hash)
node ../verify-parity.mjs

# 4. End-to-end refactor flow (valid refactor PASSes, breaking FAILs)
bash demo-refactor-flow.sh
```

Or via the unified CLI:

```bash
regret capture
regret validate
```

## Verified contract

- ✅ capture writes `.regret` files with the standard format
  (`cluster`/`version`/`fingerprint`/`captured`/`INPUT`/`OUTPUT`/`HASH`)
- ✅ validate PASSes when the captured code is unchanged
- ✅ validate PASSes for a **valid refactor** that preserves output
  (iterative → Binet's formula for `fibonacci`)
- ✅ validate FAILs (non-zero exit) for a **breaking refactor** that
  changes output (off-by-one in `fibonacci`: 55 → 89)
- ✅ awk fingerprint is byte-identical to JS `fingerprint()` for the same
  (input, output) pair — verified by `verify-parity.mjs`
- ✅ POSIX awk compatibility — works with mawk (default), nawk, and gawk
- ✅ Trivial-input guard: empty stdout → skip cluster
- ✅ Trailing-newline normalization: `print x` vs `printf "%s", x`
  produce the same fingerprint

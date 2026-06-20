# proof/c — C stack working example

End-to-end demo that the C capture+validate stack is functional.

## What's here

```
proof/c/
├── README.md                    ← this file
├── demo_math.c                  ← pure C functions (add, fibonacci, reverse, parse_csv_line, format_bytes)
├── demo_math.h                  ← header
├── regret_adapter.c             ← JSON-in/JSON-out adapter for each cluster
├── verify-parity.mjs            ← cross-stack fingerprint parity check (C hash == JS hash)
├── demo-refactor-flow.sh        ← end-to-end PASS/FAIL demo script
└── regrets/
    ├── manifest.json            ← 5 C clusters
    ├── add.regret               ← captured contract
    ├── fibonacci.regret
    ├── reverse.regret
    ├── parse-csv-line.regret
    └── format-bytes.regret
```

## Running the demo

```bash
# 1. Capture (writes/regenerates all 5 .regret files)
C_SOURCES="$(pwd)/demo_math.c:$(pwd)/regret_adapter.c" \
    C_INCLUDE="$(pwd)" \
    bash ../../scripts/capture_c.sh

# 2. Validate (should PASS — code unchanged since capture)
C_SOURCES="$(pwd)/demo_math.c:$(pwd)/regret_adapter.c" \
    C_INCLUDE="$(pwd)" \
    bash ../../scripts/validate_c.sh

# 3. Cross-stack parity check (C hash == JS hash)
node ../verify-parity.mjs

# 4. End-to-end refactor flow (valid refactor PASSes, breaking FAILs)
bash demo-refactor-flow.sh
```

## Verified contract

- ✅ capture writes `.regret` files with the standard format
  (`cluster`/`version`/`fingerprint`/`captured`/`INPUT`/`OUTPUT`/`HASH`)
- ✅ validate PASSes when the captured code is unchanged
- ✅ validate PASSes for a **valid refactor** that preserves output
  (iterative → Binet's formula for `fibonacci`)
- ✅ validate FAILs (non-zero exit) for a **breaking refactor** that
  changes output (off-by-one in `fibonacci`: 55 → 89)
- ✅ C fingerprint is byte-identical to JS `fingerprint()` for the same
  (input, output) pair — verified by `verify-parity.mjs`
- ✅ C fingerprint is also byte-identical to the Java stack's fingerprint
  (the 5 clusters here produce the same hashes as `proof/java/` when
  using the same demo target functions)

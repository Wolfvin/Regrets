# proof/cpp — C++ stack working example

End-to-end demo that the C++ capture+validate stack is functional.

## What's here

```
proof/cpp/
├── README.md                    ← this file
├── demo_math.cpp                ← pure C++ functions: free functions + MathUtils class
├── demo_math.hpp                ← header
├── regret_adapter.cpp           ← JSON-in/JSON-out adapter for each cluster
├── verify-parity.mjs            ← cross-stack fingerprint parity check (C++ hash == JS hash)
├── demo-refactor-flow.sh        ← end-to-end PASS/FAIL demo script
└── regrets/
    ├── manifest.json            ← 8 C++ clusters
    ├── add.regret               ← captured contract
    ├── fibonacci.regret
    ├── reverse.regret
    ├── parse-csv-line.regret
    ├── format-bytes.regret
    ├── factorial.regret         ← class-method example
    ├── gcd.regret               ← class-method, multi-arg
    └── is-palindrome.regret     ← class-method, returns bool
```

## Running the demo

```bash
# 1. Capture (writes/regenerates all 8 .regret files)
CPP_SOURCES="$(pwd)/demo_math.cpp:$(pwd)/regret_adapter.cpp" \
    CPP_INCLUDE="$(pwd)" \
    bash ../../scripts/capture_cpp.sh

# 2. Validate (should PASS — code unchanged since capture)
CPP_SOURCES="$(pwd)/demo_math.cpp:$(pwd)/regret_adapter.cpp" \
    CPP_INCLUDE="$(pwd)" \
    bash ../../scripts/validate_cpp.sh

# 3. Cross-stack parity check (C++ hash == JS hash)
node ../verify-parity.mjs

# 4. End-to-end refactor flow (valid refactor PASSes, breaking FAILs, exception safety)
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
- ✅ **C++ exception safety**: when an adapter throws a C++ exception
  during validate, the harness catches it and reports the cluster as
  FAIL (no crash) — other clusters still validate normally
- ✅ **Class-method support**: adapters can instantiate C++ classes and
  call instance methods (factorial, gcd, is_palindrome)
- ✅ C++ fingerprint is byte-identical to JS `fingerprint()` for the same
  (input, output) pair — verified by `verify-parity.mjs`
- ✅ C++ fingerprint is also byte-identical to the C and Java stacks'
  fingerprints for the 5 shared free-function clusters (13mxb0z /
  587q30m / 1ky49hx / 8xifg6f / 4zbjvg6)

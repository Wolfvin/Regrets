# proof/java — Java stack working example

End-to-end demo that the Java capture+validate stack is functional.

## What's here

```
proof/java/
├── README.md                    ← this file
├── verify-parity.mjs            ← cross-stack fingerprint parity check
├── demo-refactor-flow.sh        ← end-to-end PASS/FAIL demo script
└── regrets/
    ├── manifest.json            ← 5 Java clusters (add, fibonacci, reverse, parseCsvLine, formatBytes)
    ├── add.regret               ← captured contract
    ├── fibonacci.regret
    ├── reverse.regret
    ├── parse-csv-line.regret
    └── format-bytes.regret
```

The capture target is `DemoMathUtils`, a top-level non-public class that
lives inside `scripts/regret_java/RegretJava.java`. Bundling it there
lets the demo run on a JRE-only environment (no `javac` needed) —
single-file source mode compiles both `RegretJava` and `DemoMathUtils`
in one shot.

Real-world Java projects compile their code with `javac` / `mvn` /
`gradle` first, then point the manifest's `class` field at their FQCN
and pass `classpath`. See `references/java.md` for the schema.

## Running the demo

```bash
# 1. Capture (writes/regenerates all 5 .regret files)
bash ../../scripts/capture_java.sh

# 2. Validate (should PASS — code unchanged since capture)
bash ../../scripts/validate_java.sh

# 3. Cross-stack parity check (Java hash == JS hash)
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
  changes output (off-by-one in `fibonacci`)
- ✅ Java fingerprint is byte-identical to JS `fingerprint()` for the
  same (input, output) pair — verified by `verify-parity.mjs`

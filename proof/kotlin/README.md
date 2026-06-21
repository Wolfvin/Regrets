# Kotlin Stack Proof of Concept

This directory demonstrates the Regrets Kotlin stack end-to-end:
**capture → refactor → validate**. Three clusters cover the common
shapes: integer arithmetic (multi-arg), string formatting (multi-arg
with mixed types), and single-arg string transformation.

## Layout

```
proof/kotlin/
├── README.md              ← this file
├── src/
│   └── Example.kt         ← the Kotlin source under fingerprint
└── regrets/
    ├── manifest.json      ← cluster definitions
    ├── add.regret         ← captured (run capture_kotlin.sh to regenerate)
    ├── greet.regret
    └── title-case-words.regret
```

## Quick Start

```sh
# 1. Make sure kotlinc + java are installed (KOTLINC_HOME if kotlinc isn't on PATH).
#    Requires Kotlin 1.9+ and JDK 11+.

# 2. Capture fingerprints.
cd proof/kotlin
bash ../../scripts/capture_kotlin.sh
# → regrets/add.regret, regrets/greet.regret, regrets/title-case-words.regret

# 3. Validate (no code change → all PASS).
bash ../../scripts/validate_kotlin.sh
# → exit 0

# 4. Make a BREAKING refactor.
sed -i 's/a + b/a - b/' src/Example.kt
bash ../../scripts/validate_kotlin.sh
# → exit 1, "RESULT FAIL hash_mismatch expected=63qoext actual=xxjwh3v"

# 5. Make a VALID refactor (same input→output mapping).
sed -i 's/a - b/b + a/' src/Example.kt   # commutative, same output
bash ../../scripts/validate_kotlin.sh
# → exit 0 (all PASS)
```

## Cluster Catalog

| Cluster ID | Function | Inputs | Notes |
|---|---|---|---|
| `add` | `add(a: Int, b: Int): Int` | 4 inputs (pairs of Ints) | `multiArgs: true` — each input is `[a, b]` |
| `greet` | `greet(name: String, excited: Boolean): String` | 3 inputs | `multiArgs: true` — each input is `[name, excited]` |
| `title-case-words` | `titleCaseWords(input: String): String` | 3 inputs | `multiArgs: false` (default) — each input is a single String |

## Cross-stack Fingerprint Verification

The Kotlin fingerprint algorithm (`stableStringify` + `sha256` + base36
→ 7 chars) is a port of `scripts/fingerprint.js`. The two implementations
produce identical hashes for the same input/output pairs — verified with:

```sh
$ node -e "import('./scripts/fingerprint.js').then(fp => {
  console.log(fp.fingerprint([1, 2], 3));        // → 63qoext
  console.log(fp.fingerprint(['world', true], 'Hello, world!'));  // → pn5ngnw
  console.log(fp.fingerprint('hello world', 'Hello World'));      // → 4am2hvn
});"
63qoext
pn5ngnw
4am2hvn
```

These match the `HASH` lines in the captured `.regret` files in this
directory.

## What's NOT Demonstrated

- **Callee wrapping** (Ghost Proxy for inner function calls) — out of
  scope for this PR. See `references/kotlin.md` → Roadmap.
- **Class method invocation** (`classMethod` pattern) — out of scope.
- **Custom data class parameters** — only primitives, String, List, Map
  are supported as function parameter types.
- **`regret update` CLI** — not yet wired for Kotlin. Run
  `capture_kotlin.sh --cluster <id>` manually to re-capture.

## Cleanup

`capture_kotlin.sh` and `validate_kotlin.sh` create a temporary
`.regret-kotlin-build/` directory in the project root for compiled
classes. This is removed on success (kept on `--verbose` for debugging).
Add `.regret-kotlin-build/` to `.gitignore` if you don't want it tracked.

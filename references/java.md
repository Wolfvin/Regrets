# Java Stack Variant — Regrets Integration

The Java stack brings regret fingerprinting to JVM projects. The capture/validate
flow mirrors the JS and Python stacks and produces `.regret` files with identical
format, so cross-stack consistency is preserved (see verification below).

## Status: Working Preview

- ✅ `capture_java.sh` — reads `regrets/manifest.json`, finds `stack: "java"` clusters,
  invokes each entry function via reflection, writes `.regret` files.
- ✅ `validate_java.sh` — re-invokes each entry function with the captured input,
  compares the live fingerprint to the golden hash, prints PASS/FAIL.
- ✅ Cross-stack fingerprint consistency verified against JS / Python / PHP
  (same input → same 7-char hash).
- ✅ End-to-end demo in `examples/java/run-demo.sh` — capture → validate PASS →
  breaking refactor → validate FAIL → restore → PASS again.
- ⚠️ Single-input golden contract only (the first input is fingerprinted; multi-input
  `INPUTS` line not yet written — see Known Gaps below).

---

## Quick Start

1. Add `"stack": "java"` clusters to `regrets/manifest.json` (see format below).
2. Make sure your Java sources are compiled and the `.class` files (or source root)
   are reachable from the classpath you pass to the scripts.
3. Run `bash scripts/capture_java.sh` to capture fingerprints.
4. Run `bash scripts/validate_java.sh` to validate.

### Setting the classpath

The scripts look for user code on these classpath entries (in order):

- `JAVA_SRC` env var (default: `src`) — typically your source root or
  `target/classes` (Maven) / `build/classes/java/main` (Gradle).
- `JAVA_CLASSPATH` env var (default: empty) — any additional classpath entries,
  colon-separated.
- The auto-compiled `.regret-java-classes/` directory containing `RegretJava`
  and `RegretRunner` (added automatically by the shell scripts).

Example with a Maven project:

```bash
JAVA_SRC=target/classes bash scripts/capture_java.sh
JAVA_SRC=target/classes bash scripts/validate_java.sh
```

Example with multiple source roots:

```bash
JAVA_SRC="target/classes:lib/some-dep.jar" bash scripts/capture_java.sh
```

---

## Manifest Format for Java Clusters

```json
{
  "clusters": [
    {
      "id": "calculator-add",
      "entry": "Calculator::add",
      "watches": ["add"],
      "stack": "java",
      "fingerprintLevel": "entry",
      "multiArgs": true,
      "inputs": [[2, 3]]
    },
    {
      "id": "calculator-reverse",
      "entry": "com.example.StringUtils::reverse",
      "watches": ["reverse"],
      "stack": "java",
      "fingerprintLevel": "entry",
      "inputs": ["hello world"]
    },
    {
      "id": "invoice-total",
      "entry": "com.example.InvoiceService::computeTotal",
      "watches": ["computeTotal"],
      "stack": "java",
      "fingerprintLevel": "entry",
      "inputs": [{"subtotal": 100.0, "taxRate": 0.1}],
      "constructorArgs": ["default-tenant"]
    }
  ]
}
```

### Field reference

| Field | Required | Description |
|-------|----------|-------------|
| `id` | yes | Cluster identifier — used as the `.regret` filename. |
| `entry` | yes | `FullyQualifiedClassName::methodName` (e.g. `Calculator::add` or `com.example.Foo::bar`). |
| `watches` | recommended | List of method names to "watch" — informational only at this stage (used for documentation; callee-level fingerprinting not yet implemented for Java). |
| `stack` | yes | Must be `"java"`. |
| `fingerprintLevel` | recommended | `"entry"` (default) — only the entry function's output is fingerprinted. |
| `inputs` | yes | Array of inputs. Each input is either a single JSON value (single-arg call) or, with `multiArgs: true`, an array of values spread as separate arguments. |
| `multiArgs` | optional | When `true`, each input is treated as a list of positional arguments rather than a single value. |
| `constructorArgs` | optional | Array of arguments to pass to the class's constructor when invoking an instance method. If omitted, the no-arg constructor is used. |
| `normalize` | optional | Array of normalize rule names (see [fingerprint-spec.md](./fingerprint-spec.md)). Note: normalize rules are documented but **not yet implemented in the Java stack** — see Known Gaps. |
| `ignoreFields` | optional | Array of field names to strip from output before hashing. Note: **not yet implemented in the Java stack** — see Known Gaps. |
| `file` | optional | Informational — the source file the entry lives in. Not used by the runner (classpath is the source of truth). |

---

## Why Java Is Different

| Challenge | JS/Python Approach | Java Reality |
|-----------|-------------------|--------------|
| Function wrapping | `Proxy` / decorator | Reflection only — JVM has no runtime `Proxy` for arbitrary methods |
| Dynamic imports | `import()` / `importlib` | `Class.forName()` + reflection — works but slower |
| Method overloading | N/A | Method selected by arg count (first match wins) — be aware if your class has overloads |
| Primitive types | N/A | Java has `long` vs `Long` vs `int` — JSON numbers are parsed as `Long` (if integer-fit) or `Double`, then coerced to the target parameter type |
| Class instantiation | N/A | Reflection requires a declared constructor (no-arg or matching `constructorArgs`) |

The Java stack uses **direct invocation via reflection** rather than a ghost proxy:
the entry function is called with the JSON-parsed input, the return value is
JSON-serialized, and the fingerprint is computed from `(input, output)`. This
matches the PHP stack's approach (see [php.md](./php.md)).

---

## Fingerprint Algorithm — Cross-Stack Consistency

The fingerprint algorithm is **identical** across all stacks:

```
sha256(stableStringify(input) + "|" + stableStringify(output)) → base36 → first 7 chars
```

Where `stableStringify` produces JSON with recursively sorted object keys and
canonical escaping. Verified against the existing `proof/jaconv` golden fixture:

```
INPUT:  ["abcd","",true,true,true]
OUTPUT: "ａｂｃｄ"

JS:     2zkvw4g  ✅
Python: 2zkvw4g  ✅
PHP:    2zkvw4g  ✅
Java:   2zkvw4g  ✅   (new)
```

The Java implementation in `scripts/java/RegretJava.java` uses:

- `java.security.MessageDigest.getInstance("SHA-256")` for the hash
- `java.math.BigInteger.toString(36)` for base36 conversion (equivalent to JS
  `BigInt('0x' + hex).toString(36)` and Python `to_base36(int(hex, 16))`)

---

## Equivalent of Ghost Proxy in Java

Java has no JavaScript `Proxy` and no Python `unittest.mock.patch`. The Java
stack uses **direct reflection-based invocation**:

1. The capture script loads `regrets/manifest.json` and filters to `stack: "java"` clusters.
2. For each cluster, it resolves the entry class via `Class.forName()` and finds
   the entry method by name (first method with matching parameter count).
3. It instantiates the receiver (if the method is non-static) using either the
   no-arg constructor or `constructorArgs`.
4. It coerces the JSON input to the method's parameter types and invokes.
5. The return value is normalized to JSON-friendly types (arrays → `List`,
   `Map` preserved, primitives boxed, etc.).
6. The fingerprint is computed and a `.regret` file is written.

`fingerprintLevel: "entry"` is the only supported level. `fingerprintLevel:
"full"` (sequence of watched calls) is not yet implemented for Java — see
Known Gaps.

---

## Example: Capture + Validate Workflow

### Step 1 — Define your Java class

```java
// src/Calculator.java (default package — for simplicity)
public class Calculator {
    public static long add(long a, long b) { return a + b; }
    public static String toHex(long n)     { return String.format("%08X", n); }
}
```

### Step 2 — Declare a manifest

```json
// regrets/manifest.json
{
  "clusters": [
    {
      "id": "calc-add",
      "entry": "Calculator::add",
      "watches": ["add"],
      "stack": "java",
      "fingerprintLevel": "entry",
      "multiArgs": true,
      "inputs": [[2, 3], [10, 20]]
    },
    {
      "id": "calc-tohex",
      "entry": "Calculator::toHex",
      "watches": ["toHex"],
      "stack": "java",
      "fingerprintLevel": "entry",
      "inputs": [255, 4096]
    }
  ]
}
```

### Step 3 — Compile your code

```bash
javac -d build/classes src/Calculator.java
```

### Step 4 — Capture

```bash
JAVA_SRC=build/classes bash scripts/capture_java.sh
```

Output:

```
📡 Capturing: calc-add
   Entry:   Calculator::add
   ...
   ✅ Fingerprint: 13mxb0z
   📄 Saved: regrets/calc-add.regret
```

### Step 5 — Refactor (safely)

Change the internal implementation of `add` to use `BigInteger` if you want —
as long as the input/output contract stays the same, validate will still PASS.

### Step 6 — Validate

```bash
JAVA_SRC=build/classes bash scripts/validate_java.sh
```

Output (all PASS):

```
  ✅ calc-add                            13mxb0z                PASS
  ✅ calc-tohex                          zj2bzm9                PASS
```

### Step 7 — Breaking change

If you accidentally change `add` to return `a + b + 1` (off-by-one), validate
will FAIL:

```
  ❌ calc-add                            13mxb0z → 2gqjkyl      FAIL
  ✅ calc-tohex                          zj2bzm9                PASS
```

Fix the code (do NOT edit the `.regret` file) and re-run validate.

---

## Multi-Input Contracts

A cluster with multiple inputs captures only the **first** input as the golden
contract by default. Additional inputs are run during capture (to surface
runtime errors) but are not yet serialized to the `INPUTS` line that the JS /
Python stacks use for multi-input drift detection.

If you need multi-input drift detection today, declare one cluster per input
and validate them all together.

This is a known gap — see below.

---

## Known Gaps (Future Work)

1. **Multi-input `INPUTS` line** — JS/Python capture writes an `INPUTS` line
   containing every input's hash so validate can detect drift on any single
   input. The Java stack does not yet write this line — only the first input
   is golden. (Tracked in the [CLAIM] issue #342 — follow-up work.)

2. **`normalize` rules** — the JS stack supports `timestamps`, `uuids`,
   `absPaths`, `floatPrecision`, `floatTolerance`, and others. The Java stack
   accepts the `normalize` field in the manifest and writes it to the `.regret`
   file metadata, but does NOT yet apply the rules during fingerprinting. This
   means Java clusters with non-deterministic output (timestamps, UUIDs) will
   always fail validate. Workaround: make your Java functions deterministic
   (inject a clock, use a seeded random) before capturing.

3. **`ignoreFields` / `ignorePaths`** — same as above: accepted in manifest,
   written to `.regret` file metadata, but not yet applied during fingerprinting.

4. **Callee contracts** (`regrets/<parent>.calls.<callee>.regret`) — JS/Python
   support wrapping internal function calls and writing per-callee `.regret`
   files. The Java stack does not yet implement callee wrapping —
   `fingerprintLevel: "entry"` is the only supported level. Use the JS stack
   if you need callee-level contracts today.

5. **Method overloading** — the runner picks the first method whose parameter
   count matches the input. If your class has overloaded methods with the same
   arity, the wrong one may be selected. Workaround: rename one of the
   overloads, or wrap the call in a non-overloaded helper.

6. **Update mode** (`--update <cluster> --reason "..."`) — not yet implemented
   for Java. To update a golden contract, delete the `.regret` file and
   re-capture.

7. **Drift detection** (`--runs N`) — not yet implemented for Java.

If you need any of these features for production use, please open an issue
referencing the [CLAIM] issue #342.

---

## File Layout

```
scripts/
├── capture_java.sh         # bash wrapper — compiles + invokes RegretRunner capture
├── validate_java.sh        # bash wrapper — compiles + invokes RegretRunner validate
└── java/
    ├── RegretJava.java     # shared fingerprint + JSON + .regret file format
    └── RegretRunner.java   # capture/validate driver (reflection-based invocation)

examples/java/
├── Calculator.java          # demo target — pure functions, deterministic
├── Calculator_breaking.java # refactor that silently breaks 3 of the 6 methods
├── manifest.json            # 6 clusters covering different I/O shapes
└── run-demo.sh              # end-to-end demo: capture → validate → break → restore
```

---

## Cross-Stack Fingerprint Verification

To verify that the Java fingerprint algorithm matches JS / Python / PHP for a
specific input/output pair, run:

```bash
# Compile RegretJava.java once
javac -d /tmp/regret-classes scripts/java/RegretJava.java

# Compare hashes for any JSON input/output pair
java -cp /tmp/regret-classes io.github.wolfvin.regret.RegretJava \
  fingerprint '["abcd","",true,true,true]' '"ａｂｃｄ"'
# → 2zkvw4g

node --input-type=module -e "
  import { fingerprint } from './scripts/fingerprint.js'
  console.log(fingerprint(['abcd','',true,true,true], 'ａｂｃｄ', {}))
"
# → 2zkvw4g
```

Both must produce the same 7-char hash. If they don't, file a bug — this is a
regression in the cross-stack contract.

# Java Stack Variant

Regression fingerprinting for Java projects using reflection-driven capture.

## Status: Working (v1)

Capture + validate are both implemented and verified end-to-end against
`proof/java/`. Cross-stack fingerprint parity with JS/Python is verified
by `proof/java/verify-parity.mjs`.

**Scope of v1:**
- ✅ Capture: invoke static methods via reflection, compute fingerprint,
  write `.regret` file with standard format.
- ✅ Validate: re-invoke method with the same INPUT, compare hash, report
  PASS/FAIL with non-zero exit on failure.
- ✅ Cross-stack parity: identical 7-char base36 fingerprint for the same
  (input, output) pair.
- ✅ Trivial-input guard: null/NaN/throwing outputs are skipped (matches
  JS behavior).
- ❌ Callee wrapping (depth-1 contract chaining) — not yet implemented.
- ❌ Instance methods — only `public static` methods are supported.
- ❌ Auto-discovery via `regret install` — manifest must be hand-written.

---

## Quick Start

```bash
# 1. Compile your Java project (javac / mvn / gradle)
javac -d build src/**/*.java

# 2. Add Java clusters to regrets/manifest.json (see schema below)
# 3. Capture
bash scripts/capture_java.sh
# 4. Validate (after refactoring)
bash scripts/validate_java.sh
```

Or via the unified CLI (auto-detects `stack: "java"` clusters):

```bash
regret capture
regret validate
```

---

## Manifest Schema for Java Clusters

```json
{
  "clusters": [
    {
      "id": "fibonacci",
      "stack": "java",
      "class": "com.example.MathUtils",
      "method": "fibonacci",
      "entry": "fibonacci",
      "fingerprintLevel": "entry",
      "watches": ["fibonacci"],
      "inputs": [10],
      "description": "10th Fibonacci number"
    },
    {
      "id": "add",
      "stack": "java",
      "class": "com.example.MathUtils",
      "method": "add",
      "entry": "add",
      "fingerprintLevel": "entry",
      "watches": ["add"],
      "multiArgs": true,
      "inputs": [[2, 3]],
      "description": "Integer addition — two-arg method"
    }
  ]
}
```

### Java-Specific Manifest Fields

| Field | Required | Description |
|-------|----------|-------------|
| `stack` | ✅ | Must be `"java"` |
| `class` | ✅ | Fully-qualified class name (e.g., `"com.example.MathUtils"`). For the built-in demo target, use `"DemoMathUtils"`. |
| `method` | ✅ | Static method name to invoke |
| `entry` | ✅ | Same as `method` (kept for cross-stack consistency) |
| `inputs` | ✅ | Array of inputs. v1 uses the FIRST input only; multiple inputs would require per-input `.regret` files (not in scope). |
| `multiArgs` | ❌ | `true` if the method takes multiple args and `inputs[i]` is an array. Default `false`. |
| `classpath` | ❌ | Classpath for loading the target class (e.g., `"build:lib/*"`). Defaults to the system classloader. |
| `watches` | ❌ | Same semantics as JS — informational, lists functions whose I/O would be recorded if callee-wrapping were supported. |
| `fingerprintLevel` | ❌ | Always `"entry"` in v1 (callee-level fingerprinting not implemented). |

---

## How It Works

### Architecture

```
scripts/capture_java.sh       ← bash orchestrator
scripts/validate_java.sh      ← bash orchestrator
scripts/regret_java/RegretJava.java   ← single-file Java program (JEP 330)
```

`RegretJava.java` is a single source file (Java 16+ single-file source
mode) containing:
- `RegretJava` — main entry point + orchestration
- Nested `Fingerprint` class — SHA-256 → base36 → 7-char (identical to fingerprint.js)
- Nested `Json` class — minimal JSON parser + stable stringify
- `DemoMathUtils` — top-level non-public class used as the built-in demo target

### Capture Flow

1. Read `regrets/manifest.json`, filter clusters with `stack: "java"`.
2. For each cluster:
   - Load `cluster.class` via `Class.forName(...)` (using the optional
     `classpath` to build a `URLClassLoader`).
   - Find a `public static` method matching `cluster.method` whose
     parameter count matches the input arity.
   - Coerce JSON input to the method's parameter types (handles
     primitive boxing, List→array, numeric widening/narrowing).
   - Invoke via reflection.
   - Apply trivial-input guard: skip if output is `null` or `NaN`, or
     if the method throws (matches JS behavior).
   - Compute `fingerprint(input, output)` using the same algorithm as
     `fingerprint.js`:
     `sha256(stableStringify(input) + "|" + stableStringify(output)) → base36 → first 7 chars`
   - Write `<id>.regret` in the standard format.

### Validate Flow

1. Read `regrets/manifest.json`, filter Java clusters.
2. For each cluster:
   - Read the existing `.regret` file, parse `INPUT`, `OUTPUT`, `HASH`.
   - Re-invoke the method with the parsed `INPUT`.
   - Recompute fingerprint.
   - Compare to golden `HASH` — report PASS or FAIL with diff.
3. Exit with non-zero status if ANY cluster fails or is missing its
   `.regret` file.

---

## Fingerprint — Cross-Stack Parity

The Java implementation MUST produce identical fingerprints to the JS/Python
implementations for the same (input, output) pair. Verified by
`proof/java/verify-parity.mjs`:

```
$ node proof/java/verify-parity.mjs
Comparing JS fingerprint() vs Java-produced HASH from .regret files:

✅ add            JS=13mxb0z  Java=13mxb0z
✅ fibonacci      JS=587q30m  Java=587q30m
✅ reverse        JS=1ky49hx  Java=1ky49hx
✅ parse-csv      JS=8xifg6f  Java=8xifg6f
✅ format-bytes   JS=4zbjvg6  Java=4zbjvg6
```

### stableStringify Parity Notes

- Object keys are sorted recursively ( TreeMap / `Collections.sort(keys)` ).
- Numbers: integers serialize as their decimal form; doubles that are
  whole-valued serialize as integers (matching JS `Number.toString()`);
  non-finite values produce sentinels `"__nan__"`, `"__infinity__"`,
  `"__neg_infinity__"` (matches `fingerprint.js` issue #322).
- Strings: standard JSON escaping (`\"`, `\\`, `\n`, etc.).
- Arrays: ordered, no sorting.
- Circular references: `"__circular__"` sentinel.

---

## `.regret` File Format (Identical to JS/Python)

```
cluster: add
version: 1
fingerprint: 13mxb0z
captured: 2026-06-20T17:41:21.689082371Z
watches: [add]
entry: add
stack: java
class: DemoMathUtils
fingerprintLevel: entry
multiArgs: True
---
INPUT  [2,3]
OUTPUT 5
HASH   13mxb0z
```

All mandatory fields from the user contract are present:
`cluster`, `version`, `fingerprint`, `captured`, `INPUT`, `OUTPUT`, `HASH`.

---

## Type Coercion (JSON → Java Parameters)

| JSON value | Java parameter type | Coercion |
|---|---|---|
| number (integer) | `int`, `long`, `Integer`, `Long`, `double`, `Double`, etc. | `Number.intValue()` / `longValue()` / `doubleValue()` etc. |
| number (decimal) | `double`, `Double`, `float`, `Float` | `Number.doubleValue()` |
| string | `String`, `Integer`, `Long`, `Double`, `Boolean` | `parseXxx(s)` |
| string (single char) | `char`, `Character` | `s.charAt(0)` |
| boolean | `boolean` / `Boolean` | direct |
| array | `T[]` (any primitive or object array) | `Array.newInstance(componentType, ...)` + element coercion |
| array | varargs (`T...`) | same as array |
| null | any | `null` (or NPE on primitive) |

If the method has fewer parameters than the input array provides, the
caller throws `IllegalArgumentException`. Varargs methods accept fewer
args (the trailing varargs array is padded with `null`).

---

## Running the Working Example

```bash
$ cd proof/java
$ bash ../../scripts/capture_java.sh

📡 Capturing Java cluster: add
   ✅ Fingerprint: 13mxb0z
   📄 Saved: regrets/add.regret
...
Captured: 5  Skipped: 0  Failed: 0

$ bash ../../scripts/validate_java.sh

🔍 Validating Java cluster: add
   ✅ PASS  (hash 13mxb0z)
...
Passed: 5  Failed: 0  Missing: 0
```

### Verifying PASS / FAIL behavior

The demo includes a `DemoMathUtils.fibonacci(int n)` function captured
with input `10` → output `55`. To verify the regression-detection
contract:

**Valid refactor (PASS):** replace the iterative `fibonacci` body with
Binet's closed-form formula. The output for `n=10` is still `55`, so
`regret validate` PASSes — the refactor preserves the contract.

**Breaking refactor (FAIL):** change `fibonacci` to be 1-indexed (so
`n=10` returns `89`). `regret validate` FAILs with:

```
❌ FAIL  golden=587q30m  live=4c2o9uu
Golden output: 55
Live   output: 89
```

Exit code is non-zero, suitable for CI gating.

---

## Pure Logic Extraction in Java

Same principle as other stacks — extract pure business logic from
methods that have side effects:

```java
// ❌ BEFORE — side effects, hard to fingerprint
public String processOrder(Order order) {
    saveToDatabase(order);              // side effect: DB
    sendEmail(order.getEmail());        // side effect: network
    return formatReceipt(order);
}

// ✅ AFTER — pure logic extracted
public String formatReceipt(Order order) {
    // pure function — deterministic for the same Order input
    return String.format("Order #%d: $%.2f", order.getId(), order.getTotal());
}

// Thin shell with side effects
public String processOrder(Order order) {
    saveToDatabase(order);
    sendEmail(order.getEmail());
    return formatReceipt(order);  // ← fingerprint this
}
```

### Rules for Java Pure Logic Extraction

1. **Never fingerprint methods that do I/O** — `System.out`, `Files.read`,
   `HttpClient.send`, JDBC calls go in the shell.
2. **Never fingerprint methods that use `System.currentTimeMillis()` or
   `Math.random()`** — pass time/randomness as parameters.
3. **Logic classes must have zero imports of**: `java.io`, `java.net`,
   `java.sql`, `java.nio.file`, or any I/O package.
4. **Logic methods take all data as parameters** — no static mutable
   state, no instance fields that hide state.
5. **For stateful computations** — return the full state as the output
   (e.g., a `Result` record), don't mutate the input.

---

## Limitations & Non-Goals (v1)

- **Instance methods** — only `public static` methods are supported in v1.
  This avoids the complexity of constructor argument passing and instance
  state management. Future versions can add `receiver` field like the Go
  stack.
- **Callee wrapping** — there is no Ghost Proxy equivalent in Java yet.
  The `watches` field is informational only; callee `.regret` files are
  NOT generated. Future work could use bytecode instrumentation
  (ASM/ByteBuddy) or source-level transformation (JavaParser).
- **Auto-discovery** — `regret install` does not yet detect Java methods.
  Manifest must be hand-written. Future work could integrate JavaParser
  to walk class files.
- **Multiple inputs** — v1 captures only the first input from `inputs[]`.
  The JS stack supports per-input `.regret` contracts (issue #315); this
  could be added to Java in a follow-up.
- **`regret update`** — not yet wired for Java. To refresh a golden
  contract, delete the `.regret` file and re-capture.

---

## CI Integration

`regret validate` exits non-zero on any failure. For GitHub Actions:

```yaml
- name: Build
  run: mvn package -DskipTests
- name: Capture regret contracts
  run: regret capture
- name: Validate after refactor
  run: regret validate
```

Or directly via the shell scripts:

```yaml
- name: Capture
  run: bash scripts/capture_java.sh
- name: Validate
  run: bash scripts/validate_java.sh
```

---

## Real-World Usage

For a real Java project, point the manifest at your production classes:

```json
{
  "clusters": [{
    "id": "normalize-phone",
    "stack": "java",
    "class": "com.example.PhoneUtils",
    "method": "normalize",
    "entry": "normalize",
    "inputs": ["+1 (555) 123-4567"],
    "classpath": "target/classes:lib/*"
  }]
}
```

The `classpath` field accepts the OS-specific path separator (`:` on
Unix, `;` on Windows). If omitted, RegretJava uses the system
classloader (so pass `-cp` to the `java` launcher itself if needed).

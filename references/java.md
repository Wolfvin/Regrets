# Java Stack Variant

Regression fingerprinting for Java projects using generated test files and `javac`/`java` capture.

## Status: Working (Community Preview)

Java stack support is **Working** — the full capture+validate pipeline is implemented and verified end-to-end against the fixture in `tests/fixtures/java/`. The fingerprint algorithm is IDENTICAL to the JS/Python implementations, so `.regret` files are stack-agnostic.

This is a Community Preview because:
- Callee wrapping (Phase 2) is not yet implemented — only entry-level fingerprinting
- Method resolution is via reflection, which works for `public` methods only
- Generic types are not specially handled (type erasure applies)
- Spring Boot / application framework integration is out of scope

---

## Quick Start

1. Add `"stack": "java"` clusters to `regrets/manifest.json` (see schema below)
2. Compile your Java sources to a `build/classes` directory
3. Run `bash scripts/capture_java.sh` to generate, compile, and run capture
4. Run `bash scripts/validate_java.sh` to validate
5. All `.regret` files use identical format to JS stack

---

## Why Java Is Different

Java's design creates unique challenges for the Ghost Proxy pattern used in JS/Python:

| Challenge | JS/Python Approach | Java Reality |
|-----------|-------------------|--------------|
| Function wrapping | Proxy / decorator | No runtime Proxy — must use reflection or code generation |
| Dynamic imports | `import()` / `importlib` | Java requires `Class.forName()` + reflection |
| Module loading | Any file at runtime | Must be on classpath at JVM startup |
| Test execution | `node script.js` | `javac` + `java` (or `mvn test` / `gradle test`) |

**Solution:** This stack generates a `RegretCaptureTest.java` file from the manifest, compiles it together with `RegretFingerprint.java`, and runs it via `java`. The generated test uses reflection to invoke target methods — no source-code modification required.

---

## Manifest Schema for Java Clusters

```json
{
  "clusters": [
    {
      "id": "java-square",
      "entry": "square",
      "watches": ["square"],
      "file": "src/com/example/MathUtils.java",
      "stack": "java",
      "className": "com.example.MathUtils",
      "classPath": "build/classes",
      "fingerprintLevel": "entry",
      "inputs": [5, 10, 0, -3, 100]
    },
    {
      "id": "java-formatter-format",
      "entry": "format",
      "watches": ["format"],
      "file": "src/com/example/Formatter.java",
      "stack": "java",
      "className": "com.example.Formatter",
      "classPath": "build/classes",
      "classMethod": "format",
      "constructor": "Formatter",
      "constructorArgs": [],
      "fingerprintLevel": "entry",
      "inputs": ["2025_05", "2024_01", "2026_12"]
    },
    {
      "id": "java-join-multiargs",
      "entry": "join",
      "watches": ["join"],
      "file": "src/com/example/MathUtils.java",
      "stack": "java",
      "className": "com.example.MathUtils",
      "classPath": "build/classes",
      "multiArgs": true,
      "inputs": [
        ["a", "b", "-"],
        ["hello", "world", " "]
      ]
    }
  ]
}
```

### Java-Specific Manifest Fields

| Field | Required | Description |
|-------|----------|-------------|
| `stack` | ✅ | Must be `"java"` |
| `className` | ✅ | Fully-qualified class name (e.g., `com.example.MathUtils`) |
| `classPath` | ❌ | Classpath root for the compiled `.class` files (default `"."`) |
| `entry` | ✅ | Method name to invoke (must be `public`) |
| `classMethod` | ❌ | Set to method name for **instance methods** (omitted for static methods) |
| `constructor` | ❌ | Constructor name for instance methods (default: class name) |
| `constructorArgs` | ❌ | Array of arguments for the constructor (default: `[]` = no-arg constructor) |
| `multiArgs` | ❌ | If `true`, each input is an array that becomes the method's argument list |

### Type Mapping

Java types map to JSON types as follows (for both inputs and outputs):

| JSON Type | Java Type (reflection) | Notes |
|-----------|------------------------|-------|
| `null` | `null` (no args) | Method must have 0 parameters |
| `boolean` | `boolean.class` | Primitive |
| `int` | `int.class` | Primitive (small ints, ±2^31) |
| `long` | `long.class` | Primitive (large ints, ±2^63) |
| `double` | `double.class` | Primitive (any float) |
| `string` | `String.class` | |
| `array` | `Object[]` | Each element follows its own mapping |
| `object` | `Map.class` | `LinkedHashMap` for output, `LinkedHashMap` for input |

**Output normalization:** Java arrays (`int[]`, `String[]`, etc.) are automatically converted to `List<Object>` for stable JSON serialization. This matches the JS implementation's `Array.from(typedArray)` behavior.

---

## Script Runner: `scripts/capture_java.sh`

```bash
# Capture all Java clusters in manifest
bash scripts/capture_java.sh

# Capture a specific cluster
bash scripts/capture_java.sh --cluster java-square

# Use a non-default manifest path
bash scripts/capture_java.sh --manifest ./regrets/manifest.json
```

### What the script does

1. **Read manifest** — filter clusters where `stack === "java"`
2. **Compile `RegretFingerprint.java`** — port of `fingerprint.js` to Java
3. **Generate `regrets/RegretCaptureTest.java`** — Java source file with a `main()` method that:
   - Loads each target class via `Class.forName(className)`
   - For instance methods, instantiates via declared constructor
   - For each input in `inputs[]`, invokes the method via reflection
   - Computes fingerprint via `RegretFingerprint.fingerprint(input, output)`
   - Uses the first input/output as the golden contract
   - Writes `regrets/<id>.regret` with the standard format
4. **Compile the generated test** — `javac -cp <build dir>:<classPath> ...`
5. **Run the test** — `java -cp <classpath> RegretCaptureTest`
6. **Cleanup** — remove `.class` files (keep `.java` source for inspection)

### JDK location

The script auto-detects `javac` on PATH. If not found, it falls back to:
- `/home/z/.jdk/jdk-21.0.11+10/bin/javac` (worker environment)
- `/usr/lib/jvm/java-21-openjdk-amd64/bin/javac` (Debian/Ubuntu)

To override, add `javac` to PATH before running the script.

---

## Script Runner: `scripts/validate_java.sh`

```bash
# Validate all Java clusters (1 run each)
bash scripts/validate_java.sh

# Validate a specific cluster
bash scripts/validate_java.sh --cluster java-square

# Drift detection — run each cluster N times and compare fingerprints
bash scripts/validate_java.sh --runs 5
```

### What the script does

1. **Read manifest** — filter Java clusters
2. **Verify all `.regret` files exist** — fail fast if any missing
3. **Compile `RegretFingerprint.java`** — same as capture
4. **Generate `regrets/RegretValidateTest.java`** — Java source file that:
   - Reads each `.regret` file
   - Parses `INPUT`, `OUTPUT`, `HASH` lines
   - Re-invokes the method via reflection with the parsed input
   - Computes the new fingerprint
   - Compares with stored `HASH`
   - Reports `PASS` / `FAIL` / `DRIFT` per cluster
5. **Compile and run** — same as capture

### Drift detection

When `--runs N` is provided, each cluster is invoked N times. If any run produces a different fingerprint, the cluster is marked `DRIFT`. This catches non-deterministic code (e.g., `System.currentTimeMillis()`, `Math.random()`, hash map iteration order).

---

## `scripts/RegretFingerprint.java`

The Java port of `scripts/fingerprint.js`. Key functions:

### `stableStringify(Object obj) → String`

Deterministic JSON serialization with sorted object keys. Mirrors `stableStringify()` in `fingerprint.js` exactly, including:

- `null` → `"null"`
- `Double.NaN` → `"\"__nan__\""` (issue #322)
- `Double.POSITIVE_INFINITY` → `"\"__infinity__\""`
- `Double.NEGATIVE_INFINITY` → `"\"__neg_infinity__\""`
- `String` → JSON-escaped with surrounding quotes
- `List` → `"[item0,item1,...]"`
- `Map` → `"{\"k0\":v0,...}"` with sorted keys
- Whole numbers stored as double (e.g., `1.0`) → `"1"` (matches JS `Number.toString()`)

### `fingerprint(Object input, Object output) → String`

7-char base36 fingerprint. IDENTICAL algorithm to `fingerprint.js`:

```
combined = stableStringify(input) + "|" + stableStringify(output)
hash = SHA-256(combined) as hex
num = BigInteger(hex, 16)
base36 = num.toString(36)
return base36.substring(0, 7)
```

### `buildRegretFile(...) → String`

Helper that constructs the full `.regret` file content from cluster metadata + input/output.

### `main(String[] args)`

Self-test — runs 6 cross-stack parity tests and prints results. To verify:

```bash
# From the Regrets repo root:
javac scripts/RegretFingerprint.java -d /tmp
java -cp /tmp RegretFingerprint

# Compare with JS:
node --input-type=module -e "
import { fingerprint } from './scripts/fingerprint.js'
console.log(fingerprint('hello', 'HELLO'))  // Should match Java Test 1
"
```

---

## Cross-Stack Parity Verification

The Java fingerprint algorithm is **byte-for-byte identical** to the JS implementation. Verified with the test suite in `tests/java-stack.test.js`:

| Test Case | JS Fingerprint | Java Fingerprint | Match? |
|-----------|----------------|------------------|--------|
| `fingerprint('hello', 'HELLO')` | `67q5v7m` | `67q5v7m` | ✅ |
| `fingerprint(5, 25)` | `2uf6a6s` | `2uf6a6s` | ✅ |
| `fingerprint({name:'Alice', age:30}, {greeting:'Hello, Alice!', ageNextYear:31})` | `3zc7h66` | `3zc7h66` | ✅ |
| `fingerprint(['a','b','c'], ['A','B','C'])` | `chd9nel` | `chd9nel` | ✅ |
| `fingerprint(null, 'default')` | `p6tj7pv` | `p6tj7pv` | ✅ |
| `fingerprint(0.0, NaN)` | `3hll0xo` | `3hll0xo` | ✅ |

This means a `.regret` file captured from a JS function can be **validated against a Java reimplementation** of the same function, as long as the input/output pairs are identical. This is the critical contract for cross-stack refactoring (e.g., porting a library from JS to Java).

---

## Example `.regret` Output

```
cluster: java-square
version: 1
fingerprint: 2uf6a6s
captured: 2026-06-20T17:44:20.594131690Z
watches: [square]
entry: square
stack: java
fingerprintLevel: entry
---
INPUT  5
OUTPUT 25
HASH   2uf6a6s
```

For Map output:

```
cluster: java-formatter-allformats
version: 1
fingerprint: 3xvs0e7
captured: 2026-06-20T17:44:20.628856205Z
watches: [allFormats]
entry: allFormats
stack: java
fingerprintLevel: entry
---
INPUT  "2025_05"
OUTPUT {"iso":"2025-05","mmyyyy":"052025"}
HASH   3xvs0e7
```

For multiArgs (each input is an array):

```
cluster: java-join-multiargs
version: 1
fingerprint: 40e88au
captured: 2026-06-20T17:44:20.620434368Z
watches: [join]
entry: join
stack: java
fingerprintLevel: entry
---
INPUT  ["a","b","-"]
OUTPUT "a-b"
HASH   40e88au
```

---

## Pure Function Extraction in Java

Java's static typing makes pure-function identification easy. Follow these principles:

### Pattern: Extract Logic from `class` Blocks

```java
// ❌ BEFORE — mixed concerns, hard to fingerprint
public class InvoiceProcessor {
    private final HttpClient client;

    public ProcessedInvoice process(RawInvoice data) throws IOException {
        // Pure calculation
        long total = calculateTotal(data.getItems());
        long tax = applyTax(total, data.getTaxRate());

        // Side effect: write to file
        String output = formatInvoiceOutput(data.getId(), total, tax);
        Files.write(Path.of("/tmp/invoice.txt"), output.getBytes());

        // Side effect: HTTP call
        client.send("/api/invoices", output);

        return new ProcessedInvoice(total, tax);
    }
}

// ✅ AFTER — pure logic extracted to a separate class
// src/main/java/com/example/invoice/ProcessorLogic.java
public final class ProcessorLogic {
    private ProcessorLogic() {}  // no instances

    public static long calculateTotal(List<Item> items) {
        return items.stream().mapToLong(Item::getAmount).sum();
    }

    public static long applyTax(long amount, double rate) {
        return (long) (amount * (1.0 + rate));
    }

    public static String formatInvoiceOutput(String id, long total, long tax) {
        return String.format("%s|%d|%d", id, total, tax);
    }
}

// src/main/java/com/example/invoice/InvoiceProcessor.java — thin shell with side effects
public class InvoiceProcessor {
    private final HttpClient client;

    public ProcessedInvoice process(RawInvoice data) throws IOException {
        long total = ProcessorLogic.calculateTotal(data.getItems());
        long tax = ProcessorLogic.applyTax(total, data.getTaxRate());
        String output = ProcessorLogic.formatInvoiceOutput(data.getId(), total, tax);

        Files.write(Path.of("/tmp/invoice.txt"), output.getBytes());
        client.send("/api/invoices", output);

        return new ProcessedInvoice(total, tax);
    }
}
```

### Fingerprint the Logic Class

```json
{
  "id": "java-calculate-total",
  "entry": "calculateTotal",
  "watches": ["calculateTotal"],
  "file": "src/main/java/com/example/invoice/ProcessorLogic.java",
  "stack": "java",
  "className": "com.example.invoice.ProcessorLogic",
  "classPath": "build/classes/java/main",
  "inputs": [
    [{"amount": 100000}, {"amount": 250000}],
    [{"amount": 0}]
  ]
}
```

### Rules for Java Pure Logic Extraction

1. **Never fingerprint methods that do I/O** — `Files.*`, HTTP calls, DB queries go in the shell, not logic
2. **Never fingerprint `async`/`CompletableFuture` methods directly** — extract the synchronous computation, fingerprint that
3. **Logic classes must have zero `import` of**: `java.io.*`, `java.net.*`, `java.sql.*`, `java.http.*`, or any I/O library
4. **Logic methods take all data as parameters** — no `this` that hides state, no static mutable fields
5. **If a method needs `System.currentTimeMillis()`** — accept `long now` as a parameter instead, let the shell pass `System.currentTimeMillis()`

---

## Normalization: Java-Specific Patterns

| Non-Deterministic Source | Java Pattern | Regrets Normalize Rule | Replacement |
|--------------------------|-------------|------------------------|-------------|
| Current time | `System.currentTimeMillis()` | `"timestamps"` (via manifest) | `<TIMESTAMP>` |
| Random | `Math.random()`, `ThreadLocalRandom` | `"ignoreFields"` on that key | — |
| File paths | `Path.of("/abs/path")` | `"absPaths"` | `<ROOT>/...` |
| Hash map iteration | `HashMap` (unordered) | Use `LinkedHashMap` in source | (no normalization needed) |
| Object identity | `System.identityHashCode()` | `"ignoreFields"` on that key | — |

> **Note:** The current `RegretFingerprint.java` does NOT implement the full normalize ruleset (timestamps, uuids, absPaths, dynamicDates, etc.) that exists in `fingerprint.js`. Only the core `stableStringify` + `fingerprint` functions are ported. To use normalize rules with Java, the cluster must omit `normalize: [...]` from the manifest, OR the user must extend `RegretFingerprint.java` to implement the rules. This is a known gap documented in issue tracking.

---

## Known Limitations (Out of Scope for PR #1)

1. **Callee wrapping (Phase 2)** — not implemented. Only entry-level fingerprinting is supported. A future PR could add `cluster.calls.<callee>.regret` files following the JS pattern.
2. **`normalize` rules** — `RegretFingerprint.java` does not implement the normalize ruleset. Pass `normalize: []` (or omit) in the manifest for Java clusters.
3. **Private methods** — reflection requires `setAccessible(true)`, which works for private methods on most JVMs but may fail under strict module boundaries (JPMS). Public methods are the supported target.
4. **Generic types** — type erasure means `List<String>` and `List<Integer>` both serialize as `List`. This is usually fine for fingerprinting (the values differ), but be aware.
5. **Overloaded methods** — `getDeclaredMethod(name, paramTypes)` requires exact parameter types. If your class has overloads, the manifest input types must match the intended overload exactly.
6. **Maven/Gradle integration** — the script uses `javac`/`java` directly. For Maven projects, run `mvn compile` first to populate `target/classes`, then point `classPath` there. Same for Gradle (`build/classes/java/main`).

---

## Running the Fixture

The fixture at `tests/fixtures/java/` provides a complete working example:

```bash
# Compile the fixture
cd tests/fixtures/java
javac -d build/classes src/com/example/MathUtils.java src/com/example/Formatter.java

# Capture all 9 clusters
bash ../../scripts/capture_java.sh
# → writes 9 .regret files in regrets/

# Validate
bash ../../scripts/validate_java.sh
# → 9 passed, 0 failed, 0 drift

# Mutate the source (introduce a bug)
sed -i 's|return n \* n;|return n * n * n;|' src/com/example/MathUtils.java
javac -d build/classes src/com/example/MathUtils.java

# Validate again — should FAIL
bash ../../scripts/validate_java.sh --cluster java-square
# → 0 passed, 1 failed, 0 drift
# → FAIL — fingerprint mismatch
#      expected: 2uf6a6s
#      actual:   5dhm8ib
```

---

## CLI Integration

Once `stack: "java"` appears in the manifest, the unified CLI dispatches automatically:

```bash
# Capture all stacks (including Java) in manifest
regret capture

# Validate all stacks
regret validate

# Drift detection (5 runs per cluster)
regret drift

# Update a specific cluster's contract
regret update java-square --reason "method behavior intentionally changed"
```

The `regret.js` dispatcher routes Java clusters to:
- `capture` → `bash scripts/capture_java.sh`
- `validate`, `drift`, `update`, `truth`, `ci`, `guard` → `bash scripts/validate_java.sh` (with appropriate flags)

---

## CI Integration

Add to `.github/workflows/regret-validate.yml`:

```yaml
jobs:
  regret-validate:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-java@v4
        with:
          distribution: 'temurin'
          java-version: '21'
      - uses: actions/setup-node@v4
        with:
          node-version: '20'
      - run: npm install
      - run: npm run build  # if your project has a build step
      - name: Regret validate
        run: node scripts/regret.js validate --fail-fast
```

The validator exits 0 if all clusters PASS, 1 if any FAIL or DRIFT.

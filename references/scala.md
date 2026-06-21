# Scala Stack Guide

Regression fingerprinting for Scala projects (JVM) using `scala-cli` as the build/runtime.

Scala is a natural fit for Regrets: pure functions, immutable case classes, referential transparency, and ADTs are the dominant idioms — all of which fingerprint cleanly.

---

## Quick Start

1. Install [scala-cli](https://scala-cli.virtuslab.org/install) (bundles Scala 3 + JVM compiler)
2. Write your pure function as a top-level `object` method
3. Add a cluster with `stack: "scala"` to `regrets/manifest.json`
4. Run `bash scripts/capture_scala.sh` to capture fingerprints
5. Run `bash scripts/capture_scala.sh validate` to validate

---

## Why Scala Needs Regression Testing

Scala is used heavily in:

- **Data engineering** (Apache Spark, Flink pipelines) — refactor a UDF and silently change partition output
- **Backend services** (Akka/Pekko, http4s, Tapir) — change a JSON codec and break API responses
- **DSLs and schema libraries** (Avro, Protobuf, Circe schemas) — schema drift across versions
- **Financial/math libraries** — refactoring `BigDecimal` math can change rounding behavior

All four are exactly the class of refactor that Regrets catches: input → output contract preserved?

---

## Manifest for Scala Clusters

Scala clusters use `"stack": "scala"` and require two additional fields:

```json
{
  "clusters": [
    {
      "id": "slugify",
      "entry": "slugify",
      "object": "Slugify",
      "watches": ["slugify"],
      "file": "Slugify.scala",
      "stack": "scala",
      "fingerprintLevel": "entry",
      "description": "Pure slugify function",
      "inputs": [
        "Hello, World!",
        "  multiple   spaces  ",
        ""
      ]
    }
  ]
}
```

### Scala-Specific Manifest Fields

| Field | Required | Description |
|-------|----------|-------------|
| `stack` | ✅ | Must be `"scala"` |
| `object` | ✅ | Name of the Scala `object` (companion object) that contains the entry method |
| `entry` | ✅ | Method name on the object. Method signature must be `def <entry>(args: Array[Object]): Any` |
| `file` | ✅ | Path to the `.scala` source file (relative to project root) |
| `watches` | ❌ | Array of method names to watch (informational only — callee wrapping is Phase 2) |
| `multiArgs` | ❌ | If `true`, spread an array input as positional args (`args(0)`, `args(1)`, …). Default: `false` (single positional arg in `args(0)`) |
| `fingerprintLevel` | ❌ | `"entry"` (default) or `"schema"` |
| `normalize` | ❌ | Normalization rules — see "Normalization" below |
| `ignoreFields` | ❌ | Fields to exclude from fingerprint |

---

## The Entry Method Contract

The harness uses **reflection** to call your function. The entry method signature MUST be:

```scala
object MyObject:
  def myEntry(args: Array[Object]): Any =
    // args(0) is your input (boxed Java object: String, java.lang.Long, etc.)
    // Return Any — the harness re-serializes to JSON for fingerprinting.
    ???
```

This signature is awkward, but it's the price of reflection-based dispatch without codegen. The pattern is:

```scala
object Slugify:
  def slugify(args: Array[Object]): Any =
    require(args.length >= 1, "slugify requires at least 1 argument")
    val input = args(0) match
      case s: String => s
      case other     => other.toString
    slugifyString(input)  // delegate to pure impl

  def slugifyString(input: String): String =
    // The actual pure function — easy to read, easy to refactor
    ???
```

The thin `slugify(args)` wrapper is the entry; `slugifyString(input)` is what you'd refactor. Refactors to `slugifyString` preserve the fingerprint; behavior changes fail validation.

---

## multiArgs: true

If your function takes multiple positional arguments, set `"multiArgs": true`:

```json
{
  "id": "format-period",
  "entry": "formatPeriod",
  "object": "Formatter",
  "file": "Formatter.scala",
  "stack": "scala",
  "multiArgs": true,
  "inputs": [
    ["2025_05", "MMYYYY"],
    ["2024_01", "YYYY-MM"]
  ]
}
```

```scala
object Formatter:
  def formatPeriod(args: Array[Object]): Any =
    val period = args(0).asInstanceOf[String]
    val format = args(1).asInstanceOf[String]
    formatPeriodString(period, format)

  def formatPeriodString(period: String, format: String): String =
    ???
```

---

## Case Class Input/Output

Scala case classes serialize to/from JSON naturally:

```scala
case class Invoice(amount: Long, currency: String)

object InvoiceProcessor:
  def process(args: Array[Object]): Any =
    val json = args(0).asInstanceOf[String]
    // Parse JSON → case class → process → return case class
    val invoice = parseJson[Invoice](json)
    processInvoice(invoice)  // returns ProcessedInvoice case class
```

The harness serializes the returned case class via `Product.productElementNames` + `Product.productIterator` — keys are field names, values are field values. Nested case classes work recursively.

---

## Cross-Stack Fingerprint Parity

The Scala fingerprint algorithm in `scripts/scala/regret_fingerprint.scala` is **byte-identical** to:

- `scripts/fingerprint.js` (JS/TS/CSS)
- `scripts/fingerprint.py` (Python)
- `scripts/fingerprint_php.php` (PHP)

The algorithm: `sha256(stableStringify(input) + "|" + stableStringify(output))` → hex → BigInt → base36 → first 7 chars.

`stableStringify` in Scala:
- Sorts object keys recursively (lexicographic by UTF-16 code unit — matches JS)
- Emits `null` for null
- Emits `"__nan__"` for NaN, `"__infinity__"` for +∞, `"__neg_infinity__"` for −∞ (matches JS #322 fix)
- Numbers: integers as plain `123`, doubles as JSON-style (no trailing `.0`)

Verified by `proof/scala_slugify/parity_check.mjs` — runs the JS fingerprint on every input/output pair captured by Scala and asserts byte-equality.

---

## Normalization

Same rule names as JS stack:

```json
{
  "normalize": ["timestamps", "uuids", "absPaths", "dynamicDates"]
}
```

Normalization rules are NOT yet implemented in the Scala harness (Phase 1 ships without them). If your function returns timestamps or UUIDs, you must normalize them yourself inside the entry function before returning.

---

## Script Runner: `scripts/capture_scala.sh`

```bash
# Capture all Scala clusters
bash scripts/capture_scala.sh capture

# Validate all Scala clusters
bash scripts/capture_scala.sh validate

# Operate on one cluster
bash scripts/capture_scala.sh --cluster slugify

# Stop on first failure
bash scripts/capture_scala.sh validate --fail-fast
```

Internals:
1. Reads `regrets/manifest.json`, filters `stack: "scala"`
2. For each cluster: copies the user's `.scala` source + harness into a temp dir
3. Runs `scala-cli run` with both source dirs — they compile as a single project
4. The harness (`regret_harness.scala`) reflects on the user's `object`, calls `<object>.<entry>(input)`, computes the fingerprint, and writes/validates the `.regret` file

The `.regret` file format is identical to JS:

```
cluster: slugify
version: 1
fingerprints: 615ytfn,2gaag5y,47iw4ku,2r8ubcm,1hgst4y,5oge4st
captured: 2026-06-21T04:57:03.972564825Z
watches: [slugify]
entry: slugify
stack: scala
fingerprintLevel: entry
object: Slugify
---
INPUT  "Hello, World!"
OUTPUT "hello-world"
HASH   615ytfn
INPUT  "Hello, World! This is a TEST."
OUTPUT "hello-world-this-is-a-test"
HASH   2gaag5y
...
```

---

## `regret` CLI Integration

The main `regret` CLI (in `scripts/regret.js`) dispatches Scala clusters automatically:

```bash
regret capture      # captures ALL stacks in manifest, including scala
regret validate     # validates ALL stacks
regret update <id> --reason "..."  # updates one cluster (any stack)
regret validate --cluster <id>     # validates one cluster
```

The dispatch logic lives in `scripts/regret.js`:

```js
} else if (stack === 'scala') {
  success = await run('bash', [`${SCRIPTS_DIR}/capture_scala.sh`, 'capture', ...passThroughArgs]) && success
}
```

---

## Pattern: Pure Function Extraction

Scala's `Future`, `IO`, `Task` (Monix), and `ZIO` types are inherently side-effectful — do not fingerprint them directly. Extract the pure computation:

```scala
// ❌ BEFORE — has side effects (DB call), not pure
class InvoiceProcessor(db: Database):
  def process(invoice: Invoice): Future[ProcessedInvoice] =
    for
      total <- Future(computeTotal(invoice.items))  // pure
      _     <- db.save(invoice.copy(total = total)) // side effect
    yield ProcessedInvoice(invoice.id, total)

// ✅ AFTER — extract pure function, fingerprint THAT
object InvoiceLogic:
  def process(args: Array[Object]): Any =
    val invoice = args(0).asInstanceOf[Invoice]
    ProcessedInvoice(invoice.id, computeTotal(invoice.items))

  def computeTotal(items: List[LineItem]): Long =
    items.map(_.amount).sum
```

Then fingerprint `InvoiceLogic.process`:

```json
{
  "id": "invoice-process",
  "entry": "process",
  "object": "InvoiceLogic",
  "file": "InvoiceLogic.scala",
  "stack": "scala",
  "inputs": [
    { "id": "inv-001", "items": [{ "amount": 1000 }, { "amount": 2500 }] }
  ]
}
```

### Rules for Scala Pure Logic Extraction

1. **Never fingerprint functions that return `Future`/`IO`/`Task`/`ZIO`** — extract the synchronous computation
2. **`_logic.scala` modules must have zero `import`s of**: `scala.concurrent`, `cats.effect`, `zio`, `doobie`, `slick`, or any I/O library
3. **Logic functions take all data as parameters** — no `this` that hides state, no global `Ref`s
4. **If a function needs the current time** — accept `now: Long` as a parameter, let the caller pass `System.currentTimeMillis()`
5. **Random sources** — accept `seed: Long` and use `scala.util.Random(seed)` internally

---

## Real-World Use Cases

### Pattern A: Spark UDF

```scala
object SlugifyUdf:
  def slugify(args: Array[Object]): Any =
    val s = args(0).asInstanceOf[String]
    s.toLowerCase.replaceAll("[^a-z0-9]+", "-").stripSuffix("-")
```

Register it in Spark AND fingerprint it via Regrets — refactor the UDF, Regrets catches any output drift before deploy.

### Pattern B: JSON Codec

```scala
import io.circe._, io.circe.generic.semiauto._

case class User(id: Long, name: String, email: String)

object UserCodec:
  def encode(args: Array[Object]): Any =
    val user = args(0).asInstanceOf[User]
    Encoder[User].apply(user).noSpaces  // pure: same input → same JSON string
```

Fingerprint the codec output to detect schema drift across library upgrades.

### Pattern C: Schema Migration

```scala
object MigrationV1ToV2:
  def migrate(args: Array[Object]): Any =
    val v1Json = args(0).asInstanceOf[String]
    val v1 = parseV1(v1Json)
    val v2 = V2Schema(v1.id, v1.email.toLowerCase, v1.createdAt)
    v2
```

Fingerprint migrations to detect silent schema changes when refactoring.

---

## Limitations (Phase 1)

The following are out of scope for this PR and will be addressed in follow-ups:

- **Callee wrapping** — no `.calls.<callee>.regret` files yet (Phase 2 enhancement)
- **Normalization rules** — `normalize: ["timestamps", "uuids", ...]` not yet implemented in Scala harness; normalize inputs/outputs yourself inside the entry function
- **Async functions** — must extract sync computation (see Pure Function Extraction above)
- **Trait dynamic dispatch** — fingerprint the concrete impl, not the trait method
- **Macro expansion** — fingerprint post-expansion output (compile your code, then fingerprint the compiled classpath)

---

## Full Workflow Example

See `proof/scala_slugify/run_demo.sh` for a complete walkthrough:

```bash
cd proof/scala_slugify
bash run_demo.sh
```

The demo:
1. Captures fingerprints for the `Slugify.slugify` function
2. Validates (PASS for clean code)
3. Verifies cross-stack parity with JS
4. Breaks the function (prefix output with `_`)
5. Validates (FAIL with exit 1)
6. Restores the function
7. Validates (PASS again)

Output ends with `✅ End-to-End Demo PASSED`.

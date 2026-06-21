// regret_harness.scala — capture/validate driver for Scala clusters.
//
// Invoked by scripts/capture_scala.sh and scripts/validate_scala.sh.
// Reads cluster config + inputs, calls the user's function, computes
// fingerprint, writes (or compares) a .regret file.
//
// Usage:
//   scala-cli run scripts/scala -- \
//     --mode capture|validate \
//     --cluster <id> \
//     --object <ObjectName> \
//     --entry <methodName> \
//     --inputs <json-array> \
//     --regret-file <path> \
//     --source-file <path-to-scala> \
//     [--multi-args]
//
// The user's Scala source is compiled & loaded via scala-cli's `--extra-scala`
// mechanism (we use an in-process ClassLoader via scala-cli's `compile` API).
// For simplicity in this first iteration, we invoke the function via
// reflection on a compiled class loaded from a user-provided .class file
// path OR — the simpler path — we compile the user's source into a temporary
// class directory, load it, and reflect.
//
// To keep this PR self-contained, we use scala-cli's scripting feature:
//   scala-cli run scripts/scala --extra-source <user-source> -- <args>
// But scala-cli doesn't expose --extra-source as a flag. Instead we
// pre-process: the runner shell copies the user source into a temp
// directory alongside the harness, and scala-cli compiles them together.

package regrets

import scala.io.Source
import java.io.{File, PrintWriter, FileInputStream}
import java.time.{Instant, ZoneOffset}
import java.time.format.DateTimeFormatter

object RegretHarness:

  def main(args: Array[String]): Unit =
    val opts = parseArgs(args)
    opts.mode match
      case "capture"  => runCapture(opts)
      case "validate" => runValidate(opts)
      case other =>
        System.err.println(s"Unknown mode: $other")
        sys.exit(2)

  // ─── Options ────────────────────────────────────────────────────────────

  case class Options(
    mode: String = "capture",
    cluster: String = "",
    objName: String = "",
    entry: String = "",
    inputsJson: String = "[]",
    regretFile: String = "",
    sourceFile: String = "",
    multiArgs: Boolean = false,
    fingerprintLevel: String = "entry",
    watches: String = "",
  )

  def parseArgs(args: Array[String]): Options =
    var o = Options()
    var i = 0
    while i < args.length do
      args(i) match
        case "--mode"             => o = o.copy(mode = args(i + 1)); i += 2
        case "--cluster"          => o = o.copy(cluster = args(i + 1)); i += 2
        case "--object"           => o = o.copy(objName = args(i + 1)); i += 2
        case "--entry"            => o = o.copy(entry = args(i + 1)); i += 2
        case "--inputs"           => o = o.copy(inputsJson = args(i + 1)); i += 2
        case "--regret-file"      => o = o.copy(regretFile = args(i + 1)); i += 2
        case "--source-file"      => o = o.copy(sourceFile = args(i + 1)); i += 2
        case "--multi-args"       => o = o.copy(multiArgs = true); i += 1
        case "--fingerprint-level" => o = o.copy(fingerprintLevel = args(i + 1)); i += 2
        case "--watches"          => o = o.copy(watches = args(i + 1)); i += 2
        case other =>
          System.err.println(s"Unknown arg: $other")
          sys.exit(2)
    o

  // ─── Capture ────────────────────────────────────────────────────────────

  def runCapture(opts: Options): Unit =
    val inputs = Json.parse(opts.inputsJson) match
      case Json.Arr(items) => items
      case other => throw new RuntimeException(s"--inputs must be a JSON array, got $other")

    val results = inputs.map { in =>
      val out = invokeUserFn(opts, in)
      (in, out, Fingerprint(in, out))
    }

    // Write .regret file
    val regret = buildRegretContent(opts, results)
    val pw = new PrintWriter(new File(opts.regretFile))
    try pw.write(regret) finally pw.close()

    // Emit a single-line JSON summary for the runner to parse
    println("REGRET_RESULT_JSON " + ujsonWrite(results.map { case (in, out, fp) =>
      Map(
        "input" -> in,
        "output" -> out,
        "fingerprint" -> fp,
      )
    }))

  // ─── Validate ───────────────────────────────────────────────────────────

  def runValidate(opts: Options): Unit =
    // Re-invoke and compare against existing .regret file
    val existing = parseRegretFile(opts.regretFile)
    val expectedHashes = existing.hashes
    val inputs = existing.inputs

    if (inputs.length != expectedHashes.length)
      System.err.println(s"FAIL: input count mismatch (${inputs.length} vs ${expectedHashes.length})")
      sys.exit(1)

    var failures = 0
    val results = inputs.zip(expectedHashes).map { case (in, expectedHash) =>
      val out = invokeUserFn(opts, in)
      val actualHash = Fingerprint(in, out)
      val ok = actualHash == expectedHash
      if (!ok) failures += 1
      (in, out, actualHash, expectedHash, ok)
    }

    if (failures == 0)
      println(s"PASS  cluster=${opts.cluster}  all=${results.length}")
      println("REGRET_VALIDATE_JSON " + ujsonWrite(Map(
        "pass" -> true,
        "cluster" -> opts.cluster,
        "results" -> results.map { case (in, out, ah, eh, ok) =>
          Map(
            "input" -> in,
            "output" -> out,
            "actualHash" -> ah,
            "expectedHash" -> eh,
            "ok" -> ok,
          )
        }
      )))
    else
      println(s"FAIL  cluster=${opts.cluster}  failures=$failures/${results.length}")
      results.filter(!_._5).foreach { case (in, out, ah, eh, _) =>
        System.err.println(s"  input=$in  output=$out  expected=$eh  actual=$ah")
      }
      println("REGRET_VALIDATE_JSON " + ujsonWrite(Map(
        "pass" -> false,
        "cluster" -> opts.cluster,
        "failures" -> failures,
        "results" -> results.map { case (in, out, ah, eh, ok) =>
          Map(
            "input" -> in,
            "output" -> out,
            "actualHash" -> ah,
            "expectedHash" -> eh,
            "ok" -> ok,
          )
        }
      )))
      sys.exit(1)

  // ─── User function invocation ───────────────────────────────────────────
  //
  // We use scala-cli's `--jar` mechanism by compiling the user source into
  // a temp jar via scala-cli compile, then adding it to the classpath.
  //
  // BUT for simplicity in v1, we instead expect the runner to have pre-compiled
  // the user source and provide --source-class-dir. We then load via URLClassLoader.
  //
  // To keep things truly self-contained (no extra step), the runner actually
  // invokes `scala-cli run` with the user's source file PLUS the harness source
  // in a single command — see capture_scala.sh. When invoked this way, the
  // user's `object` is on the same classpath as the harness and we can call
  // it via reflection.

  def invokeUserFn(opts: Options, input: Json): Json =
    val clazz = Class.forName(opts.objName)
    val method = clazz.getMethod(opts.entry, classOf[Array[Object]])
    val argsArray: Array[Object] = opts match
      case _ if opts.multiArgs =>
        // Spread input array as positional args
        input match
          case Json.Arr(items) => items.map(jsonToScala)
          case other           => Array(jsonToScala(other))
      case _ =>
        // Single arg — pass the input as-is
        Array(jsonToScala(input))
    val raw = method.invoke(null, argsArray)
    scalaToJson(raw)

  // ─── JSON ↔ Scala conversions (best-effort) ─────────────────────────────

  def jsonToScala(j: Json): Object = j match
    case Json.Null          => null
    case Json.Bool(b)       => java.lang.Boolean.valueOf(b)
    case Json.IntNum(n)     => java.lang.Long.valueOf(n)
    case Json.DoubleNum(d)  => java.lang.Double.valueOf(d)
    case Json.Str(s)        => s
    case Json.Arr(items)    => items.map(jsonToScala)
    case Json.Obj(entries)  =>
      val m = new java.util.LinkedHashMap[String, Object]()
      for (k, v) <- entries do m.put(k, jsonToScala(v))
      m

  def scalaToJson(a: Any): Json = a match
    case null                  => Json.Null
    case b: Boolean            => Json.Bool(b)
    case b: java.lang.Boolean  => Json.Bool(b.booleanValue())
    case b: Byte               => Json.IntNum(b.toLong)
    case s: Short              => Json.IntNum(s.toLong)
    case i: Int                => Json.IntNum(i.toLong)
    case l: Long               => Json.IntNum(l)
    case f: Float              => Json.DoubleNum(f.toDouble)
    case d: Double             => Json.DoubleNum(d)
    case s: String             => Json.Str(s)
    case arr: Array[?]         => Json.Arr(arr.map(scalaToJson))
    case seq: Seq[?]           => Json.Arr(seq.map(scalaToJson).toArray)
    case m: Map[?, ?]          =>
      Json.Obj(m.toArray.map { case (k, v) => (k.toString, scalaToJson(v)) })
    case p: Product            =>
      val names = p.productElementNames.toArray
      val vals  = p.productIterator.toArray
      Json.Obj(names.zip(vals).map { case (n, v) => (n, scalaToJson(v)) })
    case other                 => Json.Str(other.toString)

  // ─── .regret file format ────────────────────────────────────────────────
  //
  // Must be byte-compatible with the JS stack. Reference format:
  //
  // cluster: <id>
  // version: 1
  // fingerprint: <fp1>
  // captured: 2026-06-13T15:42:12.258636+00:00
  // watches: [fn1, fn2]
  // entry: <entry>
  // stack: scala
  // fingerprintLevel: entry
  // object: <ObjectName>
  // ---
  // INPUT  <input1>
  // OUTPUT <output1>
  // HASH   <fp1>
  // INPUT  <input2>
  // OUTPUT <output2>
  // HASH   <fp2>
  // ...
  //
  // For single-input clusters, we emit the INPUT/OUTPUT/HASH block once.
  // For multi-input clusters, we emit INPUTS header line followed by N blocks.
  // (Mirrors the JS #315 INPUTS feature.)

  case class RegretFile(
    cluster: String,
    version: Int,
    fingerprints: Array[String],
    captured: String,
    watches: Array[String],
    entry: String,
    stack: String,
    fingerprintLevel: String,
    objName: String,
    inputs: Array[Json],
    outputs: Array[Json],
    hashes: Array[String],
  )

  def buildRegretContent(opts: Options, results: Array[(Json, Json, String)]): String =
    val now = DateTimeFormatter.ISO_INSTANT.format(Instant.now().atZone(ZoneOffset.UTC))
    val sb = new StringBuilder
    sb.append(s"cluster: ${opts.cluster}\n")
    sb.append("version: 1\n")
    // For single-input: emit single fingerprint line.
    // For multi-input: emit fingerprints joined with comma (matches JS INPUTS feature).
    if (results.length == 1)
      sb.append(s"fingerprint: ${results(0)._3}\n")
    else
      sb.append(s"fingerprints: ${results.map(_._3).mkString(",")}\n")
    sb.append(s"captured: $now\n")
    sb.append(s"watches: [${if (opts.watches.isEmpty) opts.entry else opts.watches}]\n")
    sb.append(s"entry: ${opts.entry}\n")
    sb.append("stack: scala\n")
    sb.append(s"fingerprintLevel: ${opts.fingerprintLevel}\n")
    sb.append(s"object: ${opts.objName}\n")
    sb.append("---\n")
    for (in, out, fp) <- results do
      sb.append("INPUT  ").append(compactJson(in)).append("\n")
      sb.append("OUTPUT ").append(compactJson(out)).append("\n")
      sb.append(s"HASH   $fp\n")
    sb.toString

  /** Compact JSON literal for INPUT/OUTPUT lines (no spaces, matches JS JSON.stringify default). */
  def compactJson(j: Json): String =
    val sb = new StringBuilder
    compactRender(j, sb)
    sb.toString

  private def compactRender(v: Json, sb: StringBuilder): Unit = v match
    case Json.Null          => sb.append("null")
    case Json.Bool(true)    => sb.append("true")
    case Json.Bool(false)   => sb.append("false")
    case Json.IntNum(n)     => sb.append(n.toString)
    case Json.DoubleNum(d)  =>
      if (java.lang.Double.isNaN(d))        sb.append("\"__nan__\"")
      else if (d == Double.PositiveInfinity) sb.append("\"__infinity__\"")
      else if (d == Double.NegativeInfinity) sb.append("\"__neg_infinity__\"")
      else sb.append(d.toString)
    case Json.Str(s)        =>
      sb.append('"')
      for c <- s do c match
        case '"'  => sb.append("\\\"")
        case '\\' => sb.append("\\\\")
        case '\n' => sb.append("\\n")
        case '\r' => sb.append("\\r")
        case '\t' => sb.append("\\t")
        case '\b' => sb.append("\\b")
        case '\f' => sb.append("\\f")
        case _ =>
          if (c < 0x20) sb.append("\\u").append(f"${c.toInt}%04x")
          else sb.append(c)
      sb.append('"')
    case Json.Arr(items)    =>
      sb.append('[')
      var first = true
      for it <- items do
        if (!first) sb.append(',')
        first = false
        compactRender(it, sb)
      sb.append(']')
    case Json.Obj(entries)  =>
      // Compact JSON: sort keys to match JS JSON.stringify with sorted keys (Regrets convention)
      val sorted = entries.sortBy(_._1)
      sb.append('{')
      var first = true
      for (k, v) <- sorted do
        if (!first) sb.append(',')
        first = false
        sb.append('"').append(escapeKey(k)).append("\":")
        compactRender(v, sb)
      sb.append('}')

  private def escapeKey(s: String): String =
    val sb = new StringBuilder
    for c <- s do c match
      case '"'  => sb.append("\\\"")
      case '\\' => sb.append("\\\\")
      case '\n' => sb.append("\\n")
      case '\r' => sb.append("\\r")
      case '\t' => sb.append("\\t")
      case _ =>
        if (c < 0x20) sb.append("\\u").append(f"${c.toInt}%04x")
        else sb.append(c)
    sb.toString

  def parseRegretFile(path: String): RegretFile =
    val src = scala.io.Source.fromFile(path)
    try
      val text = src.mkString
      val (header, body) = text.split("---\n", 2) match
        case Array(h, b) => (h, b)
        case _ => throw new RuntimeException(s"Malformed .regret file: $path")
      val headerMap = header.linesIterator.flatMap { line =>
        if (line.isBlank) None
        else
          val idx = line.indexOf(':')
          if (idx < 0) None
          else Some((line.substring(0, idx).trim, line.substring(idx + 1).trim))
      }.toMap

      // Parse INPUT/OUTPUT/HASH triples from body
      val lines = body.linesIterator.toArray
      val inputs  = scala.collection.mutable.ArrayBuffer[Json]()
      val outputs = scala.collection.mutable.ArrayBuffer[Json]()
      val hashes  = scala.collection.mutable.ArrayBuffer[String]()
      var i = 0
      while (i + 2 < lines.length) do
        val inLine  = lines(i).stripPrefix("INPUT  ").stripPrefix("INPUT ").trim
        val outLine = lines(i + 1).stripPrefix("OUTPUT ").stripPrefix("OUTPUT  ").trim
        val hashLine = lines(i + 2).stripPrefix("HASH   ").stripPrefix("HASH ").trim
        if (lines(i).startsWith("INPUT") && lines(i + 1).startsWith("OUTPUT") && lines(i + 2).startsWith("HASH"))
          inputs  += Json.parse(inLine)
          outputs += Json.parse(outLine)
          hashes  += hashLine
          i += 3
        else
          i += 1

      // Single-input clusters store fingerprint in "fingerprint" header field.
      // Multi-input clusters store them in "fingerprints" header (comma-separated).
      val fingerprints = headerMap.getOrElse("fingerprint",
        headerMap.getOrElse("fingerprints", "")).split(',').map(_.trim).filter(_.nonEmpty)

      RegretFile(
        cluster = headerMap.getOrElse("cluster", ""),
        version = headerMap.getOrElse("version", "1").toInt,
        fingerprints = fingerprints,
        captured = headerMap.getOrElse("captured", ""),
        watches = headerMap.getOrElse("watches", "[]")
          .stripPrefix("[").stripSuffix("]").split(',').map(_.trim).filter(_.nonEmpty),
        entry = headerMap.getOrElse("entry", ""),
        stack = headerMap.getOrElse("stack", "scala"),
        fingerprintLevel = headerMap.getOrElse("fingerprintLevel", "entry"),
        objName = headerMap.getOrElse("object", ""),
        inputs = inputs.toArray,
        outputs = outputs.toArray,
        hashes = hashes.toArray,
      )
    finally src.close()

  // ─── Tiny ujson-shim writer (so we don't pull in ujson as a dep) ─────────
  //
  // Emits a compact JSON string from a Scala Any. Used for the REGRET_RESULT_JSON
  // and REGRET_VALIDATE_JSON stdout lines that the bash runner parses.

  def ujsonWrite(a: Any): String =
    val sb = new StringBuilder
    ujsonRender(a, sb)
    sb.toString

  private def ujsonRender(a: Any, sb: StringBuilder): Unit = a match
    case null                  => sb.append("null")
    case b: Boolean            => sb.append(b.toString)
    case b: java.lang.Boolean  => sb.append(b.toString)
    case l: Long               => sb.append(l.toString)
    case i: Int                => sb.append(i.toString)
    case d: Double             => sb.append(d.toString)
    case s: String             =>
      sb.append('"')
      for c <- s do c match
        case '"'  => sb.append("\\\"")
        case '\\' => sb.append("\\\\")
        case '\n' => sb.append("\\n")
        case '\r' => sb.append("\\r")
        case '\t' => sb.append("\\t")
        case _ =>
          if (c < 0x20) sb.append("\\u").append(f"${c.toInt}%04x")
          else sb.append(c)
      sb.append('"')
    case arr: Array[?]         =>
      sb.append('[')
      var first = true
      for x <- arr do
        if (!first) sb.append(',')
        first = false
        ujsonRender(x, sb)
      sb.append(']')
    case seq: Seq[?]           =>
      sb.append('[')
      var first = true
      for x <- seq do
        if (!first) sb.append(',')
        first = false
        ujsonRender(x, sb)
      sb.append(']')
    case m: Map[?, ?]          =>
      sb.append('{')
      var first = true
      for (k, v) <- m do
        if (!first) sb.append(',')
        first = false
        sb.append('"').append(k.toString.replace("\"", "\\\"")).append("\":")
        ujsonRender(v, sb)
      sb.append('}')
    case j: Json               =>
      // Render Json tree to compact JSON
      j match
        case Json.Null        => sb.append("null")
        case Json.Bool(b)     => sb.append(b.toString)
        case Json.IntNum(n)   => sb.append(n.toString)
        case Json.DoubleNum(d) => sb.append(d.toString)
        case Json.Str(s)      =>
          sb.append('"')
          for c <- s do c match
            case '"'  => sb.append("\\\"")
            case '\\' => sb.append("\\\\")
            case '\n' => sb.append("\\n")
            case '\t' => sb.append("\\t")
            case _ => sb.append(c)
          sb.append('"')
        case Json.Arr(items)  =>
          sb.append('[')
          var first = true
          for x <- items do
            if (!first) sb.append(',')
            first = false
            ujsonRender(x, sb)
          sb.append(']')
        case Json.Obj(entries) =>
          sb.append('{')
          var first = true
          for (k, v) <- entries do
            if (!first) sb.append(',')
            first = false
            sb.append('"').append(k.replace("\"", "\\\"")).append("\":")
            ujsonRender(v, sb)
          sb.append('}')
    case other                 => ujsonWrite(other.toString)

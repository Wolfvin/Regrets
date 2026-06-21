#!/usr/bin/env bash
# capture_kotlin.sh — compile + run regret capture for Kotlin clusters
#
# Reads regrets/manifest.json, generates a Kotlin runner that invokes each
# cluster's entry function with the manifest-provided inputs, computes the
# Regrets fingerprint (identical algorithm to scripts/fingerprint.js), and
# writes a .regret file per cluster.
#
# Usage:
#   bash scripts/capture_kotlin.sh                 # capture all Kotlin clusters
#   bash scripts/capture_kotlin.sh --cluster add   # capture one cluster
#   bash scripts/capture_kotlin.sh --manifest ./regrets/manifest.json
#   bash scripts/capture_kotlin.sh --quiet
#   bash scripts/capture_kotlin.sh --verbose
#
# Requirements:
#   - kotlinc (Kotlin compiler) on PATH or at KOTLINC_HOME
#   - java (JVM 11+)
#   - node (for manifest JSON parsing — bash can't parse JSON natively)
#
# The .regret file format is identical to the JS/Python/Go/Rust stacks:
#   cluster: <id>
#   version: 1
#   fingerprint: <7-char base36>
#   captured: <ISO timestamp>
#   watches: [...]
#   entry: <function name>
#   stack: kotlin
#   fingerprintLevel: entry
#   ---
#   INPUT  <json>
#   OUTPUT <json>
#   HASH   <7-char base36>

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SKILL_DIR="$(dirname "$SCRIPT_DIR")"
PROJECT_DIR="$(pwd)"
MANIFEST="${PROJECT_DIR}/regrets/manifest.json"
REGRET_DIR="${PROJECT_DIR}/regrets"

# ─── Locate kotlinc ─────────────────────────────────────────────────────────
# Allow override via KOTLINC_HOME; otherwise look on PATH.

KOTLINC_BIN=""
if [[ -n "${KOTLINC_HOME:-}" && -x "${KOTLINC_HOME}/bin/kotlinc" ]]; then
  KOTLINC_BIN="${KOTLINC_HOME}/bin/kotlinc"
elif command -v kotlinc &>/dev/null; then
  KOTLINC_BIN="$(command -v kotlinc)"
fi

if [[ -z "$KOTLINC_BIN" ]]; then
  echo "❌ kotlinc not found. Install Kotlin (https://kotlinlang.org/docs/command-line.html)"
  echo "   or set KOTLINC_HOME to the directory containing bin/kotlinc."
  exit 1
fi

KOTLINC_DIR="$(dirname "$KOTLINC_BIN")"
KOTLIN_HOME_DIR="$(dirname "$KOTLINC_DIR")"
KOTLIN_LIB_DIR="$KOTLIN_HOME_DIR/lib"

# Java is required for both kotlinc and runtime.
if ! command -v java &>/dev/null; then
  echo "❌ java not found. Install JDK 11+."
  exit 1
fi

# ─── Parse CLI args ──────────────────────────────────────────────────────────

CLUSTER_FILTER=""
QUIET=0
VERBOSE=0
EMIT_RUNNER=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --cluster)
      CLUSTER_FILTER="$2"
      shift 2
      ;;
    --manifest)
      MANIFEST="$2"
      shift 2
      ;;
    --quiet)
      QUIET=1
      shift
      ;;
    --verbose)
      VERBOSE=1
      shift
      ;;
    --emit-runner)
      # Internal: write the runner .kt file to the given path and exit.
      # Used by validate_kotlin.sh to share the exact same runner code.
      EMIT_RUNNER="$2"
      shift 2
      ;;
    *)
      echo "Unknown arg: $1" >&2
      echo "Usage: bash scripts/capture_kotlin.sh [--cluster <id>] [--manifest <path>] [--quiet] [--verbose] [--emit-runner <path>]" >&2
      exit 1
      ;;
  esac
done

# ─── --emit-runner: write the runner .kt to the given path and exit ─────────
# This is a hidden flag used by validate_kotlin.sh to guarantee the same
# runner code path. It avoids duplicating the runner heredoc in both scripts.

if [[ -n "$EMIT_RUNNER" ]]; then
  mkdir -p "$(dirname "$EMIT_RUNNER")"
  # The runner heredoc is below; we re-execute this script with a sentinel
  # to extract just the runner code. Simpler: extract via awk from this file.
  # The runner is delimited by `cat > "$RUNNER_DIR/RegretRunner.kt" << 'KOTLIN_RUNNER_EOF'`
  # and a closing `KOTLIN_RUNNER_EOF`.
  awk '/^cat > "\$RUNNER_DIR\/RegretRunner\.kt" << .KOTLIN_RUNNER_EOF.$/{flag=1; next} /^KOTLIN_RUNNER_EOF$/{flag=0} flag' "$0" > "$EMIT_RUNNER"
  exit 0
fi

[[ $QUIET -eq 1 ]] || echo "📡 Capturing Kotlin clusters from $MANIFEST"

if [[ ! -f "$MANIFEST" ]]; then
  echo "❌ Manifest not found: $MANIFEST"
  exit 1
fi

mkdir -p "$REGRET_DIR"

# ─── Read Kotlin clusters from manifest ─────────────────────────────────────
# Use node to parse JSON (bash can't).

CLUSTERS_JSON=$(node -e "
  const m = JSON.parse(require('fs').readFileSync('$MANIFEST', 'utf8'));
  let cs = (m.clusters || []).filter(c => c.stack === 'kotlin');
  if ('$CLUSTER_FILTER') {
    cs = cs.filter(c => c.id === '$CLUSTER_FILTER');
  }
  console.log(JSON.stringify(cs));
")

if [[ "$CLUSTERS_JSON" == "[]" ]]; then
  [[ $QUIET -eq 1 ]] || echo "No Kotlin clusters found in manifest."
  exit 0
fi

# ─── Generate the Kotlin runner ─────────────────────────────────────────────
# The runner is a single .kt file that:
#   1. Reads an invocation spec (JSON) from stdin
#   2. Loads the user's compiled class via reflection
#   3. Invokes the named top-level function with each input
#   4. Computes the fingerprint (sha256 → base36 → 7 chars)
#   5. Prints INPUT/OUTPUT/HASH lines to stdout

RUNNER_DIR="${PROJECT_DIR}/.regret-kotlin-build"
mkdir -p "$RUNNER_DIR"

# Build the runner Kotlin source. Embedded heredoc — the runner is
# self-contained (no external Kotlin dependencies beyond the stdlib that
# ships with kotlinc).

cat > "$RUNNER_DIR/RegretRunner.kt" << 'KOTLIN_RUNNER_EOF'
// AUTO-GENERATED by capture_kotlin.sh — do not edit.
// Standalone Regrets capture/validate runner for Kotlin clusters.
package regrets.runner

import java.io.BufferedReader
import java.io.InputStreamReader
import java.math.BigInteger
import java.security.MessageDigest
import kotlin.reflect.KFunction

fun main(args: Array<String>) {
    // Mode is the first CLI arg: "capture" or "validate".
    // For "validate", the second arg is the expected hash from the .regret file.
    val mode = args.getOrNull(0) ?: "capture"
    val expectedHash = args.getOrNull(1)

    // Read the invocation spec from stdin (JSON).
    val stdin = BufferedReader(InputStreamReader(System.`in`, Charsets.UTF_8))
    val specJson = stdin.readText()

    val spec = parseJson(specJson) as Map<String, Any?>
    val functionName = spec["function"] as String
    val packageStr = spec["package"] as? String ?: ""
    val fileClassName = spec["fileClassName"] as String
    val inputs = spec["inputs"] as List<Any?>
    val multiArgs = (spec["multiArgs"] as? Boolean) ?: false

    val fqcn = if (packageStr.isEmpty()) fileClassName else "$packageStr.$fileClassName"
    val cls = try {
        Class.forName(fqcn)
    } catch (e: ClassNotFoundException) {
        System.err.println("ERROR: class not found: $fqcn — make sure the source file is on the classpath.")
        System.exit(2)
        return
    }

    var passCount = 0
    var failCount = 0
    var infoCount = 0  // inputs beyond the golden (no stored hash to compare)

    for ((idx, rawInput) in inputs.withIndex()) {
        val argsList = when {
            multiArgs && rawInput is List<*> -> rawInput.map { it }
            rawInput is List<*> -> rawInput
            else -> listOf(rawInput)
        }

        // Invoke the function.
        var output: Any? = null
        var threw: Boolean = false
        var errorMessage: String? = null
        try {
            output = invokeTopLevelFunction(cls, functionName, argsList)
            threw = false
            errorMessage = null
        } catch (e: Throwable) {
            output = null
            threw = true
            errorMessage = (e.cause?.message ?: e.message)?.toString()
        }

        // For validate mode, also load the expected output+hash from the spec.
        val expected = if (mode == "validate") {
            @Suppress("UNCHECKED_CAST")
            (spec["expected"] as? List<Map<String, Any?>>)?.getOrNull(idx) ?: emptyMap<String, Any?>()
        } else {
            emptyMap()
        }

        // For fingerprint: use the raw input value (single arg) when multiArgs=false,
        // the args list when multiArgs=true. This matches how the .regret file's
        // INPUT line represents the input — fingerprint(input, output) must use
        // the same value the INPUT line shows.
        val fpInput: Any? = if (multiArgs) argsList else argsList.firstOrNull()
        val fp = if (!threw) fingerprint(fpInput, output) else fingerprint(fpInput, mapOf("__threw__" to (errorMessage ?: "unknown")))

        // Print INPUT / OUTPUT / HASH lines (capture mode writes these to the .regret file).
        // In validate mode, we also print PASS/FAIL based on hash comparison.
        println("INPUT  ${stableStringify(fpInput)}")
        if (threw) {
            println("ERROR  ${stableStringify(errorMessage ?: "unknown")}")
        } else {
            println("OUTPUT ${stableStringify(output)}")
        }
        println("HASH   $fp")

        if (mode == "validate") {
            val expectedFp = expected["hash"] as? String
            when {
                // No stored hash for this input (e.g. input 2+ in the manifest
                // when the .regret file only stored input 0's hash). Print the
                // computed hash for informational purposes but don't count it
                // as pass or fail — we have no ground truth to compare against.
                expectedFp == null -> {
                    println("RESULT INFO no_expected_hash")
                    infoCount++
                }
                expectedFp == fp -> {
                    println("RESULT PASS")
                    passCount++
                }
                else -> {
                    println("RESULT FAIL hash_mismatch expected=$expectedFp actual=$fp")
                    failCount++
                }
            }
        }
        println("---")
    }

    if (mode == "validate") {
        // Exit code: 0 = no failures (PASS or INFO), 1 = at least one fail.
        // INFO inputs don't fail the run — they're inputs beyond the golden
        // whose hash isn't stored in the .regret file.
        if (failCount > 0) {
            System.err.println("VALIDATE SUMMARY: $passCount pass, $failCount fail, $infoCount info (out of ${passCount + failCount + infoCount})")
            System.exit(1)
        } else {
            System.err.println("VALIDATE SUMMARY: $passCount pass, 0 fail, $infoCount info (out of ${passCount + infoCount})")
        }
    }
}

// ─── Function invocation via reflection ────────────────────────────────────

fun invokeTopLevelFunction(cls: Class<*>, functionName: String, args: List<Any?>): Any? {
    val methods = cls.declaredMethods.filter { it.name == functionName }
    if (methods.isEmpty()) {
        throw IllegalArgumentException(
            "Function '$functionName' not found on class '${cls.name}'. Available: ${cls.declaredMethods.map { it.name }.distinct()}"
        )
    }
    val method = methods.firstOrNull { it.parameterCount == args.size }
        ?: throw IllegalArgumentException(
            "Function '$functionName' on '${cls.name}' has no overload taking ${args.size} arg(s). " +
                "Available: ${methods.map { it.parameterCount }.distinct().sorted()}"
        )
    method.isAccessible = true
    val coerced = args.mapIndexed { i, v -> coerce(v, method.parameterTypes[i]) }.toTypedArray()
    return method.invoke(null, *coerced)
}

@Suppress("UNCHECKED_CAST")
private fun coerce(v: Any?, target: Class<*>): Any? {
    if (v == null) {
        if (target.isPrimitive) {
            return when (target.name) {
                "boolean" -> false
                "int" -> 0
                "long" -> 0L
                "double" -> 0.0
                "float" -> 0.0f
                "short" -> 0.toShort()
                "byte" -> 0.toByte()
                "char" -> ' '
                else -> null
            }
        }
        return null
    }
    if (target.isAssignableFrom(v.javaClass)) return v

    return when (target) {
        String::class.java, java.lang.String::class.java -> v.toString()
        Int::class.java, java.lang.Integer::class.java, Integer.TYPE ->
            when (v) { is Number -> v.toInt(); is String -> v.toIntOrNull() ?: 0; else -> v }
        Long::class.java, java.lang.Long::class.java, java.lang.Long.TYPE ->
            when (v) { is Number -> v.toLong(); is String -> v.toLongOrNull() ?: 0L; else -> v }
        Double::class.java, java.lang.Double::class.java, java.lang.Double.TYPE ->
            when (v) { is Number -> v.toDouble(); is String -> v.toDoubleOrNull() ?: 0.0; else -> v }
        Float::class.java, java.lang.Float::class.java, java.lang.Float.TYPE ->
            when (v) { is Number -> v.toFloat(); is String -> v.toFloatOrNull() ?: 0.0f; else -> v }
        Boolean::class.java, java.lang.Boolean::class.java, java.lang.Boolean.TYPE ->
            when (v) { is Boolean -> v; is String -> v.toBooleanStrictOrNull() ?: v.toBoolean(); else -> v }
        else -> v
    }
}

// ─── stableStringify (port of scripts/fingerprint.js) ──────────────────────

fun stableStringify(obj: Any?): String = doStableStringify(obj, mutableSetOf())

private typealias AnyRef = Any

private fun doStableStringify(obj: Any?, seen: MutableSet<AnyRef>): String {
    when (obj) {
        null -> return "null"
        is Unit -> return "\"__unit__\""
        is Boolean -> return if (obj) "true" else "false"
        is Int, is Long, is Short, is Byte -> return obj.toString()
        is Float, is Double -> {
            val d = (obj as Number).toDouble()
            if (d.isNaN()) return "\"__nan__\""
            if (d == Double.POSITIVE_INFINITY) return "\"__infinity__\""
            if (d == Double.NEGATIVE_INFINITY) return "\"__neg_infinity__\""
            return jsNumberToString(d)
        }
        is String -> return jsonString(obj)
        is Char -> return jsonString(obj.toString())
        is Enum<*> -> return jsonString(obj.name)
        is List<*> -> {
            if (seen.contains(obj as AnyRef)) return "\"__circular__\""
            seen.add(obj as AnyRef)
            val parts = obj.map { doStableStringify(it, seen) }
            seen.remove(obj as AnyRef)
            return "[" + parts.joinToString(",") + "]"
        }
        is Set<*> -> {
            if (seen.contains(obj as AnyRef)) return "\"__circular__\""
            seen.add(obj as AnyRef)
            val parts = obj.map { doStableStringify(it, seen) }.sorted()
            seen.remove(obj as AnyRef)
            return "[" + parts.joinToString(",") + "]"
        }
        is Map<*, *> -> {
            if (seen.contains(obj as AnyRef)) return "\"__circular__\""
            seen.add(obj as AnyRef)
            @Suppress("UNCHECKED_CAST")
            val map = obj as Map<String, Any?>
            val keys = map.keys.sorted()
            val parts = keys.map { k -> jsonString(k) + ":" + doStableStringify(map[k], seen) }
            seen.remove(obj as AnyRef)
            return "{" + parts.joinToString(",") + "}"
        }
        is Array<*> -> {
            if (seen.contains(obj as AnyRef)) return "\"__circular__\""
            seen.add(obj as AnyRef)
            val parts = obj.map { doStableStringify(it, seen) }
            seen.remove(obj as AnyRef)
            return "[" + parts.joinToString(",") + "]"
        }
        is ByteArray -> return "[" + obj.joinToString(",") { it.toInt().toString() } + "]"
        else -> {
            if (seen.contains(obj as AnyRef)) return "\"__circular__\""
            seen.add(obj as AnyRef)
            val kClass = obj::class
            val members = kClass.members.filter { it.name.startsWith("component") }
            if (members.isNotEmpty()) {
                val parts = members.sortedBy { m ->
                    m.name.removePrefix("component").toIntOrNull() ?: 0
                }.mapIndexed { idx, m ->
                    val value = (m as KFunction<*>).call(obj)
                    jsonString(idx.toString()) + ":" + doStableStringify(value, seen)
                }
                seen.remove(obj as AnyRef)
                val entries = listOf("\"_class\":" + jsonString(kClass.simpleName ?: "Unknown")) + parts
                return "{" + entries.joinToString(",") + "}"
            }
            seen.remove(obj as AnyRef)
            return jsonString(obj.toString())
        }
    }
}

private fun jsonString(s: String): String {
    val sb = StringBuilder(s.length + 2)
    sb.append('"')
    for (ch in s) {
        when (ch) {
            '"' -> sb.append("\\\"")
            '\\' -> sb.append("\\\\")
            '\n' -> sb.append("\\n")
            '\r' -> sb.append("\\r")
            '\t' -> sb.append("\\t")
            '\b' -> sb.append("\\b")
            '\u000C' -> sb.append("\\f")
            else -> {
                val code = ch.code
                if (code < 0x20) sb.append(String.format("\\u%04x", code)) else sb.append(ch)
            }
        }
    }
    sb.append('"')
    return sb.toString()
}

private fun jsNumberToString(d: Double): String {
    if (d == 0.0) return "0"
    if (d == kotlin.math.floor(d) && !d.isInfinite() && kotlin.math.abs(d) < 1e21) {
        val asLong = d.toLong()
        if (asLong.toDouble() == d) return asLong.toString()
    }
    val s = d.toString()
    return s.replace(Regex("([+-]?\\d+\\.?\\d*)[Ee]([+-]?\\d+)")) { m ->
        val mantissa = m.groupValues[1]
        val exp = m.groupValues[2].toInt()
        val expStr = if (exp >= 0) "+$exp" else exp.toString()
        mantissa + "e" + expStr
    }
}

// ─── fingerprint (port of scripts/fingerprint.js) ──────────────────────────

fun fingerprint(input: Any?, output: Any?): String {
    val combined = stableStringify(input) + "|" + stableStringify(output)
    val md = MessageDigest.getInstance("SHA-256")
    val hashBytes = md.digest(combined.toByteArray(Charsets.UTF_8))
    val hexStr = hashBytes.joinToString("") { "%02x".format(it) }
    val bigInt = BigInteger(hexStr, 16)
    val b36 = bigInt.toString(36)
    return if (b36.length >= 7) b36.substring(0, 7) else b36
}

// ─── Minimal JSON parser (no external deps) ────────────────────────────────
// Hand-rolled because kotlinx-serialization isn't on the classpath by default.

fun parseJson(text: String): Any? {
    val parser = JsonParser(text)
    return parser.parseValue()
}

private class JsonParser(private val text: String) {
    private var pos = 0

    fun parseValue(): Any? {
        skipWs()
        val v = when (val ch = peek()) {
            '{' -> parseObject()
            '[' -> parseArray()
            '"' -> parseString()
            't', 'f' -> parseBool()
            'n' -> parseNull()
            else -> if (ch == '-' || ch.isDigit()) parseNumber() else throw IllegalStateException("Unexpected char '$ch' at $pos")
        }
        skipWs()
        return v
    }

    private fun peek(): Char = if (pos < text.length) text[pos] else '\u0000'
    private fun next(): Char = text[pos++]

    private fun skipWs() {
        while (pos < text.length && text[pos].isWhitespace()) pos++
    }

    private fun parseObject(): Map<String, Any?> {
        val m = LinkedHashMap<String, Any?>()
        next() // consume {
        skipWs()
        if (peek() == '}') { next(); return m }
        while (true) {
            skipWs()
            val key = parseString()
            skipWs()
            require(next() == ':') { "Expected ':' at $pos" }
            val v = parseValue()
            m[key] = v
            skipWs()
            when (next()) {
                ',' -> continue
                '}' -> return m
                else -> throw IllegalStateException("Expected ',' or '}' at ${pos-1}")
            }
        }
    }

    private fun parseArray(): List<Any?> {
        val l = ArrayList<Any?>()
        next() // consume [
        skipWs()
        if (peek() == ']') { next(); return l }
        while (true) {
            l.add(parseValue())
            skipWs()
            when (next()) {
                ',' -> continue
                ']' -> return l
                else -> throw IllegalStateException("Expected ',' or ']' at ${pos-1}")
            }
        }
    }

    private fun parseString(): String {
        require(next() == '"') { "Expected '\"' at ${pos-1}" }
        val sb = StringBuilder()
        while (true) {
            val ch = next()
            when (ch) {
                '"' -> return sb.toString()
                '\\' -> {
                    val esc = next()
                    sb.append(when (esc) {
                        '"' -> '"'; '\\' -> '\\'; '/' -> '/'; 'n' -> '\n'; 'r' -> '\r'
                        't' -> '\t'; 'b' -> '\b'; 'f' -> '\u000C'
                        'u' -> {
                            val hex = text.substring(pos, pos + 4); pos += 4
                            hex.toInt(16).toChar()
                        }
                        else -> esc
                    })
                }
                else -> sb.append(ch)
            }
        }
    }

    private fun parseBool(): Boolean {
        if (text.startsWith("true", pos)) { pos += 4; return true }
        if (text.startsWith("false", pos)) { pos += 5; return false }
        throw IllegalStateException("Expected 'true' or 'false' at $pos")
    }

    private fun parseNull(): Any? {
        if (text.startsWith("null", pos)) { pos += 4; return null }
        throw IllegalStateException("Expected 'null' at $pos")
    }

    private fun parseNumber(): Number {
        val start = pos
        if (peek() == '-') pos++
        while (pos < text.length && (text[pos].isDigit() || text[pos] == '.' || text[pos] == 'e' || text[pos] == 'E' || text[pos] == '+' || text[pos] == '-')) pos++
        val s = text.substring(start, pos)
        return if (s.contains('.') || s.contains('e') || s.contains('E')) s.toDouble() else s.toLong()
    }
}
KOTLIN_RUNNER_EOF

[[ $VERBOSE -eq 1 ]] && echo "Generated runner: $RUNNER_DIR/RegretRunner.kt"

# ─── For each cluster: compile source + runner, run capture, write .regret ─

CAPTURED_COUNT=0
FAILED_COUNT=0

# Use node to iterate clusters (cleaner JSON parsing than bash).
# Write the per-cluster JSON lines to a temp file so the while loop doesn't
# run in a subshell (which would lose the counter increments).
CLUSTER_LINES_FILE="$(mktemp)"
trap 'rm -f "$CLUSTER_LINES_FILE"' EXIT

echo "$CLUSTERS_JSON" | node -e "
  const clusters = JSON.parse(require('fs').readFileSync('/dev/stdin', 'utf8'));
  for (const c of clusters) {
    const inputs = (c.inputs || []).map(inp => {
      // multiArgs: input is already an array of args.
      // single-arg: input is a single value (string, number, etc.).
      return inp;
    });
    console.log(JSON.stringify({
      id: c.id,
      entry: c.entry,
      file: c.file,
      kotlinPackage: c.kotlinPackage || '',
      multiArgs: !!c.multiArgs,
      inputs: inputs,
    }));
  }
" > "$CLUSTER_LINES_FILE"

while IFS= read -r cluster_line; do
  # Parse cluster fields via node (bash has no JSON).
  CLUSTER_ID=$(echo "$cluster_line" | node -e "console.log(JSON.parse(require('fs').readFileSync('/dev/stdin','utf8')).id)")
  CLUSTER_ENTRY=$(echo "$cluster_line" | node -e "console.log(JSON.parse(require('fs').readFileSync('/dev/stdin','utf8')).entry)")
  CLUSTER_FILE=$(echo "$cluster_line" | node -e "console.log(JSON.parse(require('fs').readFileSync('/dev/stdin','utf8')).file)")
  CLUSTER_PKG=$(echo "$cluster_line" | node -e "console.log(JSON.parse(require('fs').readFileSync('/dev/stdin','utf8')).kotlinPackage)")
  CLUSTER_MULTI=$(echo "$cluster_line" | node -e "console.log(JSON.parse(require('fs').readFileSync('/dev/stdin','utf8')).multiArgs)")

  [[ $QUIET -eq 1 ]] || echo "  Capturing: $CLUSTER_ID ($CLUSTER_ENTRY)"

  # Resolve source path.
  SOURCE_PATH="${PROJECT_DIR}/${CLUSTER_FILE}"
  if [[ ! -f "$SOURCE_PATH" ]]; then
    echo "❌ Source file not found for cluster '$CLUSTER_ID': $SOURCE_PATH" >&2
    FAILED_COUNT=$((FAILED_COUNT + 1))
    continue
  fi

  # Derive the file-class name (Kotlin: src/Foo.kt → FooKt).
  FILE_BASENAME="$(basename "$CLUSTER_FILE" .kt)"
  FILE_CLASS_NAME="${FILE_BASENAME}Kt"

  # Compile the user's source + the runner into a single .jar.
  COMPILE_DIR="${RUNNER_DIR}/classes-${CLUSTER_ID}"
  rm -rf "$COMPILE_DIR"
  mkdir -p "$COMPILE_DIR"

  [[ $VERBOSE -eq 1 ]] && echo "    Compiling $SOURCE_PATH + runner..."

  if ! "$KOTLINC_BIN" \
      -cp "$KOTLIN_LIB_DIR/kotlin-stdlib.jar" \
      -no-stdlib -no-reflect \
      -d "$COMPILE_DIR" \
      "$SOURCE_PATH" "$RUNNER_DIR/RegretRunner.kt" 2> "$RUNNER_DIR/kotlinc.err"; then
    echo "❌ kotlinc failed for cluster '$CLUSTER_ID':" >&2
    cat "$RUNNER_DIR/kotlinc.err" >&2
    FAILED_COUNT=$((FAILED_COUNT + 1))
    continue
  fi

  # Build the invocation spec JSON.
  # We need to send: function, package, fileClassName, multiArgs, inputs.
  # The inputs are the raw cluster.inputs from the manifest (already JSON-shaped).
  INVOCATION_SPEC=$(echo "$cluster_line" | node -e "
    const c = JSON.parse(require('fs').readFileSync('/dev/stdin','utf8'));
    console.log(JSON.stringify({
      function: c.entry,
      package: c.kotlinPackage,
      fileClassName: '${FILE_CLASS_NAME}',
      multiArgs: c.multiArgs,
      inputs: c.inputs,
    }));
  ")

  # Run the runner. Capture stdout. Classpath: compiled classes + kotlin stdlib.
  RUNNER_CP="${COMPILE_DIR}:${KOTLIN_LIB_DIR}/kotlin-stdlib.jar"
  [[ $VERBOSE -eq 1 ]] && echo "    Running runner for $CLUSTER_ID..."

  # Disable -e locally — runner may exit non-zero on edge cases (e.g. function throws),
  # but we still want to capture and report its output.
  set +e
  RUNNER_OUTPUT=$(echo "$INVOCATION_SPEC" | java -cp "$RUNNER_CP" regrets.runner.RegretRunnerKt capture 2> "$RUNNER_DIR/runner.err")
  RUNNER_RC=$?
  set -e

  if [[ $RUNNER_RC -ne 0 ]]; then
    echo "❌ Runner failed for cluster '$CLUSTER_ID' (rc=$RUNNER_RC):" >&2
    cat "$RUNNER_DIR/runner.err" >&2 >&2
    FAILED_COUNT=$((FAILED_COUNT + 1))
    continue
  fi

  # Parse runner output: extract ALL INPUT/OUTPUT/HASH triplets.
  # The first triplet is the golden (stored as INPUT/OUTPUT/HASH lines).
  # All triplets (including the golden) are stored in an INPUTS line as a
  # JSON array, matching the JS #315 INPUTS feature. This lets validate
  # re-check EVERY input, not just the golden — critical for catching
  # breaking refactors that only affect input 2+.
  GOLDEN_INPUT=$(echo "$RUNNER_OUTPUT" | grep -m1 '^INPUT ' | sed 's/^INPUT  //')
  GOLDEN_OUTPUT=$(echo "$RUNNER_OUTPUT" | grep -m1 '^OUTPUT ' | sed 's/^OUTPUT //')
  GOLDEN_HASH=$(echo "$RUNNER_OUTPUT" | grep -m1 '^HASH ' | sed 's/^HASH   //')

  if [[ -z "$GOLDEN_INPUT" || -z "$GOLDEN_HASH" ]]; then
    echo "❌ Runner output missing INPUT/HASH for cluster '$CLUSTER_ID':" >&2
    echo "$RUNNER_OUTPUT" >&2
    FAILED_COUNT=$((FAILED_COUNT + 1))
    continue
  fi

  # Build INPUTS line: array of {hash, input, output} for every input.
  # We use node to parse the runner output (which prints INPUT/OUTPUT/HASH
  # per input, separated by "---") and emit a single JSON array.
  INPUTS_LINE=$(echo "$RUNNER_OUTPUT" | node -e "
    const lines = require('fs').readFileSync('/dev/stdin','utf8').split('\n');
    const triples = [];
    let cur = {};
    for (const line of lines) {
      if (line.startsWith('INPUT '))  cur.input  = JSON.parse(line.substring(6).trim());
      else if (line.startsWith('OUTPUT ')) cur.output = JSON.parse(line.substring(7).trim());
      else if (line.startsWith('HASH '))   { cur.hash = line.substring(5).trim(); triples.push(cur); cur = {}; }
    }
    process.stdout.write(JSON.stringify(triples));
  ")

  # Write the .regret file.
  REGRET_PATH="${REGRET_DIR}/${CLUSTER_ID}.regret"
  TIMESTAMP=$(date -u +"%Y-%m-%dT%H:%M:%S.%3NZ")

  {
    echo "cluster: ${CLUSTER_ID}"
    echo "version: 1"
    echo "fingerprint: ${GOLDEN_HASH}"
    echo "captured: ${TIMESTAMP}"
    echo "watches: [${CLUSTER_ENTRY}]"
    echo "entry: ${CLUSTER_ENTRY}"
    echo "stack: kotlin"
    echo "fingerprintLevel: entry"
    echo "kotlinPackage: ${CLUSTER_PKG}"
    echo "fileClassName: ${FILE_CLASS_NAME}"
    echo "multiArgs: ${CLUSTER_MULTI}"
    echo "env: {\"kotlin_version\":\"$("${KOTLINC_BIN}" -version 2>&1 | head -1 | sed 's/.*: //')\",\"java_version\":\"$(java -version 2>&1 | head -1 | sed 's/.* version "//' | sed 's/".*//')\"}"
    echo "---"
    echo "INPUT  ${GOLDEN_INPUT}"
    echo "OUTPUT ${GOLDEN_OUTPUT}"
    echo "HASH   ${GOLDEN_HASH}"
    # INPUTS line: store ALL input→hash pairs so validate can re-check every input.
    # Matches the JS #315 INPUTS feature format.
    echo "INPUTS ${INPUTS_LINE}"
  } > "$REGRET_PATH"

  [[ $QUIET -eq 1 ]] || echo "    ✓ ${REGRET_PATH#${PROJECT_DIR}/}"
  CAPTURED_COUNT=$((CAPTURED_COUNT + 1))
done < "$CLUSTER_LINES_FILE"

[[ $QUIET -eq 1 ]] || echo ""
[[ $QUIET -eq 1 ]] || echo "Done. Captured: ${CAPTURED_COUNT}, Failed: ${FAILED_COUNT}"

# Cleanup build dir (keep on --verbose for debugging).
[[ $VERBOSE -eq 1 ]] || rm -rf "$RUNNER_DIR"

exit 0

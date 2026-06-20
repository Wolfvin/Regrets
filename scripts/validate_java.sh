#!/usr/bin/env bash
# validate_java.sh — re-invoke Java entry methods and compare fingerprints
#
# Reads existing .regret files for Java clusters, parses INPUT/OUTPUT/HASH,
# generates a Java validator that re-invokes each entry method with the
# captured INPUT, recomputes the fingerprint, and compares it to the stored
# HASH. Reports PASS/FAIL per cluster.
#
# Usage:
#   bash scripts/validate_java.sh                  # validate all Java clusters
#   bash scripts/validate_java.sh --cluster java-square
#   bash scripts/validate_java.sh --manifest ./regrets/manifest.json
#   bash scripts/validate_java.sh --runs 5         # drift detection (N runs)
#
# Exit code:
#   0 — all clusters PASS
#   1 — at least one cluster FAILed
#
# The --runs flag repeats validation N times and reports per-run fingerprints.
# Drift is detected when fingerprints differ across runs (indicates
# non-determinism in the target code).
#
# .regret file format (parsed by this script):
#   cluster: <id>
#   version: 1
#   fingerprint: <fp>
#   captured: <ISO timestamp>
#   watches: [...]
#   entry: <entry>
#   stack: java
#   fingerprintLevel: <level>
#   ---
#   INPUT  <json>
#   OUTPUT <json>
#   HASH   <fp>

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SKILL_DIR="$(dirname "$SCRIPT_DIR")"
PROJECT_DIR="$(pwd)"
MANIFEST="${PROJECT_DIR}/regrets/manifest.json"
REGRET_DIR="${PROJECT_DIR}/regrets"

# ─── Parse CLI args ───────────────────────────────────────────────────────────

CLUSTER_FLAG=""
MANIFEST_FLAG=""
RUNS=1
i=0
args=("$@")
while [ $i -lt ${#args[@]} ]; do
  case "${args[$i]}" in
    --cluster)
      CLUSTER_FLAG="${args[$((i+1))]}"
      i=$((i+2))
      ;;
    --manifest)
      MANIFEST_FLAG="${args[$((i+1))]}"
      i=$((i+2))
      ;;
    --runs)
      RUNS="${args[$((i+1))]}"
      i=$((i+2))
      ;;
    *)
      i=$((i+1))
      ;;
  esac
done

if [ -n "$MANIFEST_FLAG" ]; then
  MANIFEST="$MANIFEST_FLAG"
fi

if [ ! -f "$MANIFEST" ]; then
  echo "❌ regrets/manifest.json not found at: $MANIFEST"
  exit 1
fi

# ─── Locate JDK ───────────────────────────────────────────────────────────────
JAVAC_BIN=""
JAVA_BIN=""
if command -v javac &> /dev/null; then
  JAVAC_BIN="javac"
  JAVA_BIN="java"
else
  for candidate in \
    "/home/z/.jdk/jdk-21.0.11+10/bin/javac" \
    "/usr/lib/jvm/java-21-openjdk-amd64/bin/javac"; do
    if [ -x "$candidate" ]; then
      JAVAC_BIN="$candidate"
      JAVA_BIN="$(dirname "$candidate")/java"
      break
    fi
  done
fi

if [ -z "$JAVAC_BIN" ]; then
  echo "❌ javac not found. Install OpenJDK 17+ or add it to PATH."
  exit 1
fi

# ─── Read Java clusters from manifest ─────────────────────────────────────────

CLUSTERS_JSON=$(node -e "
  const fs = require('fs');
  const m = JSON.parse(fs.readFileSync('$MANIFEST', 'utf8'));
  let clusters = (m.clusters || []).filter(c => c.stack === 'java');
  if ('$CLUSTER_FLAG') {
    clusters = clusters.filter(c => c.id === '$CLUSTER_FLAG');
  }
  console.log(JSON.stringify(clusters));
")

if [ "$CLUSTERS_JSON" = "[]" ]; then
  echo "No Java clusters found in manifest."
  exit 0
fi

# ─── Verify all .regret files exist ───────────────────────────────────────────

MISSING=0
node -e "
  const clusters = JSON.parse('$CLUSTERS_JSON');
  const fs = require('fs');
  const path = require('path');
  for (const c of clusters) {
    const p = path.join('$REGRET_DIR', c.id + '.regret');
    if (!fs.existsSync(p)) {
      console.error('   ❌ Missing .regret file for cluster \"' + c.id + '\": ' + p);
      process.exit(1);
    }
  }
" || exit 1

# ─── Compile RegretFingerprint.java ───────────────────────────────────────────
REGRET_BUILD_DIR="${REGRET_DIR}/_build"
mkdir -p "$REGRET_BUILD_DIR"
cp "$SCRIPT_DIR/RegretFingerprint.java" "$REGRET_BUILD_DIR/RegretFingerprint.java"
"$JAVAC_BIN" -d "$REGRET_BUILD_DIR" "$REGRET_BUILD_DIR/RegretFingerprint.java" 2>&1 || {
  echo "❌ Failed to compile RegretFingerprint.java"
  exit 1
}

# ─── Generate the validate test file ──────────────────────────────────────────
#
# For each cluster:
#   1. Read regrets/<id>.regret
#   2. Parse INPUT, OUTPUT, HASH
#   3. Use manifest className / classMethod / constructor to invoke entry
#   4. For each of N runs, re-invoke and compute fingerprint
#   5. Compare with stored HASH
#   6. Report PASS/FAIL + drift detection

VALIDATE_FILE="${REGRET_DIR}/RegretValidateTest.java"

# Build a JSON document that the generated Java can read at runtime:
# Each entry contains {cluster, regretPath, manifest config}
CLUSTER_DATA=$(node -e "
  const clusters = JSON.parse('$CLUSTERS_JSON');
  const path = require('path');
  const out = clusters.map(c => ({
    id: c.id,
    entry: c.entry,
    className: c.className,
    classMethod: c.classMethod || null,
    constructor: c.constructor || null,
    constructorArgs: c.constructorArgs || [],
    multiArgs: !!c.multiArgs,
    regretPath: path.join('$REGRET_DIR', c.id + '.regret'),
  }));
  console.log(JSON.stringify(out));
")

# Write cluster data as a resource file the Java test can read
CLUSTER_DATA_FILE="${REGRET_BUILD_DIR}/cluster_data.json"
echo "$CLUSTER_DATA" > "$CLUSTER_DATA_FILE"

# Generate the validate test file
cat > "$VALIDATE_FILE" << 'JAVAEOF'
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.lang.reflect.Constructor;
import java.lang.reflect.Method;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * RegretValidateTest — auto-generated by validate_java.sh.
 *
 * For each cluster, reads the .regret file, re-invokes the entry method with
 * the parsed INPUT, recomputes the fingerprint, and compares it to the stored
 * HASH. Reports PASS/FAIL.
 *
 * Drift detection: if --runs > 1, each cluster is invoked N times. If any
 * run produces a different fingerprint, the cluster is marked DRIFT.
 */
public class RegretValidateTest {

  static int passed = 0, failed = 0, drift = 0;

  public static void main(String[] args) throws Exception {
    int runs = 1;
    if (args.length > 0) {
      runs = Integer.parseInt(args[0]);
    }

    // Load cluster data from JSON resource file
    Path dataFile = Paths.get("regrets/_build/cluster_data.json");
    String jsonData = new String(Files.readAllBytes(dataFile), StandardCharsets.UTF_8);
    List<Map<String, Object>> clusters = parseClusterData(jsonData);

    System.out.println("🔍 Validating " + clusters.size() + " Java cluster(s) with " + runs + " run(s) each...");
    System.out.println();

    for (Map<String, Object> cluster : clusters) {
      validateCluster(cluster, runs);
    }

    System.out.println();
    System.out.println("────────────────────────────────────────────────");
    System.out.println("Java validate complete: " + passed + " passed, " + failed + " failed, " + drift + " drift");
    if (failed > 0 || drift > 0) System.exit(1);
  }

  static void validateCluster(Map<String, Object> cluster, int runs) {
    String id = (String) cluster.get("id");
    String entry = (String) cluster.get("entry");
    String className = (String) cluster.get("className");
    String classMethod = (String) cluster.get("classMethod");
    String constructor = (String) cluster.get("constructor");
    List<Object> constructorArgs = (List<Object>) cluster.get("constructorArgs");
    boolean multiArgs = Boolean.TRUE.equals(cluster.get("multiArgs"));
    String regretPath = (String) cluster.get("regretPath");

    System.out.println("📡 " + id);
    System.out.println("   File: " + regretPath);

    try {
      // Read & parse .regret file
      String content = new String(Files.readAllBytes(Paths.get(regretPath)), StandardCharsets.UTF_8);
      Map<String, String> meta = parseRegretMeta(content);
      String storedFingerprint = meta.get("fingerprint");
      // HASH line is in the data section (after ---) and is NOT JSON — it's a
      // plain alphanumeric 7-char string. Parse as raw string.
      String storedHash = parseRawDataLine(content, "HASH");
      Object goldenInput = parseRegretInput(content);
      Object goldenOutput = parseRegretOutput(content);

      if (storedHash == null) {
        System.err.println("   ❌ Missing HASH in .regret file");
        failed++;
        return;
      }

      System.out.println("   Stored fingerprint: " + storedFingerprint);
      System.out.println("   Stored HASH:        " + storedHash);

      // Load target class
      Class<?> clazz = Class.forName(className);

      // Build target (instance or null for static)
      Object target = null;
      if (classMethod != null) {
        if (constructorArgs == null || constructorArgs.isEmpty()) {
          Constructor<?> ctor = clazz.getDeclaredConstructor();
          ctor.setAccessible(true);
          target = ctor.newInstance();
        } else {
          // Build ctor args — assume all-Object types for simplicity
          Class<?>[] ctorParamTypes = new Class<?>[constructorArgs.size()];
          Object[] ctorArgValues = new Object[constructorArgs.size()];
          for (int i = 0; i < constructorArgs.size(); i++) {
            Object a = constructorArgs.get(i);
            ctorParamTypes[i] = classForValue(a);
            ctorArgValues[i] = a;
          }
          Constructor<?> ctor = clazz.getDeclaredConstructor(ctorParamTypes);
          ctor.setAccessible(true);
          target = ctor.newInstance(ctorArgValues);
        }
      }

      // Build method param types from input
      Object[] methodArgs;
      Class<?>[] methodParamTypes;
      if (multiArgs && goldenInput instanceof List) {
        List<?> inputList = (List<?>) goldenInput;
        methodParamTypes = new Class<?>[inputList.size()];
        methodArgs = new Object[inputList.size()];
        for (int i = 0; i < inputList.size(); i++) {
          Object v = inputList.get(i);
          methodParamTypes[i] = classForValue(v);
          methodArgs[i] = v;
        }
      } else if (goldenInput == null) {
        methodParamTypes = new Class<?>[0];
        methodArgs = new Object[0];
      } else {
        methodParamTypes = new Class<?>[]{ classForValue(goldenInput) };
        methodArgs = new Object[]{ goldenInput };
      }

      Method m = clazz.getDeclaredMethod(entry, methodParamTypes);
      m.setAccessible(true);

      // Run N times — collect fingerprints for drift detection
      List<String> runFingerprints = new ArrayList<>();
      List<Object> runOutputs = new ArrayList<>();
      for (int r = 0; r < runs; r++) {
        Object output = m.invoke(target, methodArgs);
        output = normalizeOutput(output);
        String fp = RegretFingerprint.fingerprint(goldenInput, output);
        runFingerprints.add(fp);
        runOutputs.add(output);
      }

      String currentFp = runFingerprints.get(0);
      Object currentOutput = runOutputs.get(0);

      // PASS/FAIL: compare current fingerprint to stored HASH
      boolean hashMatch = currentFp.equals(storedHash);

      // Drift detection — all runs should produce the same fingerprint
      boolean driftDetected = false;
      if (runs > 1) {
        for (int r = 1; r < runs; r++) {
          if (!runFingerprints.get(r).equals(currentFp)) {
            driftDetected = true;
            break;
          }
        }
      }

      System.out.println("   Current fingerprint: " + currentFp);
      if (runs > 1) {
        System.out.println("   Run fingerprints:    " + runFingerprints);
      }
      System.out.println("   Output:              " + RegretFingerprint.toJsonString(currentOutput));

      if (!hashMatch) {
        System.out.println("   ❌ FAIL — fingerprint mismatch");
        System.out.println("      expected: " + storedHash);
        System.out.println("      actual:   " + currentFp);
        failed++;
      } else if (driftDetected) {
        System.out.println("   ⚠️  DRIFT — non-deterministic output across " + runs + " runs");
        System.out.println("      fingerprints: " + runFingerprints);
        drift++;
      } else {
        System.out.println("   ✅ PASS");
        passed++;
      }
    } catch (Throwable t) {
      System.err.println("   ❌ Validate failed: " + t.getMessage());
      t.printStackTrace();
      failed++;
    }
  }

  // ─── Helpers ───────────────────────────────────────────────────────────────

  static Class<?> classForValue(Object v) {
    if (v == null) return Object.class;
    if (v instanceof Integer) return int.class;
    if (v instanceof Long) return long.class;
    if (v instanceof Double) return double.class;
    if (v instanceof Float) return float.class;
    if (v instanceof Boolean) return boolean.class;
    if (v instanceof String) return String.class;
    return Object.class;
  }

  static Object normalizeOutput(Object o) {
    if (o == null) return null;
    if (o.getClass().isArray()) {
      int len = java.lang.reflect.Array.getLength(o);
      List<Object> list = new ArrayList<>(len);
      for (int i = 0; i < len; i++) {
        list.add(normalizeOutput(java.lang.reflect.Array.get(o, i)));
      }
      return list;
    }
    return o;
  }

  static Map<String, String> parseRegretMeta(String content) {
    Map<String, String> meta = new LinkedHashMap<>();
    String[] parts = content.split("\\n---\\n", 2);
    String metaSection = parts[0];
    for (String line : metaSection.split("\\n")) {
      int colonIdx = line.indexOf(": ");
      if (colonIdx == -1) continue;
      String key = line.substring(0, colonIdx);
      String val = line.substring(colonIdx + 2).trim();
      meta.put(key, val);
    }
    return meta;
  }

  static Object parseRegretInput(String content) {
    return parseDataLine(content, "INPUT");
  }

  static Object parseRegretOutput(String content) {
    return parseDataLine(content, "OUTPUT");
  }

  /**
   * Parse a line like "INPUT  [1,2,3]" or "OUTPUT \"hello\"" and return the
   * deserialized JSON value. Uses a minimal JSON parser implemented below.
   */
  static Object parseDataLine(String content, String key) {
    Pattern p = Pattern.compile("^" + key + "\\s+(.+)$", Pattern.MULTILINE);
    Matcher m = p.matcher(content);
    if (!m.find()) return null;
    String json = m.group(1).trim();
    return JsonParser.parse(json);
  }

  /**
   * Parse a line like "HASH   2uf6a6s" and return the raw string value
   * (no JSON parsing). Used for HASH which is a plain alphanumeric 7-char
   * string, not JSON.
   */
  static String parseRawDataLine(String content, String key) {
    Pattern p = Pattern.compile("^" + key + "\\s+(.+)$", Pattern.MULTILINE);
    Matcher m = p.matcher(content);
    if (!m.find()) return null;
    return m.group(1).trim();
  }

  static List<Map<String, Object>> parseClusterData(String json) {
    Object parsed = JsonParser.parse(json);
    List<Map<String, Object>> result = new ArrayList<>();
    if (parsed instanceof List) {
      for (Object item : (List<?>) parsed) {
        if (item instanceof Map) {
          result.add((Map<String, Object>) item);
        }
      }
    }
    return result;
  }
}

/**
 * Minimal JSON parser — supports null, boolean, number, string, array, object.
 * Numbers are returned as Integer, Long, or Double depending on magnitude and
 * presence of a decimal point. Maps use LinkedHashMap to preserve order.
 */
class JsonParser {
  private final String s;
  private int i;

  JsonParser(String s) {
    this.s = s;
    this.i = 0;
  }

  static Object parse(String s) {
    JsonParser p = new JsonParser(s);
    p.skipWhitespace();
    Object v = p.parseValue();
    p.skipWhitespace();
    return v;
  }

  Object parseValue() {
    skipWhitespace();
    if (i >= s.length()) throw new RuntimeException("Unexpected end of input");
    char c = s.charAt(i);
    if (c == '"') return parseString();
    if (c == '{') return parseObject();
    if (c == '[') return parseArray();
    if (c == 't' || c == 'f') return parseBoolean();
    if (c == 'n') return parseNull();
    return parseNumber();
  }

  String parseString() {
    expect('"');
    StringBuilder sb = new StringBuilder();
    while (i < s.length()) {
      char c = s.charAt(i++);
      if (c == '"') return sb.toString();
      if (c == '\\') {
        char esc = s.charAt(i++);
        switch (esc) {
          case '"': sb.append('"'); break;
          case '\\': sb.append('\\'); break;
          case '/': sb.append('/'); break;
          case 'b': sb.append('\b'); break;
          case 'f': sb.append('\f'); break;
          case 'n': sb.append('\n'); break;
          case 'r': sb.append('\r'); break;
          case 't': sb.append('\t'); break;
          case 'u':
            String hex = s.substring(i, i + 4);
            i += 4;
            sb.append((char) Integer.parseInt(hex, 16));
            break;
          default: throw new RuntimeException("Bad escape: \\" + esc);
        }
      } else {
        sb.append(c);
      }
    }
    throw new RuntimeException("Unterminated string");
  }

  Object parseObject() {
    expect('{');
    Map<String, Object> map = new LinkedHashMap<>();
    skipWhitespace();
    if (peek() == '}') { i++; return map; }
    while (true) {
      skipWhitespace();
      String key = parseString();
      skipWhitespace();
      expect(':');
      Object value = parseValue();
      map.put(key, value);
      skipWhitespace();
      char c = s.charAt(i++);
      if (c == '}') return map;
      if (c != ',') throw new RuntimeException("Expected , or }, got " + c);
    }
  }

  Object parseArray() {
    expect('[');
    List<Object> list = new ArrayList<>();
    skipWhitespace();
    if (peek() == ']') { i++; return list; }
    while (true) {
      Object value = parseValue();
      list.add(value);
      skipWhitespace();
      char c = s.charAt(i++);
      if (c == ']') return list;
      if (c != ',') throw new RuntimeException("Expected , or ], got " + c);
    }
  }

  Boolean parseBoolean() {
    if (s.startsWith("true", i)) { i += 4; return Boolean.TRUE; }
    if (s.startsWith("false", i)) { i += 5; return Boolean.FALSE; }
    throw new RuntimeException("Bad boolean at " + i);
  }

  Object parseNull() {
    if (s.startsWith("null", i)) { i += 4; return null; }
    throw new RuntimeException("Bad null at " + i);
  }

  Object parseNumber() {
    int start = i;
    while (i < s.length()) {
      char c = s.charAt(i);
      if (Character.isDigit(c) || c == '-' || c == '+' || c == '.' || c == 'e' || c == 'E') {
        i++;
      } else {
        break;
      }
    }
    String numStr = s.substring(start, i);
    if (numStr.contains(".") || numStr.contains("e") || numStr.contains("E")) {
      return Double.valueOf(numStr);
    }
    try {
      return Integer.valueOf(numStr);
    } catch (NumberFormatException e) {
      return Long.valueOf(numStr);
    }
  }

  void skipWhitespace() {
    while (i < s.length() && Character.isWhitespace(s.charAt(i))) i++;
  }

  char peek() {
    if (i >= s.length()) throw new RuntimeException("Unexpected end of input");
    return s.charAt(i);
  }

  void expect(char c) {
    if (i >= s.length() || s.charAt(i) != c) {
      throw new RuntimeException("Expected '" + c + "' at " + i + " but got '" +
          (i < s.length() ? s.charAt(i) : "<EOF>") + "'");
    }
    i++;
  }
}
JAVAEOF

echo "📄 Generated: $VALIDATE_FILE"

# ─── Compile ──────────────────────────────────────────────────────────────────

CLASSPATH_ENTRIES=("$REGRET_BUILD_DIR" "$PROJECT_DIR")
EXTRA_CP=$(node -e "
  const clusters = JSON.parse('$CLUSTERS_JSON');
  const cps = new Set();
  for (const c of clusters) {
    if (c.classPath) cps.add(c.classPath);
  }
  console.log(Array.from(cps).join(':'));
")
if [ -n "$EXTRA_CP" ]; then
  CLASSPATH_ENTRIES+=("$EXTRA_CP")
fi
CLASSPATH=$(IFS=:; echo "${CLASSPATH_ENTRIES[*]}")

echo "🔧 Compiling with classpath: $CLASSPATH"
"$JAVAC_BIN" -cp "$CLASSPATH" -d "$REGRET_BUILD_DIR" "$VALIDATE_FILE" 2>&1 || {
  echo "❌ Compilation failed."
  exit 1
}

# ─── Run ──────────────────────────────────────────────────────────────────────

echo "🧪 Running validate (runs=$RUNS)..."
"$JAVA_BIN" -cp "$CLASSPATH" RegretValidateTest "$RUNS" 2>&1

EXIT_CODE=$?
rm -f "$REGRET_BUILD_DIR"/*.class 2>/dev/null || true
exit $EXIT_CODE

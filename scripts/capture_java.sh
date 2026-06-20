#!/usr/bin/env bash
# capture_java.sh — generate, compile, and run regret capture for Java clusters
#
# Reads regrets/manifest.json, filters stack=java clusters, generates a Java
# test file that invokes each entry method with each manifest input, computes
# the 7-char base36 fingerprint (IDENTICAL to fingerprint.js), and writes
# .regret files in the same format as capture.js / capture.py.
#
# Usage:
#   bash scripts/capture_java.sh                # capture all Java clusters
#   bash scripts/capture_java.sh --cluster java-square
#   bash scripts/capture_java.sh --manifest ./regrets/manifest.json
#
# Manifest schema for Java clusters (required fields marked *):
#   {
#     "id":              "java-square",          *
#     "entry":           "square",               *  method name (public)
#     "stack":           "java",                 *
#     "className":       "com.example.MathUtils",*  fully-qualified class name
#     "file":            "src/MathUtils.java",      source file (informational)
#     "watches":         ["square"],                watched methods (informational)
#     "classPath":       "target/classes",          classpath root (default ".")
#     "classMethod":     "format",                  set for instance methods
#     "constructor":     "Formatter",               set for instance methods
#     "constructorArgs": [],                        args for constructor
#     "multiArgs":       true,                      inputs are arg-arrays
#     "fingerprintLevel":"entry",                   default "entry"
#     "inputs":          [5, 10]                  * list of inputs
#   }
#
# Cross-stack parity: this script produces .regret files IDENTICAL in format
# to those produced by capture.js / capture.py. The fingerprint algorithm is
# the same: sha256(stableStringify(input) + "|" + stableStringify(output))
# → BigInt → base36 → first 7 chars. Parity verified against fingerprint.js
# (see RegretFingerprint.java main() for the test cases).

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SKILL_DIR="$(dirname "$SCRIPT_DIR")"
PROJECT_DIR="$(pwd)"
MANIFEST="${PROJECT_DIR}/regrets/manifest.json"
REGRET_DIR="${PROJECT_DIR}/regrets"

# Ensure regrets directory exists
mkdir -p "$REGRET_DIR"

# ─── Parse CLI args ───────────────────────────────────────────────────────────

CLUSTER_FLAG=""
MANIFEST_FLAG=""
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
# Prefer PATH javac, then fall back to /home/z/.jdk/jdk-21.0.11+10/bin (worker env).
# This fallback block is for environments where the JRE is installed but the JDK
# is not on PATH. It is the only environment-specific code in this script.

JAVAC_BIN=""
JAVA_BIN=""
if command -v javac &> /dev/null; then
  JAVAC_BIN="javac"
  JAVA_BIN="java"
else
  for candidate in \
    "/home/z/.jdk/jdk-21.0.11+10/bin/javac" \
    "/usr/lib/jvm/java-21-openjdk-amd64/bin/javac" \
    "/usr/lib/jvm/java-21-openjdk/bin/javac"; do
    if [ -x "$candidate" ]; then
      JAVAC_BIN="$candidate"
      JAVA_BIN="$(dirname "$candidate")/java"
      break
    fi
  done
fi

if [ -z "$JAVAC_BIN" ]; then
  echo "❌ javac not found. Install OpenJDK 17+ or add it to PATH."
  echo "   Debian/Ubuntu: sudo apt-get install openjdk-21-jdk-headless"
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

# Print summary
echo "📡 Capturing Java clusters..."
node -e "
  const clusters = JSON.parse('$CLUSTERS_JSON');
  clusters.forEach(c => console.log('  - ' + c.id + ' (' + c.className + '.' + c.entry + ')'));
"

# ─── Build per-cluster Java source ────────────────────────────────────────────
#
# For each cluster, the generated test file:
#   1. Loads the target class via Class.forName(className)
#   2. Resolves the method via getDeclaredMethod(entry, ...)
#      - For instance methods, instantiate first via declared constructor
#      - For static methods, target is null
#   3. For each input in inputs[], invoke the method
#   4. Compute fingerprint via RegretFingerprint.fingerprint(input, output)
#   5. Use the first input/output as the golden contract
#   6. Write regrets/<id>.regret

# Per-cluster classpath: merge cluster.classPath + project root
# (project root for RegretFingerprint class). We compile RegretFingerprint
# into a known location so it can be referenced.

# Compile RegretFingerprint.java to a known classes dir
REGRET_BUILD_DIR="${REGRET_DIR}/_build"
mkdir -p "$REGRET_BUILD_DIR"

# Copy RegretFingerprint.java next to the build dir for clean compilation
cp "$SCRIPT_DIR/RegretFingerprint.java" "$REGRET_BUILD_DIR/RegretFingerprint.java"
"$JAVAC_BIN" -d "$REGRET_BUILD_DIR" "$REGRET_BUILD_DIR/RegretFingerprint.java" 2>&1 || {
  echo "❌ Failed to compile RegretFingerprint.java"
  exit 1
}

# Generate the capture test file
TEST_FILE="${REGRET_DIR}/RegretCaptureTest.java"
node -e "
  const clusters = JSON.parse('$CLUSTERS_JSON');
  const lines = [];
  lines.push('import java.io.IOException;');
  lines.push('import java.nio.charset.StandardCharsets;');
  lines.push('import java.nio.file.Files;');
  lines.push('import java.nio.file.Path;');
  lines.push('import java.nio.file.Paths;');
  lines.push('import java.lang.reflect.Constructor;');
  lines.push('import java.lang.reflect.Method;');
  lines.push('import java.time.Instant;');
  lines.push('import java.util.ArrayList;');
  lines.push('import java.util.Arrays;');
  lines.push('import java.util.HashMap;');
  lines.push('import java.util.LinkedHashMap;');
  lines.push('import java.util.List;');
  lines.push('import java.util.Map;');
  lines.push('');
  lines.push('public class RegretCaptureTest {');
  lines.push('');
  lines.push('  public static void main(String[] args) throws Exception {');
  lines.push('    int captured = 0, failed = 0;');

  for (const cluster of clusters) {
    const id = cluster.id;
    const entry = cluster.entry;
    const className = cluster.className;
    const classMethod = cluster.classMethod || null;
    const constructorName = cluster.constructor || null;
    const constructorArgs = cluster.constructorArgs || [];
    const multiArgs = !!cluster.multiArgs;
    const fingerprintLevel = cluster.fingerprintLevel || 'entry';
    const watches = (cluster.watches || [entry]);
    const inputs = cluster.inputs || [null];

    lines.push('');
    lines.push('    // ─── Cluster: ' + id + ' ────────────────────────────────');
    lines.push('    try {');

    // Load class
    lines.push('      Class<?> clazz = Class.forName(' + JSON.stringify(className) + ');');

    // Build target instance (if instance method) or null (if static)
    if (classMethod) {
      lines.push('      // Instantiate target for instance method');
      if (constructorArgs.length === 0) {
        lines.push('      Constructor<?> ctor = clazz.getDeclaredConstructor();');
        lines.push('      ctor.setAccessible(true);');
        lines.push('      Object instance = ctor.newInstance();');
      } else {
        // Build constructor args array
        lines.push('      Class<?>[] ctorParamTypes = new Class<?>[]{' +
          constructorArgs.map(a => {
            if (typeof a === 'string') return 'String.class';
            if (typeof a === 'number') return Number.isInteger(a) ? 'int.class' : 'double.class';
            if (typeof a === 'boolean') return 'boolean.class';
            return 'Object.class';
          }).join(', ') + '};');
        lines.push('      Constructor<?> ctor = clazz.getDeclaredConstructor(ctorParamTypes);');
        lines.push('      ctor.setAccessible(true);');
        lines.push('      Object instance = ctor.newInstance(' +
          constructorArgs.map(a => {
            if (typeof a === 'string') return JSON.stringify(a);
            if (typeof a === 'number') return String(a);
            if (typeof a === 'boolean') return String(a);
            return 'null';
          }).join(', ') + ');');
      }
      lines.push('      Object target = instance;');
    } else {
      lines.push('      Object target = null;  // static method');
    }

    // For each input, build the input value, invoke, capture output
    lines.push('      List<Object> allInputs = new ArrayList<>();');
    lines.push('      List<Object> allOutputs = new ArrayList<>();');
    lines.push('      List<String> allFingerprints = new ArrayList<>();');

    for (let i = 0; i < inputs.length; i++) {
      const input = inputs[i];
      lines.push('      // Input #' + i);
      let inputExpr, argListExpr;
      if (multiArgs && Array.isArray(input)) {
        // Each element of input[] becomes a method argument
        argListExpr = input.map(v => jsonToJavaLiteral(v)).join(', ');
        // The "input" for fingerprint purposes is the array itself
        inputExpr = 'Arrays.asList(' + input.map(v => jsonToJavaBoxed(v)).join(', ') + ')';
      } else {
        inputExpr = jsonToJavaBoxed(input);
        argListExpr = jsonToJavaLiteral(input);
      }
      lines.push('      Object input' + i + ' = ' + inputExpr + ';');

      // Determine method param types — for static methods, we use the runtime
      // type of the input. For multiArgs, we use the runtime types of each element.
      // Java reflection requires explicit primitive types for primitive params,
      // but for Object-typed inputs (Integer, Double, String, etc.) we use the
      // boxed class. For simplicity, we look up the method by name + arity and
      // let reflection pick the matching overload.
      if (multiArgs && Array.isArray(input)) {
        lines.push('      Class<?>[] paramTypes' + i + ' = new Class<?>[]{' +
          input.map(v => {
            if (typeof v === 'string') return 'String.class';
            if (typeof v === 'number') return Number.isInteger(v) ? 'int.class' : 'double.class';
            if (typeof v === 'boolean') return 'boolean.class';
            return 'Object.class';
          }).join(', ') + '};');
      } else {
        // Single-arg call — pick parameter type from input type
        let paramType;
        if (input === null) {
          paramType = 'Object.class';  // null input — method may have no params
        } else if (typeof input === 'string') {
          paramType = 'String.class';
        } else if (typeof input === 'number') {
          paramType = Number.isInteger(input) ? 'int.class' : 'double.class';
        } else if (typeof input === 'boolean') {
          paramType = 'boolean.class';
        } else if (Array.isArray(input)) {
          paramType = 'Object[].class';
        } else if (typeof input === 'object') {
          paramType = 'Map.class';
        } else {
          paramType = 'Object.class';
        }
        if (input === null) {
          lines.push('      Class<?>[] paramTypes' + i + ' = new Class<?>[0];');
        } else {
          lines.push('      Class<?>[] paramTypes' + i + ' = new Class<?>[]{' + paramType + '};');
        }
      }

      lines.push('      Method m' + i + ' = clazz.getDeclaredMethod(' + JSON.stringify(entry) + ', paramTypes' + i + ');');
      lines.push('      m' + i + '.setAccessible(true);');
      if (multiArgs && Array.isArray(input)) {
        lines.push('      Object[] args' + i + ' = new Object[]{' + argListExpr + '};');
      } else if (input === null) {
        lines.push('      Object[] args' + i + ' = new Object[0];');
      } else {
        lines.push('      Object[] args' + i + ' = new Object[]{' + argListExpr + '};');
      }
      lines.push('      Object output' + i + ' = m' + i + '.invoke(target, args' + i + ');');

      // Normalize output — if it's a primitive wrapped via reflection, it's
      // already boxed. If it's a Java array, convert to List for stable
      // serialization.
      lines.push('      output' + i + ' = normalizeOutput(output' + i + ');');

      // Compute fingerprint
      lines.push('      String fp' + i + ' = RegretFingerprint.fingerprint(input' + i + ', output' + i + ');');
      lines.push('      allInputs.add(input' + i + ');');
      lines.push('      allOutputs.add(output' + i + ');');
      lines.push('      allFingerprints.add(fp' + i + ');');
      lines.push('      System.out.println(\"     input #\" + ' + i + ' + \" fp=\" + fp' + i + ' + \" output=\" + RegretFingerprint.toJsonString(output' + i + '));');
    }

    // Use first as golden
    lines.push('      Object goldenInput = allInputs.get(0);');
    lines.push('      Object goldenOutput = allOutputs.get(0);');
    lines.push('      String goldenFp = allFingerprints.get(0);');
    lines.push('      String capturedAt = Instant.now().toString();');

    // Build watches array
    lines.push('      String[] watches = new String[]{' +
      watches.map(w => JSON.stringify(w)).join(', ') + '};');

    // Build regret content
    lines.push('      String regretContent = RegretFingerprint.buildRegretFile(');
    lines.push('          ' + JSON.stringify(id) + ',');
    lines.push('          goldenFp,');
    lines.push('          capturedAt,');
    lines.push('          watches,');
    lines.push('          ' + JSON.stringify(entry) + ',');
    lines.push('          ' + JSON.stringify(fingerprintLevel) + ',');
    lines.push('          goldenInput,');
    lines.push('          goldenOutput);');

    lines.push('      Path regretPath = Paths.get(' + JSON.stringify('${REGRET_DIR}/' + id + '.regret') + ');');
    lines.push('      Files.write(regretPath, regretContent.getBytes(StandardCharsets.UTF_8));');
    lines.push('      System.out.println(\"   ✅ Fingerprint: \" + goldenFp);');
    lines.push('      System.out.println(\"   📄 Saved: \" + regretPath);');
    lines.push('      captured++;');
    lines.push('    } catch (Throwable t) {');
    lines.push('      System.err.println(\"   ❌ Capture failed for ' + id + ': \" + t.getMessage());');
    lines.push('      t.printStackTrace();');
    lines.push('      failed++;');
    lines.push('    }');
  }

  lines.push('');
  lines.push('    System.out.println();');
  lines.push('    System.out.println(\"────────────────────────────────────────────────\");');
  lines.push('    System.out.println(\"Java capture complete: \" + captured + \" captured, \" + failed + \" failed\");');
  lines.push('    if (failed > 0) System.exit(1);');
  lines.push('  }');
  lines.push('');
  lines.push('  // Convert Java arrays (int[], String[], etc.) to List for stable serialization');
  lines.push('  static Object normalizeOutput(Object o) {');
  lines.push('    if (o == null) return null;');
  lines.push('    if (o.getClass().isArray()) {');
  lines.push('      int len = java.lang.reflect.Array.getLength(o);');
  lines.push('      List<Object> list = new ArrayList<>(len);');
  lines.push('      for (int i = 0; i < len; i++) {');
  lines.push('        list.add(normalizeOutput(java.lang.reflect.Array.get(o, i)));');
  lines.push('      }');
  lines.push('      return list;');
  lines.push('    }');
  lines.push('    return o;');
  lines.push('  }');
  lines.push('}');

  console.log(lines.join('\n'));

  // Helper: convert JSON value to Java expression (literal)
  function jsonToJavaLiteral(v) {
    if (v === null || v === undefined) return 'null';
    if (typeof v === 'string') return JSON.stringify(v);
    if (typeof v === 'number') {
      if (Number.isInteger(v)) return v.toString();
      return v.toString();
    }
    if (typeof v === 'boolean') return v.toString();
    if (Array.isArray(v)) {
      return 'new Object[]{' + v.map(jsonToJavaLiteral).join(', ') + '}';
    }
    if (typeof v === 'object') {
      const entries = Object.entries(v).map(([k, val]) =>
        JSON.stringify(k) + ', ' + jsonToJavaLiteral(val));
      return 'makeMap(new Object[]{' + entries.join(', ') + '})';
    }
    return 'null';
  }

  // Helper: convert JSON value to Java expression that yields Object (boxed)
  // Used for the fingerprint input value (not method invocation args).
  function jsonToJavaBoxed(v) {
    if (v === null || v === undefined) return 'null';
    if (typeof v === 'string') return JSON.stringify(v);
    if (typeof v === 'number') {
      if (Number.isInteger(v)) {
        // Use Integer.valueOf to ensure Integer type (matches JS Number)
        if (v >= -2147483648 && v <= 2147483647) return 'Integer.valueOf(' + v + ')';
        return 'Long.valueOf(' + v + 'L)';
      }
      return 'Double.valueOf(' + v + ')';
    }
    if (typeof v === 'boolean') return 'Boolean.valueOf(' + v + ')';
    if (Array.isArray(v)) {
      return 'Arrays.asList(' + v.map(jsonToJavaBoxed).join(', ') + ')';
    }
    if (typeof v === 'object') {
      const entries = Object.entries(v).map(([k, val]) =>
        JSON.stringify(k) + ', ' + jsonToJavaBoxed(val));
      return 'makeMap(new Object[]{' + entries.join(', ') + '})';
    }
    return 'null';
  }
" > "$TEST_FILE"

# Add helper method for makeMap to the test file (append before final closing brace)
# Actually we already added normalizeOutput — now add makeMap. Use sed to insert before final }
python3 -c "
import re
with open('$TEST_FILE', 'r') as f:
    content = f.read()
helper = '''
  // Build a LinkedHashMap from key-value pairs (Object[] as varargs)
  static java.util.Map<String, Object> makeMap(Object[] kvPairs) {
    java.util.LinkedHashMap<String, Object> map = new java.util.LinkedHashMap<>();
    for (int i = 0; i + 1 < kvPairs.length; i += 2) {
      map.put(String.valueOf(kvPairs[i]), kvPairs[i + 1]);
    }
    return map;
  }
'''
# Insert before the last closing brace
idx = content.rfind('}')
content = content[:idx] + helper + '}\n'
with open('$TEST_FILE', 'w') as f:
    f.write(content)
"

echo "📄 Generated: $TEST_FILE"

# ─── Compile ──────────────────────────────────────────────────────────────────
#
# Classpath:
#   - $REGRET_BUILD_DIR (contains RegretFingerprint.class)
#   - All cluster.classPath entries (deduplicated)
#   - Project root (.)

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
"$JAVAC_BIN" -cp "$CLASSPATH" -d "$REGRET_BUILD_DIR" "$TEST_FILE" 2>&1 || {
  echo "❌ Compilation failed."
  exit 1
}

# ─── Run ──────────────────────────────────────────────────────────────────────

echo "🧪 Running capture..."
"$JAVA_BIN" -cp "$CLASSPATH" RegretCaptureTest 2>&1

EXIT_CODE=$?
# Cleanup class files (keep source for inspection)
rm -f "$REGRET_BUILD_DIR"/*.class 2>/dev/null || true
exit $EXIT_CODE

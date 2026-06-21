// RegretJava.java — capture + validate regret contracts for Java clusters.
//
// Single-file source mode (JEP 330) — runnable via `java RegretJava.java`.
// All helper classes are nested inside `RegretJava` so the file compiles
// as a single compilation unit.
//
// Usage:
//   java RegretJava.java capture  [--cluster <id>] [--manifest <path>]
//   java RegretJava.java validate [--cluster <id>] [--manifest <path>]
//
// Reads `regrets/manifest.json`, filters clusters with `stack: "java"`,
// invokes the target static method via reflection, computes the
// 7-char base36 fingerprint (identical algorithm to fingerprint.js),
// and writes / compares `.regret` files using the standard format:
//
//   cluster: <id>
//   version: 1
//   fingerprint: <hash>
//   captured: <ISO-8601>
//   watches: [a, b]
//   entry: <method>
//   stack: java
//   fingerprintLevel: entry
//   ---
//   INPUT  <json>
//   OUTPUT <json>
//   HASH   <hash>
//
// Cross-stack parity: the fingerprint function MUST produce identical
// output to fingerprint.js / fingerprint.py for the same (input, output)
// pair. Verified by `proof/java/verify-parity.mjs`.

import java.io.IOException;
import java.lang.reflect.Method;
import java.lang.reflect.Modifier;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.security.MessageDigest;
import java.time.Instant;
import java.time.ZoneOffset;
import java.time.format.DateTimeFormatter;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.TreeMap;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

public class RegretJava {

    // ─── Entry point ────────────────────────────────────────────────────────

    public static void main(String[] args) throws Exception {
        if (args.length == 0) {
            System.err.println("Usage: java RegretJava.java <capture|validate> [--cluster <id>] [--manifest <path>]");
            System.exit(2);
        }
        String mode = args[0];
        String clusterFilter = null;
        Path manifestPath = Paths.get(System.getProperty("user.dir"), "regrets", "manifest.json");

        for (int i = 1; i < args.length; i++) {
            if ("--cluster".equals(args[i]) && i + 1 < args.length) {
                clusterFilter = args[++i];
            } else if ("--manifest".equals(args[i]) && i + 1 < args.length) {
                manifestPath = Paths.get(args[++i]);
            }
        }

        switch (mode) {
            case "capture":
                runCapture(manifestPath, clusterFilter);
                break;
            case "validate":
                runValidate(manifestPath, clusterFilter);
                break;
            default:
                System.err.println("Unknown mode: " + mode);
                System.exit(2);
        }
    }

    // ─── Capture ────────────────────────────────────────────────────────────

    private static void runCapture(Path manifestPath, String clusterFilter) throws Exception {
        if (!Files.exists(manifestPath)) {
            System.err.println("❌ manifest not found: " + manifestPath);
            System.exit(1);
        }
        List<Map<String, Object>> clusters = readJavaClusters(manifestPath, clusterFilter);
        if (clusters.isEmpty()) {
            System.out.println("No Java clusters found in manifest.");
            return;
        }

        Path regretDir = manifestPath.getParent(); // regrets/
        Files.createDirectories(regretDir);

        int captured = 0, skipped = 0, failed = 0;
        for (Map<String, Object> cluster : clusters) {
            String id = str(cluster.get("id"));
            System.out.println("\n📡 Capturing Java cluster: " + id);
            try {
                CaptureResult result = captureCluster(cluster);
                if (result.skipped) {
                    System.out.println("   ⏭️  Skipped: " + result.skipReason);
                    skipped++;
                    continue;
                }
                Path regretPath = regretDir.resolve(id + ".regret");
                Files.writeString(regretPath, result.regretContent, StandardCharsets.UTF_8);
                System.out.println("   ✅ Fingerprint: " + result.fingerprint);
                System.out.println("   📄 Saved: " + regretPath);
                captured++;
            } catch (Exception e) {
                System.out.println("   ❌ Capture failed: " + e.getMessage());
                e.printStackTrace(System.out);
                failed++;
            }
        }
        System.out.println("\n────────────────────────────────────────");
        System.out.printf("Captured: %d  Skipped: %d  Failed: %d%n", captured, skipped, failed);
        if (failed > 0) System.exit(1);
    }

    // ─── Validate ───────────────────────────────────────────────────────────

    private static void runValidate(Path manifestPath, String clusterFilter) throws Exception {
        if (!Files.exists(manifestPath)) {
            System.err.println("❌ manifest not found: " + manifestPath);
            System.exit(1);
        }
        List<Map<String, Object>> clusters = readJavaClusters(manifestPath, clusterFilter);
        if (clusters.isEmpty()) {
            System.out.println("No Java clusters found in manifest.");
            return;
        }

        Path regretDir = manifestPath.getParent();
        int passed = 0, failed = 0, missing = 0;

        for (Map<String, Object> cluster : clusters) {
            String id = str(cluster.get("id"));
            System.out.println("\n🔍 Validating Java cluster: " + id);
            Path regretPath = regretDir.resolve(id + ".regret");
            if (!Files.exists(regretPath)) {
                System.out.println("   ❌ MISSING .regret file: " + regretPath);
                missing++;
                continue;
            }
            try {
                String regretContent = Files.readString(regretPath, StandardCharsets.UTF_8);
                Map<String, Object> golden = parseRegret(regretContent);
                String goldenHash = str(golden.get("HASH"));
                Object goldenInput = golden.get("INPUT");
                Object goldenOutput = golden.get("OUTPUT");

                // Re-invoke with the same input
                CaptureResult live = captureCluster(cluster, goldenInput);
                if (live.skipped) {
                    System.out.println("   ❌ Skipped during re-capture: " + live.skipReason);
                    failed++;
                    continue;
                }
                String liveHash = live.fingerprint;
                Object liveOutput = live.output;

                if (goldenHash.equals(liveHash)) {
                    System.out.println("   ✅ PASS  (hash " + liveHash + ")");
                    passed++;
                } else {
                    System.out.println("   ❌ FAIL  golden=" + goldenHash + "  live=" + liveHash);
                    System.out.println("   Golden output: " + Json.stringify(goldenOutput));
                    System.out.println("   Live   output: " + Json.stringify(liveOutput));
                    failed++;
                }
            } catch (Exception e) {
                System.out.println("   ❌ Validate error: " + e.getMessage());
                e.printStackTrace(System.out);
                failed++;
            }
        }
        System.out.println("\n────────────────────────────────────────");
        System.out.printf("Passed: %d  Failed: %d  Missing: %d%n", passed, failed, missing);
        if (failed > 0 || missing > 0) System.exit(1);
    }

    // ─── Cluster capture ────────────────────────────────────────────────────

    private static CaptureResult captureCluster(Map<String, Object> cluster) throws Exception {
        return captureCluster(cluster, null);
    }

    private static CaptureResult captureCluster(Map<String, Object> cluster, Object overrideInput) throws Exception {
        String id = str(cluster.get("id"));
        String className = str(cluster.get("class"));
        String methodName = str(cluster.getOrDefault("method", cluster.get("entry")));
        String classpath = cluster.containsKey("classpath") ? str(cluster.get("classpath")) : null;
        boolean multiArgs = bool(cluster.get("multiArgs"));

        if (className.isEmpty()) {
            throw new IllegalArgumentException("cluster `" + id + "` missing required field: class");
        }
        if (methodName.isEmpty()) {
            throw new IllegalArgumentException("cluster `" + id + "` missing required field: method (or entry)");
        }

        // Resolve input
        Object input;
        if (overrideInput != null) {
            input = overrideInput;
        } else if (cluster.containsKey("inputs") && cluster.get("inputs") != null) {
            List<?> inputs = (List<?>) cluster.get("inputs");
            if (inputs.isEmpty()) {
                input = null;
            } else {
                // Use the first input. Multiple inputs would require per-input
                // .regret files (INPUTS line) — not in scope for v1.
                input = inputs.get(0);
            }
        } else {
            input = null;
        }

        // Load class via reflection
        ClassLoader cl = buildClassLoader(classpath);
        Class<?> targetClass = Class.forName(className, true, cl);
        Method method = findStaticMethod(targetClass, methodName, input, multiArgs);
        if (method == null) {
            throw new NoSuchMethodException(
                "No static method `" + methodName + "` on " + className +
                " matching input arity " + (multiArgs ? "(multiArgs=true)" : "(single arg)"));
        }

        // Invoke
        Object[] args = buildArgs(method, input, multiArgs);
        Object output;
        try {
            output = method.invoke(null, args);
        } catch (java.lang.reflect.InvocationTargetException ite) {
            Throwable cause = ite.getCause();
            // Trivial-input guard: thrown output → skip cluster (matches JS behavior)
            return new CaptureResult(true, "method threw: " + (cause == null ? "unknown" : cause.getMessage()),
                                     null, null, null, null);
        }

        // Trivial-input guard: null/NaN output → skip
        if (output == null) {
            return new CaptureResult(true, "output is null (trivial-input guard)",
                                     null, null, null, null);
        }
        if (output instanceof Double && Double.isNaN((Double) output)) {
            return new CaptureResult(true, "output is NaN (trivial-input guard)",
                                     null, null, null, null);
        }

        // Compute fingerprint
        Object cleanInput = (overrideInput != null) ? overrideInput : input;
        String fp = Fingerprint.compute(cleanInput, output);

        // Build .regret file content
        String regretContent = buildRegretFile(cluster, id, methodName, cleanInput, output, fp);
        return new CaptureResult(false, null, fp, output, cleanInput, regretContent);
    }

    private static Method findStaticMethod(Class<?> cls, String name, Object input, boolean multiArgs) {
        // Try every method with the matching name; pick the first one whose
        // parameter count matches what we'd build.
        int desiredArity = computeDesiredArity(input, multiArgs);
        Method candidate = null;
        for (Method m : cls.getDeclaredMethods()) {
            if (!m.getName().equals(name)) continue;
            if (!Modifier.isStatic(m.getModifiers())) continue;
            m.setAccessible(true);
            if (m.getParameterCount() == desiredArity) {
                return m;
            }
            if (candidate == null) candidate = m; // fallback
        }
        // Allow varargs / arity mismatch to surface later (buildArgs may throw)
        return candidate;
    }

    private static int computeDesiredArity(Object input, boolean multiArgs) {
        if (input == null) return 0;
        if (multiArgs && input instanceof List) return ((List<?>) input).size();
        return 1;
    }

    private static Object[] buildArgs(Method m, Object input, boolean multiArgs) {
        int paramCount = m.getParameterCount();
        Class<?>[] paramTypes = m.getParameterTypes();

        if (paramCount == 0) {
            return new Object[0];
        }

        // Coerce input to args list
        List<Object> argList = new ArrayList<>();
        if (multiArgs && input instanceof List) {
            for (Object o : (List<?>) input) argList.add(o);
        } else {
            argList.add(input);
        }

        if (argList.size() != paramCount) {
            // For varargs, allow fewer args than paramCount by passing the last as null
            if (!m.isVarArgs() || argList.size() > paramCount) {
                throw new IllegalArgumentException(
                    "Method " + m.getName() + " expects " + paramCount +
                    " args but input provides " + argList.size());
            }
            // pad with nulls
            while (argList.size() < paramCount) argList.add(null);
        }

        Object[] args = new Object[paramCount];
        for (int i = 0; i < paramCount; i++) {
            Class<?> expected = paramTypes[i];
            Object val = argList.get(i);
            // Varargs: last param is array type
            if (i == paramCount - 1 && m.isVarArgs() && val != null && !expected.isInstance(val)) {
                Class<?> componentType = expected.getComponentType();
                if (val instanceof List) {
                    List<?> list = (List<?>) val;
                    Object array = java.lang.reflect.Array.newInstance(componentType, list.size());
                    for (int j = 0; j < list.size(); j++) {
                        java.lang.reflect.Array.set(array, j, coerce(list.get(j), componentType));
                    }
                    args[i] = array;
                    continue;
                }
            }
            args[i] = coerce(val, expected.isPrimitive() ? box(expected) : expected);
        }
        return args;
    }

    private static Class<?> box(Class<?> primitive) {
        if (primitive == int.class) return Integer.class;
        if (primitive == long.class) return Long.class;
        if (primitive == double.class) return Double.class;
        if (primitive == float.class) return Float.class;
        if (primitive == boolean.class) return Boolean.class;
        if (primitive == short.class) return Short.class;
        if (primitive == byte.class) return Byte.class;
        if (primitive == char.class) return Character.class;
        return primitive;
    }

    @SuppressWarnings("unchecked")
    private static Object coerce(Object val, Class<?> target) {
        if (val == null) return null;
        if (target.isInstance(val)) return val;
        // Numeric coercions
        if (val instanceof Number) {
            Number n = (Number) val;
            if (target == Integer.class || target == int.class) return n.intValue();
            if (target == Long.class || target == long.class) return n.longValue();
            if (target == Double.class || target == double.class) return n.doubleValue();
            if (target == Float.class || target == float.class) return n.floatValue();
            if (target == Short.class || target == short.class) return n.shortValue();
            if (target == Byte.class || target == byte.class) return n.byteValue();
        }
        if (val instanceof String) {
            String s = (String) val;
            if (target == Integer.class || target == int.class) return Integer.parseInt(s);
            if (target == Long.class || target == long.class) return Long.parseLong(s);
            if (target == Double.class || target == double.class) return Double.parseDouble(s);
            if (target == Boolean.class || target == boolean.class) return Boolean.parseBoolean(s);
        }
        if (target == Character.class || target == char.class) {
            if (val instanceof String && ((String) val).length() == 1) {
                return ((String) val).charAt(0);
            }
        }
        // Boolean from number
        if (val instanceof Number && (target == Boolean.class || target == boolean.class)) {
            return ((Number) val).intValue() != 0;
        }
        // List → array
        if (target.isArray() && val instanceof List) {
            List<?> list = (List<?>) val;
            Class<?> componentType = target.getComponentType();
            Object array = java.lang.reflect.Array.newInstance(componentType, list.size());
            for (int i = 0; i < list.size(); i++) {
                java.lang.reflect.Array.set(array, i, coerce(list.get(i), componentType));
            }
            return array;
        }
        // Map → no generic coercion (callers should pass JSON-compatible types)
        throw new IllegalArgumentException(
            "Cannot coerce " + val.getClass().getName() + " to " + target.getName());
    }

    // ─── Classloader ────────────────────────────────────────────────────────

    private static ClassLoader buildClassLoader(String classpath) throws Exception {
        if (classpath == null || classpath.isEmpty()) {
            return RegretJava.class.getClassLoader();
        }
        String[] parts = classpath.split(System.getProperty("path.separator"));
        List<java.net.URL> urls = new ArrayList<>();
        for (String p : parts) {
            if (p.isEmpty()) continue;
            java.io.File f = new java.io.File(p);
            urls.add(f.toURI().toURL());
        }
        return new java.net.URLClassLoader(urls.toArray(new java.net.URL[0]),
                                           RegretJava.class.getClassLoader());
    }

    // ─── .regret file build & parse ─────────────────────────────────────────

    private static String buildRegretFile(Map<String, Object> cluster,
                                          String id,
                                          String methodName,
                                          Object input,
                                          Object output,
                                          String fp) {
        List<String> watches = cluster.containsKey("watches")
            ? listOfStrings(cluster.get("watches"))
            : new ArrayList<>();
        if (watches.isEmpty()) watches.add(methodName);

        String fingerprintLevel = str(cluster.getOrDefault("fingerprintLevel", "entry"));
        String entry = str(cluster.getOrDefault("entry", methodName));
        String stack = str(cluster.getOrDefault("stack", "java"));
        boolean multiArgs = bool(cluster.get("multiArgs"));

        StringBuilder sb = new StringBuilder();
        sb.append("cluster: ").append(id).append('\n');
        sb.append("version: 1").append('\n');
        sb.append("fingerprint: ").append(fp).append('\n');
        sb.append("captured: ").append(isoNow()).append('\n');
        sb.append("watches: [").append(String.join(", ", watches)).append("]\n");
        sb.append("entry: ").append(entry).append('\n');
        sb.append("stack: ").append(stack).append('\n');
        sb.append("class: ").append(cluster.get("class")).append('\n');
        sb.append("fingerprintLevel: ").append(fingerprintLevel).append('\n');
        if (multiArgs) sb.append("multiArgs: True\n");
        sb.append("---\n");
        sb.append("INPUT  ").append(Json.stringify(input)).append('\n');
        sb.append("OUTPUT ").append(Json.stringify(output)).append('\n');
        sb.append("HASH   ").append(fp).append('\n');
        return sb.toString();
    }

    private static Map<String, Object> parseRegret(String content) {
        Map<String, Object> result = new LinkedHashMap<>();
        String[] lines = content.split("\n", -1);
        // Match the first word (key) followed by whitespace, then the rest (value).
        // Works for both `key: value` header lines and `KEY  value` / `KEY value`
        // padded-block lines (INPUT/OUTPUT/HASH use 7-char alignment via variable
        // space counts, so a single-space split is required).
        Pattern kv = Pattern.compile("^(\\S+)\\s+(.*)$");
        Pattern headerKv = Pattern.compile("^(\\S+):\\s+(.*)$");
        for (String line : lines) {
            if (line.equals("---")) continue;
            if (line.isEmpty()) continue;
            String key = null, val = null;
            // Try header form `key: value` first (so keys with colons don't get
            // truncated at the first whitespace).
            Matcher hm = headerKv.matcher(line);
            if (hm.matches()) { key = hm.group(1); val = hm.group(2); }
            else {
                Matcher m = kv.matcher(line);
                if (m.matches()) { key = m.group(1); val = m.group(2); }
            }
            if (key == null) continue;
            switch (key) {
                case "INPUT":
                    result.put("INPUT", Json.parse(val));
                    break;
                case "OUTPUT":
                    result.put("OUTPUT", Json.parse(val));
                    break;
                case "HASH":
                    result.put("HASH", val.trim());
                    break;
                case "fingerprint":
                    result.put("fingerprint", val.trim());
                    break;
                default:
                    result.put(key, val);
            }
        }
        return result;
    }

    // ─── Manifest reading ───────────────────────────────────────────────────

    @SuppressWarnings("unchecked")
    private static List<Map<String, Object>> readJavaClusters(Path manifestPath, String filter) throws Exception {
        String content = new String(Files.readAllBytes(manifestPath), StandardCharsets.UTF_8);
        Object parsed = Json.parse(content);
        if (!(parsed instanceof Map)) {
            throw new IllegalArgumentException("manifest root must be an object");
        }
        Map<String, Object> root = (Map<String, Object>) parsed;
        Object clustersObj = root.get("clusters");
        if (!(clustersObj instanceof List)) {
            throw new IllegalArgumentException("manifest.clusters must be an array");
        }
        List<Map<String, Object>> out = new ArrayList<>();
        for (Object c : (List<?>) clustersObj) {
            if (!(c instanceof Map)) continue;
            Map<String, Object> cluster = (Map<String, Object>) c;
            if (!"java".equals(str(cluster.get("stack")))) continue;
            if (filter != null && !filter.equals(str(cluster.get("id")))) continue;
            out.add(cluster);
        }
        return out;
    }

    // ─── Helpers ────────────────────────────────────────────────────────────

    private static String str(Object o) {
        return o == null ? "" : o.toString();
    }

    private static boolean bool(Object o) {
        if (o == null) return false;
        if (o instanceof Boolean) return (Boolean) o;
        String s = o.toString().trim().toLowerCase();
        return s.equals("true") || s.equals("yes") || s.equals("1");
    }

    @SuppressWarnings("unchecked")
    private static List<String> listOfStrings(Object o) {
        if (o == null) return new ArrayList<>();
        if (o instanceof List) {
            List<String> out = new ArrayList<>();
            for (Object x : (List<?>) o) out.add(x == null ? "" : x.toString());
            return out;
        }
        List<String> out = new ArrayList<>();
        out.add(o.toString());
        return out;
    }

    private static String isoNow() {
        return DateTimeFormatter.ISO_OFFSET_DATE_TIME
            .withZone(ZoneOffset.UTC)
            .format(Instant.now());
    }

    // ─── Result record ──────────────────────────────────────────────────────

    private static final class CaptureResult {
        final boolean skipped;
        final String skipReason;
        final String fingerprint;
        final Object output;
        final Object input;
        final String regretContent;

        CaptureResult(boolean skipped, String skipReason, String fingerprint,
                      Object output, Object input, String regretContent) {
            this.skipped = skipped;
            this.skipReason = skipReason;
            this.fingerprint = fingerprint;
            this.output = output;
            this.input = input;
            this.regretContent = regretContent;
        }
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Fingerprint — MUST be byte-for-byte identical to fingerprint.js
    // ─────────────────────────────────────────────────────────────────────────

    static final class Fingerprint {
        static String compute(Object input, Object output) throws Exception {
            String combined = Json.stableStringify(input) + "|" + Json.stableStringify(output);
            MessageDigest md = MessageDigest.getInstance("SHA-256");
            byte[] hash = md.digest(combined.getBytes(StandardCharsets.UTF_8));
            // Hex string
            StringBuilder hex = new StringBuilder();
            for (byte b : hash) hex.append(String.format("%02x", b));
            // Hex → BigInt → base36
            String b36 = toBase36(hex.toString());
            return b36.length() >= 7 ? b36.substring(0, 7) : b36;
        }

        private static String toBase36(String hex) {
            // Parse hex into a big integer
            java.math.BigInteger n = new java.math.BigInteger(hex, 16);
            if (n.signum() == 0) return "0";
            String chars = "0123456789abcdefghijklmnopqrstuvwxyz";
            java.math.BigInteger base = java.math.BigInteger.valueOf(36);
            java.math.BigInteger zero = java.math.BigInteger.ZERO;
            StringBuilder sb = new StringBuilder();
            java.math.BigInteger tmp = n.abs();
            while (tmp.compareTo(zero) > 0) {
                java.math.BigInteger[] divMod = tmp.divideAndRemainder(base);
                tmp = divMod[0];
                sb.insert(0, chars.charAt(divMod[1].intValue()));
            }
            return sb.toString();
        }
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Json — minimal JSON parser + stable stringify (sorted keys).
    // Stable stringify must match fingerprint.js:stableStringify output.
    // ─────────────────────────────────────────────────────────────────────────

    static final class Json {
        // ── Parse ──
        static Object parse(String s) {
            Parser p = new Parser(s);
            p.skipWs();
            Object v = p.parseValue();
            p.skipWs();
            if (p.pos < p.s.length()) {
                throw new IllegalArgumentException(
                    "Trailing characters at pos " + p.pos + ": " + p.s.substring(p.pos, Math.min(p.pos + 20, p.s.length())));
            }
            return v;
        }

        // ── Stringify (standard, not sorted — used for display) ──
        // Matches JS JSON.stringify semantics for the .regret file's OUTPUT line:
        //   - NaN / +Infinity / -Infinity  →  "null"   (invalid JSON otherwise)
        //   - Whole-valued doubles          →  written as int ("0", not "0.0")
        //   - Other doubles                 →  Double.toString (matches JS Number→string)
        // Cross-stack note: JS uses `JSON.stringify(output)` for the OUTPUT line,
        // so the .regret file produced by Java must be byte-identical to one
        // produced by JS for the same output value. Without this normalization,
        // a Java-captured .regret file containing NaN/Infinity cannot be parsed
        // by validate's Json.parse (which only accepts standard JSON tokens),
        // and a JS validate would also choke on the bare `NaN`/`Infinity` words.
        static String stringify(Object o) {
            StringBuilder sb = new StringBuilder();
            writeStandard(o, sb);
            return sb.toString();
        }

        private static void writeStandard(Object o, StringBuilder sb) {
            if (o == null) { sb.append("null"); return; }
            if (o instanceof String) { writeString((String) o, sb); return; }
            if (o instanceof Boolean) { sb.append(o.toString()); return; }
            if (o instanceof Number) {
                Number n = (Number) o;
                // JS JSON.stringify(NaN) === "null", JSON.stringify(Infinity) === "null".
                // Emit "null" for any non-finite double so the OUTPUT line stays
                // valid JSON (parseable by both Java's Json.parse and JS JSON.parse).
                if (n instanceof Double || n instanceof Float) {
                    double d = n.doubleValue();
                    if (Double.isNaN(d) || Double.isInfinite(d)) {
                        sb.append("null");
                        return;
                    }
                    // JS JSON.stringify(0.0) === "0" (no decimal point for whole doubles).
                    if (d == Math.floor(d) && Math.abs(d) < 1e21) {
                        sb.append(Long.toString((long) d));
                        return;
                    }
                    sb.append(Double.toString(d));
                    return;
                }
                // Integer/Long/Short/Byte — pass through as-is.
                sb.append(n.toString());
                return;
            }
            if (o instanceof Character) { writeString(o.toString(), sb); return; }
            if (o instanceof List) {
                sb.append('[');
                List<?> l = (List<?>) o;
                for (int i = 0; i < l.size(); i++) {
                    if (i > 0) sb.append(',');
                    writeStandard(l.get(i), sb);
                }
                sb.append(']');
                return;
            }
            if (o instanceof Map) {
                sb.append('{');
                Map<?, ?> m = (Map<?, ?>) o;
                int i = 0;
                for (Map.Entry<?, ?> e : m.entrySet()) {
                    if (i++ > 0) sb.append(',');
                    writeString(String.valueOf(e.getKey()), sb);
                    sb.append(':');
                    writeStandard(e.getValue(), sb);
                }
                sb.append('}');
                return;
            }
            if (o.getClass().isArray()) {
                int len = java.lang.reflect.Array.getLength(o);
                sb.append('[');
                for (int i = 0; i < len; i++) {
                    if (i > 0) sb.append(',');
                    writeStandard(java.lang.reflect.Array.get(o, i), sb);
                }
                sb.append(']');
                return;
            }
            // Fallback: toString as string
            writeString(o.toString(), sb);
        }

        private static void writeString(String s, StringBuilder sb) {
            sb.append('"');
            for (int i = 0; i < s.length(); i++) {
                char c = s.charAt(i);
                switch (c) {
                    case '"':  sb.append("\\\""); break;
                    case '\\': sb.append("\\\\"); break;
                    case '\b': sb.append("\\b"); break;
                    case '\f': sb.append("\\f"); break;
                    case '\n': sb.append("\\n"); break;
                    case '\r': sb.append("\\r"); break;
                    case '\t': sb.append("\\t"); break;
                    default:
                        if (c < 0x20) {
                            sb.append(String.format("\\u%04x", (int) c));
                        } else {
                            sb.append(c);
                        }
                }
            }
            sb.append('"');
        }

        // ── Stable stringify (sorted keys) — matches fingerprint.js ──
        static String stableStringify(Object o) {
            return stableStringify(o, null);
        }

        private static String stableStringify(Object o, java.util.Set<Object> seen) {
            if (o == null) return "null";
            if (o instanceof Boolean) return o.toString();
            if (o instanceof Number) {
                // Match JS Number.toString() / JSON.stringify behavior
                Number n = (Number) o;
                double d = n.doubleValue();
                if (Double.isNaN(d)) return "\"__nan__\"";
                if (d == Double.POSITIVE_INFINITY) return "\"__infinity__\"";
                if (d == Double.NEGATIVE_INFINITY) return "\"__neg_infinity__\"";
                if (o instanceof Integer || o instanceof Long || o instanceof Short || o instanceof Byte) {
                    return Long.toString(n.longValue());
                }
                // Floats: match JS Number → %g-like
                if (d == Math.floor(d) && !Double.isInfinite(d) && Math.abs(d) < 1e21) {
                    return Long.toString((long) d);
                }
                return Double.toString(d);
            }
            if (o instanceof String) {
                StringBuilder sb = new StringBuilder();
                writeString((String) o, sb);
                return sb.toString();
            }
            if (o instanceof Character) {
                StringBuilder sb = new StringBuilder();
                writeString(o.toString(), sb);
                return sb.toString();
            }
            if (o instanceof List) {
                if (seen == null) seen = new java.util.HashSet<>();
                if (seen.contains(o)) return "\"__circular__\"";
                seen.add(o);
                List<?> l = (List<?>) o;
                StringBuilder sb = new StringBuilder();
                sb.append('[');
                for (int i = 0; i < l.size(); i++) {
                    if (i > 0) sb.append(',');
                    sb.append(stableStringify(l.get(i), seen));
                }
                sb.append(']');
                seen.remove(o);
                return sb.toString();
            }
            if (o instanceof Map) {
                if (seen == null) seen = new java.util.HashSet<>();
                if (seen.contains(o)) return "\"__circular__\"";
                seen.add(o);
                Map<?, ?> m = (Map<?, ?>) o;
                List<String> keys = new ArrayList<>();
                for (Object k : m.keySet()) keys.add(String.valueOf(k));
                java.util.Collections.sort(keys);
                StringBuilder sb = new StringBuilder();
                sb.append('{');
                for (int i = 0; i < keys.size(); i++) {
                    if (i > 0) sb.append(',');
                    String k = keys.get(i);
                    StringBuilder ksb = new StringBuilder();
                    writeString(k, ksb);
                    sb.append(ksb.toString()).append(':');
                    sb.append(stableStringify(m.get(k), seen));
                }
                sb.append('}');
                seen.remove(o);
                return sb.toString();
            }
            if (o.getClass().isArray()) {
                int len = java.lang.reflect.Array.getLength(o);
                if (seen == null) seen = new java.util.HashSet<>();
                if (seen.contains(o)) return "\"__circular__\"";
                seen.add(o);
                StringBuilder sb = new StringBuilder();
                sb.append('[');
                for (int i = 0; i < len; i++) {
                    if (i > 0) sb.append(',');
                    sb.append(stableStringify(java.lang.reflect.Array.get(o, i), seen));
                }
                sb.append(']');
                seen.remove(o);
                return sb.toString();
            }
            // Fallback: treat as string
            StringBuilder sb = new StringBuilder();
            writeString(o.toString(), sb);
            return sb.toString();
        }

        // ── Parser ──
        private static final class Parser {
            final String s;
            int pos = 0;
            Parser(String s) { this.s = s; }
            void skipWs() {
                while (pos < s.length() && Character.isWhitespace(s.charAt(pos))) pos++;
            }
            Object parseValue() {
                skipWs();
                if (pos >= s.length()) throw new IllegalArgumentException("Unexpected EOF");
                char c = s.charAt(pos);
                switch (c) {
                    case '{': return parseObject();
                    case '[': return parseArray();
                    case '"': return parseString();
                    case 't': case 'f': return parseBool();
                    case 'n': return parseNull();
                    default: return parseNumber();
                }
            }
            Map<String, Object> parseObject() {
                Map<String, Object> m = new LinkedHashMap<>();
                expect('{');
                skipWs();
                if (peek() == '}') { pos++; return m; }
                while (true) {
                    skipWs();
                    String key = parseString();
                    skipWs();
                    expect(':');
                    Object val = parseValue();
                    m.put(key, val);
                    skipWs();
                    char c = next();
                    if (c == ',') continue;
                    if (c == '}') break;
                    throw new IllegalArgumentException("Expected , or } at pos " + (pos - 1));
                }
                return m;
            }
            List<Object> parseArray() {
                List<Object> l = new ArrayList<>();
                expect('[');
                skipWs();
                if (peek() == ']') { pos++; return l; }
                while (true) {
                    l.add(parseValue());
                    skipWs();
                    char c = next();
                    if (c == ',') continue;
                    if (c == ']') break;
                    throw new IllegalArgumentException("Expected , or ] at pos " + (pos - 1));
                }
                return l;
            }
            String parseString() {
                expect('"');
                StringBuilder sb = new StringBuilder();
                while (pos < s.length()) {
                    char c = s.charAt(pos++);
                    if (c == '"') return sb.toString();
                    if (c == '\\') {
                        if (pos >= s.length()) throw new IllegalArgumentException("Unterminated escape");
                        char e = s.charAt(pos++);
                        switch (e) {
                            case '"': sb.append('"'); break;
                            case '\\': sb.append('\\'); break;
                            case '/': sb.append('/'); break;
                            case 'b': sb.append('\b'); break;
                            case 'f': sb.append('\f'); break;
                            case 'n': sb.append('\n'); break;
                            case 'r': sb.append('\r'); break;
                            case 't': sb.append('\t'); break;
                            case 'u':
                                if (pos + 4 > s.length()) throw new IllegalArgumentException("Bad \\u escape");
                                String hex = s.substring(pos, pos + 4);
                                pos += 4;
                                sb.append((char) Integer.parseInt(hex, 16));
                                break;
                            default: throw new IllegalArgumentException("Bad escape: \\" + e);
                        }
                    } else {
                        sb.append(c);
                    }
                }
                throw new IllegalArgumentException("Unterminated string");
            }
            Object parseNumber() {
                int start = pos;
                while (pos < s.length()) {
                    char c = s.charAt(pos);
                    if (Character.isDigit(c) || c == '-' || c == '+' || c == '.' || c == 'e' || c == 'E') {
                        pos++;
                    } else break;
                }
                if (start == pos) throw new IllegalArgumentException("Unexpected char at pos " + pos + ": " + s.charAt(pos));
                String num = s.substring(start, pos);
                if (num.contains(".") || num.contains("e") || num.contains("E")) {
                    return Double.parseDouble(num);
                }
                try {
                    return Long.parseLong(num);
                } catch (NumberFormatException ex) {
                    return Double.parseDouble(num);
                }
            }
            Boolean parseBool() {
                if (s.startsWith("true", pos)) { pos += 4; return Boolean.TRUE; }
                if (s.startsWith("false", pos)) { pos += 5; return Boolean.FALSE; }
                throw new IllegalArgumentException("Bad bool at pos " + pos);
            }
            Object parseNull() {
                if (s.startsWith("null", pos)) { pos += 4; return null; }
                throw new IllegalArgumentException("Bad null at pos " + pos);
            }
            char peek() { skipWs(); return pos < s.length() ? s.charAt(pos) : '\0'; }
            char next() { if (pos >= s.length()) throw new IllegalArgumentException("Unexpected EOF"); return s.charAt(pos++); }
            void expect(char c) {
                skipWs();
                if (pos >= s.length() || s.charAt(pos) != c) {
                    throw new IllegalArgumentException("Expected '" + c + "' at pos " + pos);
                }
                pos++;
            }
        }
    }
}

// ─────────────────────────────────────────────────────────────────────────
// DemoTarget — pure functions used as the capture target in `proof/java/`.
//
// Lives inside RegretJava.java so the demo runs on a JRE-only environment
// (no javac needed — single-file source mode compiles this class too).
// Real-world Java projects compile their code with `javac`/`mvn`/`gradle`
// first, then point the manifest's `class` field at their FQCN and pass
// `classpath` so RegretJava loads the production classes via reflection.
// ─────────────────────────────────────────────────────────────────────────

final class DemoMathUtils {
    private DemoMathUtils() {}

    /** Add two integers. */
    public static int add(int a, int b) {
        return a + b;
    }

    /** Compute the n-th Fibonacci number (0-indexed, iterative). */
    public static long fibonacci(int n) {
        if (n < 0) throw new IllegalArgumentException("n must be >= 0");
        if (n == 0) return 0L;
        if (n == 1) return 1L;
        long a = 0, b = 1;
        for (int i = 2; i <= n; i++) {
            long c = a + b;
            a = b;
            b = c;
        }
        return b;
    }

    /** Reverse a string by code point (preserves surrogate pairs). */
    public static String reverse(String s) {
        if (s == null) return null;
        int[] cps = s.codePoints().toArray();
        StringBuilder sb = new StringBuilder(cps.length);
        for (int i = cps.length - 1; i >= 0; i--) sb.appendCodePoint(cps[i]);
        return sb.toString();
    }

    /** Tokenize a CSV line. Honors quoted fields with embedded commas. */
    public static String[] parseCsvLine(String line) {
        if (line == null || line.isEmpty()) return new String[0];
        java.util.List<String> out = new java.util.ArrayList<>();
        StringBuilder cur = new StringBuilder();
        boolean inQuotes = false;
        for (int i = 0; i < line.length(); i++) {
            char c = line.charAt(i);
            if (inQuotes) {
                if (c == '"') {
                    if (i + 1 < line.length() && line.charAt(i + 1) == '"') {
                        cur.append('"');
                        i++;
                    } else {
                        inQuotes = false;
                    }
                } else {
                    cur.append(c);
                }
            } else {
                if (c == ',') {
                    out.add(cur.toString());
                    cur.setLength(0);
                } else if (c == '"') {
                    inQuotes = true;
                } else {
                    cur.append(c);
                }
            }
        }
        out.add(cur.toString());
        return out.toArray(new String[0]);
    }

    /** Format a number of bytes into a human-readable string (binary units). */
    public static String formatBytes(long bytes) {
        if (bytes < 0) return "-" + formatBytes(-bytes);
        if (bytes < 1024L) return bytes + " B";
        final String[] units = {"KiB", "MiB", "GiB", "TiB", "PiB"};
        double v = bytes;
        int unitIdx = -1;
        while (v >= 1024.0 && unitIdx < units.length - 1) {
            v /= 1024.0;
            unitIdx++;
        }
        return String.format("%.2f %s", v, units[unitIdx]);
    }

    /**
     * Compute a stats map that deliberately includes non-finite numeric
     * sentinels (NaN, +Infinity, -Infinity) and a nested structure with
     * insertion order != sorted order.
     *
     * <p>This method exists to exercise the {@code __nan__},
     * {@code __infinity__}, and {@code __neg_infinity__} sentinels in
     * {@link RegretJava.Json#stableStringify} plus recursive key sorting —
     * paths that the basic demo functions (add/fibonacci/reverse/etc.) never
     * trigger because they return plain primitives or strings. The
     * cross-stack parity verifier
     * ({@code proof/java/verify-parity.mjs}) uses this to confirm the Java
     * fingerprint matches the JS fingerprint for these edge cases.
     *
     * @param x denominator; pass {@code 0} to trigger the Infinity paths
     * @return a map with insertion order {input, reciprocal, negReciprocal, nanField}
     */
    public static java.util.Map<String, Object> computeStats(double x) {
        java.util.Map<String, Object> out = new java.util.LinkedHashMap<>();
        out.put("input", x);
        out.put("reciprocal", 1.0 / x);        // +Infinity when x == 0
        out.put("negReciprocal", -1.0 / x);    // -Infinity when x == 0
        out.put("nanField", 0.0 / 0.0);        // always NaN
        return out;
    }
}

// ───────────────────────────────────────────────────────────────────────────
// VerifyLib — fresh functions for independent verification of the Java
// Regrets stack (proof/java_verify/).
//
// The functions here are DELIBERATELY DIFFERENT from the ones in DemoMathUtils
// (add, fibonacci, reverse, parseCsvLine, formatBytes, computeStats) to avoid
// the confirmation-bias trap documented in CONTEXT.md "Lesson Learned":
// "test ditulis dengan pattern yang sama dengan implementasi".
//
// Same algorithms as proof/c_verify/, proof/go_verify/, proof/rust_verify/,
// proof/php_verify/ → enables 6-way cross-stack parity verification
// (Java == PHP == Rust == Go == C == JS == Python).
//
// Lives inside RegretJava.java so the verify fixture also runs on a
// JRE-only environment (no javac needed — single-file source mode).
// ───────────────────────────────────────────────────────────────────────────

final class VerifyLib {
    private VerifyLib() {}

    /** Slugify: lowercase ASCII alphanumerics, replace non-alnum runs with '-',
     *  trim leading/trailing '-'. Returns "" for empty input. */
    public static String slugify(String s) {
        if (s == null || s.isEmpty()) return "";
        StringBuilder out = new StringBuilder(s.length());
        boolean lastSep = true; // start as sep so leading '-' is trimmed
        for (int i = 0; i < s.length(); i++) {
            char c = s.charAt(i);
            if (Character.isLetterOrDigit(c)) {
                out.append(Character.toLowerCase(c));
                lastSep = false;
            } else {
                if (!lastSep) {
                    out.append('-');
                    lastSep = true;
                }
            }
        }
        // Trim trailing '-'
        while (out.length() > 0 && out.charAt(out.length() - 1) == '-') {
            out.setLength(out.length() - 1);
        }
        return out.toString();
    }

    /** Base64-encode a string using standard base64 alphabet with '=' padding.
     *  Empty input returns "". Implemented from scratch (not using java.util.Base64)
     *  to exercise bit manipulation code paths. */
    public static String base64Encode(String s) {
        if (s == null || s.isEmpty()) return "";
        byte[] data = s.getBytes(java.nio.charset.StandardCharsets.UTF_8);
        final String ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
        StringBuilder out = new StringBuilder(((data.length + 2) / 3) * 4);
        for (int i = 0; i < data.length; i += 3) {
            int b0 = data[i] & 0xFF;
            int b1 = (i + 1 < data.length) ? (data[i + 1] & 0xFF) : 0;
            int b2 = (i + 2 < data.length) ? (data[i + 2] & 0xFF) : 0;
            int triple = (b0 << 16) | (b1 << 8) | b2;
            int pad = 0;
            if (i + 1 >= data.length) pad = 2;
            else if (i + 2 >= data.length) pad = 1;
            out.append(ALPHABET.charAt((triple >> 18) & 0x3F));
            out.append(ALPHABET.charAt((triple >> 12) & 0x3F));
            out.append(pad < 2 ? ALPHABET.charAt((triple >> 6) & 0x3F) : '=');
            out.append(pad < 1 ? ALPHABET.charAt(triple & 0x3F) : '=');
        }
        return out.toString();
    }

    /** CRC32 (zlib/zip polynomial 0xEDB88320) of input string's bytes.
     *  Returns the standard 32-bit checksum (initial 0xFFFFFFFF, final XOR 0xFFFFFFFF).
     *  Implemented from scratch (not using java.util.zip.CRC32) to exercise
     *  unsigned arithmetic + table initialization. */
    public static long crc32(String s) {
        if (s == null) s = "";
        byte[] data = s.getBytes(java.nio.charset.StandardCharsets.UTF_8);
        int[] table = new int[256];
        for (int i = 0; i < 256; i++) {
            int c = i;
            for (int k = 0; k < 8; k++) {
                if ((c & 1) == 1) {
                    c = 0xEDB88320 ^ (c >>> 1);
                } else {
                    c = c >>> 1;
                }
            }
            table[i] = c;
        }
        int crc = 0xFFFFFFFF;
        for (byte b : data) {
            int ub = b & 0xFF;
            crc = table[(crc ^ ub) & 0xFF] ^ (crc >>> 8);
        }
        // Return as long (unsigned 32-bit) — Java int is signed, so mask to
        // get the unsigned 32-bit value. The harness's stableStringify will
        // serialize this long without sign extension issues.
        return ((long) crc ^ 0xFFFFFFFFL) & 0xFFFFFFFFL;
    }

    /** FNV-1a 32-bit hash of input string's bytes. Different algorithm than
     *  CRC32 — exercises a different bit-manipulation pattern (multiply + XOR
     *  per byte). */
    public static long fnv1a(String s) {
        if (s == null) s = "";
        byte[] data = s.getBytes(java.nio.charset.StandardCharsets.UTF_8);
        long h = 2166136261L; // offset basis (unsigned 32-bit as long)
        final long prime = 16777619L;
        for (byte b : data) {
            int ub = b & 0xFF;
            h = (h ^ ub) & 0xFFFFFFFFL;
            h = (h * prime) & 0xFFFFFFFFL;
        }
        return h;
    }

    /** Validate an IPv4 dotted-quad. Returns true iff s is a valid dotted-quad:
     *  exactly 4 octets 0-255 separated by single '.', no leading zeros (except
     *  "0" itself), no trailing junk. */
    public static boolean isValidIPv4(String s) {
        if (s == null || s.isEmpty()) return false;
        int len = s.length();
        int octets = 0;
        int val = 0;
        int digits = 0;
        for (int i = 0; i < len; i++) {
            char c = s.charAt(i);
            if (c >= '0' && c <= '9') {
                if (digits == 1 && val == 0) return false; // leading zero
                if (digits >= 3) return false;
                val = val * 10 + (c - '0');
                digits++;
                if (val > 255) return false;
            } else if (c == '.') {
                if (digits == 0) return false; // empty octet
                octets++;
                if (octets > 4) return false;
                if (i + 1 >= len || s.charAt(i + 1) < '0' || s.charAt(i + 1) > '9') return false;
                val = 0;
                digits = 0;
            } else {
                return false; // invalid char
            }
        }
        if (digits == 0) return false;
        octets++;
        return octets == 4;
    }
}

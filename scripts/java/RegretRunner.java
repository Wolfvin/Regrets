// RegretRunner.java — capture & validate driver for Java clusters.
//
// Reads regrets/manifest.json, finds clusters with stack=java, invokes the
// entry function with each input, computes the fingerprint, and (in capture
// mode) writes a .regret file or (in validate mode) compares the live hash
// against the golden hash from the existing .regret file.
//
// Entry function lookup:
//   - "fqdn.ClassName::methodName"           → static or instance method
//   - "fqdn.ClassName::methodName" + ctorArgs → instance method (ctorArgs from manifest)
//
// Input handling:
//   - inputs: [v1, v2, ...]   each vN is a single JSON value (single-arg call)
//   - inputs: [[a, b, c]] + multiArgs: true → each call gets multiple args
//
// The function's return value is JSON-serialized via RegretJava.stableStringify.
// Methods that return void are recorded as null. Methods that return Java arrays
// are converted to List<Object> first. Methods that return Map<String,Object>
// or List<Object> are passed through unchanged.
//
// This runner is invoked by capture_java.sh / validate_java.sh after they
// compile RegretJava.java + RegretRunner.java and add the user's classpath.
// It does NOT itself spawn child processes — single JVM, single classloader.

package io.github.wolfvin.regret;

import java.io.IOException;
import java.lang.reflect.Constructor;
import java.lang.reflect.Method;
import java.lang.reflect.Modifier;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

public final class RegretRunner {

    private RegretRunner() {}

    // ─── CLI entry ────────────────────────────────────────────────────────────
    //
    //   java -cp <classpath> io.github.wolfvin.regret.RegretRunner capture  [--cluster id] [--manifest path]
    //   java -cp <classpath> io.github.wolfvin.regret.RegretRunner validate [--cluster id] [--manifest path]
    //
    // Exit codes:
    //   0 = all clusters PASS (or all captures succeeded)
    //   1 = one or more clusters FAILED (or capture failed)
    //   2 = usage error / manifest unreadable

    public static void main(String[] args) {
        if (args.length == 0) {
            System.err.println("Usage: RegretRunner <capture|validate> [--cluster id] [--manifest path] [--regret-dir path]");
            System.exit(2);
        }
        String mode = args[0];
        String clusterFilter = null;
        String manifestPath = "regrets/manifest.json";
        String regretDirOverride = null;
        for (int i = 1; i < args.length; i++) {
            if ("--cluster".equals(args[i]) && i + 1 < args.length) {
                clusterFilter = args[++i];
            } else if ("--manifest".equals(args[i]) && i + 1 < args.length) {
                manifestPath = args[++i];
            } else if ("--regret-dir".equals(args[i]) && i + 1 < args.length) {
                regretDirOverride = args[++i];
            }
        }

        if (!"capture".equals(mode) && !"validate".equals(mode)) {
            System.err.println("Unknown mode: " + mode + " (expected 'capture' or 'validate')");
            System.exit(2);
        }

        // Load manifest
        String manifestContent;
        try {
            manifestContent = new String(Files.readAllBytes(Paths.get(manifestPath)), StandardCharsets.UTF_8);
        } catch (IOException e) {
            System.err.println("Could not read manifest: " + manifestPath + " — " + e.getMessage());
            System.exit(2);
            return;
        }
        Object manifestObj = RegretJava.parseJson(manifestContent);
        if (!(manifestObj instanceof Map)) {
            System.err.println("Manifest is not a JSON object");
            System.exit(2);
            return;
        }
        Object clustersObj = ((Map<?, ?>) manifestObj).get("clusters");
        if (!(clustersObj instanceof List)) {
            System.err.println("Manifest has no 'clusters' array");
            System.exit(2);
            return;
        }

        // Filter to java clusters (and optional --cluster id)
        List<Map<String, Object>> javaClusters = new ArrayList<>();
        for (Object c : (List<?>) clustersObj) {
            if (!(c instanceof Map)) continue;
            @SuppressWarnings("unchecked")
            Map<String, Object> cluster = (Map<String, Object>) c;
            Object stack = cluster.get("stack");
            if (stack == null || !"java".equals(stack.toString())) continue;
            if (clusterFilter != null && !clusterFilter.equals(String.valueOf(cluster.get("id")))) continue;
            javaClusters.add(cluster);
        }

        if (javaClusters.isEmpty()) {
            System.out.println("No Java clusters found in manifest" +
                    (clusterFilter != null ? " matching \"" + clusterFilter + "\"" : "") + ".");
            System.exit(0);
            return;
        }

        String regretDir = regretDirOverride != null
                ? Paths.get(regretDirOverride).toAbsolutePath().toString()
                : Paths.get("regrets").toAbsolutePath().toString();
        try {
            Files.createDirectories(Paths.get(regretDir));
        } catch (IOException e) {
            System.err.println("Could not create regrets/ dir: " + e.getMessage());
            System.exit(2);
            return;
        }

        boolean allOk = true;
        for (Map<String, Object> cluster : javaClusters) {
            try {
                if ("capture".equals(mode)) {
                    boolean ok = captureCluster(cluster, regretDir);
                    if (!ok) allOk = false;
                } else {
                    boolean ok = validateCluster(cluster, regretDir);
                    if (!ok) allOk = false;
                }
            } catch (Throwable t) {
                System.out.println("  ❌ " + cluster.get("id") + " ERROR: " + t.getMessage());
                t.printStackTrace();
                allOk = false;
            }
        }

        System.out.println();
        System.out.println("─".repeat(60));
        if (allOk) {
            System.out.println("✅ All " + (mode.equals("capture") ? "captures" : "validations") +
                    " completed successfully.");
            System.exit(0);
        } else {
            System.out.println("❌ Some clusters " + (mode.equals("capture") ? "failed to capture" : "FAILED") + ".");
            System.exit(1);
        }
    }

    // ─── Capture ──────────────────────────────────────────────────────────────
    @SuppressWarnings("unchecked")
    private static boolean captureCluster(Map<String, Object> cluster, String regretDir) throws Exception {
        String id = String.valueOf(cluster.get("id"));
        String entry = String.valueOf(cluster.get("entry"));
        List<String> watches = toStringList(cluster.get("watches"));
        String fingerprintLevel = cluster.getOrDefault("fingerprintLevel", "entry").toString();
        boolean multiArgs = Boolean.TRUE.equals(cluster.get("multiArgs"));
        String file = cluster.get("file") != null ? cluster.get("file").toString() : "";
        List<String> normalize = toStringList(cluster.get("normalize"));
        List<String> ignoreFields = toStringList(cluster.get("ignoreFields"));

        Object inputsObj = cluster.get("inputs");
        List<Object> inputs;
        if (inputsObj instanceof List) {
            inputs = new ArrayList<>((List<Object>) inputsObj);
        } else if (inputsObj == null) {
            // Default: single null input
            inputs = new ArrayList<>();
            inputs.add(null);
        } else {
            inputs = new ArrayList<>();
            inputs.add(inputsObj);
        }

        System.out.println();
        System.out.println("📡 Capturing: " + id);
        System.out.println("   Entry:   " + entry);
        System.out.println("   File:    " + (file.isEmpty() ? "(from classpath)" : file));
        System.out.println("   Watches: " + (watches.isEmpty() ? "(none)" : String.join(", ", watches)));

        // For each input, invoke the entry function
        List<RunResult> results = new ArrayList<>();
        for (Object input : inputs) {
            RunResult r = invokeEntry(entry, cluster, input, multiArgs);
            results.add(r);
            if (r.error != null) {
                System.out.println("   ❌ Input " + results.size() + " threw: " + r.error);
            }
        }

        // Use first run as the golden (matches capture.js behavior)
        RunResult golden = results.get(0);
        if (golden.error != null) {
            System.out.println("   ❌ Capture failed — entry threw on first input: " + golden.error);
            return false;
        }

        String fp = RegretJava.fingerprint(golden.inputForFp, golden.output);

        String regretPath = Paths.get(regretDir, id + ".regret").toString();
        String content = RegretJava.formatRegret(
                id, fp, RegretJava.isoNow(), entry, "java", fingerprintLevel,
                watches, multiArgs, file, normalize, ignoreFields,
                golden.inputForFp, golden.output);
        Files.write(Paths.get(regretPath), content.getBytes(StandardCharsets.UTF_8));

        System.out.println("   ✅ Fingerprint: " + fp);
        System.out.println("   📄 Saved: regrets/" + id + ".regret");

        // Warn about additional inputs (multi-input contracts not yet serialized to INPUTS line)
        if (results.size() > 1) {
            System.out.println("   ℹ️  " + results.size() + " inputs captured — golden uses first input only.");
            System.out.println("       (Multi-input INPUTS line not yet implemented for Java stack — see PR #342)");
        }

        return true;
    }

    // ─── Validate ─────────────────────────────────────────────────────────────
    @SuppressWarnings("unchecked")
    private static boolean validateCluster(Map<String, Object> cluster, String regretDir) throws Exception {
        String id = String.valueOf(cluster.get("id"));
        String entry = String.valueOf(cluster.get("entry"));
        boolean multiArgs = Boolean.TRUE.equals(cluster.get("multiArgs"));

        Path regretPath = Paths.get(regretDir, id + ".regret");
        if (!Files.exists(regretPath)) {
            System.out.println("  ❌ " + pad(id, 35) + " MISSING .regret file");
            return false;
        }

        String content = new String(Files.readAllBytes(regretPath), StandardCharsets.UTF_8);
        RegretJava.RegretFile regret = RegretJava.parseRegret(content);

        // Re-invoke with the same input that was captured
        RunResult r = invokeEntry(entry, cluster, regret.input, multiArgs);
        if (r.error != null) {
            System.out.println("  ❌ " + pad(id, 35) + " ERROR during re-run: " + r.error);
            return false;
        }

        String liveHash = RegretJava.fingerprint(r.inputForFp, r.output);
        boolean isMatch = liveHash.equals(regret.goldenHash);

        String icon = isMatch ? "✅" : "❌";
        String hashStr = isMatch ? regret.goldenHash : regret.goldenHash + " → " + liveHash;
        System.out.println("  " + icon + " " + pad(id, 35) + " " + pad(hashStr, 22) +
                " " + (isMatch ? "PASS" : "FAIL"));

        return isMatch;
    }

    // ─── Reflection-based entry invocation ────────────────────────────────────
    //   entry = "fqdn.ClassName::methodName"
    //   if cluster has constructorArgs: instantiate ClassName with those args
    //   else if method is static: call directly
    //   else if method is instance: try no-arg constructor
    @SuppressWarnings("unchecked")
    private static RunResult invokeEntry(String entry, Map<String, Object> cluster, Object input, boolean multiArgs)
            throws Exception {
        int sep = entry.indexOf("::");
        if (sep == -1) {
            return RunResult.error("Entry must be 'ClassName::methodName' (got: " + entry + ")");
        }
        String className = entry.substring(0, sep);
        String methodName = entry.substring(sep + 2);

        Class<?> klass;
        try {
            klass = Class.forName(className);
        } catch (ClassNotFoundException cnfe) {
            return RunResult.error("Class not found: " + className +
                    " (ensure your code is on the classpath passed to capture_java.sh)");
        }

        // Find the method by name (single-arg Object or no-arg). We don't try to
        // disambiguate by parameter type — Java erasure + JSON parsing make this
        // fragile. Users should provide a method that accepts Object or a specific
        // type that matches the JSON value (String, Long, Double, List, Map).
        Method[] candidates = klass.getDeclaredMethods();
        Method target = null;
        for (Method m : candidates) {
            if (!m.getName().equals(methodName)) continue;
            // Prefer a method whose parameter count matches what we'll pass
            int wantParams = multiArgs && input instanceof List ? ((List<?>) input).size() : 1;
            if (m.getParameterCount() == wantParams) {
                target = m;
                break;
            }
        }
        if (target == null) {
            // Fallback: any method with this name
            for (Method m : candidates) {
                if (m.getName().equals(methodName)) {
                    target = m;
                    break;
                }
            }
        }
        if (target == null) {
            return RunResult.error("Method not found: " + className + "." + methodName);
        }
        target.setAccessible(true);

        // Build the receiver if needed
        Object receiver = null;
        if (!Modifier.isStatic(target.getModifiers())) {
            Object ctorArgsObj = cluster.get("constructorArgs");
            if (ctorArgsObj instanceof List) {
                List<Object> ctorArgs = (List<Object>) ctorArgsObj;
                Constructor<?> ctor = findMatchingConstructor(klass, ctorArgs.size());
                if (ctor == null) {
                    return RunResult.error("No constructor with " + ctorArgs.size() + " args on " + className);
                }
                ctor.setAccessible(true);
                receiver = ctor.newInstance(toJavaArgs(ctor.getParameterTypes(), ctorArgs));
            } else {
                try {
                    Constructor<?> ctor = klass.getDeclaredConstructor();
                    ctor.setAccessible(true);
                    receiver = ctor.newInstance();
                } catch (NoSuchMethodException nsme) {
                    return RunResult.error("No no-arg constructor on " + className +
                            " — provide constructorArgs in manifest");
                }
            }
        }

        // Build args
        Object[] args;
        Object inputForFp;
        if (multiArgs && input instanceof List) {
            List<Object> inputList = (List<Object>) input;
            args = toJavaArgs(target.getParameterTypes(), inputList);
            inputForFp = inputList; // fingerprint uses the array form
        } else {
            Class<?>[] ptypes = target.getParameterTypes();
            if (ptypes.length == 0) {
                args = new Object[0];
            } else if (ptypes.length == 1) {
                args = new Object[] { coerceToType(ptypes[0], input) };
            } else {
                // Multiple declared params, single input — fall back to wrapping
                if (input instanceof List) {
                    args = toJavaArgs(ptypes, (List<Object>) input);
                } else {
                    return RunResult.error("Method expects " + ptypes.length + " args but input is not a list");
                }
            }
            inputForFp = (input == null) ? null : input;
            if (input == null) inputForFp = null;
        }

        Object output;
        try {
            output = target.invoke(receiver, args);
        } catch (java.lang.reflect.InvocationTargetException ite) {
            Throwable cause = ite.getCause();
            return RunResult.error(cause != null ? cause.toString() : ite.toString());
        }

        // Normalize output to JSON-friendly types
        Object normalizedOutput = normalizeReturn(output);
        return new RunResult(inputForFp, normalizedOutput, null);
    }

    private static Constructor<?> findMatchingConstructor(Class<?> klass, int argc) {
        for (Constructor<?> c : klass.getDeclaredConstructors()) {
            if (c.getParameterCount() == argc) return c;
        }
        return null;
    }

    private static Object[] toJavaArgs(Class<?>[] ptypes, List<Object> jsonArgs) {
        Object[] out = new Object[ptypes.length];
        for (int i = 0; i < ptypes.length; i++) {
            Object v = i < jsonArgs.size() ? jsonArgs.get(i) : null;
            out[i] = coerceToType(ptypes[i], v);
        }
        return out;
    }

    @SuppressWarnings("unchecked")
    private static Object coerceToType(Class<?> targetType, Object value) {
        if (value == null) return null;
        if (targetType.isInstance(value)) return value;
        // Primitive unboxing / widening
        if (targetType == int.class || targetType == Integer.class) {
            if (value instanceof Number) return ((Number) value).intValue();
            if (value instanceof String) return Integer.parseInt((String) value);
        }
        if (targetType == long.class || targetType == Long.class) {
            if (value instanceof Number) return ((Number) value).longValue();
            if (value instanceof String) return Long.parseLong((String) value);
        }
        if (targetType == double.class || targetType == Double.class) {
            if (value instanceof Number) return ((Number) value).doubleValue();
            if (value instanceof String) return Double.parseDouble((String) value);
        }
        if (targetType == float.class || targetType == Float.class) {
            if (value instanceof Number) return ((Number) value).floatValue();
            if (value instanceof String) return Float.parseFloat((String) value);
        }
        if (targetType == boolean.class || targetType == Boolean.class) {
            if (value instanceof Boolean) return value;
            if (value instanceof String) return Boolean.parseBoolean((String) value);
        }
        if (targetType == String.class) {
            return value.toString();
        }
        if (targetType.isArray() && value instanceof List) {
            List<Object> list = (List<Object>) value;
            Class<?> component = targetType.getComponentType();
            Object array = java.lang.reflect.Array.newInstance(component, list.size());
            for (int i = 0; i < list.size(); i++) {
                java.lang.reflect.Array.set(array, i, coerceToType(component, list.get(i)));
            }
            return array;
        }
        if (targetType == List.class && value instanceof List) return value;
        if (targetType == Map.class && value instanceof Map) return value;
        if (targetType == Object.class) return value;
        // Last resort: return as-is and hope for the best
        return value;
    }

    @SuppressWarnings("unchecked")
    private static Object normalizeReturn(Object value) {
        if (value == null) return null;
        if (value instanceof Number || value instanceof Boolean || value instanceof String) return value;
        if (value instanceof List) {
            List<Object> out = new ArrayList<>();
            for (Object e : (List<?>) value) out.add(normalizeReturn(e));
            return out;
        }
        if (value instanceof Map) {
            Map<String, Object> out = new LinkedHashMap<>();
            for (Map.Entry<?, ?> e : ((Map<?, ?>) value).entrySet()) {
                out.put(String.valueOf(e.getKey()), normalizeReturn(e.getValue()));
            }
            return out;
        }
        if (value.getClass().isArray()) {
            int n = java.lang.reflect.Array.getLength(value);
            List<Object> out = new ArrayList<>(n);
            for (int i = 0; i < n; i++) out.add(normalizeReturn(java.lang.reflect.Array.get(value, i)));
            return out;
        }
        // Character → String (JSON has no char type)
        if (value instanceof Character) return value.toString();
        // Anything else: stringify
        return value.toString();
    }

    // ─── Helpers ──────────────────────────────────────────────────────────────
    private static String pad(String s, int width) {
        if (s.length() >= width) return s;
        StringBuilder sb = new StringBuilder(s);
        while (sb.length() < width) sb.append(' ');
        return sb.toString();
    }

    @SuppressWarnings("unchecked")
    private static List<String> toStringList(Object o) {
        if (o == null) return new ArrayList<>();
        if (o instanceof List) {
            List<String> out = new ArrayList<>();
            for (Object e : (List<?>) o) out.add(e == null ? "null" : e.toString());
            return out;
        }
        List<String> out = new ArrayList<>();
        out.add(o.toString());
        return out;
    }

    // ─── RunResult ────────────────────────────────────────────────────────────
    private static final class RunResult {
        final Object inputForFp;
        final Object output;
        final String error;

        RunResult(Object inputForFp, Object output, String error) {
            this.inputForFp = inputForFp;
            this.output = output;
            this.error = error;
        }

        static RunResult error(String msg) {
            return new RunResult(null, null, msg);
        }
    }
}

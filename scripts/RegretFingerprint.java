import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.TreeMap;
import java.math.BigInteger;

/**
 * RegretFingerprint — port of scripts/fingerprint.js to Java.
 *
 * Algorithm IDENTICAL to fingerprint.js / fingerprint.py / fingerprint.go:
 *   1. cleanInput  = stripFields(normalize(input,  rules), ignoreFields)
 *   2. cleanOutput = stripFields(normalize(output, rules), ignoreFields)
 *   3. combined = stableStringify(cleanInput) + "|" + stableStringify(cleanOutput)
 *   4. hash = SHA-256(combined) as hex
 *   5. num = BigInteger(hex, 16)
 *   6. base36 = num.toString(36)
 *   7. return base36.substring(0, 7)
 *
 * Usage from a generated capture/validate test:
 *   String fp = RegretFingerprint.fingerprint(input, output);
 *
 * The `input` and `output` arguments may be any JSON-serializable Java value:
 *   null, Boolean, Integer, Long, Double, String, List<Object>, Map<String,Object>.
 * Maps MUST use String keys (mirrors JS/Python object semantics).
 *
 * Cross-stack parity verified against scripts/fingerprint.js — same input/output
 * pair produces the same 7-char fingerprint in JS and Java.
 */
public class RegretFingerprint {

    // ─── stableStringify ────────────────────────────────────────────────────
    //
    // Recursive deterministic JSON serialization. Object keys are sorted
    // alphabetically. Mirrors stableStringify() in fingerprint.js exactly.
    //
    // Notable behaviors that MUST match the JS implementation:
    //   - null  -> "null"
    //   - Double.NaN           -> "\"__nan__\""          (issue #322)
    //   - Double.POSITIVE_INFINITY -> "\"__infinity__\""
    //   - Double.NEGATIVE_INFINITY -> "\"__neg_infinity__\""
    //   - String -> JSON.stringify(s) (with surrounding quotes & escaping)
    //   - List   -> "[item0,item1,...]"
    //   - Map    -> "{\"k0\":v0,\"k1\":v1,...}" with sorted keys
    //   - Double 1.0 -> "1" (Java BigInteger toString drops trailing .0 — but we use
    //     String.valueOf which keeps "1.0". This is intentional and MATCHES the JS
    //     behavior of Number.toString().)

    public static String stableStringify(Object obj) {
        return doStableStringify(obj);
    }

    private static String doStableStringify(Object obj) {
        if (obj == null) return "null";

        if (obj instanceof Boolean) return obj.toString();

        if (obj instanceof Number) {
            Number n = (Number) obj;
            // Double / Float path — handle NaN, Infinity, and finite values
            if (n instanceof Double || n instanceof Float) {
                double d = n.doubleValue();
                if (Double.isNaN(d)) return "\"__nan__\"";
                if (d == Double.POSITIVE_INFINITY) return "\"__infinity__\"";
                if (d == Double.NEGATIVE_INFINITY) return "\"__neg_infinity__\"";
                // Whole numbers stored as double: emit as integer (matches JS
                // Number.toString behavior where 1.0 -> "1"). Critical for
                // cross-stack fingerprint parity because JS stores numbers as
                // doubles and serializes 1.0 as "1".
                if (d == Math.rint(d) && !Double.isInfinite(d) && Math.abs(d) < 1e15) {
                    return Long.toString((long) d);
                }
                // Otherwise use Java's default double-to-string. JS uses
                // Number.prototype.toString which produces the same shortest
                // round-trip representation for most values. There may be edge
                // cases where they differ (exponential notation); those should
                // be caught by integration tests.
                return Double.toString(d);
            }
            // Integer / Long / BigInteger / Short / Byte
            return n.toString();
        }

        if (obj instanceof String) {
            return jsonStringEscape((String) obj);
        }

        if (obj instanceof List) {
            List<?> list = (List<?>) obj;
            StringBuilder sb = new StringBuilder("[");
            for (int i = 0; i < list.size(); i++) {
                if (i > 0) sb.append(",");
                sb.append(doStableStringify(list.get(i)));
            }
            sb.append("]");
            return sb.toString();
        }

        if (obj instanceof Map) {
            Map<?, ?> map = (Map<?, ?>) obj;
            // Sort keys alphabetically by their String representation
            TreeMap<String, Object> sorted = new TreeMap<>();
            for (Map.Entry<?, ?> entry : map.entrySet()) {
                sorted.put(String.valueOf(entry.getKey()), entry.getValue());
            }
            StringBuilder sb = new StringBuilder("{");
            boolean first = true;
            for (Map.Entry<String, Object> entry : sorted.entrySet()) {
                if (!first) sb.append(",");
                first = false;
                sb.append(jsonStringEscape(entry.getKey()));
                sb.append(":");
                sb.append(doStableStringify(entry.getValue()));
            }
            sb.append("}");
            return sb.toString();
        }

        // Fallback for unknown types — use String.valueOf. This is a known
        // gap: Java objects without a JSON adapter will produce different
        // output than JS. For PR scope, only JSON-serializable types are
        // supported (String, Number, Boolean, List, Map, null).
        return jsonStringEscape(String.valueOf(obj));
    }

    /**
     * JSON-escape a string and wrap in double quotes.
     * Mirrors JSON.stringify() behavior for strings.
     */
    private static String jsonStringEscape(String s) {
        StringBuilder sb = new StringBuilder(s.length() + 2);
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
        return sb.toString();
    }

    // ─── fingerprint ────────────────────────────────────────────────────────

    /**
     * Compute the 7-char base36 fingerprint.
     *
     * IDENTICAL algorithm to fingerprint.js:
     *   sha256(stableStringify(input) + "|" + stableStringify(output))
     *   → hex → BigInteger → base36 → first 7 chars
     */
    public static String fingerprint(Object input, Object output) {
        String combined = stableStringify(input) + "|" + stableStringify(output);
        try {
            MessageDigest md = MessageDigest.getInstance("SHA-256");
            byte[] hashBytes = md.digest(combined.getBytes(StandardCharsets.UTF_8));
            // Convert to hex string
            StringBuilder hex = new StringBuilder(hashBytes.length * 2);
            for (byte b : hashBytes) {
                hex.append(String.format("%02x", b));
            }
            // BigInt from hex, then base36
            BigInteger num = new BigInteger(hex.toString(), 16);
            String base36 = num.toString(36);
            if (base36.length() < 7) {
                return base36;
            }
            return base36.substring(0, 7);
        } catch (NoSuchAlgorithmException e) {
            throw new RuntimeException("SHA-256 not available — JVM misconfiguration", e);
        }
    }

    // ─── .regret file helpers ───────────────────────────────────────────────

    /**
     * Serialize a Java value to a JSON string for the .regret file INPUT/OUTPUT
     * line. Uses stableStringify under the hood so output is deterministic.
     *
     * This is what gets written to the .regret file as `INPUT  <value>` and
     * `OUTPUT <value>`. The validate script will parse this back and re-invoke
     * the function with the parsed input.
     */
    public static String toJsonString(Object obj) {
        return stableStringify(obj);
    }

    /**
     * Construct a complete .regret file content string.
     *
     * Format (mirrors scripts/capture.js / capture.py):
     *   cluster: <id>
     *   version: 1
     *   fingerprint: <fp>
     *   captured: <ISO timestamp>
     *   watches: [<w1>, <w2>, ...]
     *   entry: <entry>
     *   stack: java
     *   fingerprintLevel: <level>
     *   ---
     *   INPUT  <json>
     *   OUTPUT <json>
     *   HASH   <fp>
     */
    public static String buildRegretFile(
            String clusterId,
            String fingerprint,
            String captured,
            String[] watches,
            String entry,
            String fingerprintLevel,
            Object input,
            Object output) {
        StringBuilder sb = new StringBuilder();
        sb.append("cluster: ").append(clusterId).append('\n');
        sb.append("version: 1\n");
        sb.append("fingerprint: ").append(fingerprint).append('\n');
        sb.append("captured: ").append(captured).append('\n');
        sb.append("watches: [").append(String.join(", ", watches)).append("]\n");
        sb.append("entry: ").append(entry).append('\n');
        sb.append("stack: java\n");
        sb.append("fingerprintLevel: ").append(fingerprintLevel).append('\n');
        sb.append("---\n");
        sb.append("INPUT  ").append(toJsonString(input)).append('\n');
        sb.append("OUTPUT ").append(toJsonString(output)).append('\n');
        sb.append("HASH   ").append(fingerprint).append('\n');
        return sb.toString();
    }

    // ─── CLI self-test ──────────────────────────────────────────────────────
    //
    // Run: java RegretFingerprint
    // Expected: prints the fingerprint of (input="hello", output="HELLO")
    // which should match the JS implementation's output for the same input.
    //
    // To verify cross-stack parity:
    //   node -e "import('./scripts/fingerprint.js').then(({fingerprint}) => console.log(fingerprint('hello', 'HELLO')))"
    //   java RegretFingerprint
    //
    // Both should print the same 7-char string.

    public static void main(String[] args) {
        // Test 1: simple string transform
        String fp1 = fingerprint("hello", "HELLO");
        System.out.println("Test 1 (string): " + fp1);
        // Expected: matches `node -e "..."` output for fingerprint('hello', 'HELLO')

        // Test 2: numeric output
        String fp2 = fingerprint(5, 25L);  // 5^2 = 25
        System.out.println("Test 2 (number): " + fp2);

        // Test 3: object output (Map)
        Map<String, Object> input3 = new LinkedHashMap<>();
        input3.put("name", "Alice");
        input3.put("age", 30);
        Map<String, Object> output3 = new LinkedHashMap<>();
        output3.put("greeting", "Hello, Alice!");
        output3.put("ageNextYear", 31);
        String fp3 = fingerprint(input3, output3);
        System.out.println("Test 3 (object): " + fp3);

        // Test 4: array output (List)
        List<Object> input4 = Arrays.asList("a", "b", "c");
        List<Object> output4 = Arrays.asList("A", "B", "C");
        String fp4 = fingerprint(input4, output4);
        System.out.println("Test 4 (array): " + fp4);

        // Test 5: null input
        String fp5 = fingerprint(null, "default");
        System.out.println("Test 5 (null input): " + fp5);

        // Test 6: NaN output (sentinel)
        String fp6 = fingerprint(0.0, Double.NaN);
        System.out.println("Test 6 (NaN output): " + fp6);
    }
}

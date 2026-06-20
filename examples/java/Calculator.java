// Calculator.java — example target for Java-stack regret capture/validate.
//
// Pure functions with deterministic input → output. Used by
// examples/java/manifest.json + examples/java/run-demo.sh to demonstrate:
//   1. capture  → regrets/calculator-add.regret is written
//   2. validate → PASS for unchanged code
//   3. validate → FAIL after a breaking refactor (see examples/java/Calculator_breaking.java)
//
// The class is intentionally in the default package so it can be compiled
// and loaded without any package-path setup — keeps the demo runnable on a
// bare JDK without Maven/Gradle.

public class Calculator {

    /** Add two longs. Fingerprinted by cluster "calculator-add". */
    public static long add(long a, long b) {
        return a + b;
    }

    /** Multiply two longs. Fingerprinted by cluster "calculator-mul". */
    public static long mul(long a, long b) {
        return a * b;
    }

    /** Format an integer as a zero-padded hex string. */
    public static String toHex(long n) {
        // Uppercase, no leading "0x" — matches common bitfield dumpers.
        return String.format("%08X", n);
    }

    /** Reverse the characters in a string. Used to test String I/O. */
    public static String reverse(String s) {
        if (s == null) return null;
        return new StringBuilder(s).reverse().toString();
    }

    /**
     * Parse a "key=value;key=value" string into a sorted-key map.
     * Used to test Map output. Keys and values are kept as strings — the
     * stableStringify sort in RegretJava will produce a deterministic
     * fingerprint regardless of insertion order.
     */
    public static java.util.Map<String, String> parseKv(String input) {
        java.util.Map<String, String> out = new java.util.LinkedHashMap<>();
        if (input == null || input.isEmpty()) return out;
        for (String pair : input.split(";")) {
            int eq = pair.indexOf('=');
            if (eq == -1) continue;
            String k = pair.substring(0, eq).trim();
            String v = pair.substring(eq + 1).trim();
            out.put(k, v);
        }
        return out;
    }

    /**
     * Sum a list of longs. Used to test multi-arg (list) input.
     */
    public static long sumList(java.util.List<Long> xs) {
        long total = 0;
        for (Long x : xs) total += x;
        return total;
    }
}

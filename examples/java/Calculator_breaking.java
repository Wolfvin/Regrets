// Calculator_breaking.java — same API as Calculator.java, but with three
// "silent breakage" refactors that a naive unit test might miss but a regret
// fingerprint will catch:
//
//   1. add(a, b)    → returns a + b + 1   (off-by-one — classic silent regression)
//   2. toHex(n)     → lowercase           (format change — breaks downstream parsers)
//   3. reverse(s)   → returns s unchanged (no-op refactor — accidentally removed the work)
//
// mul(), parseKv(), sumList() are byte-for-byte identical to Calculator.java,
// so those clusters should still PASS validate when this class is swapped in.
//
// This file is COMPILED-IN-PLACE by run-demo.sh — it does NOT replace
// Calculator.java on disk. The .class file is swapped into the temp classes
// directory to simulate a refactor without touching the original source.
//
// NOTE: Deliberately NOT declared `public` so the filename
// (Calculator_breaking.java) does not have to match the class name. The
// resulting Calculator.class is functionally identical to one compiled
// from a public-declared source — `public` only affects cross-package
// visibility, which doesn't matter for our reflection-based invocation.

class Calculator {

    public static long add(long a, long b) {
        // BUG: silent off-by-one
        return a + b + 1;
    }

    public static long mul(long a, long b) {
        return a * b;
    }

    public static String toHex(long n) {
        // BUG: lowercase instead of uppercase
        return String.format("%08x", n);
    }

    public static String reverse(String s) {
        // BUG: returns input unchanged
        if (s == null) return null;
        return s;
    }

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

    public static long sumList(java.util.List<Long> xs) {
        long total = 0;
        for (Long x : xs) total += x;
        return total;
    }
}

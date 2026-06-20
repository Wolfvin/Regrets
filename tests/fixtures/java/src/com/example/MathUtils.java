package com.example;

/**
 * MathUtils — pure-function fixture for the Java Regrets stack.
 *
 * Every method here is deterministic, side-effect-free, and serializable.
 * This makes it an ideal first target for capture + validate verification.
 *
 * Usage:
 *   javac -d build/classes src/com/example/MathUtils.java
 *   java -cp build/classes com.example.MathUtils
 */
public final class MathUtils {

  private MathUtils() {}  // no instances — all methods static

  // ─── Single-argument integer operations ────────────────────────────────
  //
  // These map cleanly to the manifest's `inputs: [5, 10]` form. The validate
  // path will re-invoke each with the captured input and compare fingerprints.

  /** Square an integer. Pure: same input always yields same output. */
  public static int square(int n) {
    return n * n;
  }

  /** Compute factorial iteratively. Returns 1 for n=0. */
  public static long factorial(int n) {
    if (n < 0) throw new IllegalArgumentException("n must be >= 0");
    long result = 1L;
    for (int i = 2; i <= n; i++) result *= i;
    return result;
  }

  /** Reverse the decimal digits of a non-negative integer. */
  public static int reverseDecimal(int n) {
    int sign = n < 0 ? -1 : 1;
    n = Math.abs(n);
    int reversed = 0;
    while (n > 0) {
      reversed = reversed * 10 + (n % 10);
      n /= 10;
    }
    return reversed * sign;
  }

  // ─── String operations ─────────────────────────────────────────────────
  //
  // String-input methods demonstrate cross-type handling. The fingerprint
  // algorithm in RegretFingerprint.java handles Strings, Numbers, Booleans,
  // Lists, and Maps — so String input/output is fully supported.

  /** Convert ASCII letters to uppercase. */
  public static String toUpper(String s) {
    return s.toUpperCase();
  }

  /** Reverse a string character-by-character. */
  public static String reverse(String s) {
    return new StringBuilder(s).reverse().toString();
  }

  // ─── Multi-argument operations ─────────────────────────────────────────
  //
  // Use `multiArgs: true` in the manifest — each input is an array that
  // becomes the method's argument list. Demonstrates that capture_java.sh
  // correctly handles multi-arg invocation via reflection.

  /** Concatenate two strings with a separator. */
  public static String join(String a, String b, String sep) {
    return a + sep + b;
  }

  /** Add two integers. */
  public static int add(int a, int b) {
    return a + b;
  }

  // ─── Sanity-check entry point ──────────────────────────────────────────
  //
  // Run manually to verify all methods work as expected:
  //   java -cp build/classes com.example.MathUtils

  public static void main(String[] args) {
    System.out.println("square(5)      = " + square(5));
    System.out.println("factorial(5)   = " + factorial(5));
    System.out.println("reverseDecimal(1234) = " + reverseDecimal(1234));
    System.out.println("toUpper(\"hello\") = " + toUpper("hello"));
    System.out.println("reverse(\"hello\") = " + reverse("hello"));
    System.out.println("join(\"a\", \"b\", \"-\") = " + join("a", "b", "-"));
    System.out.println("add(3, 4)      = " + add(3, 4));
  }
}

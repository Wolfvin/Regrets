package com.example;

import java.util.LinkedHashMap;
import java.util.Map;

/**
 * Formatter — instance-method fixture for the Java Regrets stack.
 *
 * Demonstrates that capture_java.sh + validate_java.sh can handle instance
 * methods (not just static). The manifest must declare:
 *   classMethod: "format"
 *   constructor: "Formatter"
 *   constructorArgs: []   (no-arg constructor)
 *
 * Behavior:
 *   format("2025_05")      → "052025"   (period → MMYYYY)
 *   format("2025_12")      → "122025"
 *   formatWithPrefix("FPK-", "202505") → "FPK-052026"  (uses current month)
 *
 * The non-deterministic formatWithPrefix method is intentionally NOT captured
 * (it uses System.currentTimeMillis), to keep this fixture deterministic.
 */
public class Formatter {

  private final String separator;

  public Formatter() {
    this("_");
  }

  public Formatter(String separator) {
    this.separator = separator;
  }

  /**
   * Convert a period string from YYYY_MM format to MMYYYY.
   * Example: "2025_05" → "052025"
   */
  public String format(String period) {
    // Split on whatever separator this Formatter was constructed with
    String[] parts = period.split(java.util.regex.Pattern.quote(separator));
    if (parts.length != 2) {
      throw new IllegalArgumentException("Expected format YYYY<sep>MM, got: " + period);
    }
    String year = parts[0];
    String month = parts[1];
    return month + year;
  }

  /**
   * Convert a period string from YYYY_MM format to YYYY-MM (ISO-ish).
   * Example: "2025_05" → "2025-05"
   */
  public String toIso(String period) {
    String[] parts = period.split(java.util.regex.Pattern.quote(separator));
    if (parts.length != 2) {
      throw new IllegalArgumentException("Expected format YYYY<sep>MM, got: " + period);
    }
    return parts[0] + "-" + parts[1];
  }

  /**
   * Build a map of all derived formats for a single input.
   * Demonstrates Map output (cross-type fingerprinting).
   */
  public Map<String, String> allFormats(String period) {
    Map<String, String> result = new LinkedHashMap<>();
    result.put("mmyyyy", format(period));
    result.put("iso", toIso(period));
    return result;
  }

  public static void main(String[] args) {
    Formatter f = new Formatter();
    System.out.println("format(\"2025_05\")      = " + f.format("2025_05"));
    System.out.println("format(\"2025_12\")      = " + f.format("2025_12"));
    System.out.println("toIso(\"2025_05\")       = " + f.toIso("2025_05"));
    System.out.println("allFormats(\"2025_05\")  = " + f.allFormats("2025_05"));
  }
}

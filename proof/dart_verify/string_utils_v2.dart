// string_utils_v2.dart — FRESH Dart utility functions for independent verification.
//
// These functions are deliberately DIFFERENT from proof/dart_stack/string_utils.dart
// (which uses snakeCase, isEmail, formatThousands, levenshtein). Using different
// functions avoids the confirmation-bias trap documented in CONTEXT.md's
// "Lesson Learned" — if the verifier uses the same patterns as the implementer,
// the test passes for the same reason the implementation does, hiding bugs.
//
// Functions chosen to exercise different Dart idioms:
//   - slugify: ASCII filtering + char joining (string transform, no regex)
//   - caesarCipher: char rotation + multiArg (multiArgs: true)
//   - crc16: manual table-driven checksum (no dart:io, no package:crypto)
//   - isValidIPv4: split + range check (validation, bool return)
//   - countVowels: simple loop + counter (int return, edge case: empty string)

/// Slugify a string: lowercase, replace non-alphanumeric runs with single hyphen.
///
/// Examples:
///   "Hello, World!" → "hello-world"
///   "  multiple   spaces  " → "multiple-spaces"
///   "Already-Hyphenated" → "already-hyphenated"
String slugify(String input) {
  if (input.isEmpty) return '';
  final buf = StringBuffer();
  var lastWasHyphen = true; // suppresses leading hyphen
  for (var i = 0; i < input.length; i++) {
    final code = input.codeUnitAt(i);
    final isLower = code >= 0x61 && code <= 0x7A;
    final isUpper = code >= 0x41 && code <= 0x5A;
    final isDigit = code >= 0x30 && code <= 0x39;
    if (isLower) {
      buf.write(input[i]);
      lastWasHyphen = false;
    } else if (isUpper) {
      buf.write(input[i].toLowerCase());
      lastWasHyphen = false;
    } else if (isDigit) {
      buf.write(input[i]);
      lastWasHyphen = false;
    } else {
      // Non-alphanumeric — collapse runs to a single hyphen.
      if (!lastWasHyphen) {
        buf.write('-');
        lastWasHyphen = true;
      }
    }
  }
  var result = buf.toString();
  // Strip trailing hyphen if any.
  while (result.endsWith('-')) {
    result = result.substring(0, result.length - 1);
  }
  return result;
}

/// Caesar cipher: shift each ASCII letter by `shift` (mod 26). Non-letters pass through.
///
/// Examples:
///   ("abc", 1) → "bcd"
///   ("XYZ", 3) → "ABC"
///   ("Hello, World!", 5) → "Mjqqt, Btwqi!"
String caesarCipher(String input, int shift) {
  if (input.isEmpty) return '';
  final normalizedShift = ((shift % 26) + 26) % 26; // handle negative shifts
  final buf = StringBuffer();
  for (var i = 0; i < input.length; i++) {
    final ch = input[i];
    final code = ch.codeUnitAt(0);
    if (code >= 0x41 && code <= 0x5A) {
      // Uppercase
      final shifted = ((code - 0x41 + normalizedShift) % 26) + 0x41;
      buf.write(String.fromCharCode(shifted));
    } else if (code >= 0x61 && code <= 0x7A) {
      // Lowercase
      final shifted = ((code - 0x61 + normalizedShift) % 26) + 0x61;
      buf.write(String.fromCharCode(shifted));
    } else {
      buf.write(ch);
    }
  }
  return buf.toString();
}

/// Compute CRC-16 (CRC-CCITT variant, poly 0x1021, init 0xFFFF) of a string's UTF-8 bytes.
///
/// Manual implementation — no dart:io, no package:crypto. Returns an int in [0, 65535].
///
/// Examples:
///   "123456789" → 0x29B1 (standard CRC-CCITT test vector)
///   "" → 0xFFFF (init value, no XOR-out)
int crc16(String input) {
  const int poly = 0x1021;
  int crc = 0xFFFF;
  final bytes = input.codeUnits; // treat as raw 16-bit code units; for ASCII this == UTF-8
  for (final byte in bytes) {
    crc ^= (byte << 8);
    for (var i = 0; i < 8; i++) {
      if ((crc & 0x8000) != 0) {
        crc = ((crc << 1) ^ poly) & 0xFFFF;
      } else {
        crc = (crc << 1) & 0xFFFF;
      }
    }
  }
  return crc;
}

/// Validate whether a string is a well-formed IPv4 address (dotted-quad, 0-255 each).
///
/// Examples:
///   "192.168.1.1" → true
///   "255.255.255.255" → true
///   "256.1.1.1" → false (octet > 255)
///   "1.2.3" → false (only 3 octets)
///   "1.2.3.4.5" → false (5 octets)
bool isValidIPv4(String input) {
  if (input.isEmpty) return false;
  final parts = input.split('.');
  if (parts.length != 4) return false;
  for (final p in parts) {
    if (p.isEmpty) return false;
    // Reject leading zeros (e.g. "01", "00") to be strict.
    if (p.length > 1 && p[0] == '0') return false;
    final n = int.tryParse(p);
    if (n == null) return false;
    if (n < 0 || n > 255) return false;
  }
  return true;
}

/// Count the number of vowels (a, e, i, o, u — case-insensitive) in a string.
///
/// Examples:
///   "Hello, World!" → 3
///   "" → 0
///   "AEIOUaeiou" → 10
int countVowels(String input) {
  if (input.isEmpty) return 0;
  var count = 0;
  for (var i = 0; i < input.length; i++) {
    final ch = input[i].toLowerCase();
    if (ch == 'a' || ch == 'e' || ch == 'i' || ch == 'o' || ch == 'u') {
      count++;
    }
  }
  return count;
}

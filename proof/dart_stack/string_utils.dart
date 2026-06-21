// string_utils.dart — small real-world utility functions for the Dart stack example.
//
// These functions are deliberately pure and side-effect-free so that
// regret capture/validate can fingerprint their (input → output) pairs.
// They are NOT synthetic stubs — each is a tiny but realistic formatter /
// validator taken from common Dart utility library shapes (quill/dart-strings,
// recase, etc.).

/// Convert a string to snake_case.
///
/// Examples:
///   "HelloWorld" → "hello_world"
///   "already_snake" → "already_snake"
///   "PascalCaseXML" → "pascal_case_xml"
String snakeCase(String input) {
  if (input.isEmpty) return '';
  final buf = StringBuffer();
  for (var i = 0; i < input.length; i++) {
    final ch = input[i];
    final code = ch.codeUnitAt(0);
    final isUpper = code >= 0x41 && code <= 0x5A;
    final isLower = code >= 0x61 && code <= 0x7A;
    final isDigit = code >= 0x30 && code <= 0x39;
    final prev = i > 0 ? input[i - 1] : '';
    final prevCode = prev.isEmpty ? 0 : prev.codeUnitAt(0);
    final prevIsLower = prevCode >= 0x61 && prevCode <= 0x7A;
    final prevIsDigit = prevCode >= 0x30 && prevCode <= 0x39;

    if (isUpper) {
      // Insert underscore before uppercase if previous char was lowercase or digit
      // (handles camelCase boundaries) — but only if we're not at the start.
      if (i > 0 && (prevIsLower || prevIsDigit)) {
        buf.write('_');
      }
      buf.write(ch.toLowerCase());
    } else if (isLower || isDigit) {
      buf.write(ch);
    } else if (ch == ' ' || ch == '-' || ch == '_') {
      // Normalize word separators to a single underscore.
      if (buf.isNotEmpty && !buf.toString().endsWith('_')) {
        buf.write('_');
      }
    } else {
      // Non-alphanumeric — skip but break word.
      if (buf.isNotEmpty && !buf.toString().endsWith('_')) {
        buf.write('_');
      }
    }
  }
  var result = buf.toString();
  // Strip leading/trailing underscores.
  while (result.startsWith('_')) {
    result = result.substring(1);
  }
  while (result.endsWith('_')) {
    result = result.substring(0, result.length - 1);
  }
  // Collapse repeated underscores.
  while (result.contains('__')) {
    result = result.replaceAll('__', '_');
  }
  return result;
}

/// Validate whether a string is a well-formed email address.
///
/// Conservative check: local-part@domain.tld where local-part is 1+ chars
/// (alphanumeric, dots, plus, dash, underscore), domain is 1+ chars
/// (alphanumeric, dash, dot), and TLD is 2+ alpha chars.
bool isEmail(String input) {
  if (input.isEmpty || input.length > 254) return false;
  final re = RegExp(
    r'^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$',
  );
  return re.hasMatch(input);
}

/// Format an integer with thousands separators (commas).
///
/// Examples:
///   1000 → "1,000"
///   -1234567 → "-1,234,567"
///   0 → "0"
String formatThousands(int n) {
  if (n == 0) return '0';
  final isNegative = n < 0;
  var s = n.abs().toString();
  final buf = StringBuffer();
  var count = 0;
  for (var i = s.length - 1; i >= 0; i--) {
    if (count > 0 && count % 3 == 0) {
      buf.write(',');
    }
    buf.write(s[i]);
    count++;
  }
  final result = buf.toString().split('').reversed.join('');
  return isNegative ? '-$result' : result;
}

/// Compute Levenshtein distance between two strings.
///
/// Classic dynamic-programming implementation. Useful for fuzzy-match utilities.
int levenshtein(String a, String b) {
  if (a == b) return 0;
  if (a.isEmpty) return b.length;
  if (b.isEmpty) return a.length;

  final m = a.length;
  final n = b.length;
  // Use a single rolling row of length n+1.
  var prev = List<int>.generate(n + 1, (j) => j);
  var curr = List<int>.filled(n + 1, 0);

  for (var i = 1; i <= m; i++) {
    curr[0] = i;
    for (var j = 1; j <= n; j++) {
      final cost = a[i - 1] == b[j - 1] ? 0 : 1;
      curr[j] = [
        prev[j] + 1,        // deletion
        curr[j - 1] + 1,    // insertion
        prev[j - 1] + cost, // substitution
      ].reduce((x, y) => x < y ? x : y);
    }
    final tmp = prev;
    prev = curr;
    curr = tmp;
  }
  return prev[n];
}

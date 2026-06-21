// fingerprint_dart.dart — deterministic hash for regression contracts
//
// IDENTICAL algorithm to fingerprint.js / fingerprint.py / fingerprint_php.php.
// Same input+output pair MUST produce the same 7-char base36 hash across
// all stacks (JS, Python, PHP, Go, Rust, C, C++, Lua, C#, Kotlin, Perl, Java,
// Ruby, and now Dart).
//
// Algorithm:
//   combined = stableStringify(input) + "|" + stableStringify(output)
//   hashHex  = sha256(combined)
//   bigNum   = BigInt.parse(hashHex, radix: 16)
//   return   toBase36(bigNum).substring(0, 7)
//
// Shared module — required by capture_dart.dart and validate_dart.dart.
// Do NOT duplicate these functions. Import them:
//   import 'package:regret_testing/fingerprint_dart.dart';
//
// Cross-stack consistency verified manually against:
//   node -e "const {fingerprint}=require('./scripts/fingerprint.js'); console.log(fingerprint({a:1,b:2},{c:'x'}))"
//   python3 -c "from sys import path; path.insert(0,'scripts'); from fingerprint import fingerprint; print(fingerprint({'a':1,'b':2},{'c':'x'}))"
// Both produce the same 7-char hash for the same input/output pair.

import 'dart:convert';
import 'dart:typed_data';

// ─── Pure-Dart SHA-256 (no package dependencies) ─────────────────────────────
// Standard FIPS 180-4 implementation. We embed it here instead of depending
// on package:crypto so the script is fully self-contained — no pubspec.yaml
// needed at the repo root, and the example can declare its own deps.

const _k = <int>[
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1,
  0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3,
  0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786,
  0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147,
  0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
  0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b,
  0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a,
  0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
  0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
];

int _rotr(int x, int n) => ((x >> n) | (x << (32 - n))) & 0xFFFFFFFF;

List<int> _sha256(List<int> data) {
  final h = <int>[
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
    0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
  ];

  // Padding
  final bitLen = data.length * 8;
  final padded = List<int>.from(data)..add(0x80);
  while (padded.length % 64 != 56) padded.add(0);
  // Append 64-bit big-endian length (we only handle < 2^32 bits)
  for (var i = 7; i >= 0; i--) {
    padded.add((bitLen >> (i * 8)) & 0xFF);
  }

  for (var off = 0; off < padded.length; off += 64) {
    final w = List<int>.filled(64, 0);
    for (var i = 0; i < 16; i++) {
      w[i] = (padded[off + i * 4] << 24) |
             (padded[off + i * 4 + 1] << 16) |
             (padded[off + i * 4 + 2] << 8) |
             padded[off + i * 4 + 3];
    }
    for (var i = 16; i < 64; i++) {
      final s0 = _rotr(w[i - 15], 7) ^ _rotr(w[i - 15], 18) ^ (w[i - 15] >> 3);
      final s1 = _rotr(w[i - 2], 17) ^ _rotr(w[i - 2], 19) ^ (w[i - 2] >> 10);
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) & 0xFFFFFFFF;
    }

    var a = h[0], b = h[1], c = h[2], d = h[3];
    var e = h[4], f = h[5], g = h[6], hh = h[7];

    for (var i = 0; i < 64; i++) {
      final S1 = _rotr(e, 6) ^ _rotr(e, 11) ^ _rotr(e, 25);
      final ch = (e & f) ^ ((~e & 0xFFFFFFFF) & g);
      final t1 = (hh + S1 + ch + _k[i] + w[i]) & 0xFFFFFFFF;
      final S0 = _rotr(a, 2) ^ _rotr(a, 13) ^ _rotr(a, 22);
      final maj = (a & b) ^ (a & c) ^ (b & c);
      final t2 = (S0 + maj) & 0xFFFFFFFF;
      hh = g; g = f; f = e;
      e = (d + t1) & 0xFFFFFFFF;
      d = c; c = b; b = a;
      a = (t1 + t2) & 0xFFFFFFFF;
    }

    h[0] = (h[0] + a) & 0xFFFFFFFF;
    h[1] = (h[1] + b) & 0xFFFFFFFF;
    h[2] = (h[2] + c) & 0xFFFFFFFF;
    h[3] = (h[3] + d) & 0xFFFFFFFF;
    h[4] = (h[4] + e) & 0xFFFFFFFF;
    h[5] = (h[5] + f) & 0xFFFFFFFF;
    h[6] = (h[6] + g) & 0xFFFFFFFF;
    h[7] = (h[7] + hh) & 0xFFFFFFFF;
  }

  // Convert to byte list
  final out = <int>[];
  for (final v in h) {
    out.add((v >> 24) & 0xFF);
    out.add((v >> 16) & 0xFF);
    out.add((v >> 8) & 0xFF);
    out.add(v & 0xFF);
  }
  return out;
}

String _sha256Hex(List<int> data) {
  final bytes = _sha256(data);
  return bytes.map((b) => b.toRadixString(16).padLeft(2, '0')).join();
}

/// Public test hook — used by debug_sha256.dart to verify the SHA-256
/// implementation against known test vectors. Not called by capture/validate.
String debugSha256Hex(List<int> data) => _sha256Hex(data);

// ─── Stable JSON serialization ────────────────────────────────────────────────
// Keys sorted recursively — mirrors JS stableStringify() / Python stable_dumps().
// Output uses NO whitespace between tokens (separators: ',' and ':') and
// ensureAscii=false (unicode chars printed as-is, not escaped).

/// Recursively sort map keys so JSON output is deterministic.
/// Lists are preserved in order; Maps have keys sorted lexicographically.
Object? _stableSort(Object? obj) {
  if (obj is Map) {
    final keys = obj.keys.map((k) => k.toString()).toList()..sort();
    final sorted = <String, Object?>{};
    for (final k in keys) {
      sorted[k] = _stableSort(obj[k]);
    }
    return sorted;
  }
  if (obj is List) {
    return obj.map(_stableSort).toList();
  }
  return obj;
}

/// Stable JSON string — keys sorted, no whitespace, unicode preserved.
/// Null → "null", bool → "true"/"false", numbers via json.encode, strings
/// via json.encode (with surrounding quotes and proper escaping).
String stableStringify(Object? obj) {
  final sorted = _stableSort(obj);
  // dart:convert json.encode produces compact JSON (no whitespace) by default
  // and handles String/num/bool/null/List/Map. ensureAscii=false keeps unicode.
  return json.encode(sorted);
}

// ─── Base36 conversion ────────────────────────────────────────────────────────
// Mirrors JS BigInt.toString(36) and Python to_base36().
// Dart's BigInt does not have a built-in toRadixString(36), so we implement
// it manually using the same algorithm: divide by 36, prepend remainder char.

const _base36Chars = '0123456789abcdefghijklmnopqrstuvwxyz';

String toBase36(BigInt n) {
  if (n == BigInt.zero) return '0';
  var result = StringBuffer();
  var abs = n.isNegative ? -n : n;
  while (abs > BigInt.zero) {
    final divMod = abs % BigInt.from(36);
    abs = abs ~/ BigInt.from(36);
    // divMod is BigInt; convert to int for char lookup
    final idx = divMod.toInt();
    result.write(_base36Chars[idx]);
  }
  // Reverse — we built LSB-first
  final s = result.toString();
  return String.fromCharCodes(s.codeUnits.reversed);
}

// ─── Normalize ────────────────────────────────────────────────────────────────
// Apply normalization rules to non-deterministic values BEFORE hashing.
// Mirrors JS fingerprint.js normalize() — same rule names, same semantics:
//   timestamps: ISO 8601 datetime string -> <TIMESTAMP>
//   uuids: UUID v4 -> <UUID>
//   absPaths: /abs/path -> <ROOT>/...
//   dynamicDates: MMYYYY/YYYY embedded in strings -> <MMYYYY>/<YYYY>
//   epochs: 1B-10T -> <EPOCH>
//   floatPrecision: strip trailing .0 from number-like strings
//
// Most clusters won't need any normalization rules — the default empty list
// is a no-op.

Object? normalize(Object? obj, List<String> rules) {
  if (rules.isEmpty) return obj;

  if (obj is String) {
    var s = obj;
    if (rules.contains('timestamps')) {
      final re = RegExp(r'^\d{4}-\d{2}-\d{2}T[\d:.Z+\-]+$');
      if (re.hasMatch(s)) return '<TIMESTAMP>';
    }
    if (rules.contains('uuids')) {
      final re = RegExp(
        r'^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$',
        caseSensitive: false,
      );
      if (re.hasMatch(s)) return '<UUID>';
    }
    if (rules.contains('absPaths') && s.startsWith('/')) {
      final parts = s.split('/');
      if (parts.length >= 3) {
        return '<ROOT>/${parts.sublist(3).join('/')}';
      }
    }
    if (rules.contains('dynamicDates')) {
      // MMYYYY (valid month 01-12) then standalone YYYY (19xx/20xx)
      var r = s.replaceAllMapped(
        RegExp(r'(0[1-9]|1[0-2])\d{4}'),
        (_) => '<MMYYYY>',
      );
      r = r.replaceAllMapped(
        RegExp(r'(?<!\d)(20\d{2}|19\d{2})(?!\d)'),
        (_) => '<YYYY>',
      );
      return r;
    }
    if (rules.contains('floatPrecision')) {
      final re = RegExp(r'^-?(\d+)\.0+$');
      if (re.hasMatch(s)) {
        return re.firstMatch(s)!.group(1)!;
      }
    }
    return s;
  }

  if (obj is int) {
    if (rules.contains('epochs') &&
        obj > 1000000000 && obj < 9999999999999) {
      return '<EPOCH>';
    }
    return obj;
  }

  if (obj is double) {
    if (rules.contains('epochs') &&
        obj > 1000000000 && obj < 9999999999999) {
      return '<EPOCH>';
    }
    return obj;
  }

  if (obj is Map) {
    return obj.map((k, v) => MapEntry(k, normalize(v, rules)));
  }

  if (obj is List) {
    return obj.map((e) => normalize(e, rules)).toList();
  }

  return obj;
}

// ─── Strip fields ─────────────────────────────────────────────────────────────
// Remove specified keys from any nested map (recursively).
// Used when a cluster output contains a non-deterministic field that can't
// be normalized (e.g. timestamp in a specific path that should be ignored).

Object? stripFields(Object? obj, List<String> fields) {
  if (fields.isEmpty) return obj;

  if (obj is Map) {
    final out = <String, Object?>{};
    obj.forEach((k, v) {
      if (!fields.contains(k.toString())) {
        out[k.toString()] = stripFields(v, fields);
      }
    });
    return out;
  }

  if (obj is List) {
    return obj.map((e) => stripFields(e, fields)).toList();
  }

  return obj;
}

// ─── Deep clone ───────────────────────────────────────────────────────────────
// For Dart, we deep-clone via JSON round-trip when the value is JSON-able
// (Map<String,?>, List, primitives). For non-JSON-able values (custom objects),
// the caller must convert to JSON-compatible form BEFORE calling fingerprint.

Object? deepClone(Object? obj) {
  if (obj == null) return null;
  if (obj is String || obj is num || obj is bool) return obj;
  if (obj is List) return obj.map(deepClone).toList();
  if (obj is Map) {
    return obj.map((k, v) => MapEntry(k.toString(), deepClone(v)));
  }
  // Fallback: encode/decode JSON. Loses type info but preserves structure.
  return json.decode(json.encode(obj));
}

// ─── Core fingerprint ────────────────────────────────────────────────────────
// combined = stableStringify(input) + "|" + stableStringify(output)
// sha256 -> BigInt (base 16) -> base36 -> first 7 chars
//
// This MUST produce identical output to fingerprint.js / fingerprint.py for
// the same input/output pair. Verified manually — see file header.

String fingerprint(
  Object? inputData,
  Object? outputData, {
  List<String> rules = const [],
  List<String> ignoreFields = const [],
}) {
  final cleanInput = stripFields(
    normalize(deepClone(inputData), rules),
    ignoreFields,
  );
  final cleanOutput = stripFields(
    normalize(deepClone(outputData), rules),
    ignoreFields,
  );

  final combined = '${stableStringify(cleanInput)}|${stableStringify(cleanOutput)}';
  final bytes = utf8.encode(combined);
  final hashHex = _sha256Hex(bytes);

  final bigNum = BigInt.parse(hashHex, radix: 16);
  final b36 = toBase36(bigNum);
  return b36.length >= 7 ? b36.substring(0, 7) : b36;
}

// ─── Trivial output guard ─────────────────────────────────────────────────────
// Mirrors CONTEXT.md "Trivial Input Guard":
//   Output null/undefined/NaN/throws → cluster di-skip.
// Returns true if the output is "trivial" (should skip capture/validate).

bool isTrivialOutput(Object? output) {
  if (output == null) return true;
  if (output is double && output.isNaN) return true;
  if (output is String && output.isEmpty) return true;
  if (output is List && output.isEmpty) return true;
  if (output is Map && output.isEmpty) return true;
  return false;
}

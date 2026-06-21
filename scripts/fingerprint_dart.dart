// fingerprint_dart.dart — deterministic hash for regression contracts
//
// IDENTICAL algorithm to fingerprint.js / fingerprint.py / fingerprint.go:
//   sha256(stableStringify(input) + "|" + stableStringify(output)) → base36 → first 7 chars
//
// Used by capture_dart.sh and validate_dart.sh (via dart run) to compute
// a fingerprint that matches what other stacks would produce for the same
// (input, output) pair — the cross-stack consistency contract.
//
// stableStringify() sorts object keys recursively, matches JS behavior for
// primitives, arrays, and maps. Sentinel handling for non-finite numbers
// (NaN, Infinity, -Infinity) mirrors fingerprint.js issue #322.

import 'dart:convert';
import 'dart:typed_data';
import 'package:crypto/crypto.dart' as crypto;

/// Sentinel strings — must EXACTLY match fingerprint.js.
const _kSentinelNan = '"__nan__"';
const _kSentinelInfinity = '"__infinity__"';
const _kSentinelNegInfinity = '"__neg_infinity__"';
const _kSentinelFunction = '"__function__"';
const _kSentinelSymbol = '"__symbol__"';
const _kSentinelCircular = '"__circular__"';

/// Stable JSON stringify — keys sorted recursively.
/// Must produce identical output to JS stableStringify() / Python stable_dumps().
///
/// Handles:
///   - null → "null", undefined → "undefined"
///   - NaN → "__nan__", Infinity → "__infinity__", -Infinity → "__neg_infinity__"
///   - String → JSON-encoded string
///   - int / double → JSON-encoded number (with sentinel handling for non-finite)
///   - BigInt → "__bigint__:<digits>"
///   - Function → "__function__"
///   - Symbol → "__symbol__"
///   - DateTime → ISO string (JSON-encoded)
///   - List → "[" + items.join(",") + "]"
///   - Map → "{" + sorted keys + ":" + values + "}"
///   - Circular → "__circular__"
String stableStringify(Object? obj, [Set<Object?>? seen]) {
  if (obj == null) {
    // null and undefined both serialize to "null" via JSON.stringify in JS.
    // (Dart has no undefined; treat null as "null" to match JSON.stringify(null).)
    return 'null';
  }

  // Number handling — must mirror fingerprint.js sentinel logic for NaN/Infinity.
  if (obj is double) {
    if (obj.isNaN) return _kSentinelNan;
    if (obj.isInfinite) {
      return obj.isNegative ? _kSentinelNegInfinity : _kSentinelInfinity;
    }
    // JS JSON.stringify(number) produces e.g. "1.5", "1", "0.0001".
    // Dart's jsonEncode matches for normal finite doubles.
    return jsonEncode(obj);
  }
  if (obj is int) {
    return obj.toString();
  }
  if (obj is BigInt) {
    return '__bigint__:${obj.toString()}';
  }
  if (obj is bool) {
    return obj ? 'true' : 'false';
  }
  if (obj is String) {
    return jsonEncode(obj); // matches JSON.stringify(str)
  }
  if (obj is DateTime) {
    return jsonEncode(obj.toUtc().toIso8601String());
  }

  // Function — JSON.stringify returns undefined; sentinel prevents string concat break.
  if (obj is Function) {
    return _kSentinelFunction;
  }

  // Symbol — Dart has no first-class Symbol type that's JSON-serializable;
  // if someone passes a Symbol, emit the sentinel.
  if (obj is Symbol) {
    return _kSentinelSymbol;
  }

  // TypedData (Uint8List, etc.) — convert to regular list, matches JS TypedArray branch.
  if (obj is TypedData) {
    final list = (obj.buffer.asUint8List().toList());
    return '[' + list.map(stableStringify).join(',') + ']';
  }

  // List — array branch with circular detection.
  if (obj is List) {
    seen ??= <Object?>{};
    if (seen.contains(obj)) return _kSentinelCircular;
    seen.add(obj);
    try {
      final parts = <String>[];
      for (final item in obj) {
        parts.add(stableStringify(item, seen));
      }
      return '[' + parts.join(',') + ']';
    } finally {
      seen.remove(obj);
    }
  }

  // Map — object branch with sorted keys + circular detection.
  if (obj is Map) {
    seen ??= <Object?>{};
    if (seen.contains(obj)) return _kSentinelCircular;
    seen.add(obj);
    try {
      // Sort keys as strings (matches Object.keys(obj).sort() in JS).
      final keys = obj.keys.map((k) => k.toString()).toList()..sort();
      final parts = <String>[];
      for (final key in keys) {
        final value = obj[obj.keys.firstWhere(
          (k) => k.toString() == key,
          orElse: () => key,
        )];
        parts.add('${jsonEncode(key)}:${stableStringify(value, seen)}');
      }
      return '{' + parts.join(',') + '}';
    } finally {
      seen.remove(obj);
    }
  }

  // Fallback — try JSON encode; if that fails, fall back to toString().
  try {
    return jsonEncode(obj);
  } catch (_) {
    return jsonEncode(obj.toString());
  }
}

/// Convert a hex string to base36 (lowercase).
/// Mirrors JS: BigInt('0x' + hash).toString(36).
String _hexToBase36(String hex) {
  // Parse hex into a big integer.
  final big = BigInt.parse(hex, radix: 16);
  if (big == BigInt.zero) return '0';
  return big.toRadixString(36);
}

/// Compute the 7-char base36 fingerprint.
///
/// IDENTICAL algorithm to fingerprint.js / fingerprint.py / fingerprint.go:
///   sha256(stableStringify(input) + "|" + stableStringify(output)) → base36 → first 7 chars
String fingerprint(Object? input, Object? output) {
  final combined = stableStringify(input) + '|' + stableStringify(output);
  final hashBytes = crypto.sha256.convert(utf8.encode(combined));
  final hexStr = hashBytes.toString();
  final b36 = _hexToBase36(hexStr);
  return b36.length >= 7 ? b36.substring(0, 7) : b36;
}

// regret_fingerprint.dart — deterministic hash for regression contracts
// IDENTICAL algorithm to fingerprint.js / fingerprint.py:
//   sha256(stableStringify(input) + "|" + stableStringify(output)) -> base36 -> first 7 chars
//
// This is a standalone library — no external package dependencies.
// SHA-256 is implemented natively here to avoid requiring `package:crypto`.

import 'dart:convert';
import 'dart:typed_data';

// ─── SHA-256 (pure Dart, no dependencies) ──────────────────────────────────
// Minimal SHA-256 implementation so we don't need package:crypto.

class _SHA256 {
  static final List<int> _k = [
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5,
    0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3,
    0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc,
    0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7,
    0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
    0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3,
    0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5,
    0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
    0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
  ];

  int _h0 = 0x6a09e667, _h1 = 0xbb67ae85, _h2 = 0x3c6ef372, _h3 = 0xa54ff53a;
  int _h4 = 0x510e527f, _h5 = 0x9b05688c, _h6 = 0x1f83d9ab, _h7 = 0x5be0cd19;

  final BytesBuilder _bytes = BytesBuilder();

  void add(List<int> data) {
    _bytes.add(data);
  }

  List<int> close() {
    final data = _bytes.toBytes();
    final bitLen = data.length * 8;

    // Padding
    _bytes.add([0x80]);
    final padLen = (56 - (data.length + 1) % 64) % 64;
    _bytes.add(List.filled(padLen, 0));

    // Append length as 64-bit big-endian
    final lenBytes = Uint8List(8);
    lenBytes[0] = (bitLen >> 56) & 0xff;
    lenBytes[1] = (bitLen >> 48) & 0xff;
    lenBytes[2] = (bitLen >> 40) & 0xff;
    lenBytes[3] = (bitLen >> 32) & 0xff;
    lenBytes[4] = (bitLen >> 24) & 0xff;
    lenBytes[5] = (bitLen >> 16) & 0xff;
    lenBytes[6] = (bitLen >> 8) & 0xff;
    lenBytes[7] = bitLen & 0xff;
    _bytes.add(lenBytes);

    final padded = _bytes.toBytes();

    // Process 64-byte blocks
    for (int offset = 0; offset < padded.length; offset += 64) {
      _processBlock(padded, offset);
    }

    final hash = <int>[];
    hash.addAll(_int32ToBytes(_h0));
    hash.addAll(_int32ToBytes(_h1));
    hash.addAll(_int32ToBytes(_h2));
    hash.addAll(_int32ToBytes(_h3));
    hash.addAll(_int32ToBytes(_h4));
    hash.addAll(_int32ToBytes(_h5));
    hash.addAll(_int32ToBytes(_h6));
    hash.addAll(_int32ToBytes(_h7));
    return hash;
  }

  void _processBlock(List<int> block, int offset) {
    final w = List<int>.filled(64, 0);

    for (int i = 0; i < 16; i++) {
      w[i] = (block[offset + i * 4] << 24) |
          (block[offset + i * 4 + 1] << 16) |
          (block[offset + i * 4 + 2] << 8) |
          block[offset + i * 4 + 3];
    }

    for (int i = 16; i < 64; i++) {
      final s0 = _rotr(w[i - 15], 7) ^ _rotr(w[i - 15], 18) ^ (w[i - 15] >> 3);
      final s1 = _rotr(w[i - 2], 17) ^ _rotr(w[i - 2], 19) ^ (w[i - 2] >> 10);
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) & 0xffffffff;
    }

    int a = _h0, b = _h1, c = _h2, d = _h3;
    int e = _h4, f = _h5, g = _h6, h = _h7;

    for (int i = 0; i < 64; i++) {
      final S1 = _rotr(e, 6) ^ _rotr(e, 11) ^ _rotr(e, 25);
      final ch = (e & f) ^ ((~e) & g);
      final temp1 = (h + S1 + ch + _k[i] + w[i]) & 0xffffffff;
      final S0 = _rotr(a, 2) ^ _rotr(a, 13) ^ _rotr(a, 22);
      final maj = (a & b) ^ (a & c) ^ (b & c);
      final temp2 = (S0 + maj) & 0xffffffff;

      h = g;
      g = f;
      f = e;
      e = (d + temp1) & 0xffffffff;
      d = c;
      c = b;
      b = a;
      a = (temp1 + temp2) & 0xffffffff;
    }

    _h0 = (_h0 + a) & 0xffffffff;
    _h1 = (_h1 + b) & 0xffffffff;
    _h2 = (_h2 + c) & 0xffffffff;
    _h3 = (_h3 + d) & 0xffffffff;
    _h4 = (_h4 + e) & 0xffffffff;
    _h5 = (_h5 + f) & 0xffffffff;
    _h6 = (_h6 + g) & 0xffffffff;
    _h7 = (_h7 + h) & 0xffffffff;
  }

  int _rotr(int x, int n) => ((x >> n) | (x << (32 - n))) & 0xffffffff;

  List<int> _int32ToBytes(int v) => [
        (v >> 24) & 0xff,
        (v >> 16) & 0xff,
        (v >> 8) & 0xff,
        v & 0xff,
      ];
}

/// Compute SHA-256 hash of [data], returning hex string.
String _sha256Hex(String data) {
  final sha = _SHA256();
  sha.add(utf8.encode(data));
  final hash = sha.close();
  return hash.map((b) => b.toRadixString(16).padLeft(2, '0')).join('');
}

// ─── Stable JSON Stringify ──────────────────────────────────────────────────

/// Stable JSON stringify — keys sorted recursively.
/// Mirrors fingerprint.js stableStringify() exactly.
String stableStringify(dynamic obj, [Set<dynamic>? seen]) {
  seen ??= <dynamic>{};

  if (obj == null) return 'null';
  if (obj is bool) return obj.toString();
  if (obj is int) return obj.toString();
  if (obj is double) {
    if (obj.isNaN) return '"__nan__"';
    if (obj.isInfinite) {
      return obj.isNegative ? '"__neg_infinity__"' : '"__infinity__"';
    }
    // Preserve integer-valued doubles as integers (matching JS behavior)
    if (obj == obj.truncateToDouble() && !obj.isInfinite) {
      return obj.toInt().toString();
    }
    return obj.toString();
  }
  if (obj is BigInt) return '__bigint__:${obj.toString()}';
  if (obj is String) return jsonEncode(obj);
  if (obj is DateTime) return jsonEncode(obj.toUtc().toIso8601String());
  if (obj is Function) return '"__function__"';
  if (obj is List) {
    if (seen.contains(obj)) return '"__circular__"';
    seen.add(obj);
    final result = '[${obj.map((v) => stableStringify(v, seen)).join(',')}]';
    seen.remove(obj);
    return result;
  }
  if (obj is Map) {
    if (seen.contains(obj)) return '"__circular__"';
    seen.add(obj);
    final keys = obj.keys.map((k) => k.toString()).toList()..sort();
    final parts = keys.map((k) => '${jsonEncode(k)}:${stableStringify(obj[k], seen)}').join(',');
    seen.remove(obj);
    return '{$parts}';
  }
  return jsonEncode(obj.toString());
}

// ─── Base36 conversion ──────────────────────────────────────────────────────

/// Convert a BigInt to base36 string (lowercase).
/// Mirrors JS BigInt.toString(36) and Python to_base36().
String _toBase36(BigInt n) {
  if (n == BigInt.zero) return '0';
  const chars = '0123456789abcdefghijklmnopqrstuvwxyz';
  final base = BigInt.from(36);
  final zero = BigInt.zero;
  final buf = StringBuffer();
  var temp = n.abs();

  while (temp > zero) {
    final remainder = temp.remainder(base);
    buf.write(chars[remainder.toInt()]);
    temp = temp ~/ base;
  }

  return buf.toString().split('').reversed.join('');
}

// ─── Fingerprint ────────────────────────────────────────────────────────────

/// Compute the 7-char base36 fingerprint.
/// IDENTICAL algorithm to fingerprint.js / fingerprint.py:
///   sha256(stableStringify(input) + "|" + stableStringify(output)) -> base36 -> first 7 chars
String fingerprint(dynamic input, dynamic output) {
  final combined = stableStringify(input) + '|' + stableStringify(output);
  final hexStr = _sha256Hex(combined);
  final bigNum = BigInt.parse(hexStr, radix: 16);
  final b36 = _toBase36(bigNum);
  return b36.length >= 7 ? b36.substring(0, 7) : b36;
}

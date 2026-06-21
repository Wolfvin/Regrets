// debug_sha256.dart — verify pure-Dart SHA-256 against known test vectors.
import 'fingerprint_dart.dart';

void main() {
  // Test vector 1: empty string
  var h = debugSha256Hex([]);
  print('sha256("")      = $h');
  print('  match: ${h == "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"}');
  print('');

  // Test vector 2: "abc"
  h = debugSha256Hex([97, 98, 99]);
  print('sha256("abc")   = $h');
  print('  match: ${h == "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"}');
  print('');

  // Test vector 3: "hello world"
  h = debugSha256Hex([104, 101, 108, 108, 111, 32, 119, 111, 114, 108, 100]);
  print('sha256("hello world") = $h');
  print('  match: ${h == "b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9"}');
  print('');

  // ─── Fingerprint tests ────────────────────────────────────────────────────
  print('=== Fingerprint tests ===');
  print('');

  // Test: fingerprint(0, "Rp 0") — input is int, output is String
  final fp1 = fingerprint(0, 'Rp 0');
  print('fingerprint(0, "Rp 0")           = $fp1');
  final combined1 = '${stableStringify(0)}|${stableStringify("Rp 0")}';
  print('  combined string: "$combined1"');
  print('  combined bytes:  ${combined1.codeUnits}');
  print('');

  // Test: fingerprint(1500000, "Rp 1.500.000")
  final fp2 = fingerprint(1500000, 'Rp 1.500.000');
  print('fingerprint(1500000, "Rp 1.500.000") = $fp2');
  print('');

  // Test: fingerprint(17.0, "Underweight")
  final fp3 = fingerprint(17.0, 'Underweight');
  print('fingerprint(17.0, "Underweight") = $fp3');
  print('');

  // Test: fingerprint for cart
  final cartInput = [
    {"name": "Nasi Goreng", "price": 25000, "qty": 2},
    {"name": "Es Teh", "price": 5000, "qty": 1},
  ];
  final cartOutput = {
    "subtotal": 55000,
    "tax": 6050,
    "total": 61050,
    "itemCount": 3,
  };
  final fp4 = fingerprint(cartInput, cartOutput);
  print('fingerprint(cart) = $fp4');
  final combined4 = '${stableStringify(cartInput)}|${stableStringify(cartOutput)}';
  print('  combined string: "$combined4"');
  print('');

  // Cross-validate with Python: should give same hash
  // python3 -c "from sys import path; path.insert(0,'scripts'); from fingerprint import fingerprint; print(fingerprint(0, 'Rp 0'))"
  // Expected (computed manually): different hash for different input/output pairs
  print('=== stableStringify debug ===');
  print('stableStringify(0)             = "${stableStringify(0)}"');
  print('stableStringify("Rp 0")        = "${stableStringify("Rp 0")}"');
  print('stableStringify(1500000)       = "${stableStringify(1500000)}"');
  print('stableStringify("Rp 1.500.000") = "${stableStringify("Rp 1.500.000")}"');
  print('stableStringify(17.0)          = "${stableStringify(17.0)}"');
  print('stableStringify("Underweight") = "${stableStringify("Underweight")}"');
  print('stableStringify(cartInput)     = "${stableStringify(cartInput)}"');
  print('stableStringify(cartOutput)    = "${stableStringify(cartOutput)}"');
  print('');

  // ─── toBase36 debug ───────────────────────────────────────────────────────
  print('=== toBase36 + BigInt.parse debug ===');
  final c1 = '${stableStringify(0)}|${stableStringify("Rp 0")}';
  final b1 = c1.codeUnits;
  final h1 = debugSha256Hex(b1);
  print('combined1: "$c1"');
  print('hash1:     $h1');
  final big1 = BigInt.parse(h1, radix: 16);
  print('big1:      $big1');
  print('toBase36(big1): ${toBase36(big1)}');
  print('substring(0,7): ${toBase36(big1).substring(0, 7)}');
  print('');

  final cCart = '${stableStringify(cartInput)}|${stableStringify(cartOutput)}';
  final bCart = cCart.codeUnits;
  final hCart = debugSha256Hex(bCart);
  print('combinedCart: "$cCart"');
  print('hashCart:     $hCart');
  final bigCart = BigInt.parse(hCart, radix: 16);
  print('bigCart:      $bigCart');
  print('toBase36(bigCart): ${toBase36(bigCart)}');
  print('substring(0,7): ${toBase36(bigCart).substring(0, 7)}');
}

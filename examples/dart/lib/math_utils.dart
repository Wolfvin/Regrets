// math_utils.dart — real Dart functions used as capture/validate targets.
//
// These are intentionally non-trivial so the fingerprint actually exercises
// code paths (not just constant returns). Two functions are exported:
//
//   - formatRupiah(int): String — format integer as Indonesian Rupiah.
//       e.g. 1500000 -> "Rp 1.500.000"
//
//   - classifyBmi(double): String — classify BMI per WHO categories.
//       e.g. 22.5 -> "Normal", 17.0 -> "Underweight"
//
//   - summarizeCart(List<Map>): Map — given a list of cart items
//       {name, price, qty}, compute subtotal, tax (11% PPN), total.
//       Returns: {subtotal: int, tax: int, total: int, itemCount: int}
//
// We use these because they touch: string formatting, branching on
// numeric ranges, and aggregate computation over a list of maps. A
// refactor that changes any of these will produce a different output
// and therefore a different fingerprint.

/// Format an integer as Indonesian Rupiah currency string.
/// Uses dot as thousand separator per Indonesian convention.
String formatRupiah(int amount) {
  if (amount < 0) return '-Rp ${_formatAbs(amount.abs())}';
  return 'Rp ${_formatAbs(amount)}';
}

String _formatAbs(int n) {
  final s = n.toString();
  final buf = StringBuffer();
  var count = 0;
  for (var i = s.length - 1; i >= 0; i--) {
    if (count > 0 && count % 3 == 0) buf.write('.');
    buf.write(s[i]);
    count++;
  }
  return String.fromCharCodes(buf.toString().codeUnits.reversed);
}

/// Classify BMI per WHO categories.
/// Returns one of: "Underweight", "Normal", "Overweight", "Obese".
String classifyBmi(double bmi) {
  if (bmi < 18.5) return 'Underweight';
  if (bmi < 25.0) return 'Normal';
  if (bmi < 30.0) return 'Overweight';
  return 'Obese';
}

/// Summarize a cart of items.
/// Each item: {"name": String, "price": int, "qty": int}.
/// Returns: {"subtotal": int, "tax": int, "total": int, "itemCount": int}
/// Tax is 11% PPN (Indonesian VAT), rounded to nearest integer.
///
/// Input is `List<dynamic>` (instead of `List<Map<...>>`) because the regret
/// harness passes JSON-decoded data, which always produces `List<dynamic>`
/// and `Map<String, dynamic>` regardless of the source-code type annotations.
/// We cast each element to `Map<String, dynamic>` inside the loop.
Map<String, Object> summarizeCart(List<dynamic> items) {
  var subtotal = 0;
  var itemCount = 0;
  for (final item in items) {
    final m = item as Map<String, dynamic>;
    final price = (m['price'] as num).toInt();
    final qty = (m['qty'] as num).toInt();
    subtotal += price * qty;
    itemCount += qty;
  }
  // 11% PPN, rounded to nearest integer
  final tax = (subtotal * 0.11).round();
  final total = subtotal + tax;
  return {
    'subtotal': subtotal,
    'tax': tax,
    'total': total,
    'itemCount': itemCount,
  };
}

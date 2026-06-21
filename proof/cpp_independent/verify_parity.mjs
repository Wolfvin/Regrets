// Cross-stack fingerprint parity verification
// Same INPUT/OUTPUT → same fingerprint across JS and C++
// Tests: string input "hello" → output "olleh" (reverse)

import crypto from 'crypto';

function fingerprint(input, output) {
  const stable = (val) => {
    if (val === null || val === undefined) return 'null';
    if (typeof val === 'boolean') return val ? 'true' : 'false';
    if (typeof val === 'number') {
      if (Number.isNaN(val)) return '"__nan__"';
      if (!Number.isFinite(val)) return val > 0 ? '"__infinity__"' : '"__neg_infinity__"';
      if (Number.isInteger(val) && Math.abs(val) < 1e21) return String(val);
      return val.toString();
    }
    if (typeof val === 'string') return JSON.stringify(val);
    if (Array.isArray(val)) return '[' + val.map(stable).join(',') + ']';
    if (typeof val === 'object') {
      const keys = Object.keys(val).sort();
      return '{' + keys.map(k => JSON.stringify(k) + ':' + stable(val[k])).join(',') + '}';
    }
    return String(val);
  };

  const combined = stable(input) + '|' + stable(output);
  const hash = crypto.createHash('sha256').update(combined).digest('hex');

  // Hex → base36 (matching fingerprint.js)
  let num = BigInt('0x' + hash);
  const base = 36n;
  const chars = '0123456789abcdefghijklmnopqrstuvwxyz';
  let result = '';
  if (num === 0n) {
    result = '0';
  } else {
    while (num > 0n) {
      result = chars[Number(num % base)] + result;
      num = num / base;
    }
  }
  // Pad to 7 chars
  while (result.length < 7) result = '0' + result;
  return result.substring(0, 7);
}

// Test: same inputs/outputs as our C++ fixture
const tests = [
  { input: "hello", output: "olleh", expectedCpp: "5nssd6s", desc: "reverse(hello)" },
  { input: "Race Car", output: true, expectedCpp: "382h75s", desc: "is_palindrome(Race Car)" },
  { input: "hello world", output: 2, expectedCpp: "1na8qrz", desc: "word_count(hello world)" },
  { input: "Hello World! 2024", output: "hello-world-2024", expectedCpp: "45tk3ov", desc: "slugify" },
  { input: "hello world", output: "Hello World", expectedCpp: "4am2hvn", desc: "title_case" },
];

console.log("=== Cross-Stack Fingerprint Parity: JS vs C++ ===\n");
let allMatch = true;
for (const t of tests) {
  const jsFp = fingerprint(t.input, t.output);
  const match = jsFp === t.expectedCpp;
  console.log(`${match ? '✅' : '❌'} ${t.desc}: JS=${jsFp} C++=${t.expectedCpp} ${match ? 'MATCH' : 'MISMATCH'}`);
  if (!match) allMatch = false;
}
console.log(`\n${allMatch ? '✅ ALL FINGERPRINTS MATCH' : '❌ FINGERPRINT MISMATCH DETECTED'}`);
process.exit(allMatch ? 0 : 1);

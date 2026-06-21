// Verify cross-stack fingerprint consistency: same (input, output) must produce
// the same hash in JS (fingerprint.js) and Dart (fingerprint_dart.dart).
import { fingerprint, stableStringify } from './fingerprint.js'

const cases = [
  // snake-case input0: "HelloWorld" → "hello_world" → hash=69495z4
  { input: 'HelloWorld', output: 'hello_world', expected: '69495z4' },
  // levenshtein input0: ["kitten","sitting"] → 3 → hash=tu16lpe
  { input: ['kitten', 'sitting'], output: 3, expected: 'tu16lpe' },
  // format-thousands input0: 0 → "0" → hash=1r8v87w
  { input: 0, output: '0', expected: '1r8v87w' },
  // is-email input0: "user@example.com" → true → hash=1cb1iqg
  { input: 'user@example.com', output: true, expected: '1cb1iqg' },
]

let allPass = true
for (const { input, output, expected } of cases) {
  const jsHash = fingerprint(input, output)
  const ok = jsHash === expected
  if (!ok) allPass = false
  console.log(`${ok ? '✅' : '❌'} JS hash(${JSON.stringify(input)} → ${JSON.stringify(output)}) = ${jsHash} (expected ${expected} from Dart)`)
}

console.log(allPass ? '\n✅ Cross-stack fingerprint consistency verified' : '\n❌ Mismatch — cross-stack contract broken')
process.exit(allPass ? 0 : 1)

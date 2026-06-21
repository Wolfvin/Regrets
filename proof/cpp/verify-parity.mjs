// verify-parity.mjs — verify that the C++ harness produces the same 7-char
// base36 hash as the JS reference implementation (fingerprint.js) for the
// same (input, output) pair.
//
// Run: node proof/cpp/verify-parity.mjs

import { readFileSync } from 'node:fs'
import { fingerprint } from '../../scripts/fingerprint.js'

const cases = [
  // Free-function clusters (these must match C / Java / JS hashes exactly)
  { id: 'add',             input: [2, 3],                                          output: 5 },
  { id: 'fibonacci',       input: 10,                                              output: 55 },
  { id: 'reverse',         input: 'Hello, World!',                                 output: '!dlroW ,olleH' },
  { id: 'parse-csv-line',  input: '"hello, world",42,"quoted, field"',
                            output: ['hello, world', '42', 'quoted, field'] },
  { id: 'format-bytes',    input: 1073741824,                                      output: '1.00 GiB' },
  // C++-only class-method clusters (no other stack has these, just verify parity with JS)
  { id: 'factorial',       input: 5,                                               output: 120 },
  { id: 'gcd',             input: [48, 36],                                        output: 12 },
  { id: 'is-palindrome',   input: 'A man, a plan, a canal: Panama',                output: true },
]

let failures = 0
console.log('Comparing JS fingerprint() vs C++-produced HASH from .regret files:\n')
for (const c of cases) {
  const jsFp = fingerprint(c.input, c.output)
  const regretPath = `proof/cpp/regrets/${c.id}.regret`
  const regret = readFileSync(regretPath, 'utf8')
  const m = regret.match(/^HASH\s+(\S+)/m)
  const cppFp = m ? m[1] : null
  const match = jsFp === cppFp
  console.log(`${match ? '✅' : '❌'} ${c.id.padEnd(16)} JS=${jsFp}  C++=${cppFp}  ${match ? '' : 'MISMATCH'}`)
  if (!match) failures++
}
console.log(`\n${failures === 0 ? '✅ All fingerprints match — cross-stack parity verified.' : `❌ ${failures} mismatches`}`)
process.exit(failures === 0 ? 0 : 1)

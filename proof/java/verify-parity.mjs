// verify-parity.mjs — verify that the Java fingerprint produces the same
// 7-char base36 hash as the JS reference implementation (fingerprint.js)
// for the same (input, output) pair.
//
// Run: node proof/java/verify-parity.mjs

import { readFileSync } from 'node:fs'
import { fingerprint } from '../../scripts/fingerprint.js'

const cases = [
  { name: 'add',          input: [2, 3],                            output: 5 },
  { name: 'fibonacci',    input: 10,                                 output: 55 },
  { name: 'reverse',      input: 'Hello, World!',                    output: '!dlroW ,olleH' },
  { name: 'parse-csv',    input: '"hello, world",42,"quoted, field"',
                            output: ['hello, world', '42', 'quoted, field'] },
  { name: 'format-bytes', input: 1073741824,                         output: '1.00 GiB' },
  // Edge-case parity: exercises the __nan__, __infinity__, __neg_infinity__
  // sentinels in stableStringify (issue #322) plus recursive key sorting.
  // The Java side inserts keys in order {input, reciprocal, negReciprocal, nanField};
  // after alphabetical sorting the canonical form is
  //   {"input":0,"nanField":"__nan__","negReciprocal":"__neg_infinity__","reciprocal":"__infinity__"}
  // — JS fingerprint() must produce the same hash for the equivalent JS object.
  { name: 'stats',        input: 0,
                            output: { input: 0, reciprocal: Infinity,
                                      negReciprocal: -Infinity, nanField: NaN } },
]

let failures = 0
console.log('Comparing JS fingerprint() vs Java-produced HASH from .regret files:\n')
for (const c of cases) {
  const jsFp = fingerprint(c.input, c.output)
  const regretPath = `proof/java/regrets/${c.name === 'parse-csv' ? 'parse-csv-line' : c.name}.regret`
  const regret = readFileSync(regretPath, 'utf8')
  const m = regret.match(/^HASH\s+(\S+)/m)
  const javaFp = m ? m[1] : null
  const match = jsFp === javaFp
  console.log(`${match ? '✅' : '❌'} ${c.name.padEnd(14)} JS=${jsFp}  Java=${javaFp}  ${match ? '' : 'MISMATCH'}`)
  if (!match) failures++
}
console.log(`\n${failures === 0 ? '✅ All fingerprints match — cross-stack parity verified.' : `❌ ${failures} mismatches`}`)
process.exit(failures === 0 ? 0 : 1)

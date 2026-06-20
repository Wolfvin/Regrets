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

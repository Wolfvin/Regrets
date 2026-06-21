// verify-parity.mjs — verify that the awk stack produces the same 7-char
// base36 hash as the JS reference implementation (fingerprint.js) for the
// same (input, output) pair.
//
// Run: node proof/awk/verify-parity.mjs

import { readFileSync } from 'node:fs'
import { fingerprint } from '../../scripts/fingerprint.js'

const cases = [
  { id: 'sum-column',      input: '1\n2\n3\n4\n5\n',                                output: '15' },
  { id: 'fibonacci',       input: '10',                                             output: '55' },
  { id: 'reverse-lines',   input: 'Hello\nWorld\n',                                 output: 'dlroW\nolleH' },
  { id: 'word-count',      input: 'the quick brown fox\njumps over\n',              output: '6' },
  { id: 'csv-field-count', input: '"hello, world",42,"quoted, field"',              output: '3' },
  { id: 'max-value',       input: '3\n1\n4\n1\n5\n9\n2\n6\n',                       output: '9' },
]

let failures = 0
console.log('Comparing JS fingerprint() vs awk-produced HASH from .regret files:\n')
for (const c of cases) {
  const jsFp = fingerprint(c.input, c.output)
  const regretPath = `proof/awk/regrets/${c.id}.regret`
  const regret = readFileSync(regretPath, 'utf8')
  const m = regret.match(/^HASH\s+(\S+)/m)
  const awkFp = m ? m[1] : null
  const match = jsFp === awkFp
  console.log(`${match ? '✅' : '❌'} ${c.id.padEnd(18)} JS=${jsFp}  awk=${awkFp}  ${match ? '' : 'MISMATCH'}`)
  if (!match) failures++
}
console.log(`\n${failures === 0 ? '✅ All fingerprints match — cross-stack parity verified.' : `❌ ${failures} mismatches`}`)
process.exit(failures === 0 ? 0 : 1)

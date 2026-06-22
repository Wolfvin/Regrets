// verify-parity.mjs — verify that the Go stack produces the same 7-char
// base36 hash as the JS reference implementation (fingerprint.js) for the
// same (input, output) pair.
//
// Run: node proof/go_independent/verify-parity.mjs

import { readFileSync } from 'node:fs'
import { fingerprint } from '../../scripts/fingerprint.js'

// Each case mirrors the top-level INPUT/OUTPUT/HASH trio stored in the
// captured .regret file. The JS fingerprint is computed independently
// from the same (input, output) pair and compared to the stored HASH.
//
// Notes:
//   - For multi-return functions (ParseISO8601 returns (time, error)),
//     the captured OUTPUT is an array like ["2026-06-22T15:04:05Z", null].
//     We compute JS fingerprint() on the same array.
//   - For map returns (CountWords), the captured OUTPUT is an object.
//   - For multiArgs functions (DaysBetween, AddBusinessDays, etc.), the
//     captured INPUT is an array like ["2026-01-01", "2026-01-10"].
const cases = [
  {
    id: 'parse-iso8601',
    input: '2026-06-22T15:04:05Z',
    output: ['2026-06-22T15:04:05Z', null],
  },
  {
    id: 'format-duration',
    input: 3661,
    output: '1h 1m 1s',
  },
  {
    id: 'weekday-name',
    input: '2026-06-22',
    output: 'Monday',
  },
  {
    id: 'days-between',
    input: ['2026-01-01', '2026-01-10'],
    output: 9,
  },
  {
    id: 'add-business-days',
    input: ['2026-06-22', 5],
    output: '2026-06-29',
  },
  {
    id: 'format-cents',
    input: 1099,
    output: '$10.99',
  },
  {
    id: 'apply-discount',
    input: [1000, 10],
    output: 900,
  },
  {
    id: 'sum-cents',
    input: '100|200|300',
    output: 600,
  },
  {
    id: 'parse-money',
    input: '$10.99',
    output: 1099,
  },
  {
    id: 'dedupe-strings',
    input: 'a|b|a|c|b',
    output: 'a|b|c',
  },
  {
    id: 'sort-and-join',
    input: ['banana|apple|cherry', ','],
    output: 'apple,banana,cherry',
  },
  {
    id: 'count-words',
    input: 'The Quick Brown Fox the',
    output: { The: 1, Quick: 1, Brown: 1, Fox: 1, the: 1 },
  },
  {
    id: 'intersect',
    input: 'a|b|c||b|c|d',
    output: 'b|c',
  },
  {
    id: 'chunk',
    input: '1|2|3|4|5|2',
    output: '1,2;3,4;5',
  },
]

let failures = 0
console.log('Comparing JS fingerprint() vs Go-produced HASH from .regret files:\n')
for (const c of cases) {
  const jsFp = fingerprint(c.input, c.output)
  const regretPath = `proof/go_independent/regrets/${c.id}.regret`
  let regret = ''
  try {
    regret = readFileSync(regretPath, 'utf8')
  } catch {
    console.log(`❌ ${c.id.padEnd(22)} .regret file not found at ${regretPath}`)
    failures++
    continue
  }
  const m = regret.match(/^HASH\s+(\S+)/m)
  const goFp = m ? m[1] : null
  const match = jsFp === goFp
  console.log(`${match ? '✅' : '❌'} ${c.id.padEnd(22)} JS=${jsFp}  go=${goFp}  ${match ? '' : 'MISMATCH'}`)
  if (!match) failures++
}
console.log(`\n${failures === 0 ? '✅ All fingerprints match — cross-stack parity verified.' : `❌ ${failures} mismatches`}`)
process.exit(failures === 0 ? 0 : 1)

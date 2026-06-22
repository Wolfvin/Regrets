// verify-parity.mjs — verify that the awk stack produces the same 7-char
// base36 hash as the JS reference implementation (fingerprint.js) for the
// same (input, output) pair.
//
// Run: node proof/awk_independent/verify-parity.mjs

import { readFileSync } from 'node:fs'
import { fingerprint } from '../../scripts/fingerprint.js'

// Cases mirror the fixtures in proof/awk_independent/regrets/manifest.json.
// Each case has the cluster id + the (input, output) pair expected to be
// stored as the top-level INPUT/OUTPUT/HASH in the captured .regret file.
const cases = [
  {
    id: 'apache-status-class',
    input: '127.0.0.1 - - [10/Oct/2026:13:55:36 -0700] "GET / HTTP/1.1" 200 2326\n10.0.0.5 - - [10/Oct/2026:13:55:42 -0700] "POST /login HTTP/1.1" 401 758\n',
    output: '2xx\n4xx',
  },
  {
    id: 'markdown-links',
    input: 'See [the docs](https://example.com/docs) and [source](src/index.js).\nNo links here.\nAnother [link](https://foo.bar).\n',
    output: 'the docs -> https://example.com/docs\nsource -> src/index.js\nlink -> https://foo.bar',
  },
  {
    id: 'dedupe-lines',
    input: 'alpha\nbeta\nalpha\ngamma\nbeta\n',
    output: 'alpha\nbeta\ngamma',
  },
  {
    id: 'indent-prefix',
    input: 'one\ntwo\nthree\n',
    output: '   one\n   two\n   three',   // 3-space prefix (cluster.args -v indent=3)
  },
  {
    id: 'transpose-matrix',
    input: '1\t2\t3\n4\t5\t6\n',
    output: '1\t4\n2\t5\n3\t6',
  },
]

let failures = 0
console.log('Comparing JS fingerprint() vs awk-produced HASH from .regret files:\n')
for (const c of cases) {
  const jsFp = fingerprint(c.input, c.output)
  const regretPath = `proof/awk_independent/regrets/${c.id}.regret`
  let regret = ''
  try {
    regret = readFileSync(regretPath, 'utf8')
  } catch {
    console.log(`❌ ${c.id.padEnd(22)} .regret file not found at ${regretPath}`)
    failures++
    continue
  }
  const m = regret.match(/^HASH\s+(\S+)/m)
  const awkFp = m ? m[1] : null
  const match = jsFp === awkFp
  console.log(`${match ? '✅' : '❌'} ${c.id.padEnd(22)} JS=${jsFp}  awk=${awkFp}  ${match ? '' : 'MISMATCH'}`)
  if (!match) failures++
}
console.log(`\n${failures === 0 ? '✅ All fingerprints match — cross-stack parity verified.' : `❌ ${failures} mismatches`}`)
process.exit(failures === 0 ? 0 : 1)

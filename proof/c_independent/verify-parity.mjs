// verify-parity.mjs — verify that the C harness produces the same 7-char
// base36 hash as the JS reference implementation (fingerprint.js) for the
// same (input, output) pairs in proof/c_independent/.
//
// This is INDEPENDENT of the C harness's own fingerprint code — it uses
// the JS reference implementation, which itself was already verified
// against the Python implementation.
//
// Run: node proof/c_independent/verify-parity.mjs

import { readFileSync } from 'node:fs'
import { fingerprint } from '../../scripts/fingerprint.js'

// Reference (input, output) pairs — INDEPENDENTLY verified against
// Python's base64, zlib.crc32, fnvhash, and a hand-written slugify + ipv4
// validator.  See proof/c_independent/README.md for the verification table.
const cases = [
  // slugify (3 inputs)
  { cluster: 'slugify', input: 'Hello, World! This is a TEST.', output: 'hello-world-this-is-a-test' },
  { cluster: 'slugify', input: '  multiple   spaces   here  ',  output: 'multiple-spaces-here' },
  { cluster: 'slugify', input: 'ABC---DEF???GHI',                output: 'abc-def-ghi' },
  // base64-encode (3 inputs)
  { cluster: 'base64-encode', input: 'Hello',        output: 'SGVsbG8=' },
  { cluster: 'base64-encode', input: 'hello world',  output: 'aGVsbG8gd29ybGQ=' },
  { cluster: 'base64-encode', input: '',             output: '' },
  // crc32 (2 inputs)
  { cluster: 'crc32', input: 'Hello',                                    output: 4157704578 },
  { cluster: 'crc32', input: 'The quick brown fox jumps over the lazy dog', output: 1095738169 },
  // fnv1a-32 (2 inputs)
  { cluster: 'fnv1a-32', input: 'Hello', output: 4116459851 },
  { cluster: 'fnv1a-32', input: '',      output: 2166136261 },
  // is-valid-ipv4 (5 inputs)
  { cluster: 'is-valid-ipv4', input: '192.168.1.1',     output: true },
  { cluster: 'is-valid-ipv4', input: '255.255.255.255', output: true },
  { cluster: 'is-valid-ipv4', input: '256.0.0.1',       output: false },
  { cluster: 'is-valid-ipv4', input: '01.02.03.04',     output: false },
  { cluster: 'is-valid-ipv4', input: '1.2.3',           output: false },
]

let failures = 0
const seen = new Set()
console.log('Comparing JS fingerprint() vs C-produced HASH from .regret files:\n')
for (const c of cases) {
  const jsFp = fingerprint(c.input, c.output)
  // Read regret file; first-input hash is on HASH line, additional inputs are in INPUTS line
  const regret = readFileSync(`proof/c_independent/regrets/${c.cluster}.regret`, 'utf8')
  if (!seen.has(c.cluster)) {
    // First occurrence for this cluster: read top-level HASH
    const m = regret.match(/^HASH\s+(\S+)/m)
    const cFp = m ? m[1] : null
    const match = jsFp === cFp
    // Only check the top-level if this case is the first input
    // (the .regret's first INPUT/OUTPUT pair corresponds to cases[0] for that cluster)
    seen.add(c.cluster)
  }
  // Look up this specific input in either the top-level INPUT or the INPUTS array
  const topInputMatch = regret.match(/^INPUT\s+(\S.*?)$/m)
  let cFp
  if (topInputMatch) {
    const topInput = JSON.parse(topInputMatch[1])
    if (JSON.stringify(topInput) === JSON.stringify(c.input)) {
      const m = regret.match(/^HASH\s+(\S+)/m)
      cFp = m ? m[1] : null
    }
  }
  if (cFp === undefined) {
    // Search INPUTS line
    const inputsMatch = regret.match(/^INPUTS\s+(\[.*\])\s*$/m)
    if (inputsMatch) {
      const inputs = JSON.parse(inputsMatch[1])
      const entry = inputs.find(e => JSON.stringify(e.input) === JSON.stringify(c.input))
      cFp = entry ? entry.hash : null
    }
  }
  const match = jsFp === cFp
  console.log(`${match ? '✅' : '❌'} ${c.cluster.padEnd(16)} input=${JSON.stringify(c.input).padEnd(50)} JS=${jsFp}  C=${cFp}  ${match ? '' : 'MISMATCH'}`)
  if (!match) failures++
}
console.log(`\n${failures === 0 ? '✅ All fingerprints match — cross-stack parity verified (C == JS).' : `❌ ${failures} mismatches`}`)
process.exit(failures === 0 ? 0 : 1)

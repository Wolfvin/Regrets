// parity_check.mjs — verify that Scala-captured fingerprints match JS fingerprint
// for the same input/output pairs that appear in regrets/slugify.regret.
//
// This is the cross-stack parity guarantee: the same input → same output must
// produce the same 7-char fingerprint regardless of which stack captured it.
//
// Run from proof/scala_slugify/ directory:
//   node parity_check.mjs

import { readFileSync } from 'fs'
import { fingerprint, stableStringify } from '../../scripts/fingerprint.js'

const regret = readFileSync('regrets/slugify.regret', 'utf8')
const lines = regret.split('\n')

const cases = []
for (let i = 0; i < lines.length; i++) {
  if (!lines[i].startsWith('INPUT  ')) continue
  // Lines look like: INPUT  "Hello, World!"
  //                  OUTPUT "hello-world"
  //                  HASH   615ytfn
  const inJson  = lines[i].slice('INPUT  '.length).trim()
  const outJson = lines[i+1].slice('OUTPUT '.length).trim()
  const hash    = lines[i+2].slice('HASH   '.length).trim()
  const inVal   = JSON.parse(inJson)
  const outVal  = JSON.parse(outJson)
  cases.push({ inVal, outVal, expected: hash })
}

console.log('Verifying cross-stack parity: Scala-captured fingerprints vs JS computation.')
console.log()

let allOk = true
for (const c of cases) {
  const got = fingerprint(c.inVal, c.outVal)
  const ok  = got === c.expected
  console.log(`  ${ok ? '✅' : '❌'}  ${stableStringify(c.inVal)} | ${stableStringify(c.outVal)}  →  ${got} (expected ${c.expected})`)
  if (!ok) allOk = false
}

if (!allOk) {
  console.log('\n❌ Cross-stack parity FAILED — Scala and JS fingerprints diverge.')
  process.exit(1)
}

console.log(`\n✅ All ${cases.length} Scala fingerprints match JS — cross-stack parity verified.`)

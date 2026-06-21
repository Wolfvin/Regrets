// cross_stack_parity_v2.mjs — Verify JS fingerprint matches Dart fingerprint for
// the SAME (input, output) pairs from the v2 (independent verification) fixtures.
//
// This is the cross-stack portability contract: a .regret file captured by
// capture_dart.sh must be parseable + comparable by scripts/validate.js (the JS
// validator), and vice versa. The contract holds iff the underlying hash
// function is byte-for-byte identical across stacks.
//
// This script:
//   1. Reads each .regret file in regrets/ for the v2 clusters (slugify,
//      caesar-cipher, crc16, is-valid-ipv4, count-vowels).
//   2. Extracts the (INPUT, OUTPUT) pair + the Dart-computed HASH.
//   3. Recomputes the hash in JS using fingerprint.js.
//   4. Asserts JS hash == Dart hash.
//
// Run AFTER `bash scripts/capture_dart.sh` (with v2 manifest at regrets/manifest.json).
import { readFileSync, readdirSync } from 'fs'
import { resolve, join } from 'path'
import { fingerprint } from '../../scripts/fingerprint.js'

const REGRET_DIR = resolve(process.cwd(), 'regrets')

// v2 clusters — only check .regret files for these cluster IDs
const V2_CLUSTERS = new Set(['slugify', 'caesar-cipher', 'crc16', 'is-valid-ipv4', 'count-vowels'])

function parseRegret(content) {
  const [metaSection, dataSection] = content.split('\n---\n')
  const meta = {}
  for (const line of metaSection.split('\n')) {
    const idx = line.indexOf(': ')
    if (idx === -1) continue
    const key = line.slice(0, idx)
    const val = line.slice(idx + 2).trim()
    if (key === 'watches') meta.watches = val.slice(1, -1).split(', ').filter(Boolean)
    else if (key === 'version') meta.version = Number(val)
    else meta[key] = val
  }
  const lines = (dataSection || '').split('\n')
  const inputLine = lines.find(l => l.startsWith('INPUT '))
  const outputLine = lines.find(l => l.startsWith('OUTPUT '))
  const hashLine = lines.find(l => l.startsWith('HASH '))
  let parsedInput = null, parsedOutput = null
  if (inputLine) {
    const s = inputLine.replace(/^INPUT\s+/, '')
    try { parsedInput = s === 'undefined' ? undefined : JSON.parse(s) } catch { parsedInput = null }
  }
  if (outputLine) {
    const s = outputLine.replace(/^OUTPUT\s+/, '')
    try { parsedOutput = s === 'undefined' ? undefined : JSON.parse(s) } catch { parsedOutput = null }
  }
  return {
    cluster: meta.cluster,
    input: parsedInput,
    output: parsedOutput,
    dartHash: hashLine ? hashLine.replace(/^HASH\s+/, '').trim() : null,
  }
}

let allPass = true
let checked = 0

const regretFiles = readdirSync(REGRET_DIR).filter(f => f.endsWith('.regret'))
for (const f of regretFiles.sort()) {
  const content = readFileSync(join(REGRET_DIR, f), 'utf8')
  const parsed = parseRegret(content)
  if (!parsed.cluster || !V2_CLUSTERS.has(parsed.cluster)) continue
  if (!parsed.dartHash) {
    console.log(`❌ FAIL  ${f}  (missing HASH line)`)
    allPass = false
    continue
  }
  const jsHash = fingerprint(parsed.input, parsed.output)
  const ok = jsHash === parsed.dartHash
  if (!ok) allPass = false
  checked++
  console.log(`${ok ? '✅' : '❌'} ${f.padEnd(40)}  JS=${jsHash}  Dart=${parsed.dartHash}  ${ok ? 'MATCH' : 'MISMATCH'}  input=${JSON.stringify(parsed.input)} output=${JSON.stringify(parsed.output)}`)
}

console.log()
console.log(`Checked: ${checked} v2 .regret files`)
console.log(allPass
  ? '✅ Cross-stack fingerprint consistency verified — JS hash == Dart hash for all v2 fixture cases.'
  : '❌ Mismatch detected — cross-stack contract broken for v2 fixtures.')
process.exit(allPass ? 0 : 1)

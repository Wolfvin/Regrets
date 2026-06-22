#!/usr/bin/env node
// proof/nim_third_verify/verify-parity.mjs
//
// Cross-stack fingerprint parity check for the third_verify fixture.
// Verifies that Nim HASH values for each cluster match the JS fingerprint()
// for the same (input, output) pair.
//
// This is the SAME check that proof/java/verify-parity.mjs runs for the Java
// stack. We import the real `fingerprint` from scripts/fingerprint.js (no
// inlining) so the comparison is apples-to-apples — any mismatch would mean
// the Nim adapter's algorithm has drifted from the JS reference.
//
// Run from this dir:
//   node verify-parity.mjs

import { readFileSync, readdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { fingerprint } from '../../scripts/fingerprint.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const REGRETS_DIR = join(__dirname, 'regrets')

// ─── Parse .regret file ──────────────────────────────────────────────────────
function parseRegret(content) {
  const lines = content.split('\n')
  const meta = {}
  const data = {}
  let inData = false
  for (const line of lines) {
    if (line.trim() === '---') {
      inData = true
      continue
    }
    if (!inData) {
      const m = line.match(/^([\w]+):\s*(.*)$/)
      if (m) meta[m[1]] = m[2]
    } else {
      const m = line.match(/^(\w+)\s+(.*)$/)
      if (m) {
        if (m[1] === 'INPUT' || m[1] === 'OUTPUT') {
          try {
            data[m[1]] = JSON.parse(m[2])
          } catch {
            data[m[1]] = m[2]
          }
        } else {
          data[m[1]] = m[2]
        }
      }
    }
  }
  return { meta, data }
}

// ─── Main ────────────────────────────────────────────────────────────────────
const regretFiles = readdirSync(REGRETS_DIR).filter((f) => f.endsWith('.regret'))
console.log(`Cross-stack parity check for ${regretFiles.length} Nim clusters`)
console.log('══════════════════════════════════════════════════════════════════════════════')
console.log(`${'cluster'.padEnd(28)} | ${'Nim hash'.padEnd(10)} | ${'JS hash'.padEnd(10)} | ${'match'}`)
console.log('─'.repeat(78))

let allMatch = true
for (const f of regretFiles.sort()) {
  const content = readFileSync(join(REGRETS_DIR, f), 'utf8')
  const { meta, data } = parseRegret(content)
  const nimHash = data.HASH
  const input = data.INPUT
  const output = data.OUTPUT
  const jsHash = fingerprint(input, output)
  const match = nimHash === jsHash
  if (!match) allMatch = false
  const cluster = meta.cluster || f.replace(/\.regret$/, '')
  console.log(
    `${cluster.padEnd(28)} | ${nimHash.padEnd(10)} | ${jsHash.padEnd(10)} | ${match ? '✅' : '❌'}`
  )
}
console.log('══════════════════════════════════════════════════════════════════════════════')
if (allMatch) {
  console.log('✅ All clusters match — Nim hash == JS fingerprint(input, output).')
  console.log('   Cross-stack parity preserved by fingerprint_nim.nim using the same')
  console.log('   sha256(stableStringify(input) + "|" + stableStringify(output)) → base36[0:7]')
  console.log('   algorithm as fingerprint.js.')
  process.exit(0)
} else {
  console.log('❌ Parity BROKEN — at least one Nim hash differs from JS fingerprint.')
  console.log('   This indicates the Nim adapter has drifted from the JS reference.')
  process.exit(1)
}

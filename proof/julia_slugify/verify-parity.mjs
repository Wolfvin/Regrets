#!/usr/bin/env node
// proof/julia_slugify/verify-parity.mjs
//
// Cross-stack fingerprint parity check for the Julia slugify fixture.
// Verifies that Julia HASH values match the JS fingerprint() for the same
// (input, output) pair, AND that they match the Nim slugify fixture's
// HASH values (since both implementations produce the same string output
// for the same input — byte-identical contracts across 3 stacks).
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
console.log(`Cross-stack parity check for ${regretFiles.length} Julia clusters`)
console.log('══════════════════════════════════════════════════════════════════════════════')
console.log(`${'cluster'.padEnd(15)} | ${'Julia hash'.padEnd(12)} | ${'JS hash'.padEnd(10)} | ${'Nim hash'.padEnd(10)} | ${'match'}`)
console.log('─'.repeat(78))

// Nim slugify .regret files are at proof/nim_slugify/regrets/
const NIM_REGRETS_DIR = join(__dirname, '..', 'nim_slugify', 'regrets')

let allMatch = true
for (const f of regretFiles.sort()) {
  const content = readFileSync(join(REGRETS_DIR, f), 'utf8')
  const { meta, data } = parseRegret(content)
  const juliaHash = data.HASH
  const input = data.INPUT
  const output = data.OUTPUT
  const jsHash = fingerprint(input, output)
  // Look up Nim hash from corresponding .regret file (same cluster id)
  const nimRegretPath = join(NIM_REGRETS_DIR, f)
  let nimHash = '—'
  try {
    const nimContent = readFileSync(nimRegretPath, 'utf8')
    const { data: nimData } = parseRegret(nimContent)
    nimHash = nimData.HASH || '—'
  } catch {
    // Nim file may not exist (e.g. on a fresh checkout without Nim fixture)
  }
  const match = juliaHash === jsHash && (nimHash === '—' || juliaHash === nimHash)
  if (!match) allMatch = false
  const cluster = meta.cluster || f.replace(/\.regret$/, '')
  console.log(
    `${cluster.padEnd(15)} | ${juliaHash.padEnd(12)} | ${jsHash.padEnd(10)} | ${nimHash.padEnd(10)} | ${match ? '✅' : '❌'}`
  )
}
console.log('══════════════════════════════════════════════════════════════════════════════')
if (allMatch) {
  console.log('✅ All clusters match — Julia hash == JS fingerprint(input, output) == Nim hash.')
  console.log('   Cross-stack parity preserved by fingerprint_julia.jl using the same')
  console.log('   sha256(stableStringify(input) + "|" + stableStringify(output)) → base36[0:7]')
  console.log('   algorithm as fingerprint.js / fingerprint_nim.nim.')
  process.exit(0)
} else {
  console.log('❌ Parity BROKEN — at least one Julia hash differs from JS/Nim.')
  process.exit(1)
}

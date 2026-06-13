#!/usr/bin/env node
// verify-truths.js — Dual-truth verification script
// Automates the comparison of KEBENARAN 1 (raw output) vs KEBENARAN 2 (fingerprints)
// and verifies that both truths remain intact after refactoring.
//
// This script was created because during a real refactoring session on cdigit,
// the manual comparison of KEBENARAN 1 raw outputs against current code output
// was error-prone and tedious. Automating this ensures the dual-truth
// verification pattern is actually executed, not just documented.
//
// Usage:
//   node scripts/verify-truths.js --kebenaran1 <path> --kebenaran2 <path>
//   node scripts/verify-truths.js  (uses defaults: regrets/KEBENARAN_*.json)

import { readFileSync, existsSync } from 'fs'
import { resolve, join, dirname } from 'path'
import { pathToFileURL } from 'url'
import { fingerprint } from './fingerprint.js'

// ─── CLI args ─────────────────────────────────────────────────────────────────

function getArg(args, flag) {
  const i = args.indexOf(flag)
  return i !== -1 ? args[i + 1] ?? null : null
}

const args = process.argv.slice(2)
const k1Path = getArg(args, '--kebenaran1') ?? resolve(process.cwd(), 'regrets', 'KEBENARAN_1_raw_output.json')
const k2Path = getArg(args, '--kebenaran2') ?? resolve(process.cwd(), 'regrets', 'KEBENARAN_2_fingerprints.json')
const manifestPath = getArg(args, '--manifest') ?? resolve(process.cwd(), 'regrets', 'manifest.json')

// ─── Load truths ───────────────────────────────────────────────────────────────

if (!existsSync(k1Path)) {
  console.error(`❌ KEBENARAN 1 not found: ${k1Path}`)
  console.error('   Run Phase 2 first to save raw output baseline.')
  process.exit(1)
}

if (!existsSync(k2Path)) {
  console.error(`❌ KEBENARAN 2 not found: ${k2Path}`)
  console.error('   Run Phase 2 first to save fingerprint baseline.')
  process.exit(1)
}

const k1 = JSON.parse(readFileSync(k1Path, 'utf8'))
const k2 = JSON.parse(readFileSync(k2Path, 'utf8'))
let manifest
try { manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) }
catch { console.error(`❌ Could not read manifest: ${manifestPath}`); process.exit(1) }

// ─── Verification 1: Raw output matches KEBENARAN 1 ────────────────────────────

console.log('\n🔍 VERIFICATION 1: Raw Output vs KEBENARAN 1\n')

let v1Pass = 0
let v1Fail = 0

for (const [clusterId, data] of Object.entries(k1)) {
  const clusterDef = manifest.clusters.find(c => c.id === clusterId)
  if (!clusterDef) {
    console.log(`  ⚠️  ${clusterId}: not in manifest — skipping`)
    continue
  }

  // Import the module and run the entry function
  try {
    const absPath = resolve(process.cwd(), clusterDef.file)
    const moduleUrl = pathToFileURL(absPath).href
    const mod = await import(moduleUrl)

    const entryFn = mod[data.entry] ?? mod.default?.[data.entry]
    if (typeof entryFn !== 'function') {
      console.log(`  ❌ ${clusterId}: entry "${data.entry}" not found in ${clusterDef.file}`)
      v1Fail++
      continue
    }

    let allMatch = true
    for (const test of data.outputs) {
      const actualOutput = await entryFn(test.input)
      if (JSON.stringify(actualOutput) !== JSON.stringify(test.output)) {
        console.log(`  ❌ ${clusterId}: input "${test.input}" expected ${JSON.stringify(test.output)} got ${JSON.stringify(actualOutput)}`)
        allMatch = false
      }
    }

    if (allMatch) {
      console.log(`  ✅ ${clusterId.padEnd(35)} ${data.outputs.length} outputs IDENTICAL`)
      v1Pass++
    } else {
      v1Fail++
    }
  } catch (err) {
    console.log(`  ❌ ${clusterId}: ${err.message}`)
    v1Fail++
  }
}

// ─── Verification 2: Fingerprints match KEBENARAN 2 ────────────────────────────

console.log('\n🔍 VERIFICATION 2: Fingerprints vs KEBENARAN 2\n')

let v2Pass = 0
let v2Fail = 0

const regretDir = resolve(process.cwd(), 'regrets')
for (const [clusterId, expectedFp] of Object.entries(k2.fingerprints || {})) {
  const regretPath = join(regretDir, `${clusterId}.regret`)
  if (!existsSync(regretPath)) {
    console.log(`  ❌ ${clusterId}: .regret file not found`)
    v2Fail++
    continue
  }

  const content = readFileSync(regretPath, 'utf8')
  const fpMatch = content.match(/^fingerprint:\s+(\S+)/m)
  const currentFp = fpMatch ? fpMatch[1] : null

  if (currentFp === expectedFp.fingerprint) {
    console.log(`  ✅ ${clusterId.padEnd(35)} ${currentFp}`)
    v2Pass++
  } else {
    console.log(`  ❌ ${clusterId.padEnd(35)} expected ${expectedFp.fingerprint} got ${currentFp}`)
    v2Fail++
  }
}

// ─── Verification 3: Chain hashes match ────────────────────────────────────────

console.log('\n🔍 VERIFICATION 3: Chain Hashes vs KEBENARAN 2\n')

let v3Pass = 0
let v3Fail = 0

const chainDir = join(regretDir, 'chains')
for (const [chainId, expectedHash] of Object.entries(k2.chainHashes || {})) {
  const chainPath = join(chainDir, `${chainId}.chain`)
  if (!existsSync(chainPath)) {
    console.log(`  ❌ ${chainId}: .chain file not found`)
    v3Fail++
    continue
  }

  const content = readFileSync(chainPath, 'utf8')
  const hashMatch = content.match(/^chain_hash:\s+(\S+)/m)
  const currentHash = hashMatch ? hashMatch[1] : null

  if (currentHash === expectedHash) {
    console.log(`  ✅ ${chainId.padEnd(35)} ${currentHash}`)
    v3Pass++
  } else {
    console.log(`  ❌ ${chainId.padEnd(35)} expected ${expectedHash} got ${currentHash}`)
    v3Fail++
  }
}

// ─── Summary ──────────────────────────────────────────────────────────────────

const totalPass = v1Pass + v2Pass + v3Pass
const totalFail = v1Fail + v2Fail + v3Fail

console.log(`\n${'─'.repeat(60)}`)
console.log(`Verification 1 (Raw Output):    ${v1Pass} PASS, ${v1Fail} FAIL`)
console.log(`Verification 2 (Fingerprints):   ${v2Pass} PASS, ${v2Fail} FAIL`)
console.log(`Verification 3 (Chain Hashes):   ${v3Pass} PASS, ${v3Fail} FAIL`)
console.log(`${'─'.repeat(60)}`)

if (totalFail === 0) {
  console.log(`✅ All ${totalPass} verifications passed. Refactor is proven safe.`)
  process.exit(0)
} else {
  console.log(`❌ ${totalFail} verification(s) failed.`)
  console.log(`\nIf Verification 1 failed → the output genuinely changed (real regression)`)
  console.log(`If Verification 2 failed → run 'regret validate' to check cluster fingerprints`)
  console.log(`If Verification 3 failed → run 'regret chain --validate' to check chain hashes`)
  process.exit(1)
}

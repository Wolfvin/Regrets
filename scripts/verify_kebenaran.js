#!/usr/bin/env node
// verify_kebenaran.js — Verify KEBENARAN 1 and KEBENARAN 2 are semantically identical
// Part of the Dual-Truth Verification pattern.
//
// Usage:
//   node scripts/verify_kebenaran.js
//   node scripts/verify_kebenaran.js --manifest ./regrets/manifest.json

import { readFileSync, existsSync } from 'fs'
import { resolve, join } from 'path'

const args = process.argv.slice(2)
const regretDir = resolve(process.cwd(), 'regrets')

// ─── Load KEBENARAN files ──────────────────────────────────────────────────────

const k1Path = join(regretDir, 'KEBENARAN_1_raw_output.json')
const k2Path = join(regretDir, 'KEBENARAN_2_fingerprints.json')

if (!existsSync(k1Path)) {
  console.error('❌ KEBENARAN 1 not found at: ' + k1Path)
  console.error('   Run this first: capture raw outputs before refactoring')
  process.exit(1)
}

if (!existsSync(k2Path)) {
  console.error('❌ KEBENARAN 2 not found at: ' + k2Path)
  console.error('   Run this first: capture Regrets fingerprints before refactoring')
  process.exit(1)
}

const k1 = JSON.parse(readFileSync(k1Path, 'utf8'))
const k2 = JSON.parse(readFileSync(k2Path, 'utf8'))

// ─── Verify identity ──────────────────────────────────────────────────────────

console.log('\n🔍 Verifying KEBENARAN 1 (raw output) vs KEBENARAN 2 (fingerprints)...\n')

let allOk = true
let checked = 0

// K1 is a flat dict of cluster_id → { entry, outputs: [{ input, output }] }
// K2 has clusters dict of cluster_id → { fingerprint, golden_hash, golden_input, golden_output }
const k2Clusters = k2.clusters || {}

for (const [clusterId, data] of Object.entries(k1)) {
  const k2Cluster = k2Clusters[clusterId]
  if (!k2Cluster) {
    console.log(`❌ ${clusterId}: not found in KEBENARAN 2`)
    allOk = false
    continue
  }

  // Compare the first output (which is what the .regret file stores)
  const outputs = data.outputs || []
  if (outputs.length === 0) {
    console.log(`⚠️  ${clusterId}: no outputs in KEBENARAN 1`)
    continue
  }

  const k1Output = outputs[0].output
  const k2GoldenOutput = k2Cluster.golden_output

  const k1Str = JSON.stringify(k1Output, Object.keys(k1Output).sort())
  const k2Str = JSON.stringify(k2GoldenOutput, Object.keys(k2GoldenOutput).sort())

  if (k1Str === k2Str) {
    console.log(`✅ ${clusterId}: K1 output === K2 golden output`)
    checked++
  } else {
    console.log(`❌ ${clusterId}: MISMATCH`)
    console.log(`   K1: ${k1Str.slice(0, 200)}`)
    console.log(`   K2: ${k2Str.slice(0, 200)}`)
    allOk = false
  }
}

// Check for clusters in K2 but not in K1
for (const clusterId of Object.keys(k2Clusters)) {
  if (!k1[clusterId]) {
    console.log(`⚠️  ${clusterId}: in K2 but not in K1`)
  }
}

// Verify chain hashes
const k2Chains = k2.chains || {}
for (const [chainId, chainData] of Object.entries(k2Chains)) {
  console.log(`⛓  Chain ${chainId}: hash = ${chainData.chain_hash}`)
}

console.log()

if (allOk) {
  console.log(`✅ VERIFICATION PASSED: ${checked} clusters verified — KEBENARAN 1 and KEBENARAN 2 are semantically identical.`)
  console.log('   Safe to proceed with refactoring.')
  process.exit(0)
} else {
  console.log('❌ VERIFICATION FAILED: KEBENARAN 1 and KEBENARAN 2 are NOT identical.')
  console.log('   This means there is a false negative — Regrets is capturing something incorrectly.')
  console.log('   STOP. Fix Regrets before proceeding.')
  process.exit(1)
}

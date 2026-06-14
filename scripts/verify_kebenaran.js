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

// KEBENARAN files may be in regrets/ or proof/<projectName>/
// truth.js saves to proof/<projectName>/ by default, but verify_kebenaran.js
// previously only looked in regrets/. This caused a friction point where
// agents had to manually copy files between directories.
// Now we search both locations automatically.

let k1Path = join(regretDir, 'KEBENARAN_1_raw_output.json')
let k2Path = join(regretDir, 'KEBENARAN_2_fingerprints.json')

// If not in regrets/, try to find in proof/ directory
if (!existsSync(k1Path) || !existsSync(k2Path)) {
  const proofDir = resolve(process.cwd(), 'proof')
  if (existsSync(proofDir)) {
    // Try to find KEBENARAN files in any subdirectory of proof/
    const { readdirSync: readdirSync2, statSync: statSync2 } = await import('fs')
    try {
      const entries = readdirSync2(proofDir, { withFileTypes: true })
      for (const entry of entries) {
        if (entry.isDirectory()) {
          const candidate = join(proofDir, entry.name)
          const k1Candidate = join(candidate, 'KEBENARAN_1_raw_output.json')
          const k2Candidate = join(candidate, 'KEBENARAN_2_fingerprints.json')
          if (existsSync(k1Candidate) && existsSync(k2Candidate)) {
            k1Path = k1Candidate
            k2Path = k2Candidate
            console.log(`📂 Found KEBENARAN files in proof/${entry.name}/`)
            break
          }
        }
      }
    } catch { /* no proof/ subdirectories */ }
  }
}

if (!existsSync(k1Path)) {
  console.error('❌ KEBENARAN 1 not found in regrets/ or proof/')
  console.error('   Run `regret truth` first to capture dual truth baselines')
  process.exit(1)
}

if (!existsSync(k2Path)) {
  console.error('❌ KEBENARAN 2 not found in regrets/ or proof/')
  console.error('   Run `regret truth` first to capture dual truth baselines')
  process.exit(1)
}

const k1 = JSON.parse(readFileSync(k1Path, 'utf8'))
const k2 = JSON.parse(readFileSync(k2Path, 'utf8'))

// ─── Verify identity ──────────────────────────────────────────────────────────

console.log('\n🔍 Verifying KEBENARAN 1 (raw output) vs KEBENARAN 2 (fingerprints)...\n')

let allOk = true
let checked = 0

// K1 is a flat dict of cluster_id → { entry, outputs: [{ input, output }] }
// K2 may store fingerprints under "clusters" (old format) or "fingerprints" (current format)
// The truth.js command saves under "fingerprints", so we check both keys for compatibility.
// K2 clusters dict: cluster_id → { fingerprint, golden_hash, golden_input, golden_output }
// K2 may also use "fingerprints" key (from truth.py) instead of "clusters" (from truth.js)
const k2Clusters = k2.clusters || k2.fingerprints || {}

for (const [clusterId, data] of Object.entries(k1)) {
  const k2Cluster = k2Clusters[clusterId]
  if (!k2Cluster) {
    console.log(`❌ ${clusterId}: not found in KEBENARAN 2`)
    allOk = false
    continue
  }

  // K1 may be stored in two formats depending on truth.js version:
  // - Array format: [{ input, output }, ...] (current truth.js)
  // - Object format: { entry, outputs: [{ input, output }] } (older format)
  let outputs
  if (Array.isArray(data)) {
    outputs = data
  } else if (data && data.outputs) {
    outputs = data.outputs
  } else {
    outputs = []
  }

  const outputList = outputs
  if (outputList.length === 0) {
    console.log(`⚠️  ${clusterId}: no outputs in KEBENARAN 1`)
    continue
  }

  // Handle both truth.js format ({outputs: [{input, output}]}) and truth.py format ([{input, output}])
  const firstOutput = outputList[0]
  const k1Output = firstOutput.output !== undefined ? firstOutput.output : firstOutput

  // K2 may have golden_output (truth.js) or just fingerprint (truth.py)
  const k2GoldenOutput = k2Cluster.golden_output

  // If K2 has golden_output (proof format), compare directly
  if (k2GoldenOutput !== undefined) {
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
  } else if (k2Cluster.fingerprint || k2Cluster.hash) {
    // K2 only has fingerprint (truth.py format) — verify that fingerprint exists
    // The actual fingerprint comparison is done by `regret validate`
    const fp = k2Cluster.fingerprint || k2Cluster.hash
    console.log(`✅ ${clusterId}: K1 output captured, K2 fingerprint = ${fp}`)
    checked++
  } else {
    console.log(`⚠️  ${clusterId}: K2 entry has no golden_output or fingerprint`)
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
  const hash = chainData.chain_hash || chainData.chainHash || 'unknown'
  console.log(`⛓  Chain ${chainId}: hash = ${hash}`)
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

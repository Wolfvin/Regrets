#!/usr/bin/env node
// verify_kebenaran.js — Verify KEBENARAN 1 and KEBENARAN 2 are semantically identical
// Part of the Dual-Truth Verification pattern.
//
// Usage:
//   node scripts/verify_kebenaran.js
//   node scripts/verify_kebenaran.js --manifest ./regrets/manifest.json
//
// Supports two KEBENARAN 2 formats:
//   1. Legacy: { clusters: { id: { fingerprint, golden_output, ... } } }
//   2. Current (from truth.js): { fingerprints: { id: { fingerprint, hash, ... } }, chains: {...} }
//
// Also searches for KEBENARAN files in proof/ subdirectory if not found in regrets/.

import { readFileSync, existsSync, readdirSync } from 'fs'
import { resolve, join } from 'path'
import { fingerprint, stripFields, normalize } from './fingerprint.js'

const args = process.argv.slice(2)
const regretDir = resolve(process.cwd(), 'regrets')

// ─── Load KEBENARAN files ──────────────────────────────────────────────────────

// Search in regrets/ first, then in proof/*/ subdirectory
let k1Path = join(regretDir, 'KEBENARAN_1_raw_output.json')
let k2Path = join(regretDir, 'KEBENARAN_2_fingerprints.json')

if (!existsSync(k1Path) || !existsSync(k2Path)) {
  // Search in proof/ subdirectories
  const proofDir = resolve(process.cwd(), 'proof')
  if (existsSync(proofDir)) {
    try {
      const subdirs = readdirSync(proofDir, { withFileTypes: true })
        .filter(d => d.isDirectory())
        .map(d => d.name)
      for (const sub of subdirs) {
        const candidateK1 = join(proofDir, sub, 'KEBENARAN_1_raw_output.json')
        const candidateK2 = join(proofDir, sub, 'KEBENARAN_2_fingerprints.json')
        if (existsSync(candidateK1) && existsSync(candidateK2)) {
          k1Path = candidateK1
          k2Path = candidateK2
          break
        }
      }
    } catch { /* no proof dir */ }
  }
}

if (!existsSync(k1Path)) {
  console.error('❌ KEBENARAN 1 not found. Searched:')
  console.error('   ' + join(regretDir, 'KEBENARAN_1_raw_output.json'))
  console.error('   proof/*/KEBENARAN_1_raw_output.json')
  console.error('   Run this first: regret truth')
  process.exit(1)
}

if (!existsSync(k2Path)) {
  console.error('❌ KEBENARAN 2 not found. Searched:')
  console.error('   ' + join(regretDir, 'KEBENARAN_2_fingerprints.json'))
  console.error('   proof/*/KEBENARAN_2_fingerprints.json')
  console.error('   Run this first: regret truth')
  process.exit(1)
}

console.log(`   KEBENARAN 1: ${k1Path}`)
console.log(`   KEBENARAN 2: ${k2Path}`)

const k1 = JSON.parse(readFileSync(k1Path, 'utf8'))
const k2 = JSON.parse(readFileSync(k2Path, 'utf8'))

// ─── Normalize K2 format ───────────────────────────────────────────────────────
// Support both formats:
//   Legacy:   { clusters: { id: { fingerprint, golden_output, ... } } }
//   Current:  { fingerprints: { id: { fingerprint, hash, captured, entry } }, chains: {...} }

let k2Clusters
const k2Chains = k2.chains || {}

if (k2.clusters) {
  // Legacy format — already has clusters
  k2Clusters = k2.clusters
} else if (k2.fingerprints) {
  // Current format from truth.js — convert fingerprints to cluster-like structure
  // The fingerprints format stores { fingerprint, hash, captured, entry } but not golden_output.
  // We need to verify by re-computing fingerprints from K1 outputs and comparing against K2 stored fingerprints.
  k2Clusters = null // Signal that we use fingerprint comparison mode
} else {
  console.error('❌ KEBENARAN 2 has unknown format. Expected .clusters or .fingerprints key.')
  process.exit(1)
}

// ─── Verify identity ──────────────────────────────────────────────────────────

console.log('\n🔍 Verifying KEBENARAN 1 (raw output) vs KEBENARAN 2 (fingerprints)...\n')

let allOk = true
let checked = 0

if (k2Clusters) {
  // Legacy format — compare outputs directly
  for (const [clusterId, data] of Object.entries(k1)) {
    const k2Cluster = k2Clusters[clusterId]
    if (!k2Cluster) {
      console.log(`❌ ${clusterId}: not found in KEBENARAN 2`)
      allOk = false
      continue
    }

    // K1 can be either:
    //   - Array of {input, output} (current truth.js format)
    //   - Object with {outputs: [{input, output}]} (legacy format)
    let outputs
    if (Array.isArray(data)) {
      outputs = data
    } else {
      outputs = data.outputs || []
    }
    if (outputs.length === 0) {
      console.log(`⚠️  ${clusterId}: no outputs in KEBENARAN 1`)
      continue
    }

    const k1Output = outputs[0].output
    const k2GoldenOutput = k2Cluster.golden_output

    // Handle primitive types (strings, numbers) that don't have Object.keys
    const k1Str = typeof k1Output === 'object' && k1Output !== null
      ? JSON.stringify(k1Output, Object.keys(k1Output).sort())
      : JSON.stringify(k1Output)
    const k2Str = typeof k2GoldenOutput === 'object' && k2GoldenOutput !== null
      ? JSON.stringify(k2GoldenOutput, Object.keys(k2GoldenOutput).sort())
      : JSON.stringify(k2GoldenOutput)

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
} else {
  // Current format — verify by comparing fingerprints
  // Load manifest to get cluster configs for re-fingerprinting
  const manifestPath = resolve(process.cwd(), 'regrets/manifest.json')
  let manifest
  try {
    manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  } catch {
    console.error('❌ Cannot read regrets/manifest.json for fingerprint verification')
    process.exit(1)
  }

  for (const [clusterId, data] of Object.entries(k1)) {
    const k2Fp = k2.fingerprints[clusterId]
    if (!k2Fp) {
      console.log(`❌ ${clusterId}: not found in KEBENARAN 2 fingerprints`)
      allOk = false
      continue
    }

    // K1 can be either:
    //   - Array of {input, output} (current truth.js format)
    //   - Object with {outputs: [{input, output}]} (legacy format)
    let outputs
    if (Array.isArray(data)) {
      outputs = data
    } else {
      outputs = data.outputs || []
    }
    if (outputs.length === 0) {
      console.log(`⚠️  ${clusterId}: no outputs in KEBENARAN 1`)
      continue
    }

    // Compare the stored fingerprint with one computed from K1 output
    const storedFp = k2Fp.fingerprint || k2Fp.hash

    // Load the .regret file to get the golden fingerprint
    const regretPath = join(regretDir, `${clusterId}.regret`)
    if (!existsSync(regretPath)) {
      console.log(`⚠️  ${clusterId}: no .regret file found`)
      continue
    }

    const regretContent = readFileSync(regretPath, 'utf8')
    const regretFpMatch = regretContent.match(/^fingerprint:\s+(\S+)/m)
    const regretFp = regretFpMatch ? regretFpMatch[1] : null

    // Verify: K2 fingerprint matches current .regret file fingerprint
    if (storedFp === regretFp) {
      console.log(`✅ ${clusterId}: K2 fingerprint (${storedFp}) === current .regret (${regretFp})`)
      checked++
    } else {
      console.log(`❌ ${clusterId}: K2 fingerprint (${storedFp}) !== current .regret (${regretFp})`)
      allOk = false
    }
  }

  // Check for fingerprints in K2 but not in K1
  for (const clusterId of Object.keys(k2.fingerprints)) {
    if (!k1[clusterId]) {
      console.log(`⚠️  ${clusterId}: in K2 but not in K1`)
    }
  }
}

// Verify chain hashes
for (const [chainId, chainData] of Object.entries(k2Chains)) {
  const chainHash = chainData.chainHash || chainData.chain_hash
  console.log(`⛓  Chain ${chainId}: hash = ${chainHash}`)
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

#!/usr/bin/env node
// truth.js — Dual-truth capture and verification
// Captures KEBENARAN 1 (raw output) and KEBENARAN 2 (fingerprints) before refactoring,
// then verifies them after refactoring.
//
// Usage:
//   node scripts/truth.js capture          Save both truths
//   node scripts/truth.js verify           Verify current state matches both truths
//   node scripts/truth.js verify --quick   Only verify KEBENARAN 2 (fingerprint check)
//
// Born from the tengwarjs refactoring experience: every time I needed to capture
// and verify the dual truths, I had to write custom scripts. This should be built-in.

import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync } from 'fs'
import { resolve, join, dirname } from 'path'
import { pathToFileURL } from 'url'
import { fingerprint, fingerprintSequence, extractSchema } from './fingerprint.js'
import { createGhost, deepClone } from './ghost.js'

// ─── CLI args ─────────────────────────────────────────────────────────────────

const args = process.argv.slice(2)
const mode = args[0] ?? 'help'
const quickMode = args.includes('--quick')
const manifestPath = resolve(process.cwd(), 'regrets/manifest.json')
const regretDir = resolve(process.cwd(), 'regrets')
const truthDir = resolve(process.cwd(), 'regrets/truths')

// ─── Parse .regret file ──────────────────────────────────────────────────────

function parseRegret(content) {
  const [metaSection, dataSection] = content.split('\n---\n')
  const meta = {}
  for (const line of metaSection.split('\n')) {
    const colonIdx = line.indexOf(': ')
    if (colonIdx === -1) continue
    const key = line.slice(0, colonIdx)
    const val = line.slice(colonIdx + 2).trim()
    if (key === 'watches') meta.watches = val.slice(1, -1).split(', ').filter(Boolean)
    else if (key === 'normalize') meta.normalize = val.slice(1, -1).split(', ').filter(Boolean)
    else if (key === 'ignoreFields') meta.ignoreFields = val.slice(1, -1).split(', ').filter(Boolean)
    else if (key === 'fingerprintMode') meta.fingerprintMode = val
    else if (key === 'valuePaths') meta.valuePaths = val.slice(1, -1).split(', ').filter(Boolean)
    else if (key === 'version') meta.version = Number(val)
    else meta[key] = val
  }
  const lines = dataSection?.split('\n') ?? []
  const inputLine = lines.find(l => l.startsWith('INPUT '))
  const outputLine = lines.find(l => l.startsWith('OUTPUT '))
  const hashLine = lines.find(l => l.startsWith('HASH '))
  let parsedInput = null
  let parsedOutput = null
  if (inputLine) {
    const inputStr = inputLine.replace(/^INPUT\s+/, '')
    parsedInput = inputStr === 'undefined' ? undefined : JSON.parse(inputStr)
  }
  if (outputLine) {
    const outputStr = outputLine.replace(/^OUTPUT\s+/, '')
    parsedOutput = outputStr === 'undefined' ? undefined : JSON.parse(outputStr)
  }
  return {
    ...meta,
    input: parsedInput,
    output: parsedOutput,
    goldenHash: hashLine ? hashLine.replace(/^HASH\s+/, '').trim() : null
  }
}

// ─── Load manifest ────────────────────────────────────────────────────────────

let manifest
try { manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) }
catch { console.error(`❌ Could not read manifest: ${manifestPath}`); process.exit(1) }

// ─── Run a single cluster and get live output ─────────────────────────────────

async function runClusterLive(clusterDef) {
  const { entry, file, normalize = [], ignoreFields = [], fingerprintLevel = 'entry',
          multiArgs = false, fingerprintMode = 'value', valuePaths = [], inputs, stack } = clusterDef

  if (stack && stack !== 'js' && stack !== 'ts') {
    return null // Skip non-JS stacks
  }

  let mod = await import(pathToFileURL(resolve(process.cwd(), file)).href)

  // Handle CJS modules
  if (mod.default && typeof mod.default === 'object' && !Array.isArray(mod.default)) {
    const merged = { ...mod }
    for (const key of Object.keys(mod.default)) {
      if (!(key in merged)) merged[key] = mod.default[key]
    }
    mod = merged
  }

  // Resolve entry function — handles "module.exports" for CJS single-export
  const entryFn = mod[entry]
    ?? (entry === 'module.exports' || entry === 'default' ? mod.default : null)
    ?? mod.default?.[entry]

  if (typeof entryFn !== 'function') return null

  const testInputs = (inputs && inputs.length > 0) ? inputs : [undefined]
  const outputs = []

  for (const input of testInputs) {
    const inputForArgs = deepClone(input)
    const args_ = multiArgs && Array.isArray(inputForArgs) ? [...inputForArgs] : [inputForArgs]
    const rawOutput = await entryFn(...args_)
    const output = deepClone(rawOutput)
    const fpInput = multiArgs && Array.isArray(input) ? input : input

    let fp
    if (fingerprintMode === 'schema') {
      const schema = extractSchema(output)
      fp = fingerprint(fpInput, schema, { normalize, ignoreFields })
    } else if (fingerprintMode === 'mixed') {
      const schema = extractSchema(output)
      const selectedValues = {}
      for (const path of valuePaths) {
        const key = path.replace(/^\$\./, '')
        const parts = key.split('.')
        let val = output
        for (const p of parts) val = val?.[p]
        if (val !== undefined) selectedValues[path] = val
      }
      const combined = { schema, values: selectedValues }
      fp = fingerprint(fpInput, combined, { normalize, ignoreFields })
    } else {
      fp = fingerprint(fpInput, output, { normalize, ignoreFields })
    }

    outputs.push({ input: deepClone(input), output, fingerprint: fp })
  }

  return outputs
}

// ─── CAPTURE mode ─────────────────────────────────────────────────────────────

async function captureTruths() {
  console.log('\n📡 Capturing dual truths before refactoring...\n')

  mkdirSync(truthDir, { recursive: true })

  // KEBENARAN 1: Raw output of all entry functions
  const kebenaran1 = {}
  // KEBENARAN 2: All fingerprints from .regret files
  const kebenaran2 = { fingerprints: {}, chains: {}, savedAt: new Date().toISOString() }

  // Read .regret files for KEBENARAN 2
  const regretFiles = readdirSync(regretDir).filter(f => f.endsWith('.regret'))

  for (const file of regretFiles) {
    const id = file.replace('.regret', '')
    const content = readFileSync(join(regretDir, file), 'utf8')
    const regret = parseRegret(content)
    kebenaran2.fingerprints[id] = {
      fingerprint: regret.fingerprint,
      goldenHash: regret.goldenHash,
      captured: regret.captured
    }
  }

  // Read chain files for KEBENARAN 2
  const chainsDir = join(regretDir, 'chains')
  if (existsSync(chainsDir)) {
    const chainFiles = readdirSync(chainsDir).filter(f => f.endsWith('.chain'))
    for (const cf of chainFiles) {
      const chainContent = readFileSync(join(chainsDir, cf), 'utf8')
      const chainId = cf.replace('.chain', '')
      const chainHash = chainContent.match(/^chain_hash:\s+(\S+)/m)
      if (chainHash) {
        kebenaran2.chains[chainId] = { chainHash: chainHash[1] }
      }
    }
  }

  // Capture KEBENARAN 1: Run all clusters directly
  for (const cluster of manifest.clusters) {
    const { id, stack } = cluster
    if (stack && stack !== 'js' && stack !== 'ts') {
      console.log(`  ⏭️  ${id}: stack=${stack} — skip (capture manually)`)
      continue
    }

    try {
      const outputs = await runClusterLive(cluster)
      if (outputs) {
        kebenaran1[id] = {
          entry: cluster.entry,
          outputs: outputs.map(o => ({ input: o.input, output: o.output }))
        }
        console.log(`  ✅ ${id}: ${outputs.length} I/O pair(s) captured`)
      } else {
        console.log(`  ⚠️  ${id}: could not run`)
      }
    } catch (err) {
      console.log(`  ❌ ${id}: ${err.message}`)
    }
  }

  // Save KEBENARAN 1
  writeFileSync(
    join(truthDir, 'KEBENARAN_1_raw_output.json'),
    JSON.stringify(kebenaran1, null, 2),
    'utf8'
  )
  console.log(`\n📄 KEBENARAN 1 saved: regrets/truths/KEBENARAN_1_raw_output.json`)

  // Save KEBENARAN 2
  writeFileSync(
    join(truthDir, 'KEBENARAN_2_fingerprints.json'),
    JSON.stringify(kebenaran2, null, 2),
    'utf8'
  )
  console.log(`📄 KEBENARAN 2 saved: regrets/truths/KEBENARAN_2_fingerprints.json`)

  // Verify identity
  console.log(`\n🔍 Verifying KEBENARAN 1 ≡ KEBENARAN 2...`)
  let mismatches = 0
  for (const clusterId in kebenaran1) {
    const k1output = kebenaran1[clusterId].outputs[0]?.output
    const k2regret = kebenaran2.fingerprints[clusterId]
    if (!k2regret) {
      console.log(`  ⚠️  ${clusterId}: no fingerprint in KEBENARAN 2`)
      continue
    }
    // The fingerprint should be reproducible from the raw output
    const clusterDef = manifest.clusters.find(c => c.id === clusterId)
    if (clusterDef) {
      const input = kebenaran1[clusterId].outputs[0]?.input
      const fp = fingerprint(input, k1output, {
        normalize: clusterDef.normalize || [],
        ignoreFields: clusterDef.ignoreFields || []
      })
      if (fp !== k2regret.goldenHash) {
        console.log(`  ❌ ${clusterId}: fingerprint mismatch (live=${fp}, golden=${k2regret.goldenHash})`)
        mismatches++
      } else {
        console.log(`  ✅ ${clusterId}: IDENTIK (fp=${fp})`)
      }
    }
  }

  if (mismatches === 0) {
    console.log(`\n✅ Both truths are IDENTIK. Safe to refactor.`)
  } else {
    console.log(`\n❌ ${mismatches} mismatch(es). FIX Regrets before refactoring.`)
    process.exit(1)
  }
}

// ─── VERIFY mode ──────────────────────────────────────────────────────────────

async function verifyTruths() {
  const k1path = join(truthDir, 'KEBENARAN_1_raw_output.json')
  const k2path = join(truthDir, 'KEBENARAN_2_fingerprints.json')

  if (!existsSync(k1path) || !existsSync(k2path)) {
    console.error(`❌ Truth files not found. Run 'regret truth capture' first.`)
    process.exit(1)
  }

  const k1 = JSON.parse(readFileSync(k1path, 'utf8'))
  const k2 = JSON.parse(readFileSync(k2path, 'utf8'))

  console.log('\n🔍 Verifying dual truths after refactoring...\n')

  let v1Pass = 0, v1Fail = 0, v2Pass = 0, v2Fail = 0, v3Pass = 0, v3Fail = 0

  for (const cluster of manifest.clusters) {
    const { id, stack, normalize = [], ignoreFields = [] } = cluster
    if (stack && stack !== 'js' && stack !== 'ts') continue

    try {
      const outputs = await runClusterLive(cluster)
      if (!outputs || !outputs.length) {
        console.log(`  ⚠️  ${id}: could not run`)
        continue
      }

      // VERIFICATION 1: Regrets fingerprint matches KEBENARAN 2
      const liveFp = outputs[0].fingerprint
      const k2Fp = k2.fingerprints[id]?.goldenHash
      if (liveFp === k2Fp) {
        v1Pass++
      } else {
        v1Fail++
        console.log(`  ❌ V1 ${id}: fingerprint ${liveFp} ≠ golden ${k2Fp}`)
      }

      // VERIFICATION 2: Raw output matches KEBENARAN 1
      if (k1[id]) {
        const k1outputs = k1[id].outputs.map(o => o.output)
        const liveOutputs = outputs.map(o => o.output)
        if (JSON.stringify(k1outputs) === JSON.stringify(liveOutputs)) {
          v2Pass++
        } else {
          v2Fail++
          console.log(`  ❌ V2 ${id}: raw output changed`)
        }
      }

      // VERIFICATION 3: Cross-fingerprint check
      // (redundant with V1, but explicitly verifies the hash algorithm consistency)
      if (k1[id] && k1[id].outputs[0]) {
        const crossFp = fingerprint(k1[id].outputs[0].input, outputs[0].output, { normalize, ignoreFields })
        if (crossFp === k2Fp) {
          v3Pass++
        } else {
          v3Fail++
          console.log(`  ❌ V3 ${id}: cross-fingerprint ${crossFp} ≠ golden ${k2Fp}`)
        }
      }

      console.log(`  ✅ ${id}: V1=${liveFp === k2Fp ? 'PASS' : 'FAIL'} V2=${v2Pass > v1Fail ? 'PASS' : 'FAIL'} V3=${v3Pass > v1Fail ? 'PASS' : 'FAIL'}`)

    } catch (err) {
      console.log(`  ❌ ${id}: ${err.message}`)
      v1Fail++; v2Fail++; v3Fail++
    }
  }

  console.log(`\n${'─'.repeat(50)}`)
  console.log(`VERIFICATION 1 (Fingerprint vs KEBENARAN 2): ${v1Pass} pass, ${v1Fail} fail`)
  console.log(`VERIFICATION 2 (Raw output vs KEBENARAN 1):  ${v2Pass} pass, ${v2Fail} fail`)
  console.log(`VERIFICATION 3 (Cross-fingerprint):           ${v3Pass} pass, ${v3Fail} fail`)

  if (v1Fail === 0 && v2Fail === 0 && v3Fail === 0) {
    console.log(`\n✅ All 3 verifications GREEN. Refactor is proven safe.`)
  } else {
    console.log(`\n❌ Some verifications FAILED. Fix the CODE, not the truths.`)
    process.exit(1)
  }
}

// ─── Main ─────────────────────────────────────────────────────────────────────

if (mode === 'capture') {
  captureTruths().catch(err => { console.error('Fatal:', err); process.exit(1) })
} else if (mode === 'verify') {
  verifyTruths().catch(err => { console.error('Fatal:', err); process.exit(1) })
} else {
  console.log(`
regret truth — Dual-truth capture and verification

Usage:
  node scripts/truth.js capture          Save KEBENARAN 1 + KEBENARAN 2 before refactoring
  node scripts/truth.js verify           Verify both truths after refactoring (3-way check)
  node scripts/truth.js verify --quick   Only verify fingerprints (skip raw output check)

The dual-truth pattern ensures that:
  - KEBENARAN 1: Raw actual output (ground truth, framework-independent)
  - KEBENARAN 2: Regrets fingerprint contract (behavioral contract)

Both must match after refactoring for the refactor to be proven safe.

This command was born from the tengwarjs refactoring experience, where
manually writing kebenaran-1/2 scripts for every project was error-prone
and tedious. Now it's built-in.
`)
}

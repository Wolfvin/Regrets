#!/usr/bin/env node
// truth.js — Save dual truth baselines before refactoring
// KEBENARAN 1: Raw output from every entry function
// KEBENARAN 2: Fingerprint contracts from .regret files
//
// Usage:
//   node scripts/truth.js
//   node scripts/truth.js --outdir ./proof/myproject
//
// Both truths must be identical in meaning. If they disagree,
// there's a false negative in Regrets — fix it before refactoring.

import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync } from 'fs'
import { resolve, join } from 'path'
import { fingerprint, fingerprintSequence, extractSchema } from './fingerprint.js'
import { createGhost, deepClone } from './ghost.js'
import { pathToFileURL } from 'url'

// ─── CLI args ─────────────────────────────────────────────────────────────────

const args = process.argv.slice(2)
const outdirIdx = args.indexOf('--outdir')
const outDir = outdirIdx !== -1 ? args[outdirIdx + 1] : resolve(process.cwd(), 'proof')
const manifestPath = resolve(process.cwd(), 'regrets/manifest.json')

// ─── Load manifest ────────────────────────────────────────────────────────────

let manifest
try {
  manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
} catch (e) {
  console.error(`❌ Could not read manifest: ${manifestPath}`)
  process.exit(1)
}

// ─── KEBENARAN 1: Raw Output ─────────────────────────────────────────────────

console.log('\n📡 Saving KEBENARAN 1 — Raw output from entry functions\n')

const rawOutputs = {}

for (const cluster of manifest.clusters) {
  const { id, entry, watches, file, stack, normalize = [], ignoreFields = [],
          fingerprintLevel = 'entry', fingerprintMode = 'value', valuePaths = [],
          inputs, classMethod, constructor: constructorName, constructorArgs, setup,
          resetState, deepCloneInput = true, seed } = cluster

  if (stack && stack !== 'js' && stack !== 'ts') {
    console.log(`  ⏭️  ${id}: stack=${stack} — skipping (use truth.py for Python)`)
    continue
  }

  try {
    const absPath = resolve(process.cwd(), file)
    let rawModule = await import(pathToFileURL(absPath).href)

    // CJS module merge
    if (rawModule.default && typeof rawModule.default === 'object' && !Array.isArray(rawModule.default)) {
      const merged = { ...rawModule }
      for (const key of Object.keys(rawModule.default)) {
        if (!(key in merged)) merged[key] = rawModule.default[key]
      }
      rawModule = merged
    } else if (rawModule.default && typeof rawModule.default === 'function') {
      const merged = { ...rawModule }
      const fnName = rawModule.default.name
      if (fnName && !(fnName in merged)) merged[fnName] = rawModule.default
      rawModule = merged
    }

    const testInputs = (inputs && inputs.length > 0) ? inputs : [undefined]

    if (classMethod) {
      const Cls = rawModule[constructorName ?? entry] ?? rawModule.default?.[constructorName ?? entry]
      if (typeof Cls !== 'function') throw new Error(`Constructor "${constructorName ?? entry}" not found`)
      const cArgs = constructorArgs ? deepClone(constructorArgs) : []

      const outputs = []
      for (const input of testInputs) {
        const instance = new Cls(...cArgs)
        if (setup && setup.length > 0) {
          for (const step of setup) {
            instance[step.method](...(step.args ? deepClone(step.args) : []))
          }
        }
        const inputForArgs = deepClone(input)
        const args_ = cluster.multiArgs && Array.isArray(inputForArgs) ? [...inputForArgs] : [inputForArgs]
        const rawOutput = await instance[classMethod](...args_)
        outputs.push({ input: deepClone(input), output: deepClone(rawOutput) })
      }
      rawOutputs[id] = outputs
    } else {
      const entryFn = rawModule[entry] ?? rawModule.default?.[entry]
      if (typeof entryFn !== 'function') throw new Error(`Entry "${entry}" not found`)

      const outputs = []
      for (const input of testInputs) {
        // Seed RNG for deterministic output if configured
        const origRandom = Math.random
        if (seed != null) {
          let s = seed | 0
          Math.random = () => {
            s |= 0; s = s + 0x6D2B79F5 | 0
            let t = Math.imul(s ^ s >>> 15, 1 | s)
            t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t
            return ((t ^ t >>> 14) >>> 0) / 4294967296
          }
        }

        // Reset module-level state if configured
        if (resetState) {
          const resetFn = rawModule[resetState] ?? rawModule.default?.[resetState]
          if (typeof resetFn === 'function') resetFn()
        }

        const inputForArgs = deepCloneInput ? deepClone(input) : input
        const args_ = cluster.multiArgs && Array.isArray(inputForArgs) ? [...inputForArgs] : [inputForArgs]
        const rawOutput = await entryFn(...args_)

        // Restore RNG
        if (seed != null) Math.random = origRandom

        outputs.push({ input: deepClone(input), output: deepClone(rawOutput) })
      }
      rawOutputs[id] = outputs
    }

    console.log(`  ✅ ${id}`)
  } catch (err) {
    console.error(`  ❌ ${id}: ${err.message}`)
  }
}

// ─── KEBENARAN 2: Fingerprint Contracts ───────────────────────────────────────

console.log('\n📡 Saving KEBENARAN 2 — Fingerprint contracts from .regret files\n')

const fingerprints = {}
const regretDir = resolve(process.cwd(), 'regrets')

try {
  const regretFiles = readdirSync(regretDir).filter(f => f.endsWith('.regret'))

  for (const file of regretFiles) {
    const content = readFileSync(join(regretDir, file), 'utf8')
    const fpMatch = content.match(/^fingerprint:\s+(\S+)/m)
    const hashMatch = content.match(/^HASH\s+(\S+)/m)
    const clusterMatch = content.match(/^cluster:\s+(.+)$/m)
    const capturedMatch = content.match(/^captured:\s+(.+)$/m)
    const entryMatch = content.match(/^entry:\s+(.+)$/m)

    const id = clusterMatch ? clusterMatch[1].trim() : file.replace('.regret', '')
    fingerprints[id] = {
      fingerprint: fpMatch ? fpMatch[1] : null,
      hash: hashMatch ? hashMatch[1] : null,
      captured: capturedMatch ? capturedMatch[1] : null,
      entry: entryMatch ? entryMatch[1].trim() : null
    }
    console.log(`  ✅ ${id}: ${fpMatch ? fpMatch[1] : 'no fingerprint'}`)
  }
} catch (err) {
  console.error(`❌ Could not read .regret files: ${err.message}`)
}

// Read chain hashes
const chains = {}
const chainsDir = join(regretDir, 'chains')
if (existsSync(chainsDir)) {
  const chainFiles = readdirSync(chainsDir).filter(f => f.endsWith('.chain'))
  for (const file of chainFiles) {
    const content = readFileSync(join(chainsDir, file), 'utf8')
    const chainHashMatch = content.match(/^chain_hash:\s+(\S+)/m)
    const chainId = file.replace('.chain', '')
    chains[chainId] = { chainHash: chainHashMatch ? chainHashMatch[1] : null }
    console.log(`  ✅ chain/${chainId}: ${chainHashMatch ? chainHashMatch[1] : 'no hash'}`)
  }
}

// ─── Consistency Check ───────────────────────────────────────────────────────

const k1Ids = new Set(Object.keys(rawOutputs))
const k2Ids = new Set(Object.keys(fingerprints))

const inK1NotK2 = [...k1Ids].filter(id => !k2Ids.has(id))
const inK2NotK1 = [...k2Ids].filter(id => !k1Ids.has(id))

if (inK1NotK2.length || inK2NotK1.length) {
  console.error('\n❌ INCONSISTENCY between KEBENARAN 1 and KEBENARAN 2:')
  if (inK1NotK2.length) console.error(`   In K1 but not K2: ${inK1NotK2.join(', ')}`)
  if (inK2NotK1.length) console.error(`   In K2 but not K1: ${inK2NotK1.join(', ')}`)
  console.error('   Fix this before refactoring — it indicates a false negative.')
  process.exit(1)
}

// ─── Write Output Files ───────────────────────────────────────────────────────

// Determine project name from manifest or cwd
const projectName = manifest.projectName || process.cwd().split('/').pop()

const proofDir = args.includes('--outdir')
  ? outDir
  : join(outDir, projectName)

mkdirSync(proofDir, { recursive: true })

const k1Path = join(proofDir, 'KEBENARAN_1_raw_output.json')
const k2Path = join(proofDir, 'KEBENARAN_2_fingerprints.json')

writeFileSync(k1Path, JSON.stringify(rawOutputs, null, 2) + '\n', 'utf8')
writeFileSync(k2Path, JSON.stringify({ fingerprints, chains }, null, 2) + '\n', 'utf8')

console.log(`\n${'─'.repeat(50)}`)
console.log(`✅ Both truths saved:`)
console.log(`   KEBENARAN 1: ${k1Path} (${Object.keys(rawOutputs).length} clusters)`)
console.log(`   KEBENARAN 2: ${k2Path} (${Object.keys(fingerprints).length} fingerprints, ${Object.keys(chains).length} chains)`)
console.log(`\n   Consistency: ✅ Both truths are aligned`)
console.log(`\nYou are now safe to refactor. Run 'regret validate' after each change.`)

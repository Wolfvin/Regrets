#!/usr/bin/env node
// capture.js — ghost-proxy runner
// Reads regrets/manifest.json, instruments watched functions,
// runs entry points, and writes .regret files.
//
// Usage:
//   node scripts/capture.js
//   node scripts/capture.js --cluster transform-user-data
//   node scripts/capture.js --manifest ./regrets/manifest.json

import { readFileSync, writeFileSync, mkdirSync } from 'fs'
import { resolve, dirname, join } from 'path'
import { fileURLToPath, pathToFileURL } from 'url'
import { fingerprint, fingerprintSequence, extractSchema } from './fingerprint.js'
import { createGhost, deepClone } from './ghost.js'

const __dirname = dirname(fileURLToPath(import.meta.url))

// ─── CLI args ─────────────────────────────────────────────────────────────────

const args = process.argv.slice(2)
const clusterFilter = args.includes('--cluster') ? args[args.indexOf('--cluster') + 1] : null
const manifestPath  = args.includes('--manifest') ? args[args.indexOf('--manifest') + 1] : undefined
  ?? resolve(process.cwd(), 'regrets/manifest.json')

// ─── Load manifest ────────────────────────────────────────────────────────────

let manifest
try {
  manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
} catch (e) {
  console.error(`❌ Could not read manifest: ${manifestPath}`)
  console.error(`   Create regrets/manifest.json first. See SKILL.md for format.`)
  process.exit(1)
}

const clusters = clusterFilter
  ? manifest.clusters.filter(c => c.id === clusterFilter)
  : manifest.clusters

if (!clusters.length) {
  console.error(`❌ No clusters found${clusterFilter ? ` matching "${clusterFilter}"` : ''}`)
  process.exit(1)
}

// Ghost Proxy and deepClone imported from ghost.js

// ─── Run clusters ─────────────────────────────────────────────────────────────

const outDir = resolve(process.cwd(), 'regrets')
mkdirSync(outDir, { recursive: true })

let passed = 0
let failed = 0

for (const cluster of clusters) {
  const { id, entry, watches, file, stack, normalize = [], ignoreFields = [],
          fingerprintLevel = 'entry', fingerprintMode = 'value', valuePaths = [], inputs } = cluster

  console.log(`\n📡 Capturing: ${id}`)
  console.log(`   File:    ${file}`)
  console.log(`   Entry:   ${entry}`)
  console.log(`   Watches: ${watches.join(', ')}`)

  if (stack && stack !== 'js' && stack !== 'ts') {
    console.log(`   ⚠️  Stack "${stack}" — see references/ for non-JS capture`)
    continue
  }

  try {
    // Dynamic import of target module
    const absPath = resolve(process.cwd(), file)
    const moduleUrl = pathToFileURL(absPath).href
    const rawModule = await import(moduleUrl)

    const recorder = []
    const ghostModule = createGhost(rawModule, watches, recorder)

    // Entry function from ghost module
    const entryFn = ghostModule[entry] ?? rawModule[entry]
    if (typeof entryFn !== 'function') {
      throw new Error(`Entry "${entry}" not found or not a function in ${file}`)
    }

    // Run with provided inputs, or with no args if none specified
    // multiArgs: true → each input is spread as separate arguments
    const testInputs = inputs ?? [undefined]
    const results = []

    for (const input of testInputs) {
      recorder.length = 0  // clear between runs
      const args_ = cluster.multiArgs && Array.isArray(input) ? input : [input]
      const output = await entryFn(...args_)
      
      const fpInput = cluster.multiArgs && Array.isArray(input) ? input : input

      // Determine fingerprint based on fingerprintMode
      let fp
      if (fingerprintMode === 'schema') {
        const schema = extractSchema(output)
        fp = fingerprint(fpInput, schema, { normalize, ignoreFields })
      } else if (fingerprintMode === 'mixed') {
        const schema = extractSchema(output)
        const selectedValues = {}
        for (const path of valuePaths) {
          // Simple dot-notation extraction (e.g., "$.status" → output.status)
          const key = path.replace(/^\$\./, '')
          const parts = key.split('.')
          let val = output
          for (const p of parts) {
            val = val?.[p]
          }
          if (val !== undefined) selectedValues[path] = val
        }
        const combined = { schema, values: selectedValues }
        fp = fingerprint(fpInput, combined, { normalize, ignoreFields })
      } else {
        // Default: value mode
        fp = fingerprintLevel === 'entry'
          ? fingerprint(fpInput, output, { normalize, ignoreFields })
          : fingerprintSequence(recorder, { normalize, ignoreFields })
      }

      results.push({ input, output, fp, calls: [...recorder] })
    }

    // Use first run as the golden (representative) for the .regret file
    const { input, output, fp } = results[0]

    // Write .regret file
    const regretPath = join(outDir, `${id}.regret`)
    const timestamp  = new Date().toISOString()

    // Convert TypedArrays to regular arrays for JSON serialization
    // Without this, JSON.stringify(Uint8Array) produces {"0":1,"1":2,...} instead of [1,2,...]
    const serializableOutput = ArrayBuffer.isView(output) && !(output instanceof DataView)
      ? Array.from(output)
      : output

    const content = [
      `cluster: ${id}`,
      `version: 1`,
      `fingerprint: ${fp}`,
      `captured: ${timestamp}`,
      `watches: [${watches.join(', ')}]`,
      `entry: ${entry}`,
      `stack: ${stack ?? 'js'}`,
      `fingerprintLevel: ${fingerprintLevel}`,
      fingerprintMode !== 'value' ? `fingerprintMode: ${fingerprintMode}` : null,
      valuePaths.length ? `valuePaths: [${valuePaths.join(', ')}]` : null,
      normalize.length ? `normalize: [${normalize.join(', ')}]` : null,
      ignoreFields.length ? `ignoreFields: [${ignoreFields.join(', ')}]` : null,
      `---`,
      `INPUT  ${JSON.stringify(input)}`,
      `OUTPUT ${JSON.stringify(serializableOutput)}`,
      `HASH   ${fp}`,
    ].filter(Boolean).join('\n')

    writeFileSync(regretPath, content, 'utf8')

    console.log(`   ✅ Fingerprint: ${fp}`)
    console.log(`   📄 Saved: regrets/${id}.regret`)
    passed++

  } catch (err) {
    console.error(`   ❌ Capture failed: ${err.message}`)
    failed++
  }
}

// ─── Summary ──────────────────────────────────────────────────────────────────

console.log(`\n${'─'.repeat(50)}`)
console.log(`Capture complete: ${passed} captured, ${failed} failed`)

if (failed > 0) {
  console.log(`\n⚠️  Fix failed captures before proceeding to PHASE 2.`)
  console.log(`   Hint: Check that 'entry' and 'watches' names match exports in your file.`)
  process.exit(1)
}

console.log(`\nNext: node scripts/validate.js`)
console.log(`If all green → you are clear to refactor.`)

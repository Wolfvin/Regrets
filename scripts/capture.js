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
          fingerprintLevel = 'entry', fingerprintMode = 'value', valuePaths = [], inputs,
          instanceMethods = {} } = cluster

  console.log(`\n📡 Capturing: ${id}`)
  console.log(`   File:    ${file}`)
  console.log(`   Entry:   ${entry}`)
  console.log(`   Watches: ${watches.join(', ')}`)

  if (stack && stack !== 'js' && stack !== 'ts') {
    const stackScripts = {
      python: 'python3 scripts/capture.py',
      react: 'node scripts/capture_react.mjs',
      rust: 'bash scripts/capture_rust.sh capture',
      go: 'bash scripts/capture_go.sh capture',
    }
    if (stackScripts[stack]) {
      console.log(`   ⏭️  Stack "${stack}" — use: ${stackScripts[stack]}`)
    } else {
      console.log(`   ⚠️  Stack "${stack}" is not supported — see references/ for available stacks`)
    }
    continue
  }

  try {
    // Dynamic import of target module
    const absPath = resolve(process.cwd(), file)
    const moduleUrl = pathToFileURL(absPath).href
    let rawModule = await import(moduleUrl)

    // Handle CJS modules: when a CommonJS module is imported via ESM dynamic import,
    // named exports may not be available — instead they're on `mod.default`.
    // The ESM namespace object is frozen (not extensible), so we must create a new
    // plain object that merges both the namespace and the default export.
    if (rawModule.default && typeof rawModule.default === 'object' && !Array.isArray(rawModule.default)) {
      const merged = { ...rawModule }
      for (const key of Object.keys(rawModule.default)) {
        if (!(key in merged)) {
          merged[key] = rawModule.default[key]
        }
      }
      // Replace the frozen namespace with the extensible merged object
      rawModule = merged
    }

    const recorder = []
    const ghostModule = createGhost(rawModule, watches, recorder, instanceMethods)

    if (Object.keys(instanceMethods).length > 0) {
      console.log(`   Instance methods: ${Object.entries(instanceMethods).map(([k,v]) => `${k}.${v.join('/')}`).join(', ')}`)
    }

    // Entry function from ghost module
    // Supports both ESM named exports and CommonJS default exports.
    // CommonJS modules imported via dynamic import() may nest exports
    // under .default, so we check: mod.fn → mod.default.fn → error
    const entryFn = ghostModule[entry] ?? rawModule[entry] ?? rawModule.default?.[entry]
    if (typeof entryFn !== 'function') {
      throw new Error(`Entry "${entry}" not found or not a function in ${file}`)
    }

    // Run with provided inputs, or with no args if none specified
    // multiArgs: true → each input is spread as separate arguments
    // Note: empty array `[]` means "no inputs specified" — treat same as undefined
    // Use `[null]` in manifest to call a zero-argument function once
    const testInputs = (inputs && inputs.length > 0) ? inputs : [undefined]
    const results = []

    for (const input of testInputs) {
      recorder.length = 0  // clear between runs
      // Deep-clone input BEFORE calling the function to prevent mutation from
      // corrupting the stored fingerprint. Two clones: one for the .regret file
      // (immutable record), one for the args (may be mutated by the function)
      const inputForRecord = deepClone(input)
      const inputForArgs = deepClone(input)
      const args_ = cluster.multiArgs && Array.isArray(inputForArgs) ? [...inputForArgs] : [inputForArgs]
      const rawOutput = await entryFn(...args_)
      // Deep-clone output BEFORE fingerprinting to ensure the fingerprint is computed
      // from the same serializable data that will be stored in the .regret file.
      // Without this, non-serializable properties (functions, circular refs) would be
      // present during fingerprinting but absent in the stored OUTPUT — causing the
      // .regret file's data to be irreproducible from its own hash.
      const output = deepClone(rawOutput)

      const fpInput = cluster.multiArgs && Array.isArray(inputForRecord) ? inputForRecord : inputForRecord

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

      results.push({ input: inputForRecord, output, fp, calls: [...recorder] })
    }

    // Warn about watched functions that were never called during capture
    const calledFns = new Set()
    for (const r of results) {
      for (const call of r.calls) {
        calledFns.add(call.fn)
      }
    }
    const uncalledWatches = watches.filter(fn => !calledFns.has(fn))
    if (uncalledWatches.length > 0) {
      console.warn(`   ⚠️  Watched function(s) never called during capture: ${uncalledWatches.join(', ')}`)
      console.warn(`      The fingerprint may be based on incomplete data.`)
      console.warn(`      Consider splitting into separate clusters or adjusting the entry function.`)
    }

    // Warn when fingerprintLevel is 'watched' or 'full' but no calls were recorded.
    // This commonly happens with class-based APIs where constructors are called
    // with `new` but the Ghost Proxy lacks a `construct` trap, or where
    // instance methods are not proxied.
    if (fingerprintLevel === 'watched' || fingerprintLevel === 'full') {
      const totalCalls = results.reduce((sum, r) => sum + r.calls.length, 0)
      if (totalCalls === 0) {
        console.error(`   ❌ fingerprintLevel is "${fingerprintLevel}" but NO watched functions were called!`)
        console.error(`      This means the fingerprint is based on an empty call sequence — it tests NOTHING.`)
        console.error(`      For class-based APIs, use 'instanceMethods' in manifest to watch constructor + methods.`)
        console.error(`      Example: { "instanceMethods": { "Track": ["addEvent", "buildData"] } }`)
      }
    }

    // Use first run as the golden (representative) for the .regret file
    const { input, output, fp } = results[0]

    // Write .regret file
    const regretPath = join(outDir, `${id}.regret`)
    const timestamp  = new Date().toISOString()

    // Output is already deepClone'd (serializable), no further conversion needed
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
      Object.keys(instanceMethods).length ? `instanceMethods: ${JSON.stringify(instanceMethods)}` : null,
      `---`,
      `INPUT  ${JSON.stringify(input ?? null)}`,
      `OUTPUT ${JSON.stringify(output ?? null)}`,
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

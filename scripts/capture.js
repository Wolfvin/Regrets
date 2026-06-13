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
      const fpInput = cluster.multiArgs && Array.isArray(input) ? input : input

      let output, errorResult
      try {
        output = await entryFn(...args_)
      } catch (err) {
        // Error path: record the error as the output for fingerprinting
        // This allows error-path regression testing — ensures the same errors
        // are thrown for the same invalid inputs after refactoring.
        errorResult = err instanceof Error ? err.message : String(err)
      }

      if (errorResult !== undefined) {
        // Fingerprint error paths: { __error: errorMessage }
        const errorOutput = { __error: errorResult }
        const fp = fingerprint(fpInput, errorOutput, { normalize, ignoreFields })
        results.push({ input, output: errorOutput, fp, calls: [...recorder], isError: true })
        console.log(`   ⚠️  Error path captured for input ${JSON.stringify(input)}: ${errorResult}`)
      } else {
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

        results.push({ input, output, fp, calls: [...recorder], isError: false })
      }
    }

    if (results.length === 0) {
      throw new Error('No results captured — all inputs failed')
    }

    // Write one .regret file per input (multi-input support)
    // If there's only one result, use the original single-file format for backward compat
    // If there are multiple results, write them as separate .regret files with indexed names
    const timestamp = new Date().toISOString()

    if (results.length === 1) {
      // Single input — original format
      const { input, output, fp, isError } = results[0]
      const regretPath = join(outDir, `${id}.regret`)
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
        isError ? `errorPath: true` : null,
        `---`,
        `INPUT  ${JSON.stringify(input)}`,
        `OUTPUT ${JSON.stringify(serializableOutput)}`,
        `HASH   ${fp}`,
      ].filter(Boolean).join('\n')

      writeFileSync(regretPath, content, 'utf8')
      console.log(`   ✅ Fingerprint: ${fp}`)
      console.log(`   📄 Saved: regrets/${id}.regret`)
    } else {
      // Multiple inputs — write canonical (first) + error-path .regret files
      // The first successful result is the golden (backward compat)
      // Error-path results get separate files with --error-N suffix
      // Additional successful inputs get --input-N suffix
      let successIdx = 0
      let errorIdx = 0
      for (let i = 0; i < results.length; i++) {
        const { input, output, fp, isError } = results[i]
        const serializableOutput = ArrayBuffer.isView(output) && !(output instanceof DataView)
          ? Array.from(output)
          : output

        let regretPath, clusterName
        if (i === 0) {
          // First result always gets canonical name (backward compat)
          regretPath = join(outDir, `${id}.regret`)
          clusterName = id
        } else if (isError) {
          errorIdx++
          clusterName = `${id}--error-${errorIdx}`
          regretPath = join(outDir, `${clusterName}.regret`)
        } else {
          successIdx++
          clusterName = `${id}--input-${successIdx}`
          regretPath = join(outDir, `${clusterName}.regret`)
        }

        const content = [
          `cluster: ${clusterName}`,
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
          isError ? `errorPath: true` : null,
          `parentCluster: ${id}`,
          `---`,
          `INPUT  ${JSON.stringify(input)}`,
          `OUTPUT ${JSON.stringify(serializableOutput)}`,
          `HASH   ${fp}`,
        ].filter(Boolean).join('\n')

        writeFileSync(regretPath, content, 'utf8')
        const icon = isError ? '⚠️' : '✅'
        console.log(`   ${icon} Input #${i}: ${fp}${isError ? ' (error path)' : ''}`)
        console.log(`   📄 Saved: regrets/${clusterName}.regret`)
      }
    }

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

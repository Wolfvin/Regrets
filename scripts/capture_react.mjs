#!/usr/bin/env node
// capture_react.mjs — React component render capture
// Uses react-dom/server renderToStaticMarkup (no DOM, no browser needed)
//
// Usage:
//   node scripts/capture_react.mjs
//   node scripts/capture_react.mjs --cluster invoice-card-render
//   node scripts/capture_react.mjs --manifest ./regrets/manifest.json

import { readFileSync, writeFileSync, mkdirSync } from 'fs'
import { resolve, join, dirname } from 'path'
import { fileURLToPath, pathToFileURL } from 'url'
import { fingerprint, normalize, stableStringify, extractSchema } from './fingerprint.js'
import { deepClone, normalizeHtml } from './ghost.js'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

const __dirname = dirname(fileURLToPath(import.meta.url))

// ─── CLI args ─────────────────────────────────────────────────────────────────

const args = process.argv.slice(2)
const clusterFilter = args.includes('--cluster') ? args[args.indexOf('--cluster') + 1] : null
const manifestPath = args.includes('--manifest')
  ? args[args.indexOf('--manifest') + 1]
  : resolve(process.cwd(), 'regrets/manifest.json')

// ─── Load manifest ────────────────────────────────────────────────────────────

let manifest
try {
  manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
} catch {
  console.error(`❌ Could not read manifest: ${manifestPath}`)
  process.exit(1)
}

const clusters = clusterFilter
  ? manifest.clusters.filter(c => c.id === clusterFilter)
  : manifest.clusters.filter(c => c.stack === 'react')

if (!clusters.length) {
  console.log('No React clusters found in manifest.')
  process.exit(0)
}

// HTML normalization imported from ghost.js

// ─── Capture React clusters ──────────────────────────────────────────────────

const outDir = resolve(process.cwd(), 'regrets')
mkdirSync(outDir, { recursive: true })

let captured = 0
let failed = 0

for (const cluster of clusters) {
  const { id, entry, file, stripAttrs = [], normalize: normRules = [], ignoreFields = [],
          fingerprintMode, valuePaths = [], fingerprintLevel = 'entry', inputs } = cluster

  console.log(`\n📡 Capturing React: ${id}`)
  console.log(`   Component: ${entry}`)
  console.log(`   File: ${file}`)

  try {
    // Try .js extension (compiled from .tsx)
    let absPath = resolve(process.cwd(), file)
    // If file doesn't exist and ends with .tsx, try .js
    try {
      readFileSync(absPath)
    } catch {
      const jsPath = absPath.replace(/\.(tsx|jsx)$/, '.js')
      try {
        readFileSync(jsPath)
        absPath = jsPath
      } catch {
        // Try with js/ prefix
        const jsDir = resolve(process.cwd(), 'js', file.replace(/^src\//, '').replace(/\.(tsx|jsx)$/, '.js'))
        absPath = jsDir
      }
    }

    const moduleUrl = pathToFileURL(absPath).href
    const mod = await import(moduleUrl)

    const Component = mod[entry] ?? mod.default?.[entry] ?? mod.default
    if (!Component) {
      throw new Error(`Component "${entry}" not found in ${file}`)
    }

    const testInputs = inputs ?? [{}]
    const results = []

    for (const input of testInputs) {
      // Render component to static HTML string
      const element = React.createElement(Component, input)
      const rawHtml = renderToStaticMarkup(element)
      const html = normalizeHtml(rawHtml, stripAttrs)

      // Determine fingerprint target based on mode
      let fp
      if (fingerprintMode === 'schema') {
        const schema = extractSchema(html)
        fp = fingerprint(input, schema, { normalize: normRules, ignoreFields })
      } else if (fingerprintMode === 'mixed') {
        const schema = extractSchema(html)
        const selectedValues = {}
        for (const path of valuePaths) {
          // Simple path extraction for string output
          if (path.startsWith('$.') && typeof html === 'string') {
            // For HTML strings, valuePaths don't apply the same way
            // This is a future enhancement
          }
        }
        const combined = { schema, values: selectedValues }
        fp = fingerprint(input, combined, { normalize: normRules, ignoreFields })
      } else {
        // Default: value mode — fingerprint the normalized HTML string
        fp = fingerprint(input, html, { normalize: normRules, ignoreFields })
      }

      results.push({ input, output: html, fp })
    }

    // Use first result as golden
    const { input, output, fp } = results[0]
    const regretPath = join(outDir, `${id}.regret`)
    const timestamp = new Date().toISOString()

    // ─── Multi-input contract (mirrors JS Issue #315) ──────────────────────
    //
    // When the manifest declares multiple `inputs`, we serialize the per-input
    // contract for inputs[1+] as an `INPUTS` line. Each entry is
    //   { input, output, hash }
    // The first input is intentionally OMITTED from this array (it's already
    // represented by the top-level INPUT/OUTPUT/HASH lines) — same convention
    // as capture.js. validate_react.mjs parses this line and re-runs every
    // stored input; any hash mismatch FAILs the cluster even when input[0]
    // still matches.
    //
    // Backward compatibility:
    //   - Old .regret files (no INPUTS line): validate falls back to comparing
    //     only the first hash. Old captures still work — they just don't get
    //     multi-input protection. Re-capture to opt in.
    //   - New .regret files with a single input: INPUTS line is OMITTED
    //     (results.length <= 1) — no overhead for the common case.
    //   - New .regret files with multiple inputs: INPUTS line contains
    //     results.slice(1) — validate compares every hash.
    let inputsLine = null
    if (results.length > 1) {
      const inputsPayload = results.slice(1).map(r => ({
        input: r.input,
        output: r.output,
        hash: r.fp,
      }))
      inputsLine = `INPUTS ${JSON.stringify(inputsPayload)}`
    }

    const content = [
      `cluster: ${id}`,
      `version: 1`,
      `fingerprint: ${fp}`,
      `captured: ${timestamp}`,
      `watches: [${entry}]`,
      `entry: ${entry}`,
      `stack: react`,
      `renderMode: static`,
      normRules.length ? `normalize: [${normRules.join(', ')}]` : null,
      ignoreFields.length ? `ignoreFields: [${ignoreFields.join(', ')}]` : null,
      stripAttrs.length ? `stripAttrs: [${stripAttrs.join(', ')}]` : null,
      fingerprintMode ? `fingerprintMode: ${fingerprintMode}` : null,
      `---`,
      `INPUT  ${JSON.stringify(input)}`,
      `OUTPUT ${JSON.stringify(output)}`,
      `HASH   ${fp}`,
      inputsLine,
    ].filter(Boolean).join('\n')

    writeFileSync(regretPath, content, 'utf8')
    console.log(`   ✅ Fingerprint: ${fp}`)
    console.log(`   📄 Saved: regrets/${id}.regret`)
    captured++

  } catch (err) {
    console.error(`   ❌ Capture failed: ${err.message}`)
    failed++
  }
}

// ─── Summary ──────────────────────────────────────────────────────────────────

console.log(`\n${'─'.repeat(50)}`)
console.log(`React capture complete: ${captured} captured, ${failed} failed`)

if (failed > 0) {
  process.exit(1)
}

#!/usr/bin/env node
// validate.js — regression validator
// Usage:
//   node scripts/validate.js
//   node scripts/validate.js --runs 5
//   node scripts/validate.js --cluster transform-user-data
//   node scripts/validate.js --update transform-user-data --reason "tax rate changed to 12%"
//   node scripts/validate.js --fail-fast

import { readFileSync, writeFileSync, readdirSync, appendFileSync, existsSync } from 'fs'
import { createHash } from 'crypto'
import { resolve, join, basename } from 'path'
import { pathToFileURL } from 'url'
import { fingerprint, fingerprintSequence, extractSchema } from './fingerprint.js'
import { createGhost, deepClone, normalizeHtml } from './ghost.js'

// ─── CLI args ─────────────────────────────────────────────────────────────────

function getArg(args, flag) {
  const i = args.indexOf(flag)
  return i !== -1 ? args[i + 1] ?? null : null
}

const args          = process.argv.slice(2)
const clusterFilter = getArg(args, '--cluster')
const failFast      = args.includes('--fail-fast')
const runs          = parseInt(getArg(args, '--runs') ?? '1')
const updateTarget  = getArg(args, '--update')
const updateReason  = getArg(args, '--reason')
const manifestPath  = getArg(args, '--manifest') ?? resolve(process.cwd(), 'regrets/manifest.json')
const regretDir     = resolve(process.cwd(), 'regrets')
const auditLog      = join(regretDir, 'audit.log')

// ─── Validate --update usage ──────────────────────────────────────────────────

if (updateTarget && !updateReason) {
  console.error(`❌ --update requires --reason`)
  console.error(`   Example: --update ${updateTarget} --reason "describe why behavior changed"`)
  process.exit(1)
}

if (updateReason && updateReason.split(' ').length < 4) {
  console.error(`❌ --reason is too vague: "${updateReason}"`)
  console.error(`   Be specific. e.g. "tax rate updated from 11% to 12% per new regulation"`)
  process.exit(1)
}

// ─── Parse a .regret file ─────────────────────────────────────────────────────

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
    else meta[key] = val
  }
  const lines = dataSection?.split('\n') ?? []
  const inputLine  = lines.find(l => l.startsWith('INPUT '))
  const outputLine = lines.find(l => l.startsWith('OUTPUT '))
  const hashLine   = lines.find(l => l.startsWith('HASH '))
  return {
    ...meta,
    input:      inputLine  ? JSON.parse(inputLine.replace(/^INPUT\s+/, ''))   : null,
    output:     outputLine ? JSON.parse(outputLine.replace(/^OUTPUT\s+/, '')) : null,
    goldenHash: hashLine   ? hashLine.replace(/^HASH\s+/, '').trim()          : null,
    raw:        content
  }
}

// Ghost proxy imported from ghost.js

function clone(v) { return deepClone(v) }

// ─── Load manifest ────────────────────────────────────────────────────────────

let manifest
try { manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) }
catch { console.error(`❌ Could not read manifest: ${manifestPath}`); process.exit(1) }

// ─── Find .regret files ───────────────────────────────────────────────────────

const filterId = clusterFilter ?? updateTarget ?? null
let regretFiles
try {
  regretFiles = readdirSync(regretDir)
    .filter(f => f.endsWith('.regret'))
    .filter(f => !filterId || f === `${filterId}.regret`)
} catch { console.error(`❌ regrets/ not found. Run capture.js first.`); process.exit(1) }

if (!regretFiles.length) {
  console.error(`❌ No .regret files found${filterId ? ` for "${filterId}"` : ''}.`)
  process.exit(1)
}

// ─── React cluster runner ─────────────────────────────────────────────────────

async function runReactCluster(clusterDef, regret) {
  const { entry, file, normalize: normRules = [], ignoreFields = [],
          stripAttrs = [], fingerprintMode: fpMode = 'value', valuePaths = [] } = clusterDef
  const mode = regret.fingerprintMode || fpMode || 'value'
  const paths = regret.valuePaths || valuePaths || []

  let React, renderToStaticMarkup
  try {
    React = (await import('react')).default
    renderToStaticMarkup = (await import('react-dom/server.js')).renderToStaticMarkup
  } catch {
    throw new Error('React not available. Install react and react-dom for React cluster validation.')
  }

  const absPath = resolve(process.cwd(), file)
  let moduleUrl
  try {
    const { readFileSync } = await import('fs')
    readFileSync(absPath)
    moduleUrl = pathToFileURL(absPath).href
  } catch {
    const jsPath = absPath.replace(/\.(tsx|jsx)$/, '.js')
    moduleUrl = pathToFileURL(jsPath).href
  }

  const mod = await import(moduleUrl)
  const Component = mod[entry] ?? mod.default?.[entry] ?? mod.default
  if (!Component) throw new Error(`Component "${entry}" not found in ${file}`)

  const hashes = []
  let lastOutput = null

  for (let i = 0; i < runs; i++) {
    const goldenInput = regret.input
    const element = React.createElement(Component, goldenInput)
    const rawHtml = renderToStaticMarkup(element)
    const html = normalizeHtml(rawHtml, stripAttrs)

    let fp
    if (mode === 'schema') {
      const schema = extractSchema(html)
      fp = fingerprint(goldenInput, schema, { normalize: normRules, ignoreFields })
    } else if (mode === 'mixed') {
      const schema = extractSchema(html)
      const selectedValues = {}
      for (const path of paths) {
        const key = path.replace(/^\$\./, '')
        const parts = key.split('.')
        let val = html
        for (const p of parts) { val = val?.[p] }
        if (val !== undefined) selectedValues[path] = val
      }
      const combined = { schema, values: selectedValues }
      fp = fingerprint(goldenInput, combined, { normalize: normRules, ignoreFields })
    } else {
      fp = fingerprint(goldenInput, html, { normalize: normRules, ignoreFields })
    }

    hashes.push(fp)
    lastOutput = html
  }

  return { hashes, lastOutput }
}

// ─── Run cluster N times ──────────────────────────────────────────────────────

async function runCluster(clusterDef, regret) {
  const { entry, file, normalize = [], ignoreFields = [], fingerprintLevel = 'entry',
          multiArgs = false, fingerprintMode = 'value', valuePaths = [], stack } = clusterDef

  // Skip stacks not handled by this validator
  if (stack === 'python') {
    console.log(`  ⏭️  ${clusterDef.id}: stack=python — use validate.py`)
    return { hashes: [regret.goldenHash], lastOutput: null, skipped: true }
  }
  if (stack === 'rust') {
    console.log(`  ⏭️  ${clusterDef.id}: stack=rust — use capture_rust.sh validate`)
    return { hashes: [regret.goldenHash], lastOutput: null, skipped: true }
  }

  // React stack: re-render component and compare
  if (stack === 'react') {
    return await runReactCluster(clusterDef, regret)
  }

  const mod = await import(pathToFileURL(resolve(process.cwd(), file)).href)
  const hashes = []
  let lastOutput = null

  // Determine which inputs to validate.
  // In drift mode: only validate the golden input across N runs.
  // Different inputs naturally produce different fingerprints — mixing them
  // in the same hashes array would trigger false positive drift detection.
  // In normal mode: validate golden input first, then all other inputs.
  const allInputs = clusterDef.inputs ?? [regret.input]
  const inputsToValidate = driftMode
    ? [regret.input]  // Drift mode: only golden input, repeated across runs
    : (() => {
        const result = [regret.input]  // Always validate golden first
        for (const inp of allInputs) {
          if (JSON.stringify(inp) !== JSON.stringify(regret.input)) {
            result.push(inp)
          }
        }
        return result
      })()

  for (let i = 0; i < runs; i++) {
    for (const currentInput of inputsToValidate) {
      const recorder = []
      const ghost    = createGhost(mod, regret.watches ?? clusterDef.watches, recorder)
      const entryFn  = ghost[entry] ?? mod[entry]
      if (typeof entryFn !== 'function') throw new Error(`Entry "${entry}" not found in ${file}`)
      // multiArgs: spread input as separate arguments
      const args_ = multiArgs && Array.isArray(currentInput) ? currentInput : [currentInput]
      const output   = await entryFn(...args_)
      lastOutput     = output
      const fpInput  = multiArgs && Array.isArray(currentInput) ? currentInput : currentInput

      // Determine fingerprint based on fingerprintMode (from .regret or manifest)
      const mode = regret.fingerprintMode || fingerprintMode || 'value'
      const paths = regret.valuePaths || valuePaths || []
      let fp
      if (mode === 'schema') {
        const schema = extractSchema(output)
        fp = fingerprint(fpInput, schema, { normalize, ignoreFields })
      } else if (mode === 'mixed') {
        const schema = extractSchema(output)
        const selectedValues = {}
        for (const path of paths) {
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
      hashes.push(fp)
    } // end for each input
  } // end for each run
  return { hashes, lastOutput }
}

// ─── Update a .regret ─────────────────────────────────────────────────────────

function updateRegret(regretPath, regret, newHash, liveOutput, reason) {
  const oldHash = regret.goldenHash
  const now = new Date().toISOString()
  // Sanitize reason: replace newlines to prevent audit.log corruption
  const safeReason = reason.replace(/[\r\n]+/g, ' ')
  const newContent = regret.raw
    .replace(/^fingerprint: .+$/m, `fingerprint: ${newHash}`)
    .replace(/^captured: .+$/m,    `captured: ${now}`)
    .replace(/^OUTPUT .+$/m,       `OUTPUT ${JSON.stringify(liveOutput)}`)
    .replace(/^HASH .+$/m,         `HASH   ${newHash}`)
  writeFileSync(regretPath, newContent, 'utf8')

  // ─── Hash chain ────────────────────────────────────────────────────────────
  let prevChain = '0000000'  // genesis
  if (existsSync(auditLog)) {
    const logContent = readFileSync(auditLog, 'utf8').trim()
    if (logContent) {
      const lines = logContent.split('\n')
      // Walk backwards to find the last chain hash
      for (let i = lines.length - 1; i >= 0; i--) {
        const m = lines[i].match(/^\s*chain:\s*(\S+)/)
        if (m) { prevChain = m[1]; break }
      }
    }
  }

  const clusterId = basename(regretPath, '.regret')
  const newEntryContent = `${now}  UPDATE  ${clusterId}\n  old: ${oldHash}\n  new: ${newHash}\n  reason: ${safeReason}\n  by: AI refactor session`
  const chainHash = createHash('sha256').update(prevChain + newEntryContent).digest('hex').slice(0, 7)

  const entry = `\n${newEntryContent}\n  chain: ${chainHash}`
  appendFileSync(auditLog, entry, 'utf8')
  return { oldHash, newHash }
}

// ─── Main ─────────────────────────────────────────────────────────────────────

const updateMode = !!updateTarget
const driftMode  = runs > 1 && !updateMode

if (updateMode)     console.log(`\n🔄 Update mode — cluster: ${updateTarget}\n   Reason: ${updateReason}\n`)
else if (driftMode) console.log(`\n🔍 Drift detection — ${runs} runs per cluster...\n`)
else                console.log(`\n🔍 Validating ${regretFiles.length} cluster(s)...\n`)

const results = []

for (const file of regretFiles) {
  const id         = basename(file, '.regret')
  const regretPath = join(regretDir, file)
  const regret     = parseRegret(readFileSync(regretPath, 'utf8'))
  const def        = manifest.clusters.find(c => c.id === id)
  if (!def) { console.warn(`  ⚠️  ${id}: not in manifest — skipping`); continue }

  try {
    const { hashes, lastOutput, skipped } = await runCluster(def, regret)
    if (skipped) { results.push({ id, pass: true, skipped: true }); continue }
    const liveHash = hashes[0]
    const isMatch  = liveHash === regret.goldenHash
    const isDrift  = driftMode && new Set(hashes).size > 1

    if (updateMode) {
      if (isMatch) {
        console.log(`  ℹ️  ${id.padEnd(35)} unchanged — no update needed`)
        results.push({ id, pass: true })
      } else {
        const { oldHash, newHash } = updateRegret(regretPath, regret, liveHash, lastOutput, updateReason)
        console.log(`  ✅ ${id.padEnd(35)} ${oldHash} → ${newHash}  UPDATED`)
        results.push({ id, pass: true, updated: true })
      }
    } else if (driftMode) {
      if (isDrift) {
        console.log(`  ❌ ${id.padEnd(35)} DRIFT  [${hashes.join(' / ')}]`)
        results.push({ id, pass: false, drift: true })
      } else {
        const icon = isMatch ? '✅' : '❌'
        console.log(`  ${icon} ${id.padEnd(35)} ${liveHash}  × ${runs}  ${isMatch ? 'PASS+STABLE' : 'FAIL'}`)
        results.push({ id, pass: isMatch })
      }
    } else {
      const icon = isMatch ? '✅' : '❌'
      const hstr = isMatch ? regret.goldenHash : `${regret.goldenHash} → ${liveHash}`
      console.log(`  ${icon} ${id.padEnd(35)} ${hstr.padEnd(22)} ${isMatch ? 'PASS' : 'FAIL'}`)
      results.push({ id, pass: isMatch, golden: regret.goldenHash, live: liveHash })
    }

  } catch (err) {
    console.log(`  ❌ ${id.padEnd(35)} ERROR: ${err.message}`)
    results.push({ id, pass: false, error: err.message })
  }

  if (!results.at(-1).pass && failFast) { console.log(`\n  --fail-fast: stopping.`); break }
}

// ─── Summary ──────────────────────────────────────────────────────────────────

const passed  = results.filter(r => r.pass).length
const failed  = results.filter(r => !r.pass).length
const drifted = results.filter(r => r.drift).length

console.log(`\n${'─'.repeat(60)}`)

if (updateMode) {
  console.log(`✅ Update complete. ${results.filter(r => r.updated).length} updated.\n   Audit: regrets/audit.log`)
  process.exit(0)
}
if (driftMode && drifted > 0) {
  console.log(`❌ Drift in ${drifted} cluster(s). Add normalize rules and re-capture.`)
  process.exit(1)
}
if (failed === 0) {
  console.log(`✅ All ${passed} tests passed${driftMode ? ` (${runs} runs — stable)` : ''}. Refactor is safe.\n`)
  process.exit(0)
}
console.log(`❌ ${failed}/${results.length} FAILED.\n`)
results.filter(r => !r.pass).forEach(r => {
  console.log(`  • ${r.id}`)
  if (r.error) console.log(`    ${r.error}`)
  else console.log(`    Expected: ${r.golden}  Got: ${r.live}`)
})
console.log(`\nFix the CODE — do not edit .regret files.\nRe-run: node scripts/validate.js`)
process.exit(1)

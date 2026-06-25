#!/usr/bin/env node
// diff.js — Compare live output against .regret golden output
// Shows exactly what changed when a cluster goes RED.
//
// Usage:
//   node scripts/diff.js                              Compare all clusters
//   node scripts/diff.js --cluster <id>               Compare specific cluster
//   node scripts/diff.js --manifest ./regrets/manifest.json

import { readFileSync } from 'fs'
import { resolve, join, dirname } from 'path'
import { fileURLToPath, pathToFileURL } from 'url'
import { fingerprint, fingerprintSequence, extractSchema } from './fingerprint.js'
import { createGhost, deepClone } from './ghost.js'
import { mergeCjsModule } from './cjs-merge.js'
import { deepDiff, formatDiffs, formatValue } from './diff-utils.js'

const __dirname = dirname(fileURLToPath(import.meta.url))

// ─── CLI args ─────────────────────────────────────────────────────────────────

function getArg(args, flag) {
  const i = args.indexOf(flag)
  return i !== -1 ? args[i + 1] ?? null : null
}

const args = process.argv.slice(2)
const clusterFilter = getArg(args, '--cluster')
const manifestPath = getArg(args, '--manifest') ?? resolve(process.cwd(), 'regrets/manifest.json')
const regretDir = resolve(process.cwd(), 'regrets')

// ─── Parse .regret file ──────────────────────────────────────────────────────

function parseRegret(content) {
  // CRLF -> LF guard, see validate.js's parseRegret() for the full
  // explanation (git core.autocrlf=true breaks this split otherwise).
  content = content.replaceAll('\r\n', '\n')
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
  return { ...meta, input: parsedInput, output: parsedOutput }
}

// ─── Main ─────────────────────────────────────────────────────────────────────

let manifest
try { manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) }
catch { console.error(`❌ Could not read manifest: ${manifestPath}`); process.exit(1) }

import { readdirSync } from 'fs'

let regretFiles
try {
  regretFiles = readdirSync(regretDir)
    .filter(f => f.endsWith('.regret'))
    .filter(f => {
      if (!clusterFilter) return true
      // Exact match: filterId === "main" → main.regret
      if (f === `${clusterFilter}.regret`) return true
      // When filterId is a parent cluster, also include its callee contracts
      // (main.calls.add.regret, main.calls.mul.regret, etc.) so that
      // `regret diff --cluster main` diffs callee regressions too.
      // Only apply when filterId itself is NOT a callee (.calls.).
      if (clusterFilter.includes('.calls.')) return false
      return f.startsWith(`${clusterFilter}.calls.`) && f.endsWith('.regret')
    })
} catch { console.error(`❌ regrets/ not found.`); process.exit(1) }

if (!regretFiles.length) {
  console.error(`❌ No .regret files found${clusterFilter ? ` for "${clusterFilter}"` : ''}.`)
  process.exit(1)
}

console.log(`\n🔍 Diffing ${regretFiles.length} cluster(s) against live output...\n`)

let anyDiff = false

for (const file of regretFiles) {
  const id = file.replace('.regret', '')
  const regretPath = join(regretDir, file)
  const regret = parseRegret(readFileSync(regretPath, 'utf8'))
  let def = manifest.clusters.find(c => c.id === id)

  // ── Callee contract handling ──────────────────────────────────────────────
  // Callee contracts (<parent>.calls.<callee>) are intentionally not declared
  // in the manifest — they are derived from their parent cluster by capture.js.
  // When we encounter a callee .regret file, look up the parent cluster's
  // definition to find the module file and stack info, then diff the callee
  // function directly.
  const isCallee = id.includes('.calls.')
  let calleeName = null
  let parentDef = null

  if (!def && isCallee) {
    const parentId = id.split('.calls.')[0]
    parentDef = manifest.clusters.find(c => c.id === parentId)
    calleeName = id.split('.calls.').slice(1).join('.calls.')

    if (!parentDef) {
      // Parent not in manifest either — this is truly orphaned
      console.warn(`  ⚠️  ${id}: parent "${parentId}" not in manifest — skipping`)
      continue
    }

    // Use parent's definition for module resolution and stack info
    def = parentDef
  } else if (!def) {
    // Not a callee and not in manifest — truly orphaned
    console.warn(`  ⚠️  ${id}: not in manifest — skipping`)
    continue
  }

  const { entry, file: moduleFile, normalize = [], ignoreFields = [],
          fingerprintLevel = 'entry', fingerprintMode = 'value', valuePaths = [],
          multiArgs = false, stack } = def

  // Skip non-JS/TS stacks (they need their own diff implementation)
  if (stack === 'python') {
    console.log(`  ⏭️  ${id}: stack=python — use python3 scripts/diff.py`)
    continue
  }
  if (stack === 'rust' || stack === 'go') {
    console.log(`  ⏭️  ${id}: stack=${stack} — not supported for diff`)
    continue
  }

  try {
    let mod = await import(pathToFileURL(resolve(process.cwd(), moduleFile)).href)
    // Handle CJS modules — merge default exports for consistent access
    mod = mergeCjsModule(mod)

    // For callee contracts, use the callee name as the entry point
    const effectiveEntry = isCallee ? (calleeName ?? regret.entry ?? entry) : entry

    const recorder = []
    const ghostModule = createGhost(mod, regret.watches ?? def.watches, recorder)
    const entryFn = ghostModule[effectiveEntry] ?? mod[effectiveEntry] ?? mod.default?.[effectiveEntry]
    if (typeof entryFn !== 'function') throw new Error(`Entry "${effectiveEntry}" not found`)

    const goldenInput = regret.input
    const inputForArgs = deepClone(goldenInput)
    // Callee contracts store inputs as arrays (the arguments list), so always
    // spread for callees. For parent clusters, respect the multiArgs flag.
    const args_ = isCallee
      ? (Array.isArray(inputForArgs) ? [...inputForArgs] : [inputForArgs])
      : (multiArgs && Array.isArray(inputForArgs) ? [...inputForArgs] : [inputForArgs])
    const rawOutput = await entryFn(...args_)
    const liveOutput = deepClone(rawOutput)

    const goldenOutput = regret.output
    const liveFp = fingerprint(goldenInput, liveOutput, { normalize, ignoreFields })
    const goldenFp = regret.fingerprint

    const isMatch = liveFp === goldenFp
    const icon = isMatch ? '✅' : '❌'
    const calleeTag = isCallee ? ' [callee]' : ''

    console.log(`${icon} ${id.padEnd(40)} ${goldenFp} → ${liveFp}${calleeTag}`)

    if (!isMatch) {
      anyDiff = true
      // Show diff between golden output and live output
      const diffs = deepDiff(goldenOutput, liveOutput)
      if (diffs.length === 0) {
        // Fingerprints differ but deep diff shows no difference
        // This can happen due to normalization or key ordering
        console.log(`  ⚠️  Fingerprint differs but deep diff shows no structural difference.`)
        console.log(`      This may be caused by normalization rules or key ordering.`)
        console.log(`      Golden output: ${formatValue(goldenOutput, 200)}`)
        console.log(`      Live output:   ${formatValue(liveOutput, 200)}`)
      } else {
        console.log(formatDiffs(diffs))
      }
      console.log()
    }

  } catch (err) {
    console.log(`  ❌ ${id.padEnd(40)} ERROR: ${err.message}`)
    anyDiff = true
  }
}

if (anyDiff) {
  console.log(`\n⚠️  Differences found. Fix the CODE — do not edit .regret files.`)
  process.exit(1)
} else {
  console.log(`\n✅ All clusters match — no differences found.`)
  process.exit(0)
}

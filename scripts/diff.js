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

// ─── Deep diff ────────────────────────────────────────────────────────────────

function deepDiff(expected, actual, path = '') {
  const diffs = []

  if (expected === actual) return diffs

  // Type mismatch
  if (typeof expected !== typeof actual || expected === null || actual === null) {
    if (expected !== actual) {
      diffs.push({ path: path || '(root)', expected, actual, type: 'value_mismatch' })
    }
    return diffs
  }

  // Array comparison
  if (Array.isArray(expected) && Array.isArray(actual)) {
    if (expected.length !== actual.length) {
      diffs.push({ path: path || '(root)', expected: `array[${expected.length}]`, actual: `array[${actual.length}]`, type: 'length_mismatch' })
    }
    const maxLen = Math.max(expected.length, actual.length)
    for (let i = 0; i < maxLen; i++) {
      const eVal = i < expected.length ? expected[i] : undefined
      const aVal = i < actual.length ? actual[i] : undefined
      const subPath = `${path}[${i}]`
      diffs.push(...deepDiff(eVal, aVal, subPath))
    }
    return diffs
  }

  // Object comparison
  if (typeof expected === 'object' && typeof actual === 'object') {
    if (Array.isArray(expected) !== Array.isArray(actual)) {
      diffs.push({ path: path || '(root)', expected, actual, type: 'type_mismatch' })
      return diffs
    }
    const allKeys = new Set([...Object.keys(expected), ...Object.keys(actual)])
    for (const key of allKeys) {
      const subPath = path ? `${path}.${key}` : key
      if (!(key in expected)) {
        diffs.push({ path: subPath, expected: undefined, actual: actual[key], type: 'added_key' })
      } else if (!(key in actual)) {
        diffs.push({ path: subPath, expected: expected[key], actual: undefined, type: 'removed_key' })
      } else {
        diffs.push(...deepDiff(expected[key], actual[key], subPath))
      }
    }
    return diffs
  }

  // Primitive comparison
  if (expected !== actual) {
    // Check if it's a float tolerance issue
    if (typeof expected === 'number' && typeof actual === 'number') {
      const diff = Math.abs(expected - actual)
      const relDiff = expected !== 0 ? diff / Math.abs(expected) : diff
      if (diff < 0.01 || relDiff < 1e-10) {
        diffs.push({ path: path || '(root)', expected, actual, type: 'float_tolerance', diff })
        return diffs
      }
    }
    diffs.push({ path: path || '(root)', expected, actual, type: 'value_mismatch' })
  }

  return diffs
}

// ─── Format diff output ──────────────────────────────────────────────────────

function formatValue(val, maxLen = 80) {
  if (val === undefined) return 'undefined'
  if (val === null) return 'null'
  const str = typeof val === 'object' ? JSON.stringify(val) : String(val)
  return str.length > maxLen ? str.slice(0, maxLen) + '...' : str
}

function formatDiffs(diffs) {
  if (!diffs.length) return '  (no differences)'

  const lines = []
  for (const d of diffs) {
    const icon = d.type === 'float_tolerance' ? '≈' : d.type === 'added_key' ? '+' : d.type === 'removed_key' ? '-' : '≠'
    lines.push(`  ${icon} ${d.path}`)
    lines.push(`      golden:  ${formatValue(d.expected)}`)
    lines.push(`      live:    ${formatValue(d.actual)}`)
    if (d.type === 'float_tolerance') {
      lines.push(`      diff:    ${d.diff} (within float tolerance)`)
    }
    if (d.type === 'length_mismatch') {
      lines.push(`      ⚠️  Array length changed — this likely means added/removed items`)
    }
  }
  return lines.join('\n')
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
    .filter(f => !clusterFilter || f === `${clusterFilter}.regret`)
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
  const def = manifest.clusters.find(c => c.id === id)
  if (!def) { console.warn(`  ⚠️  ${id}: not in manifest — skipping`); continue }

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

    const recorder = []
    const ghostModule = createGhost(mod, regret.watches ?? def.watches, recorder)
    const entryFn = ghostModule[entry] ?? mod[entry] ?? mod.default?.[entry]
    if (typeof entryFn !== 'function') throw new Error(`Entry "${entry}" not found`)

    const goldenInput = regret.input
    const inputForArgs = deepClone(goldenInput)
    const args_ = multiArgs && Array.isArray(inputForArgs) ? [...inputForArgs] : [inputForArgs]
    const rawOutput = await entryFn(...args_)
    const liveOutput = deepClone(rawOutput)

    const goldenOutput = regret.output
    const liveFp = fingerprint(goldenInput, liveOutput, { normalize, ignoreFields })
    const goldenFp = regret.fingerprint

    const isMatch = liveFp === goldenFp
    const icon = isMatch ? '✅' : '❌'

    console.log(`${icon} ${id.padEnd(40)} ${goldenFp} → ${liveFp}`)

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

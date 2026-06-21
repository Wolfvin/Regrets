#!/usr/bin/env node
// check.js — Pre-flight manifest validation
// Verifies manifest structure AND that all entry functions exist
// in the compiled output before running capture, preventing confusing errors.
//
// Validation phases:
//   Phase 1 — Manifest structure validation (schema-level checks)
//   Phase 2 — Export existence validation (import & verify)
//
// Usage:
//   node scripts/check.js
//   node scripts/check.js --cluster my-cluster

import { readFileSync } from 'fs'
import { resolve } from 'path'
import { pathToFileURL } from 'url'
import { mergeCjsModule } from './cjs-merge.js'

const args = process.argv.slice(2)
const clusterFilter = args.includes('--cluster') ? args[args.indexOf('--cluster') + 1] : null
const manifestPath = args.includes('--manifest')
  ? args[args.indexOf('--manifest') + 1]
  : resolve(process.cwd(), 'regrets/manifest.json')

let manifest
try {
  manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
} catch {
  console.error(`❌ Could not read manifest: ${manifestPath}`)
  process.exit(1)
}

const clusters = clusterFilter
  ? manifest.clusters.filter(c => c.id === clusterFilter)
  : manifest.clusters

if (!clusters.length) {
  console.error(`❌ No clusters found${clusterFilter ? ` matching "${clusterFilter}"` : ''}`)
  process.exit(1)
}

console.log(`\n🔍 Pre-flight Check — ${clusters.length} cluster(s)\n`)

// ─── Phase 1: Manifest structure validation ──────────────────────────────────
// Collect ALL errors and warnings first, then print them at once.

const VALID_STACKS = ['js', 'ts', 'python', 'react', 'vue', 'go', 'php', 'rust', 'css']
const VALID_FINGERPRINT_LEVELS = ['entry', 'full', 'watched']

const structErrors = []   // { clusterId, message }
const structWarnings = [] // { clusterId, message }

// 1. Duplicate cluster IDs
const idCounts = new Map()
for (const cluster of clusters) {
  const id = cluster.id
  if (!id) continue
  idCounts.set(id, (idCounts.get(id) || 0) + 1)
}
for (const [id, count] of idCounts) {
  if (count > 1) {
    structErrors.push({ clusterId: id, message: `Duplicate cluster id: '${id}'. IDs must be unique.` })
  }
}

// Per-cluster validations
for (let i = 0; i < clusters.length; i++) {
  const cluster = clusters[i]
  const cid = cluster.id || `index-${i}`

  // 5. Missing required fields: id, entry, stack
  for (const field of ['id', 'entry', 'stack']) {
    if (!cluster[field]) {
      structErrors.push({ clusterId: cid, message: `cluster at index ${i} missing required field: ${field}` })
    }
  }

  // 4. Invalid stack value
  if (cluster.stack && !VALID_STACKS.includes(cluster.stack)) {
    structErrors.push({ clusterId: cid, message: `Unknown stack '${cluster.stack}'. Valid: ${VALID_STACKS.join('|')}` })
  }

  // 6. Invalid fingerprintLevel
  if (cluster.fingerprintLevel && !VALID_FINGERPRINT_LEVELS.includes(cluster.fingerprintLevel)) {
    structErrors.push({ clusterId: cid, message: `invalid fingerprintLevel '${cluster.fingerprintLevel}'` })
  }

  // 2. Empty inputs array
  if (cluster.inputs && Array.isArray(cluster.inputs) && cluster.inputs.length === 0) {
    structWarnings.push({ clusterId: cid, message: `cluster '${cid}' has no inputs — fingerprint will be empty` })
  }
  if (!cluster.inputs && !cluster.multiArgs) {
    // No inputs field at all — also warn
    structWarnings.push({ clusterId: cid, message: `cluster '${cid}' has no inputs — fingerprint will be empty` })
  }

  // 3. Empty watches array with fingerprintLevel:'full'
  if (cluster.fingerprintLevel === 'full') {
    const watches = cluster.watches
    if (!watches || !Array.isArray(watches) || watches.length === 0) {
      structErrors.push({ clusterId: cid, message: `watches required for fingerprintLevel:'full'` })
    }
  }

  // 7. multiArgs:true but inputs not array of arrays
  if (cluster.multiArgs) {
    const inputs = cluster.inputs
    if (!Array.isArray(inputs) || inputs.length === 0 || !inputs.every(item => Array.isArray(item))) {
      structWarnings.push({ clusterId: cid, message: `multiArgs requires inputs to be array of arrays` })
    }
  }
}

// Print Phase 1 results
if (structErrors.length > 0 || structWarnings.length > 0) {
  console.log('📋 Phase 1 — Manifest structure validation:\n')
  for (const err of structErrors) {
    console.error(`  Error: [${err.clusterId}] ${err.message}`)
  }
  for (const warn of structWarnings) {
    console.warn(`  Warning: [${warn.clusterId}] ${warn.message}`)
  }
  console.log()
}

// If structural errors exist, stop here (exit 1)
if (structErrors.length > 0) {
  console.log(`${'─'.repeat(50)}`)
  console.log(`Manifest structure: ${structErrors.length} error(s), ${structWarnings.length} warning(s)`)
  console.log(`\n❌ Fix manifest errors before running capture.`)
  process.exit(1)
}

// If only warnings, note them but continue
if (structWarnings.length > 0) {
  console.log(`  (${structWarnings.length} warning(s) — non-blocking)\n`)
}

// If no errors and no warnings, print success for phase 1
if (structErrors.length === 0 && structWarnings.length === 0) {
  console.log(`📋 Phase 1 — Manifest structure: ✅ ${clusters.length} cluster(s), all fields OK\n`)
}

// ─── Phase 2: Export existence validation ────────────────────────────────────

// Run preBuild if specified
if (manifest.preBuild) {
  console.log(`🔧 Running preBuild: ${manifest.preBuild}`)
  const { execSync } = await import('child_process')
  try {
    execSync(manifest.preBuild, { stdio: 'inherit', cwd: process.cwd() })
  } catch {
    console.error(`❌ preBuild failed`)
    process.exit(1)
  }
}

let passed = 0
let warnings = structWarnings.length
let failed = 0

// Group by file to avoid redundant imports
const fileMap = new Map()
for (const cluster of clusters) {
  const { file, stack } = cluster
  if (stack && stack !== 'js' && stack !== 'ts') {
    console.log(`  ⏭️  ${cluster.id}: stack="${stack}" — skip (use native validator)`)
    continue
  }
  if (!fileMap.has(file)) fileMap.set(file, [])
  fileMap.get(file).push(cluster)
}

for (const [file, fileClusters] of fileMap) {
  console.log(`\n📂 ${file}`)

  let mod
  try {
    const absPath = resolve(process.cwd(), file)
    const moduleUrl = pathToFileURL(absPath).href
    let rawModule = await import(moduleUrl)
    mod = mergeCjsModule(rawModule)
  } catch (e) {
    console.error(`  ❌ Cannot import module: ${e.message}`)
    for (const c of fileClusters) {
      console.error(`     ${c.id}: FAIL (module import failed)`)
      failed++
    }
    continue
  }

  const availableExports = Object.keys(mod).filter(k => typeof mod[k] === 'function')
  console.log(`   Available functions: ${availableExports.length}`)

  for (const cluster of fileClusters) {
    const { id, entry, watches = [], classMethod, constructor: constructorName, storeDispatch } = cluster

    // Check storeDispatch mode
    if (storeDispatch) {
      const storeExport = mod[storeDispatch.store] ?? mod.default?.[storeDispatch.store]
      if (!storeExport) {
        console.error(`  ❌ ${id}: Store "${storeDispatch.store}" not found`)
        failed++
        continue
      }
      if (typeof storeExport.dispatch !== 'function') {
        console.error(`  ❌ ${id}: "${storeDispatch.store}" has no dispatch method`)
        failed++
        continue
      }
      console.log(`  ✅ ${id}: store "${storeDispatch.store}" found with dispatch`)
      passed++
      continue
    }

    // Check classMethod mode
    if (classMethod) {
      const Cls = mod[constructorName ?? entry] ?? mod.default?.[constructorName ?? entry]
      if (typeof Cls !== 'function') {
        console.error(`  ❌ ${id}: Constructor "${constructorName ?? entry}" not found or not a class`)
        failed++
        continue
      }
      console.log(`  ✅ ${id}: class "${constructorName ?? entry}" found`)
      passed++
      continue
    }

    // Check function-based entry
    const entryFn = mod[entry]
      ?? mod.default?.[entry]
      ?? ((entry === 'default' || entry === 'module.exports') && typeof mod.default === 'function' ? mod.default : null)

    if (typeof entryFn !== 'function') {
      // Suggest similar names
      const suggestions = availableExports.filter(k =>
        k.toLowerCase().includes(entry.toLowerCase().slice(0, 5)) ||
        entry.toLowerCase().includes(k.toLowerCase().slice(0, 5))
      )
      const suggestStr = suggestions.length
        ? ` (did you mean: ${suggestions.join(', ')}?)`
        : ''
      console.error(`  ❌ ${id}: Entry "${entry}" not found${suggestStr}`)
      failed++
      continue
    }

    // Check watches
    const missingWatches = watches.filter(w => typeof mod[w] !== 'function')
    if (missingWatches.length > 0) {
      console.warn(`  ⚠️  ${id}: Watch target(s) not found as functions: ${missingWatches.join(', ')}`)
      warnings++
    }

    console.log(`  ✅ ${id}: entry "${entry}" found, ${watches.length} watch(es) checked`)
    passed++
  }
}

console.log(`\n${'─'.repeat(50)}`)
console.log(`Pre-flight: ${passed} passed, ${warnings} warnings, ${failed} failed`)

if (failed > 0) {
  console.log(`\n❌ Fix failed checks before running capture.`)
  process.exit(1)
}

console.log(`\n✅ Manifest valid: ${clusters.length} clusters, all fields OK`)

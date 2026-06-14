#!/usr/bin/env node
// check.js — Pre-flight manifest validation
// Verifies that all entry functions exist in the compiled output
// before running capture, preventing confusing errors.
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
let warnings = 0
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

console.log(`\n✅ All checks passed. Safe to run capture.`)

#!/usr/bin/env node
// uninstall.js — Remove regrets/ directory (or selected files) with confirmation
//
// Usage:
//   node scripts/uninstall.js
//   node scripts/uninstall.js --keep-manifest
//   node scripts/uninstall.js --force
//   node scripts/uninstall.js --keep-manifest --force
//
// Behavior:
//   Without flags:  remove entire regrets/ directory (manifest + .regret files + audit.log)
//   --keep-manifest: remove only .regret files + audit.log, preserve manifest.json
//   --force:        skip confirmation prompt
//   Without --force: show confirmation before deleting

import { readFileSync, readdirSync, existsSync, rmSync, unlinkSync } from 'fs'
import { resolve, join } from 'path'
import { createInterface } from 'readline'

const args = process.argv.slice(2)
const keepManifest = args.includes('--keep-manifest')
const force = args.includes('--force')
const regretDir = resolve(process.cwd(), 'regrets')

// ─── Check if regrets/ exists ──────────────────────────────────────────────────

if (!existsSync(regretDir)) {
  console.log(`\n⏭️  No regrets/ directory found. Already clean.`)
  process.exit(0)
}

// ─── Scan regrets/ directory ───────────────────────────────────────────────────

const allFiles = readdirSync(regretDir)
const regretFiles = allFiles.filter(f => f.endsWith('.regret'))
const hasManifest = allFiles.includes('manifest.json')
const hasAuditLog = allFiles.includes('audit.log')
const manifestPath = join(regretDir, 'manifest.json')

// Count clusters from manifest (if available)
let clusterCount = regretFiles.length
let failCount = 0
if (hasManifest) {
  try {
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
    clusterCount = (manifest.clusters || []).length

    // Check for FAIL status in audit.log
    if (hasAuditLog) {
      const auditContent = readFileSync(join(regretDir, 'audit.log'), 'utf8').trim()
      const blocks = auditContent.split('\n\n').filter(Boolean)
      const failClusters = new Set()
      for (const block of blocks) {
        const lines = block.trim().split('\n')
        const header = lines[0]
        const parts = header.trim().split(/\s+/)
        if (parts.length >= 3 && parts[1] === 'FAIL') {
          failClusters.add(parts[2])
        }
      }
      failCount = failClusters.size
    }
  } catch { /* use regretFiles.length as fallback */ }
}

// ─── Display summary ───────────────────────────────────────────────────────────

console.log(`\n🧹 Uninstalling Regrets...\n`)
console.log(`Found: ${clusterCount} cluster${clusterCount !== 1 ? 's' : ''}, ${regretFiles.length} .regret file${regretFiles.length !== 1 ? 's' : ''}${hasAuditLog ? ', 1 audit.log' : ''}`)

if (failCount > 0) {
  console.log(`Warning: ${failCount} cluster${failCount !== 1 ? 's have' : ' has'} FAIL status — unresolved regressions will be lost.`)
}

// ─── Confirmation ───────────────────────────────────────────────────────────────

const action = keepManifest ? 'Remove .regret files and audit.log' : 'Remove regrets/ directory'

if (!force) {
  const confirmed = await askConfirmation(`${action}? (y/N): `)
  if (!confirmed) {
    console.log(`\n🛑 Uninstall cancelled.`)
    process.exit(0)
  }
}

// ─── Perform deletion ───────────────────────────────────────────────────────────

const removedItems = []

if (keepManifest) {
  // Remove only .regret files + audit.log, keep manifest.json
  for (const f of regretFiles) {
    const filePath = join(regretDir, f)
    unlinkSync(filePath)
    removedItems.push(f)
  }

  if (hasAuditLog) {
    unlinkSync(join(regretDir, 'audit.log'))
    removedItems.push('audit.log')
  }

  // Also remove chains/ subdirectory if present
  const chainsDir = join(regretDir, 'chains')
  if (existsSync(chainsDir)) {
    rmSync(chainsDir, { recursive: true, force: true })
    removedItems.push('chains/')
  }

  // Remove chains.json if present
  const chainsJson = join(regretDir, 'chains.json')
  if (existsSync(chainsJson)) {
    unlinkSync(chainsJson)
    removedItems.push('chains.json')
  }
} else {
  // Remove entire regrets/ directory
  rmSync(regretDir, { recursive: true, force: true })
  removedItems.push('entire regrets/ directory')
}

// ─── Print result ──────────────────────────────────────────────────────────────

console.log(`\n✅ Regrets uninstalled.`)

if (keepManifest) {
  const regretCount = regretFiles.length
  const parts = []
  if (regretCount > 0) parts.push(`${regretCount} .regret file${regretCount !== 1 ? 's' : ''}`)
  if (hasAuditLog) parts.push('audit.log')
  if (removedItems.includes('chains/')) parts.push('chains/')
  if (removedItems.includes('chains.json')) parts.push('chains.json')
  parts.push('manifest.json preserved')
  console.log(`Removed: ${parts.join(', ')}`)
} else {
  const parts = []
  if (regretFiles.length > 0) parts.push(`${regretFiles.length} .regret files`)
  if (hasManifest) parts.push('manifest.json')
  if (hasAuditLog) parts.push('audit.log')
  console.log(`Removed: ${parts.join(', ')}`)
}

console.log(`To reinstall: regret install`)

// ─── Helper: ask confirmation ──────────────────────────────────────────────────

function askConfirmation(prompt) {
  return new Promise((resolve) => {
    const rl = createInterface({
      input: process.stdin,
      output: process.stdout
    })
    rl.question(prompt, (answer) => {
      rl.close()
      resolve(answer.toLowerCase() === 'y' || answer.toLowerCase() === 'yes')
    })
  })
}

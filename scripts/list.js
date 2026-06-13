#!/usr/bin/env node
// list.js — List all clusters with their status, stack, and entry points
// Quick overview of what's being regression-tested.
//
// Usage:
//   node scripts/list.js
//   node scripts/list.js --manifest ./regrets/manifest.json

import { readFileSync, readdirSync, existsSync } from 'fs'
import { resolve, join } from 'path'

const args = process.argv.slice(2)
const manifestPath = args.includes('--manifest')
  ? args[args.indexOf('--manifest') + 1]
  : resolve(process.cwd(), 'regrets/manifest.json')
const regretDir = resolve(process.cwd(), 'regrets')

// ─── Load manifest ────────────────────────────────────────────────────────────

let manifest
try { manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) }
catch { console.error(`❌ Could not read manifest: ${manifestPath}`); process.exit(1) }

// ─── Load .regret files for fingerprint info ──────────────────────────────────

function parseRegretMeta(content) {
  const meta = {}
  const metaSection = content.split('\n---\n')[0]
  for (const line of metaSection.split('\n')) {
    const colonIdx = line.indexOf(': ')
    if (colonIdx === -1) continue
    const key = line.slice(0, colonIdx)
    const val = line.slice(colonIdx + 2).trim()
    meta[key] = val
  }
  return meta
}

const regretMetas = {}
try {
  const files = readdirSync(regretDir).filter(f => f.endsWith('.regret'))
  for (const f of files) {
    const content = readFileSync(join(regretDir, f), 'utf8')
    regretMetas[f.replace('.regret', '')] = parseRegretMeta(content)
  }
} catch { /* no regrets/ dir yet */ }

// ─── Load chains ──────────────────────────────────────────────────────────────

const chainsDir = join(regretDir, 'chains')
const chainFile = join(regretDir, 'chains.json')
let chainCount = 0
let chainIds = []
try {
  if (existsSync(chainFile)) {
    const chains = JSON.parse(readFileSync(chainFile, 'utf8'))
    chainCount = chains.chains?.length || 0
    chainIds = chains.chains?.map(c => c.id) || []
  }
} catch { /* no chains */ }

// ─── Render ────────────────────────────────────────────────────────────────────

console.log('\n📋 REGRET CLUSTER REGISTRY')
console.log('─'.repeat(80))

const col = { id: 30, stack: 8, entry: 25, file: 30, fp: 10, status: 10 }

// Header
console.log(
  'cluster'.padEnd(col.id) +
  'stack'.padEnd(col.stack) +
  'entry'.padEnd(col.entry) +
  'fingerprint'.padEnd(col.fp) +
  'status'
)
console.log('─'.repeat(80))

for (const cluster of manifest.clusters) {
  const meta = regretMetas[cluster.id] || {}
  const hasRegret = !!meta.fingerprint
  const fp = meta.fingerprint || '(not captured)'
  const status = hasRegret ? '✅ GREEN' : '⏳ PENDING'

  const file = cluster.file || cluster.module || ''
  const displayFile = file.length > col.file - 2 ? '...' + file.slice(-(col.file - 5)) : file

  console.log(
    cluster.id.padEnd(col.id) +
    (cluster.stack || 'js').padEnd(col.stack) +
    cluster.entry.padEnd(col.entry) +
    fp.padEnd(col.fp) +
    status
  )
}

console.log('─'.repeat(80))
console.log(`Total clusters: ${manifest.clusters.length} | Captured: ${Object.keys(regretMetas).length} | Chains: ${chainCount}`)

if (chainIds.length > 0) {
  console.log(`\n⛓  Chains: ${chainIds.join(', ')}`)
}

// Show uncaptured clusters
const uncaptured = manifest.clusters.filter(c => !regretMetas[c.id])
if (uncaptured.length > 0) {
  console.log(`\n⏳ Uncaptured clusters (run 'regret capture' first):`)
  for (const c of uncaptured) {
    console.log(`  • ${c.id} (${c.stack || 'js'} → ${c.entry})`)
  }
}

// Show orphaned .regret files (not in manifest)
const manifestIds = new Set(manifest.clusters.map(c => c.id))
const orphaned = Object.keys(regretMetas).filter(id => !manifestIds.has(id))
if (orphaned.length > 0) {
  console.log(`\n⚠️  Orphaned .regret files (not in manifest):`)
  for (const id of orphaned) {
    console.log(`  • ${id}.regret`)
  }
}

console.log()

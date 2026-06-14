#!/usr/bin/env node
// status.js — Quick snapshot of Regrets state for "is it safe to refactor?"
//
// Usage:
//   node scripts/status.js
//   node scripts/status.js --json
//
// Reads manifest + .regret files + audit.log to compute coverage, health,
// confidence, and safeToRefactor — without running any captures/validates.
//
// safeToRefactor logic:
//   YES:    all clusters SOLID + HIGH confidence
//   PARTIAL: has GOOD/MEDIUM clusters (or NEW)
//   NO:     has FRAGILE/UNSTABLE or LOW confidence clusters

import { readFileSync, readdirSync, existsSync, statSync } from 'fs'
import { resolve, join, basename } from 'path'
import { computeConfidence, parseAuditForDrift } from './confidence.js'

const args = process.argv.slice(2)
const jsonOutput = args.includes('--json')
const regretDir = resolve(process.cwd(), 'regrets')
const manifestPath = resolve(process.cwd(), 'regrets/manifest.json')
const auditLogPath = join(regretDir, 'audit.log')

// ─── Check if installed ─────────────────────────────────────────────────────────

const isInstalled = existsSync(manifestPath)

if (!isInstalled) {
  if (jsonOutput) {
    console.log(JSON.stringify({ installed: false, clusters: 0, captured: 0, lastCapture: null, health: {}, confidence: {}, safeToRefactor: 'NO' }))
  } else {
    console.log(`\n📊 Regrets Status\n\nInstalled: NO\n\nRun 'regret install' to get started.`)
  }
  process.exit(0)
}

// ─── Load manifest ──────────────────────────────────────────────────────────────

let manifest
try {
  manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
} catch {
  if (jsonOutput) {
    console.log(JSON.stringify({ installed: false, clusters: 0, captured: 0, lastCapture: null, health: {}, confidence: {}, safeToRefactor: 'NO' }))
  } else {
    console.log(`\n📊 Regrets Status\n\nInstalled: NO (manifest corrupt)\n`)
  }
  process.exit(1)
}

const clusters = manifest.clusters || []
const clusterCount = clusters.length

// ─── Parse .regret files ──────────────────────────────────────────────────────

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
let regretFiles = []
try {
  regretFiles = readdirSync(regretDir).filter(f => f.endsWith('.regret'))
  for (const f of regretFiles) {
    const content = readFileSync(join(regretDir, f), 'utf8')
    regretMetas[f.replace('.regret', '')] = parseRegretMeta(content)
  }
} catch { /* no regrets/ dir or no .regret files */ }

// ─── Compute metrics ───────────────────────────────────────────────────────────

const driftMap = parseAuditForDrift(auditLogPath)
const now = Date.now()

// Parse audit.log for updates/drifts per cluster
const auditData = {}
if (existsSync(auditLogPath)) {
  try {
    const content = readFileSync(auditLogPath, 'utf8').trim()
    const blocks = content.split('\n\n').filter(Boolean)
    for (const block of blocks) {
      const lines = block.trim().split('\n')
      const header = lines[0]
      const parts = header.trim().split(/\s+/)
      if (parts.length < 3) continue
      const type = parts[1]
      const id = parts[2]
      if (!id) continue
      if (!auditData[id]) auditData[id] = { updates: 0, drifts: 0 }
      if (type === 'UPDATE') auditData[id].updates++
      if (type === 'DRIFT') auditData[id].drifts++
    }
  } catch { /* audit.log not readable */ }
}

// Health scoring (same logic as health.js)
function scoreCluster({ updates, drifts, ageDays }) {
  let score = 100
  score -= updates * 15
  score -= drifts * 25
  if (ageDays < 3) score -= 10
  if (ageDays > 30) score += 5
  return Math.max(0, Math.min(100, score))
}

function healthLabel(score, isNew) {
  if (isNew) return 'NEW'
  if (score >= 90) return 'SOLID'
  if (score >= 70) return 'GOOD'
  if (score >= 50) return 'UNSTABLE'
  return 'FRAGILE'
}

// Compute per-cluster health + confidence
let latestCaptureTime = 0
const healthCounts = { SOLID: 0, GOOD: 0, UNSTABLE: 0, FRAGILE: 0, NEW: 0 }
const confidenceCounts = { HIGH: 0, MEDIUM: 0, LOW: 0 }
const skippedClusters = []
const fragileList = []
const lowConfList = []

for (const cluster of clusters) {
  const meta = regretMetas[cluster.id]
  const hasRegret = !!meta?.fingerprint

  if (!hasRegret) {
    skippedClusters.push(cluster.id)
    // Skipped clusters get FRAGILE + LOW
    healthCounts.FRAGILE++
    confidenceCounts.LOW++
    lowConfList.push({ id: cluster.id, reason: 'not captured' })
    fragileList.push({ id: cluster.id, reason: 'not captured' })
    continue
  }

  // Parse capture time
  const captured = meta.captured ? new Date(meta.captured).getTime() : now
  if (captured > latestCaptureTime) latestCaptureTime = captured

  const ageHours = (now - captured) / (1000 * 60 * 60)
  const ageDays = Math.floor(ageHours / 24)
  const audit = auditData[cluster.id] || { updates: 0, drifts: 0 }
  const isNew = ageHours < 72 && audit.updates === 0 && audit.drifts === 0

  // Health
  const score = scoreCluster({ updates: audit.updates, drifts: audit.drifts, ageDays })
  const health = healthLabel(score, isNew)
  healthCounts[health] = (healthCounts[health] || 0) + 1

  if (health === 'FRAGILE' || health === 'UNSTABLE') {
    fragileList.push({ id: cluster.id, reason: `${health} (score: ${score})` })
  }

  // Confidence
  const inputCount = (cluster.inputs || []).length
  const hasDriftOrUpdate = !!driftMap[cluster.id]
  const confidence = computeConfidence({ inputCount, ageDays, hasDriftOrUpdate })
  confidenceCounts[confidence.label] = (confidenceCounts[confidence.label] || 0) + 1

  if (confidence.label === 'LOW') {
    lowConfList.push({ id: cluster.id, reason: `${inputCount} input${inputCount !== 1 ? 's' : ''}, ${ageDays}d old` })
  }
}

// Coverage
const capturedCount = clusterCount - skippedClusters.length
const coveragePct = clusterCount > 0 ? Math.round((capturedCount / clusterCount) * 100) : 0

// Last capture time
const lastCaptureISO = latestCaptureTime > 0 ? new Date(latestCaptureTime).toISOString() : null
const lastCaptureAgo = latestCaptureTime > 0 ? formatTimeAgo(now - latestCaptureTime) : 'never'

// safeToRefactor
const hasFragile = healthCounts.FRAGILE > 0 || healthCounts.UNSTABLE > 0
const hasLow = confidenceCounts.LOW > 0
const hasGood = healthCounts.GOOD > 0 || healthCounts.NEW > 0
const hasMedium = confidenceCounts.MEDIUM > 0

let safeToRefactor
if (hasFragile || hasLow) {
  safeToRefactor = 'NO'
} else if (hasGood || hasMedium) {
  safeToRefactor = 'PARTIAL'
} else if (clusterCount > 0 && capturedCount === clusterCount) {
  safeToRefactor = 'YES'
} else {
  safeToRefactor = 'NO'
}

// ─── Output ─────────────────────────────────────────────────────────────────────

if (jsonOutput) {
  const jsonResult = {
    installed: true,
    clusters: clusterCount,
    captured: capturedCount,
    skipped: skippedClusters.length,
    lastCapture: lastCaptureISO,
    coverage: coveragePct,
    health: healthCounts,
    confidence: confidenceCounts,
    safeToRefactor,
  }
  console.log(JSON.stringify(jsonResult, null, 0))
} else {
  console.log(`\n📊 Regrets Status\n`)
  console.log(`Installed: YES (${clusterCount} cluster${clusterCount !== 1 ? 's' : ''})`)
  console.log(`Last capture: ${lastCaptureAgo}`)
  console.log(`Coverage: ${coveragePct}% (${capturedCount}/${clusterCount} captured${skippedClusters.length > 0 ? `, ${skippedClusters.length} skipped` : ''})`)

  // Health summary
  const healthParts = []
  if (healthCounts.SOLID) healthParts.push(`${healthCounts.SOLID} SOLID`)
  if (healthCounts.GOOD) healthParts.push(`${healthCounts.GOOD} GOOD`)
  if (healthCounts.UNSTABLE) healthParts.push(`${healthCounts.UNSTABLE} UNSTABLE`)
  if (healthCounts.FRAGILE) healthParts.push(`${healthCounts.FRAGILE} FRAGILE`)
  if (healthCounts.NEW) healthParts.push(`${healthCounts.NEW} NEW`)
  console.log(`Health: ${healthParts.join(', ')}`)

  // Confidence summary
  const confParts = []
  if (confidenceCounts.HIGH) confParts.push(`${confidenceCounts.HIGH} HIGH`)
  if (confidenceCounts.MEDIUM) confParts.push(`${confidenceCounts.MEDIUM} MEDIUM`)
  if (confidenceCounts.LOW) confParts.push(`${confidenceCounts.LOW} LOW`)
  console.log(`Confidence: ${confParts.join(', ')}`)

  // Action needed
  const actions = []
  if (fragileList.length > 0) {
    actions.push(`${fragileList.length} cluster${fragileList.length !== 1 ? 's' : ''} FRAGILE/UNSTABLE — add more inputs or fix drift`)
  }
  if (lowConfList.length > 0) {
    actions.push(`${lowConfList.length} cluster${lowConfList.length !== 1 ? 's' : ''} LOW confidence — too few inputs`)
  }
  if (skippedClusters.length > 0) {
    actions.push(`${skippedClusters.length} cluster${skippedClusters.length !== 1 ? 's' : ''} not captured — run 'regret capture'`)
  }

  if (actions.length > 0) {
    console.log(`\n⚠️  Action needed:`)
    for (const a of actions) {
      console.log(`  • ${a}`)
    }
  }

  // Safe to refactor verdict
  const verdictIcon = safeToRefactor === 'YES' ? '✅' : safeToRefactor === 'PARTIAL' ? '🟡' : '🔴'
  let verdictDetail = ''
  if (safeToRefactor === 'PARTIAL') verdictDetail = ' (see fragile clusters)'
  if (safeToRefactor === 'NO') verdictDetail = ' (fix issues first)'

  console.log(`\nSafe to refactor: ${safeToRefactor}${verdictDetail}`)
  console.log()
}

// ─── Helper ─────────────────────────────────────────────────────────────────────

function formatTimeAgo(ms) {
  const seconds = Math.floor(ms / 1000)
  if (seconds < 60) return 'just now'
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  if (days < 30) return `${days}d ago`
  const months = Math.floor(days / 30)
  return `${months}mo ago`
}

#!/usr/bin/env node
// health.js — cluster health score report + confidence scoring
// Reads audit.log + .regret files + manifest to score cluster stability
// and compute confidence (HIGH/MEDIUM/LOW) per cluster.
//
// Usage:
//   node scripts/health.js
//   node scripts/health.js --sort fragile
//   node scripts/health.js --json

import { readFileSync, readdirSync, existsSync } from 'fs'
import { resolve, join, basename } from 'path'
import { computeConfidence, parseAuditForDrift } from './confidence.js'

const args      = process.argv.slice(2)
const sortBy    = args[args.indexOf('--sort') + 1] ?? 'health'
const jsonOutput = args.includes('--json')
const regretDir = resolve(process.cwd(), 'regrets')
const auditLog  = join(regretDir, 'audit.log')

// ─── Load manifest (for input counts) ──────────────────────────────────────────

let manifest = { clusters: [] }
const manifestPath = resolve(process.cwd(), 'regrets/manifest.json')
try {
  manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
} catch (e) {
  if (e.code === 'ENOENT') {
    console.error(`❌ regrets/manifest.json not found at ${manifestPath}. Run 'regret init' first.`)
    process.exit(1)
  }
  console.error(`❌ Invalid JSON in ${manifestPath}: ${e.message}. Fix the syntax and retry.`)
  process.exit(1)
}

// Build lookup: cluster-id -> input count
const inputCountMap = {}
for (const c of manifest.clusters || []) {
  inputCountMap[c.id] = (c.inputs || []).length
}

// ─── Parse audit.log ──────────────────────────────────────────────────────────

function parseAuditLog() {
  if (!existsSync(auditLog)) return {}
  const content = readFileSync(auditLog, 'utf8').trim()
  if (!content) return {}

  const events = {}
  const blocks = content.split('\n\n').filter(Boolean)

  for (const block of blocks) {
    const lines = block.trim().split('\n')
    const header = lines[0] // "2024-03-01T09:00:00Z  UPDATE  cluster-id"
    const parts  = header.trim().split(/\s+/)
    const type   = parts[1]
    const id     = parts[2]
    if (!id) continue
    if (!events[id]) events[id] = { updates: 0, drifts: 0, history: [] }
    if (type === 'UPDATE') events[id].updates++
    if (type === 'DRIFT')  events[id].drifts++
    events[id].history.push({ type, date: parts[0] })
  }

  return events
}

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

// ─── Health score (0–100) ─────────────────────────────────────────────────────

function scoreCluster({ updates, drifts, ageDays }) {
  let score = 100
  score -= updates * 15   // each intentional update = -15
  score -= drifts  * 25   // each drift = -25 (worse, indicates hidden bugs)
  if (ageDays < 3)  score -= 10  // brand new, not proven yet
  if (ageDays > 30) score += 5   // old and stable = bonus
  return Math.max(0, Math.min(100, score))
}

function healthLabel(score, { isNew = false } = {}) {
  if (isNew)       return { label: 'NEW',      bar: '░░░░░░', color: '🩵', note: '(newly captured — run drift to verify)' }
  if (score >= 90) return { label: 'SOLID',    bar: '██████', color: '✅' }
  if (score >= 70) return { label: 'GOOD',     bar: '█████░', color: '🟢' }
  if (score >= 50) return { label: 'UNSTABLE', bar: '███░░░', color: '🟡' }
  return              { label: 'FRAGILE',   bar: '██░░░░', color: '🔴' }
}

// ─── Main ─────────────────────────────────────────────────────────────────────

let regretFiles
try {
  regretFiles = readdirSync(regretDir).filter(f => f.endsWith('.regret'))
} catch {
  console.error(`❌ regrets/ directory not found. Run capture.js first.`)
  process.exit(1)
}

if (!regretFiles.length) {
  console.log(`No .regret files found. Nothing to report.`)
  process.exit(0)
}

const auditData = parseAuditLog()
const driftMap  = parseAuditForDrift(auditLog)
const now = Date.now()

const clusters = regretFiles.map(f => {
  const id      = basename(f, '.regret')
  const content = readFileSync(join(regretDir, f), 'utf8')
  const meta    = parseRegretMeta(content)
  const audit   = auditData[id] ?? { updates: 0, drifts: 0, history: [] }
  const captured = meta.captured ? new Date(meta.captured).getTime() : now
  const ageHours = (now - captured) / (1000 * 60 * 60)
  const ageDays  = Math.floor(ageHours / 24)
  const isNew    = ageHours < 72 && audit.updates === 0 && audit.drifts === 0
  const score    = scoreCluster({ updates: audit.updates, drifts: audit.drifts, ageDays })
  const health   = healthLabel(score, { isNew })

  // Confidence score
  const inputCount = inputCountMap[id] ?? 0
  const hasDriftOrUpdate = !!driftMap[id]
  const confidence = computeConfidence({ inputCount, ageDays, hasDriftOrUpdate })

  return { id, ageDays, score, health, isNew, confidence, inputCount, ...audit }
})

// Sort
const sorted = [...clusters].sort((a, b) => {
  if (sortBy === 'fragile') return a.score - b.score
  if (sortBy === 'age')     return b.ageDays - a.ageDays
  if (sortBy === 'confidence') return a.confidence.score - b.confidence.score
  return b.score - b.score  // default: healthiest first
})

// ─── Render ───────────────────────────────────────────────────────────────────

if (jsonOutput) {
  // JSON output mode
  const jsonResult = {
    clusters: sorted.map(c => ({
      id: c.id,
      fragility: Math.max(0, 100 - c.score) / 100,
      lastCapture: c.ageDays === 0 ? 'today' : `${c.ageDays}d ago`,
      score: c.score,
      label: c.health.label,
      isNew: c.isNew,
      updates: c.updates,
      drifts: c.drifts,
      confidence: c.confidence.label,
      confidenceScore: c.confidence.score,
    }))
  }
  console.log(JSON.stringify(jsonResult, null, 0))
} else {
  const COL = { id: 24, updates: 8, drifts: 7, age: 9, health: 16, confidence: 8, detail: 30 }

  console.log(`\nCLUSTER HEALTH REPORT`)
  console.log(`${'─'.repeat(90)}`)
  console.log(
    `${'cluster'.padEnd(COL.id)}` +
    `${'updates'.padEnd(COL.updates)}` +
    `${'drifts'.padEnd(COL.drifts)}` +
    `${'age'.padEnd(COL.age)}` +
    `${'health'.padEnd(COL.health)}` +
    `${'conf'.padEnd(COL.confidence)}` +
    `detail`
  )
  console.log(`${'─'.repeat(90)}`)

  for (const c of sorted) {
    const age = c.ageDays === 0 ? 'today' : `${c.ageDays}d`
    const healthStr = `${c.health.bar} ${c.health.label}`
    const confStr = c.confidence.label
    const inputStr = `${c.inputCount} input${c.inputCount !== 1 ? 's' : ''}`
    const detail = `${inputStr}, ${age} old`
    console.log(
      `${c.id.padEnd(COL.id)}` +
      `${String(c.updates).padEnd(COL.updates)}` +
      `${String(c.drifts).padEnd(COL.drifts)}` +
      `${age.padEnd(COL.age)}` +
      `${healthStr.padEnd(COL.health)}` +
      `${confStr.padEnd(COL.confidence)}` +
      `${detail}`
    )
  }

  console.log(`${'─'.repeat(90)}`)

  // ─── Legend ─────────────────────────────────────────────────────────────────

  console.log(`\nLegend:`)
  console.log(`  🩵 NEW      = recently captured, not yet verified`)
  console.log(`  ✅ SOLID    = stable, no changes detected`)
  console.log(`  🟢 GOOD     = minor changes, still healthy`)
  console.log(`  🟡 UNSTABLE = frequent changes, needs attention`)
  console.log(`  🔴 FRAGILE  = critical, high drift or update rate`)
  console.log(`\nConfidence: HIGH (>=0.8) | MEDIUM (>=0.5) | LOW (<0.5)`)
  console.log(`  Formula: F1(inputs)*0.5 + F2(age)*0.2 + F3(drift history)*0.3`)

  // ─── Recommendations ──────────────────────────────────────────────────────────

  const fragile  = sorted.filter(c => c.score < 50)
  const unstable = sorted.filter(c => c.score >= 50 && c.score < 70)
  const lowConf  = sorted.filter(c => c.confidence.label === 'LOW')

  if (fragile.length || unstable.length) {
    console.log(`\nRecommendations:`)
    for (const c of fragile) {
      if (c.updates >= 3) console.log(`  ${c.id.padEnd(COL.id)} → high update rate, consider splitting this cluster`)
      if (c.drifts  >= 1) console.log(`  ${c.id.padEnd(COL.id)} → drift detected, add normalize rules to manifest`)
    }
    for (const c of unstable) {
      console.log(`  ${c.id.padEnd(COL.id)} → monitor closely, ${c.updates} update(s), ${c.drifts} drift(s)`)
    }
  } else {
    console.log(`\n✅ All clusters are healthy. Safe to refactor.`)
  }

  if (lowConf.length) {
    console.log(`\nLow confidence clusters (add more inputs or wait for maturity):`)
    for (const c of lowConf) {
      console.log(`  ${c.id.padEnd(COL.id)} ${c.confidence.score}  (${c.inputCount} input${c.inputCount !== 1 ? 's' : ''}, ${c.ageDays}d old)`)
    }
  }

  const solid = sorted.filter(c => c.score >= 90 && !c.isNew)
  if (solid.length) {
    console.log(`\nDo not touch (SOLID contracts):`)
    solid.forEach(c => console.log(`  ${c.id}`))
  }

  console.log()
}

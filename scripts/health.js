#!/usr/bin/env node
// health.js — cluster health score report
// Reads audit.log + .regret files to score cluster stability
//
// Usage:
//   node scripts/health.js
//   node scripts/health.js --sort fragile

import { readFileSync, readdirSync, existsSync } from 'fs'
import { resolve, join, basename } from 'path'

const args      = process.argv.slice(2)
const sortBy    = args[args.indexOf('--sort') + 1] ?? 'health'
const jsonOutput = args.includes('--json')
const regretDir = resolve(process.cwd(), 'regrets')
const auditLog  = join(regretDir, 'audit.log')

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

function healthLabel(score) {
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
const now = Date.now()

const clusters = regretFiles.map(f => {
  const id      = basename(f, '.regret')
  const content = readFileSync(join(regretDir, f), 'utf8')
  const meta    = parseRegretMeta(content)
  const audit   = auditData[id] ?? { updates: 0, drifts: 0, history: [] }
  const captured = meta.captured ? new Date(meta.captured).getTime() : now
  const ageDays  = Math.floor((now - captured) / (1000 * 60 * 60 * 24))
  const score    = scoreCluster({ updates: audit.updates, drifts: audit.drifts, ageDays })
  const health   = healthLabel(score)

  return { id, ageDays, score, health, ...audit }
})

// Sort
const sorted = [...clusters].sort((a, b) => {
  if (sortBy === 'fragile') return a.score - b.score
  if (sortBy === 'age')     return b.ageDays - a.ageDays
  return b.score - a.score  // default: healthiest first
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
      updates: c.updates,
      drifts: c.drifts,
    }))
  }
  console.log(JSON.stringify(jsonResult, null, 0))
} else {
  const COL = { id: 30, updates: 8, drifts: 7, age: 9, bar: 8 }

  console.log(`\nCLUSTER HEALTH REPORT`)
  console.log(`${'─'.repeat(72)}`)
  console.log(
    `${'cluster'.padEnd(COL.id)}` +
    `${'updates'.padEnd(COL.updates)}` +
    `${'drifts'.padEnd(COL.drifts)}` +
    `${'age'.padEnd(COL.age)}` +
    `health`
  )
  console.log(`${'─'.repeat(72)}`)

  for (const c of sorted) {
    const age = c.ageDays === 0 ? 'today' : `${c.ageDays}d`
    console.log(
      `${c.id.padEnd(COL.id)}` +
      `${String(c.updates).padEnd(COL.updates)}` +
      `${String(c.drifts).padEnd(COL.drifts)}` +
      `${age.padEnd(COL.age)}` +
      `${c.health.bar} ${c.health.label}`
    )
  }

  console.log(`${'─'.repeat(72)}`)

  // ─── Recommendations ──────────────────────────────────────────────────────────

  const fragile  = sorted.filter(c => c.score < 50)
  const unstable = sorted.filter(c => c.score >= 50 && c.score < 70)

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

  const solid = sorted.filter(c => c.score >= 90)
  if (solid.length) {
    console.log(`\nDo not touch (SOLID contracts):`)
    solid.forEach(c => console.log(`  ${c.id}`))
  }

  console.log()
}

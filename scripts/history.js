#!/usr/bin/env node
// history.js — `regret history <cluster>` — audit log of contract updates (#248)
//
// Parses regrets/audit.log and prints every recorded event for the requested
// cluster (UPDATE, DRIFT, CAPTURE, etc.). Each entry shows:
//   - timestamp
//   - event type (UPDATE / DRIFT / etc.)
//   - old hash → new hash (if applicable)
//   - reason (from --reason flag)
//   - author / "by" line (defaults to "AI refactor session" for legacy entries;
//     enriched with git author + git SHA when #250 is implemented)
//   - chain hash (for tamper-evidence verification)
//
// Usage:
//   node scripts/history.js <clusterId>           Show all events for a cluster
//   node scripts/history.js <clusterId> --json    Machine-readable JSON
//   node scripts/history.js <clusterId> --limit N Show only the last N events
//   node scripts/history.js --all                 Show events for every cluster
//
// Exit codes:
//   0 — events found and printed (or --all with no events: empty result)
//   1 — cluster not found in audit.log / no audit.log / bad args
//
// Audit.log format (reference):
//   <ISO timestamp>  <TYPE>  <cluster-id>
//     old: <hash>
//     new: <hash>
//     reason: <reason text>
//     by: <author or "AI refactor session">
//     gitAuthor: <git author name <email>>   ← optional, added by #250
//     gitSha: <git HEAD short SHA>            ← optional, added by #250
//     ciRunId: <GitHub run id or CI run id>  ← optional, added by #250
//     chain: <chain hash>
//
// Blocks are separated by blank lines. Old entries (pre-#250) will not have
// gitAuthor / gitSha / ciRunId fields — we just show what's there.

import { readFileSync, existsSync } from 'fs'
import { resolve, join } from 'path'

const args = process.argv.slice(2)

// ─── Help ────────────────────────────────────────────────────────────────────
if (args.includes('--help') || args.includes('-h')) {
  console.log(`
regret history — View audit log of contract updates for a cluster

USAGE:
  regret history <clusterId>              Show all events for a cluster
  regret history <clusterId> --json       Machine-readable JSON output
  regret history <clusterId> --limit N    Show only the last N events
  regret history --all                    Show events for every cluster
  regret history --all --json             All events as JSON

OPTIONS:
  --json              Emit JSON to stdout (no human-readable formatting)
  --limit <N>         Only show the last N events (default: all)
  --all               Show events for all clusters (not just one)
  --audit-log <path>  Path to audit.log (default: regrets/audit.log)

EXAMPLES:
  regret history parse-config
  regret history parse-config --json
  regret history parse-config --limit 5
  regret history --all --json | jq '.events | length'

The audit log is append-only and tamper-evident (each entry chains to the
previous one via a SHA-256 hash). Use this command to answer:
  - "When did this cluster's contract last change, and why?"
  - "Who authorized this update?"
  - "What was the git commit at the time of the update?"
`)
  process.exit(0)
}

const jsonOutput = args.includes('--json')
const showAll = args.includes('--all')
const limitIdx = args.indexOf('--limit')
const limit = limitIdx !== -1 ? parseInt(args[limitIdx + 1] ?? '0', 10) : 0
const auditLogPath = args.includes('--audit-log')
  ? args[args.indexOf('--audit-log') + 1]
  : resolve(process.cwd(), 'regrets/audit.log')

// Positional arg = cluster ID (only when not --all)
const targetCluster = !showAll
  ? args.find(a => !a.startsWith('-') && a !== '--all')
  : null

if (!showAll && !targetCluster) {
  console.error('❌ Usage: regret history <clusterId>')
  console.error('   Or:  regret history --all')
  console.error('   Run `regret history --help` for more info.')
  process.exit(1)
}

// ─── Parse audit.log ─────────────────────────────────────────────────────────

/**
 * Parse the audit.log file into a list of structured event objects.
 *
 * @param {string} logPath - Path to audit.log
 * @returns {Array<Object>} List of events
 */
function parseAuditLog(logPath) {
  if (!existsSync(logPath)) return []
  const content = readFileSync(logPath, 'utf8').trim()
  if (!content) return []

  const events = []
  const blocks = content.split('\n\n').filter(Boolean)
  for (const block of blocks) {
    const lines = block.trim().split('\n')
    if (lines.length === 0) continue

    // Header line: "<ISO timestamp>  TYPE  cluster-id"
    const header = lines[0].trim()
    // Use a tolerant regex — timestamp is ISO 8601 (with or without Z),
    // then whitespace, then TYPE (uppercase letters), then cluster id.
    const headerMatch = header.match(/^(\S+)\s+(\S+)\s+(.+)$/)
    if (!headerMatch) continue

    const [, timestamp, type, clusterId] = headerMatch

    // Parse the indented key:value lines that follow
    const event = {
      timestamp,
      type,
      clusterId: clusterId.trim(),
      oldHash: null,
      newHash: null,
      reason: null,
      by: null,
      gitSha: null,
      gitAuthor: null,
      ciRunId: null,
      chain: null,
      raw: block,
    }

    for (let i = 1; i < lines.length; i++) {
      const line = lines[i]
      // Lines look like "  key: value" with 2-space indent
      const m = line.match(/^\s+(\w+):\s*(.*)$/)
      if (!m) continue
      const [, key, value] = m
      switch (key) {
        case 'old': event.oldHash = value; break
        case 'new': event.newHash = value; break
        case 'reason': event.reason = value; break
        case 'by': event.by = value; break
        case 'gitSha': event.gitSha = value; break
        case 'gitAuthor': event.gitAuthor = value; break
        case 'ciRunId': event.ciRunId = value; break
        case 'chain': event.chain = value; break
      }
    }

    events.push(event)
  }

  return events
}

const allEvents = parseAuditLog(auditLogPath)
const events = showAll
  ? allEvents
  : allEvents.filter(e => e.clusterId === targetCluster)

if (events.length === 0) {
  if (jsonOutput) {
    console.log(JSON.stringify({
      clusterId: targetCluster,
      auditLogPath,
      eventCount: 0,
      events: [],
    }, null, 2))
  } else {
    if (!existsSync(auditLogPath)) {
      console.error(`ℹ️  No audit log found at ${auditLogPath}.`)
      console.error('    Updates will be logged here once you run `regret update <id> --reason "..."`.')
    } else if (showAll) {
      console.log('ℹ️  Audit log is empty.')
    } else {
      console.error(`ℹ️  No audit-log events found for cluster "${targetCluster}".`)
      console.error('    This cluster has never been updated via `regret update`.')
    }
  }
  process.exit(0)
}

// Apply --limit (take the LAST N events — most recent)
const limitedEvents = limit > 0 ? events.slice(-limit) : events

// ─── Output ──────────────────────────────────────────────────────────────────

if (jsonOutput) {
  const payload = {
    clusterId: targetCluster,
    auditLogPath,
    eventCount: limitedEvents.length,
    totalEventCount: events.length,
    events: limitedEvents.map(e => ({
      timestamp: e.timestamp,
      type: e.type,
      clusterId: e.clusterId,
      oldHash: e.oldHash,
      newHash: e.newHash,
      reason: e.reason,
      author: e.gitAuthor ?? e.by,
      gitSha: e.gitSha,
      ciRunId: e.ciRunId,
      chain: e.chain,
    })),
  }
  console.log(JSON.stringify(payload, null, 2))
} else {
  // Human-readable output
  const headerCluster = showAll ? '(all clusters)' : targetCluster
  console.log(`\n📜 Audit History — ${headerCluster}`)
  console.log(`   Source: ${auditLogPath}`)
  console.log(`   Events: ${limitedEvents.length}${events.length !== limitedEvents.length ? ` (showing last ${limitedEvents.length} of ${events.length})` : ''}`)
  console.log('─'.repeat(80))

  for (const e of limitedEvents) {
    console.log('')
    console.log(`  ${e.timestamp}  ${e.type}  ${e.clusterId}`)
    if (e.oldHash && e.newHash) {
      console.log(`    ${e.oldHash} → ${e.newHash}`)
    } else if (e.newHash) {
      console.log(`    hash: ${e.newHash}`)
    }
    if (e.reason) {
      console.log(`    reason:   ${e.reason}`)
    }
    // Author: prefer git author (#250), fall back to "by" line for legacy entries
    const authorLabel = e.gitAuthor ?? e.by
    if (authorLabel) {
      console.log(`    author:   ${authorLabel}`)
    }
    if (e.gitSha) {
      console.log(`    git sha:  ${e.gitSha}`)
    }
    if (e.ciRunId) {
      console.log(`    ci run:   ${e.ciRunId}`)
    }
    if (e.chain) {
      console.log(`    chain:    ${e.chain}`)
    }
  }

  console.log('')
  console.log('─'.repeat(80))
  // Tamper-evidence note
  if (limitedEvents.length > 0) {
    const lastChain = limitedEvents[limitedEvents.length - 1].chain
    if (lastChain) {
      console.log(`   Last chain hash: ${lastChain}`)
      console.log(`   (Each entry chains to the previous via SHA-256 — tampering with`)
      console.log(`    any historical entry will invalidate every subsequent chain hash.)`)
    }
  }
  console.log('')
}

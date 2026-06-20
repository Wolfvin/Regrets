#!/usr/bin/env node
// history.js — Show audit log for a specific cluster
//
// Usage:
//   node scripts/history.js <clusterId>
//   node scripts/history.js <clusterId> --json
//
// Reads regrets/audit.log and filters entries for the given cluster.
// Each entry shows: timestamp, action, old/new hashes, reason, chain hash.

import { readFileSync, existsSync } from 'fs'
import { join, resolve } from 'path'
import { fileURLToPath } from 'url'
import { dirname } from 'path'

const __dirname = dirname(fileURLToPath(import.meta.url))
const args = process.argv.slice(2)

if (args.length === 0 || args.includes('--help')) {
  console.log(`Usage: regret history <clusterId> [--json]

Show the audit log for a specific cluster from regrets/audit.log.

Options:
  --json    Output as JSON array (one object per entry)

Examples:
  regret history main
  regret history main.calls.add --json
`)
  process.exit(0)
}

const clusterId = args.find(a => !a.startsWith('-'))
const jsonOutput = args.includes('--json')

const projectRoot = resolve(process.cwd())
const regretDir = join(projectRoot, 'regrets')
const auditLog = join(regretDir, 'audit.log')

if (!existsSync(auditLog)) {
  console.error(`No audit.log found at ${auditLog}`)
  console.error('Run regret capture + regret update to create audit entries.')
  process.exit(1)
}

// Parse audit.log entries. Format:
//
//   <timestamp>  UPDATE  <clusterId>
//     old: <oldHash>
//     new: <newHash>
//     reason: <reason>
//     by: <author>
//     chain: <chainHash>
//
// Entries are separated by blank lines.
const logContent = readFileSync(auditLog, 'utf8').trim()
if (!logContent) {
  console.log('Audit log is empty.')
  process.exit(0)
}

const entries = []
const blocks = logContent.split(/\n\n+/)

for (const block of blocks) {
  const lines = block.split('\n').map(l => l.trim()).filter(Boolean)
  if (lines.length === 0) continue

  const headerMatch = lines[0].match(/^(\S+)\s+(UPDATE|CAPTURE|ROLLBACK)\s+(.+)$/)
  if (!headerMatch) continue

  const entry = {
    timestamp: headerMatch[1],
    action: headerMatch[2],
    clusterId: headerMatch[3],
  }

  for (let i = 1; i < lines.length; i++) {
    const oldMatch = lines[i].match(/^old:\s*(.+)$/)
    if (oldMatch) entry.oldHash = oldMatch[1]

    const newMatch = lines[i].match(/^new:\s*(.+)$/)
    if (newMatch) entry.newHash = newMatch[1]

    const reasonMatch = lines[i].match(/^reason:\s*(.+)$/)
    if (reasonMatch) entry.reason = reasonMatch[1]

    const byMatch = lines[i].match(/^by:\s*(.+)$/)
    if (byMatch) entry.author = byMatch[1]

    const chainMatch = lines[i].match(/^chain:\s*(.+)$/)
    if (chainMatch) entry.chain = chainMatch[1]

    const shaMatch = lines[i].match(/^gitSha:\s*(.+)$/)
    if (shaMatch) entry.gitSha = shaMatch[1]
  }

  entries.push(entry)
}

// Filter to the requested cluster
const filtered = entries.filter(e => e.clusterId === clusterId)

if (filtered.length === 0) {
  console.log(`No audit entries found for cluster "${clusterId}".`)
  if (clusterId.includes('.calls.')) {
    console.log(`Tip: callee contracts share the parent's audit trail. Try: regret history ${clusterId.split('.calls.')[0]}`)
  }
  process.exit(0)
}

if (jsonOutput) {
  console.log(JSON.stringify(filtered, null, 2))
} else {
  console.log(`Audit history for "${clusterId}" (${filtered.length} entries)\n`)
  for (const entry of filtered) {
    console.log(`  ${entry.timestamp}  ${entry.action}`)
    if (entry.oldHash && entry.newHash) {
      console.log(`    ${entry.oldHash} → ${entry.newHash}`)
    }
    if (entry.reason) {
      console.log(`    reason: ${entry.reason}`)
    }
    if (entry.author) {
      console.log(`    by: ${entry.author}`)
    }
    if (entry.gitSha) {
      console.log(`    git: ${entry.gitSha}`)
    }
    if (entry.chain) {
      console.log(`    chain: ${entry.chain}`)
    }
    console.log()
  }
}

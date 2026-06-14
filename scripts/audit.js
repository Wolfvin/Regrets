#!/usr/bin/env node
// audit.js — Comprehensive pre-refactor readiness audit (JS/TS stack)
// Combines health, coverage, drift, and chain status into a single report.
// This is the JS/TS equivalent of audit.py — it addresses the gap where
// JS/TS projects had no combined pre-refactor readiness check.
//
// Usage:
//   node scripts/audit.js
//   node scripts/audit.js --strict   (exit 1 if any issues found)
//
// Inspired by the Coretax-Auto-Downloader project — a Chrome extension
// where running health + coverage + drift manually before refactoring
// was error-prone and time-consuming.

import { readFileSync, existsSync, readdirSync } from 'fs'
import { resolve, join } from 'path'
import { execFileSync } from 'child_process'

const args = process.argv.slice(2)
const strict = args.includes('--strict')
const CWD = process.cwd()
const REGRET_DIR = resolve(CWD, 'regrets')
const MANIFEST_PATH = resolve(CWD, 'regrets/manifest.json')

// ─── Helper ────────────────────────────────────────────────────────────────────

function runCommand(cmd, cmdArgs) {
  try {
    const result = execFileSync(cmd, cmdArgs, {
      encoding: 'utf8',
      cwd: CWD,
      timeout: 120000,
      stdio: ['pipe', 'pipe', 'pipe']
    })
    return { output: result, code: 0 }
  } catch (err) {
    return { output: err.stdout || '', code: err.status || 1 }
  }
}

// ─── Checks ────────────────────────────────────────────────────────────────────

function checkManifest() {
  if (!existsSync(MANIFEST_PATH)) {
    return { ok: false, msg: 'No manifest.json found' }
  }
  try {
    const manifest = JSON.parse(readFileSync(MANIFEST_PATH, 'utf8'))
    const clusters = manifest.clusters || []
    if (!clusters.length) {
      return { ok: false, msg: 'No clusters defined in manifest' }
    }
    // Check for common manifest issues
    const issues = []
    for (const cluster of clusters) {
      if (!cluster.id) issues.push(`cluster missing "id" field`)
      if (!cluster.entry) issues.push(`cluster "${cluster.id}" missing "entry" field`)
      if (!cluster.file) issues.push(`cluster "${cluster.id}" missing "file" field`)
    }
    if (issues.length > 0) {
      return { ok: false, msg: `${issues.length} issue(s): ${issues.slice(0, 3).join('; ')}` }
    }
    return { ok: true, msg: `${clusters.length} cluster(s) defined` }
  } catch (e) {
    return { ok: false, msg: `Invalid JSON: ${e.message}` }
  }
}

function checkRegretFiles() {
  if (!existsSync(REGRET_DIR)) {
    return { ok: false, msg: 'No regrets/ directory' }
  }
  try {
    const manifest = JSON.parse(readFileSync(MANIFEST_PATH, 'utf8'))
    const clusterIds = new Set((manifest.clusters || []).map(c => c.id))
    const regretFiles = new Set()
    for (const f of readdirSync(REGRET_DIR)) {
      if (f.endsWith('.regret')) regretFiles.add(f.replace('.regret', ''))
    }
    const missing = [...clusterIds].filter(id => !regretFiles.has(id))
    if (missing.length > 0) {
      return { ok: false, msg: `Missing .regret files: ${missing.join(', ')}` }
    }
    return { ok: true, msg: `All ${clusterIds.size} .regret files present` }
  } catch (e) {
    return { ok: false, msg: `Error: ${e.message}` }
  }
}

function checkValidate() {
  const scriptDir = resolve(import.meta.dirname || '.', '')
  const validatePath = resolve(scriptDir, 'validate.js')
  if (!existsSync(validatePath)) {
    return { ok: false, msg: 'validate.js not found' }
  }
  const { output, code } = runCommand('node', [validatePath])
  if (code === 0) {
    const greenCount = (output.match(/✅/g) || []).length
    return { ok: true, msg: `${greenCount} cluster(s) GREEN` }
  } else {
    const redCount = (output.match(/❌/g) || []).length
    return { ok: false, msg: `${redCount} cluster(s) RED — fix before refactoring` }
  }
}

function checkDrift() {
  const scriptDir = resolve(import.meta.dirname || '.', '')
  const validatePath = resolve(scriptDir, 'validate.js')
  if (!existsSync(validatePath)) {
    return { ok: false, msg: 'validate.js not found for drift check' }
  }
  const { output, code } = runCommand('node', [validatePath, '--runs', '3'])
  if (output.includes('DRIFT')) {
    const driftCount = (output.match(/DRIFT/g) || []).length
    return { ok: false, msg: `${driftCount} cluster(s) DRIFT — add normalize rules` }
  }
  if (code === 0) {
    const stableCount = (output.match(/STABLE/g) || []).length
    return { ok: true, msg: `${stableCount} cluster(s) STABLE across 3 runs` }
  }
  return { ok: false, msg: 'Drift check failed' }
}

function checkHealth() {
  const scriptDir = resolve(import.meta.dirname || '.', '')
  const healthPath = resolve(scriptDir, 'health.js')
  if (!existsSync(healthPath)) {
    return { ok: false, msg: 'health.js not found' }
  }
  const { output } = runCommand('node', [healthPath])
  const solidCount = (output.match(/SOLID/g) || []).length
  const goodCount = (output.match(/GOOD/g) || []).length
  const unstableCount = (output.match(/UNSTABLE/g) || []).length
  const fragileCount = (output.match(/FRAGILE/g) || []).length

  if (fragileCount > 0 || unstableCount > 0) {
    return { ok: false, msg: `SOLID: ${solidCount}, GOOD: ${goodCount}, UNSTABLE: ${unstableCount}, FRAGILE: ${fragileCount}` }
  }
  return { ok: true, msg: `SOLID: ${solidCount}, GOOD: ${goodCount}` }
}

function checkCoverage() {
  const scriptDir = resolve(import.meta.dirname || '.', '')
  const coveragePath = resolve(scriptDir, 'coverage.js')
  if (!existsSync(coveragePath)) {
    return { ok: true, msg: 'Coverage check skipped (coverage.js not found)', warning: true }
  }
  const { output, code } = runCommand('node', [coveragePath])
  if (output.includes('UNDER-COVERED')) {
    const underCount = (output.match(/UNDER-COVERED/g) || []).length
    return { ok: false, msg: `${underCount} cluster(s) UNDER-COVERED` }
  }
  if (output.includes('PARTIAL')) {
    const partialCount = (output.match(/PARTIAL/g) || []).length
    return { ok: true, msg: `All clusters covered, ${partialCount} PARTIAL (acceptable but improve)`, warning: true }
  }
  return { ok: true, msg: 'All clusters WELL-COVERED' }
}

function checkChains() {
  const chainsJson = resolve(REGRET_DIR, 'chains.json')
  const chainsDir = resolve(REGRET_DIR, 'chains')

  if (!existsSync(chainsJson)) {
    return { ok: true, msg: 'No chains defined (optional)', warning: true }
  }

  try {
    const chains = JSON.parse(readFileSync(chainsJson, 'utf8'))
    const chainList = chains.chains || []
    if (chainList.length === 0) {
      return { ok: true, msg: 'No chains in chains.json', warning: true }
    }

    // Check that chain files exist
    if (!existsSync(chainsDir)) {
      return { ok: false, msg: `${chainList.length} chain(s) defined but no chains/ directory` }
    }

    let captured = 0
    let uncaptured = []
    for (const chain of chainList) {
      const chainFile = resolve(chainsDir, `${chain.id}.chain`)
      if (existsSync(chainFile)) {
        captured++
      } else {
        uncaptured.push(chain.id)
      }
    }

    if (uncaptured.length > 0) {
      return { ok: false, msg: `${uncaptured.length} chain(s) not captured: ${uncaptured.join(', ')}` }
    }
    return { ok: true, msg: `All ${captured} chain(s) captured` }
  } catch (e) {
    return { ok: false, msg: `Invalid chains.json: ${e.message}` }
  }
}

// ─── Main ──────────────────────────────────────────────────────────────────────

console.log('\n╔══════════════════════════════════════════════════════════════════╗')
console.log('║              REGRET PRE-REFACTOR AUDIT REPORT (JS/TS)           ║')
console.log('╚══════════════════════════════════════════════════════════════════╝')
console.log()

const checks = [
  ('Manifest', checkManifest),
  ('Regret Files', checkRegretFiles),
  ('Validation', checkValidate),
  ('Drift Detection', checkDrift),
  ('Cluster Health', checkHealth),
  ('Branch Coverage', checkCoverage),
  ('Chains', checkChains),
]

let allPass = true
const warnings = []

for (const [name, checkFn] of checks) {
  process.stdout.write(`  Checking ${name}... `)
  try {
    const result = checkFn()
    const hasWarning = result.warning || false
    if (result.ok) {
      const icon = hasWarning ? '🟡' : '✅'
      console.log(`${icon} ${result.msg}`)
      if (hasWarning) warnings.push(`${name}: ${result.msg}`)
    } else {
      console.log(`❌ ${result.msg}`)
      allPass = false
    }
  } catch (e) {
    console.log(`⚠️  Error: ${e.message}`)
    warnings.push(`${name}: check failed — ${e.message}`)
  }
}

console.log()
console.log('─'.repeat(68))

if (allPass && warnings.length === 0) {
  console.log('✅ AUDIT PASSED — All checks GREEN. Safe to refactor.')
} else if (allPass && warnings.length > 0) {
  console.log('🟡 AUDIT PASSED with warnings:')
  for (const w of warnings) console.log(`   • ${w}`)
  console.log('   Refactoring is possible but consider addressing warnings first.')
} else {
  console.log('❌ AUDIT FAILED — Fix the issues above before refactoring.')
}

console.log()

if (strict && !allPass) {
  process.exit(1)
}

#!/usr/bin/env node
// regret.js — unified runner for regret-based regression testing
// Auto-detects stack from manifest and dispatches to the appropriate handler.
//
// Usage:
//   node scripts/regret.js capture [--cluster <id>]
//   node scripts/regret.js validate [--cluster <id>] [--runs 5] [--fail-fast]
//   node scripts/regret.js health [--sort fragile]
//   node scripts/regret.js update <cluster-id> --reason "specific reason"
//   node scripts/regret.js drift
//   node scripts/regret.js ci
//   node scripts/regret.js guard

import { readFileSync } from 'fs'
import { resolve, dirname } from 'path'
import { fileURLToPath } from 'url'
import { execFileSync } from 'child_process'

const __dirname = dirname(fileURLToPath(import.meta.url))
const SCRIPTS_DIR = __dirname

// ─── CLI args ─────────────────────────────────────────────────────────────────

const args = process.argv.slice(2)
const command = args[0] ?? 'help'
const passThroughArgs = args.slice(1)

// ─── Helper ────────────────────────────────────────────────────────────────────

/**
 * Run a command safely using execFileSync (no shell injection risk).
 * @param {string} cmd - The executable (e.g., 'node', 'python3', 'bash')
 * @param {string[]} cmdArgs - Arguments as an array (properly escaped)
 * @returns {boolean} true if exit code 0
 */
function run(cmd, cmdArgs) {
  const displayCmd = `${cmd} ${cmdArgs.join(' ')}`
  console.log(`\n$ ${displayCmd}`)
  try {
    execFileSync(cmd, cmdArgs, { stdio: 'inherit', cwd: process.cwd() })
    return true
  } catch {
    return false
  }
}

// ─── Detect stacks from manifest ───────────────────────────────────────────────

function detectStacks() {
  const manifestPath = resolve(process.cwd(), 'regrets/manifest.json')
  try {
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
    const stacks = new Set()
    for (const cluster of manifest.clusters) {
      stacks.add(cluster.stack || 'js')
    }
    return [...stacks]
  } catch {
    return ['js']
  }
}

// ─── Command dispatch ─────────────────────────────────────────────────────────

let success = true

switch (command) {
  case 'capture': {
    const stacks = detectStacks()
    for (const stack of stacks) {
      if (stack === 'js' || stack === 'ts') {
        success = run('node', [`${SCRIPTS_DIR}/capture.js`, ...passThroughArgs]) && success
      } else if (stack === 'python') {
        success = run('python3', [`${SCRIPTS_DIR}/capture.py`, ...passThroughArgs]) && success
      } else if (stack === 'react') {
        success = run('node', [`${SCRIPTS_DIR}/capture_react.mjs`, ...passThroughArgs]) && success
      } else if (stack === 'rust') {
        success = run('bash', [`${SCRIPTS_DIR}/capture_rust.sh`, 'capture', ...passThroughArgs]) && success
      }
    }
    break
  }

  case 'validate': {
    const stacks = detectStacks()
    for (const stack of stacks) {
      if (stack === 'js' || stack === 'ts' || stack === 'react') {
        success = run('node', [`${SCRIPTS_DIR}/validate.js`, ...passThroughArgs]) && success
      } else if (stack === 'python') {
        success = run('python3', [`${SCRIPTS_DIR}/validate.py`, ...passThroughArgs]) && success
      } else if (stack === 'rust') {
        success = run('bash', [`${SCRIPTS_DIR}/capture_rust.sh`, 'validate', ...passThroughArgs]) && success
      }
    }
    break
  }

  case 'health': {
    success = run('node', [`${SCRIPTS_DIR}/health.js`, ...passThroughArgs])
    break
  }

  case 'update': {
    // Find which stack the target cluster belongs to
    const targetCluster = passThroughArgs.find(a => !a.startsWith('-'))
    const manifestPath = resolve(process.cwd(), 'regrets/manifest.json')
    let targetStack = 'js'
    try {
      const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
      const cluster = manifest.clusters.find(c => c.id === targetCluster)
      if (cluster) targetStack = cluster.stack || 'js'
    } catch { /* default to js */ }

    if (targetStack === 'python') {
      success = run('python3', [`${SCRIPTS_DIR}/validate.py`, ...passThroughArgs])
    } else {
      success = run('node', [`${SCRIPTS_DIR}/validate.js`, ...passThroughArgs])
    }
    break
  }

  case 'drift': {
    const stacks = detectStacks()
    for (const stack of stacks) {
      if (stack === 'js' || stack === 'ts' || stack === 'react') {
        success = run('node', [`${SCRIPTS_DIR}/validate.js`, '--runs', '5', ...passThroughArgs]) && success
      } else if (stack === 'python') {
        success = run('python3', [`${SCRIPTS_DIR}/validate.py`, '--runs', '5', ...passThroughArgs]) && success
      }
    }
    break
  }

  case 'ci': {
    const stacks = detectStacks()
    for (const stack of stacks) {
      if (stack === 'js' || stack === 'ts' || stack === 'react') {
        success = run('node', [`${SCRIPTS_DIR}/validate.js`, '--fail-fast', ...passThroughArgs]) && success
      } else if (stack === 'python') {
        success = run('python3', [`${SCRIPTS_DIR}/validate.py`, '--fail-fast', ...passThroughArgs]) && success
      }
    }
    break
  }

  case 'rollback': {
    const targetCluster = passThroughArgs.find(a => !a.startsWith('-'))
    if (!targetCluster) {
      console.error('❌ Usage: regret rollback <cluster-id>')
      process.exit(1)
    }
    console.log(`\n🔄 Rolling back: ${targetCluster}`)
    console.log('   Re-capturing fingerprint with current code...\n')
    success = run('node', [`${SCRIPTS_DIR}/capture.js`, '--cluster', targetCluster]) && success
    if (success) {
      success = run('node', [`${SCRIPTS_DIR}/validate.js`, '--cluster', targetCluster]) && success
    }
    break
  }

  case 'chain': {
    success = run('node', [`${SCRIPTS_DIR}/contest.mjs`, ...passThroughArgs])
    break
  }

  case 'guard': {
    const stacks = detectStacks()
    for (const stack of stacks) {
      if (stack === 'js' || stack === 'ts' || stack === 'react') {
        success = run('node', [`${SCRIPTS_DIR}/validate.js`, '--fail-fast', ...passThroughArgs]) && success
      } else if (stack === 'python') {
        success = run('python3', [`${SCRIPTS_DIR}/validate.py`, '--fail-fast', ...passThroughArgs]) && success
      }
    }
    if (success) {
      console.log('\n✅ Regret guard passed — all clusters green.')
    } else {
      console.log('\n❌ Regret guard FAILED — some clusters are red.')
    }
    break
  }

  case 'help':
  default:
    console.log(`
regret.js — Unified Regret Runner

Usage:
  node scripts/regret.js capture [--cluster <id>]     Capture fingerprints
  node scripts/regret.js validate [--cluster <id>]    Validate against golden
  node scripts/regret.js health [--sort fragile]      Health report
  node scripts/regret.js update <id> --reason "..."   Safe update with audit trail
  node scripts/regret.js drift [--cluster <id>]       Drift detection (5 runs)
  node scripts/regret.js ci                            CI mode (fail-fast)
  node scripts/regret.js rollback <id>                  Rollback cluster (re-capture + validate)
  node scripts/regret.js chain [--capture|--validate]  Chain testing (multi-step flows)
  node scripts/regret.js guard                         Pre-build gate

Auto-detects stack from manifest.json and dispatches to the right handler:
  js/ts   → capture.js / validate.js
  python  → capture.py / validate.py
  react   → capture_react.mjs / validate.js
  rust    → capture_rust.sh
`)
    break
}

process.exit(success ? 0 : 1)

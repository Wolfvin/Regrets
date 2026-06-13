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
//   node scripts/regret.js coverage [--cluster <id>] [--verbose]
//   node scripts/regret.js scan [--dir src/] [--stack js] [--format manifest]
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

// ─── Pre-build hook ───────────────────────────────────────────────────────────
// If the manifest has a `preBuild` field, run it before capture/validate/truth.
// This is essential for TypeScript projects that need `npm run build` before
// Regrets can import the compiled output.
// Example manifest: { "preBuild": "npm run build", "clusters": [...] }

function runPreBuild() {
  try {
    const manifestPath = resolve(process.cwd(), 'regrets/manifest.json')
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
    if (manifest.preBuild) {
      console.log(`\n🔧 Running preBuild: ${manifest.preBuild}`)
      try {
        const [cmd, ...cmdArgs] = manifest.preBuild.split(' ')
        execFileSync(cmd, cmdArgs, { stdio: 'inherit', cwd: process.cwd() })
        console.log(`   ✅ preBuild succeeded\n`)
        return true
      } catch {
        console.error(`   ❌ preBuild failed — continuing anyway\n`)
        return false
      }
    }
  } catch { /* no manifest or no preBuild — that's fine */ }
  return true
}

const needsPreBuild = ['capture', 'validate', 'truth', 'drift', 'ci', 'guard', 'chain']
if (needsPreBuild.includes(command)) {
  runPreBuild()
}

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
      } else if (stack === 'php') {
        success = run('php', [`${SCRIPTS_DIR}/capture_php.php`, ...passThroughArgs]) && success
      } else if (stack === 'rust') {
        success = run('bash', [`${SCRIPTS_DIR}/capture_rust.sh`, 'capture', ...passThroughArgs]) && success
      } else if (stack === 'go') {
        success = run('bash', [`${SCRIPTS_DIR}/capture_go.sh`, 'capture', ...passThroughArgs]) && success
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
      } else if (stack === 'php') {
        success = run('php', [`${SCRIPTS_DIR}/validate_php.php`, ...passThroughArgs]) && success
      } else if (stack === 'rust') {
        success = run('bash', [`${SCRIPTS_DIR}/capture_rust.sh`, 'validate', ...passThroughArgs]) && success
      } else if (stack === 'go') {
        success = run('bash', [`${SCRIPTS_DIR}/capture_go.sh`, 'validate', ...passThroughArgs]) && success
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
    } else if (targetStack === 'php') {
      success = run('php', [`${SCRIPTS_DIR}/validate_php.php`, ...passThroughArgs])
    } else if (targetStack === 'go') {
      success = run('bash', [`${SCRIPTS_DIR}/capture_go.sh`, 'validate', ...passThroughArgs])
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
      } else if (stack === 'php') {
        success = run('php', [`${SCRIPTS_DIR}/validate_php.php`, '--runs', '5', ...passThroughArgs]) && success
      } else if (stack === 'go') {
        console.log(`  ⏭️  Go drift detection: run capture_go.sh with --runs flag manually`)
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
      } else if (stack === 'php') {
        success = run('php', [`${SCRIPTS_DIR}/validate_php.php`, '--fail-fast', ...passThroughArgs]) && success
      } else if (stack === 'go') {
        success = run('bash', [`${SCRIPTS_DIR}/capture_go.sh`, 'validate', ...passThroughArgs]) && success
      }
    }
    break
  }

  case 'check': {
    // Pre-flight manifest validation (Python only for now)
    const stacksForCheck = detectStacks()
    if (stacksForCheck.includes('python')) {
      success = run('python3', [`${SCRIPTS_DIR}/check.py`, ...passThroughArgs])
    } else {
      // Basic JS manifest validation
      try {
        const manifest = JSON.parse(readFileSync(resolve(process.cwd(), 'regrets/manifest.json'), 'utf8'))
        console.log('\n🔍 Checking manifest.json...\n')
        let ok = true
        for (const cluster of manifest.clusters) {
          const hasId = !!cluster.id
          const hasEntry = !!cluster.entry
          const hasFile = !!cluster.file
          const icon = (hasId && hasEntry && hasFile) ? '✅' : '❌'
          const issues = []
          if (!hasId) issues.push('missing id')
          if (!hasEntry) issues.push('missing entry')
          if (!hasFile) issues.push('missing file')
          console.log(`  ${icon} ${cluster.id || '(unnamed)'}${issues.length ? ' — ' + issues.join(', ') : ''}`)
          if (issues.length) ok = false
        }
        success = ok
      } catch (e) {
        console.error(`❌ manifest.json error: ${e.message}`)
        success = false
      }
    }
    break
  }

  case 'truth': {
    const stacks = detectStacks()
    for (const stack of stacks) {
      if (stack === 'js' || stack === 'ts' || stack === 'react') {
        success = run('node', [`${SCRIPTS_DIR}/truth.js`, ...passThroughArgs]) && success
      } else if (stack === 'python') {
        success = run('python3', [`${SCRIPTS_DIR}/truth.py`, ...passThroughArgs]) && success
      } else {
        console.log(`  ⏭️  Stack "${stack}" — truth capture not yet supported`)
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

  case 'diff': {
    success = run('node', [`${SCRIPTS_DIR}/diff.js`, ...passThroughArgs])
    break
  }

  case 'list': {
    success = run('node', [`${SCRIPTS_DIR}/list.js`, ...passThroughArgs])
    break
  }

  case 'verify-kebenaran': {
    success = run('node', [`${SCRIPTS_DIR}/verify_kebenaran.js`, ...passThroughArgs])
    break
  }

  case 'chain': {
    const stacks = detectStacks()
    for (const stack of stacks) {
      if (stack === 'js' || stack === 'ts' || stack === 'react') {
        success = run('node', [`${SCRIPTS_DIR}/contest.mjs`, ...passThroughArgs]) && success
      } else if (stack === 'python') {
        success = run('python3', [`${SCRIPTS_DIR}/contest.py`, ...passThroughArgs]) && success
      }
    }
    break
  }

  case 'scan': {
    const stacks = detectStacks()
    for (const stack of stacks) {
      if (stack === 'js' || stack === 'ts' || stack === 'react') {
        success = run('node', [`${SCRIPTS_DIR}/scan.js`, ...passThroughArgs]) && success
      } else if (stack === 'python') {
        success = run('python3', [`${SCRIPTS_DIR}/scan.py`, ...passThroughArgs]) && success
      } else {
        // Default to JS scanner for unknown stacks
        success = run('node', [`${SCRIPTS_DIR}/scan.js`, ...passThroughArgs]) && success
      }
    }
    break
  }

  case 'coverage': {
    const stacks = detectStacks()
    for (const stack of stacks) {
      if (stack === 'js' || stack === 'ts' || stack === 'react') {
        success = run('node', [`${SCRIPTS_DIR}/coverage.js`, ...passThroughArgs]) && success
      } else if (stack === 'python') {
        success = run('python3', [`${SCRIPTS_DIR}/coverage.py`, ...passThroughArgs]) && success
      } else {
        // Default to JS coverage for unknown stacks
        success = run('node', [`${SCRIPTS_DIR}/coverage.js`, ...passThroughArgs]) && success
      }
    }
    break
  }

  case 'audit': {
    success = run('python3', [`${SCRIPTS_DIR}/audit.py`, ...passThroughArgs])
    break
  }

  case 'diagnose': {
    success = run('node', [`${SCRIPTS_DIR}/diagnose.js`, ...passThroughArgs])
    break
  }

  case 'guard': {
    const stacks = detectStacks()
    for (const stack of stacks) {
      if (stack === 'js' || stack === 'ts' || stack === 'react') {
        success = run('node', [`${SCRIPTS_DIR}/validate.js`, '--fail-fast', ...passThroughArgs]) && success
      } else if (stack === 'python') {
        success = run('python3', [`${SCRIPTS_DIR}/validate.py`, '--fail-fast', ...passThroughArgs]) && success
      } else if (stack === 'php') {
        success = run('php', [`${SCRIPTS_DIR}/validate_php.php`, '--fail-fast', ...passThroughArgs]) && success
      } else if (stack === 'go') {
        success = run('bash', [`${SCRIPTS_DIR}/capture_go.sh`, 'validate', ...passThroughArgs]) && success
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
  node scripts/regret.js diff [--cluster <id>]     Show output diff (what changed)
  node scripts/regret.js list                       List all clusters with status
  node scripts/regret.js verify-kebenaran            Verify KEBENARAN 1 vs KEBENARAN 2
  node scripts/regret.js chain [--capture|--validate]  Chain testing (multi-step flows, JS+Python)
  node scripts/regret.js truth                         Save dual truth baselines
  node scripts/regret.js scan [--dir src/] [--stack]   Scan project for cluster suggestions
  node scripts/regret.js coverage [--cluster <id>]     Branch coverage analysis
  node scripts/regret.js audit [--strict]              Pre-refactor readiness audit
  node scripts/regret.js diagnose <file>                Diagnose module exports & recommend mode
  node scripts/regret.js guard                         Pre-build gate
  node scripts/regret.js check [--cluster <id>]        Pre-flight manifest validation

Auto-detects stack from manifest.json and dispatches to the right handler:
  js/ts   → capture.js / validate.js
  python  → capture.py / validate.py
  php     → capture_php.php / validate_php.php
  react   → capture_react.mjs / validate.js
  rust    → capture_rust.sh
  go      → capture_go.sh (Community Preview)
`)
    break
}

process.exit(success ? 0 : 1)

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
const skipBuild = passThroughArgs.includes('--skip-build')
if (skipBuild) {
  // Remove --skip-build from args so it doesn't get passed to sub-commands
  const idx = passThroughArgs.indexOf('--skip-build')
  if (idx !== -1) passThroughArgs.splice(idx, 1)
  console.log('\n⏩ Skipping preBuild (--skip-build flag)')
}
if (needsPreBuild.includes(command) && !skipBuild) {
  runPreBuild()
}

switch (command) {
  case 'init': {
    success = run('node', [`${SCRIPTS_DIR}/init.js`, ...passThroughArgs])
    break
  }

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
    // Pre-flight manifest validation — verifies exports exist in compiled output
    const stacksForCheck = detectStacks()
    if (stacksForCheck.includes('python')) {
      success = run('python3', [`${SCRIPTS_DIR}/check.py`, ...passThroughArgs])
    } else {
      // Full JS pre-flight: import module, verify entries exist
      success = run('node', [`${SCRIPTS_DIR}/check.js`, ...passThroughArgs])
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
      } else if (stack === 'php') {
        success = run('php', [`${SCRIPTS_DIR}/truth_php.php`, ...passThroughArgs]) && success
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
    const diffStacks = detectStacks()
    let diffOk = true
    for (const stack of diffStacks) {
      if (stack === 'python') {
        diffOk = run('python3', [`${SCRIPTS_DIR}/diff.py`, ...passThroughArgs]) && diffOk
      } else {
        diffOk = run('node', [`${SCRIPTS_DIR}/diff.js`, ...passThroughArgs]) && diffOk
      }
    }
    success = diffOk
    break
  }

  case 'list': {
    success = run('node', [`${SCRIPTS_DIR}/list.js`, ...passThroughArgs])
    break
  }

  case 'verify-kebenaran': {
    const stacks = detectStacks()
    let kebenaranOk = true
    for (const stack of stacks) {
      if (stack === 'python') {
        kebenaranOk = run('python3', [`${SCRIPTS_DIR}/verify_kebenaran.py`, ...passThroughArgs]) && kebenaranOk
      } else {
        kebenaranOk = run('node', [`${SCRIPTS_DIR}/verify_kebenaran.js`, ...passThroughArgs]) && kebenaranOk
      }
    }
    success = kebenaranOk
    break
  }

  case 'chain': {
    const stacks = detectStacks()
    for (const stack of stacks) {
      if (stack === 'js' || stack === 'ts' || stack === 'react') {
        success = run('node', [`${SCRIPTS_DIR}/contest.mjs`, ...passThroughArgs]) && success
      } else if (stack === 'python') {
        success = run('python3', [`${SCRIPTS_DIR}/contest.py`, ...passThroughArgs]) && success
      } else if (stack === 'php') {
        console.log(`  ⏭️  PHP chain testing: use regret chain with JS/Python stacks for now — PHP chain support coming soon`)
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
    // If --decompose flag is passed but no stack detected, run Python scanner
    if (passThroughArgs.includes('--decompose') && !success) {
      // Try Python scanner with the --decompose flag directly
      const dirArg = passThroughArgs.find(a => !a.startsWith('-'))
      if (dirArg) {
        success = run('python3', [`${SCRIPTS_DIR}/scan.py`, dirArg, '--decompose'])
      }
    }
    break
  }

  case 'structure': {
    success = run('node', [`${SCRIPTS_DIR}/structure.js`, ...passThroughArgs])
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

  case 'branch-map': {
    success = run('node', [`${SCRIPTS_DIR}/branch-map.js`, ...passThroughArgs])
    break
  }

  case 'audit': {
    const stacksForAudit = detectStacks()
    if (stacksForAudit.includes('python')) {
      success = run('python3', [`${SCRIPTS_DIR}/audit.py`, ...passThroughArgs])
    } else {
      success = run('node', [`${SCRIPTS_DIR}/audit.js`, ...passThroughArgs])
    }
    break
  }

  case 'analyze': {
    success = run('python3', [`${SCRIPTS_DIR}/analyze.py`, ...passThroughArgs])
    break
  }

  case 'diagnose': {
    success = run('node', [`${SCRIPTS_DIR}/diagnose.js`, ...passThroughArgs])
    break
  }

  case 'compare': {
    success = run('node', [`${SCRIPTS_DIR}/compare.js`, ...passThroughArgs])
    break
  }

  case 'mutate-audit': {
    success = run('python3', [`${SCRIPTS_DIR}/mutate_audit.py`, ...passThroughArgs])
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
  node scripts/regret.js init [--stack js|python|php|go]  Initialize regrets/ directory
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
  node scripts/regret.js chain [--capture|--validate]  Chain testing (multi-step flows, JS+Python+PHP)
  node scripts/regret.js truth [--outdir <dir>]        Save dual truth baselines (JS+Python)
  node scripts/regret.js scan [--dir src/] [--stack] [--decompose] [--manifest]   Scan project for cluster suggestions
  node scripts/regret.js scan --decompose <path>                    Detect god modules and suggest decomposition
  node scripts/regret.js coverage [--cluster <id>] [--suggest-inputs]  Branch coverage analysis
  node scripts/regret.js branch-map [--ts]             Generate branch-map.md with input suggestions
  node scripts/regret.js analyze [dir] [--json]        Deep structural analysis (god functions, duplicates, cross-module deps)
  node scripts/regret.js diagnose <file>                Diagnose module exports & recommend mode
  node scripts/regret.js compare --pre <dir> --post <dir>  Compare pre vs post truth baselines
  node scripts/regret.js audit [--strict]              Pre-refactor readiness audit
  node scripts/regret.js mutate-audit <path>            Detect functions that mutate input args
  node scripts/regret.js guard                         Pre-build gate
  node scripts/regret.js check [--cluster <id>]        Pre-flight manifest validation

Global flags:
  --skip-build        Skip preBuild step (use when project is already built)

Auto-detects stack from manifest.json and dispatches to the right handler:
  js/ts   → capture.js / validate.js
  python  → capture.py / validate.py / truth.py
  php     → capture_php.php / validate_php.php
  react   → capture_react.mjs / validate.js
  rust    → capture_rust.sh
  go      → capture_go.sh (Community Preview)
`)
    break
}

process.exit(success ? 0 : 1)

#!/usr/bin/env node
// setup.js — One-command onboarding for Regrets
// Orchestrates: scan → check → capture → validate → summary
//
// Usage:
//   node scripts/regret.js setup
//   node scripts/regret.js setup --stack js
//   node scripts/regret.js setup --stack python
//   node scripts/regret.js setup --stack ts
//
// If regrets/manifest.json already exists → skip scan, go straight to check.
// If scan finds no clusters → print guidance and exit.
// Each step prints ✅ or ❌ with reason.

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs'
import { resolve, dirname, join } from 'path'
import { fileURLToPath } from 'url'
import { execFileSync } from 'child_process'

const __dirname = dirname(fileURLToPath(import.meta.url))
const SCRIPTS_DIR = __dirname
const projectRoot = process.cwd()

// ─── CLI args ─────────────────────────────────────────────────────────────────

const args = process.argv.slice(2)
const stackArg = args.find(a => a.startsWith('--stack='))?.split('=')[1]
  ?? args[args.indexOf('--stack') + 1]
  ?? null
const skipBuild = args.includes('--skip-build')

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Run a command using execFileSync (no shell injection risk).
 * Captures stdout and returns it, while inheriting stderr for visibility.
 * @returns {{ ok: boolean, stdout: string }}
 */
function runCapture(cmd, cmdArgs) {
  const displayCmd = `${cmd} ${cmdArgs.join(' ')}`
  try {
    const stdout = execFileSync(cmd, cmdArgs, {
      cwd: projectRoot,
      encoding: 'utf8',
      stdio: ['inherit', 'pipe', 'inherit'],
    })
    return { ok: true, stdout }
  } catch (e) {
    return { ok: false, stdout: e.stdout ?? '' }
  }
}

/**
 * Run a command inheriting all stdio (visible in terminal).
 * @returns {boolean} true if exit code 0
 */
function runVisible(cmd, cmdArgs) {
  try {
    execFileSync(cmd, cmdArgs, { stdio: 'inherit', cwd: projectRoot })
    return true
  } catch {
    return false
  }
}

function stepStart(label) {
  console.log(`\n${'─'.repeat(60)}`)
  console.log(`⏳ Step ${label}`)
  console.log(`${'─'.repeat(60)}`)
}

function stepOk(msg) {
  console.log(`   ✅ ${msg}`)
}

function stepFail(msg) {
  console.log(`   ❌ ${msg}`)
}

// ─── Determine effective stack ────────────────────────────────────────────────

function detectStackFromProject() {
  // Check for common project markers
  if (existsSync(resolve(projectRoot, 'setup.py')) || existsSync(resolve(projectRoot, 'pyproject.toml'))) {
    return 'python'
  }
  if (existsSync(resolve(projectRoot, 'tsconfig.json'))) {
    return 'ts'
  }
  if (existsSync(resolve(projectRoot, 'package.json'))) {
    return 'js'
  }
  if (existsSync(resolve(projectRoot, 'go.mod'))) {
    return 'go'
  }
  if (existsSync(resolve(projectRoot, 'composer.json'))) {
    return 'php'
  }
  return null
}

function detectStackFromManifest() {
  const manifestPath = resolve(projectRoot, 'regrets/manifest.json')
  if (!existsSync(manifestPath)) return null
  try {
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
    const stacks = new Set()
    for (const cluster of manifest.clusters) {
      stacks.add(cluster.stack || 'js')
    }
    return [...stacks]
  } catch {
    return null
  }
}

// ─── MAIN ─────────────────────────────────────────────────────────────────────

const manifestPath = resolve(projectRoot, 'regrets/manifest.json')
const manifestExists = existsSync(manifestPath)

console.log('\n🚀 Regret Setup — One-command onboarding')
console.log(`   Project: ${projectRoot}`)

// Determine stack
const effectiveStack = stackArg ?? (manifestExists ? null : detectStackFromProject())
if (effectiveStack) {
  console.log(`   Stack: ${effectiveStack}`)
} else if (manifestExists) {
  const stacks = detectStackFromManifest()
  console.log(`   Stack: auto-detected from manifest (${(stacks ?? ['unknown']).join(', ')})`)
} else {
  console.log(`   Stack: auto-detect (no --stack flag, no manifest)`)
}

// ═══════════════════════════════════════════════════════════════════════════════
// STEP 1: Ensure manifest.json exists (scan if needed)
// ═══════════════════════════════════════════════════════════════════════════════

let clustersCount = 0

if (manifestExists) {
  stepStart('1/5: Manifest already exists — skipping scan')
  try {
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
    clustersCount = manifest.clusters?.length ?? 0
    stepOk(`manifest.json found with ${clustersCount} cluster(s)`)
  } catch (e) {
    stepFail(`manifest.json exists but is invalid JSON: ${e.message}`)
    console.log('\n   Fix regrets/manifest.json and re-run setup.')
    process.exit(1)
  }
} else {
  stepStart('1/5: No manifest — running scan to discover clusters')

  // Determine which scanner to use
  const scanStack = effectiveStack ?? 'js'
  let scanResult

  if (scanStack === 'python') {
    // Python scanner: scan.py
    const scanDir = existsSync(resolve(projectRoot, 'src')) ? 'src' : '.'
    scanResult = runCapture('python3', [`${SCRIPTS_DIR}/scan.py`, scanDir, '--recursive'])
  } else {
    // JS/TS scanner: scan.js --format manifest
    const scanArgs = [`${SCRIPTS_DIR}/scan.js`, '--format', 'manifest']
    if (scanStack) scanArgs.push('--stack', scanStack)
    if (existsSync(resolve(projectRoot, 'src'))) scanArgs.push('--dir', 'src')
    scanResult = runCapture('node', scanArgs)
  }

  // The scanner may exit 0 but print a human-readable message instead of JSON
  // when no source files are found. Handle both cases.
  const stdoutTrimmed = scanResult.stdout.trim()
  if (!stdoutTrimmed) {
    stepFail('Scan produced no output — no clusters found in this project')
    console.log('\n   No clusters found. Create regrets/manifest.json manually — see SKILL.md')
    process.exit(1)
  }

  // Parse the scan output as JSON manifest.
  // scan.js may print header lines before the JSON object, so extract the
  // first '{' onward.
  let scannedManifest
  try {
    const jsonStart = stdoutTrimmed.indexOf('{')
    if (jsonStart === -1) throw new Error('No JSON object found in scanner output')
    scannedManifest = JSON.parse(stdoutTrimmed.slice(jsonStart))
  } catch {
    // Scanner output was not JSON — likely a "no source files found" message
    stepFail('Scan found no clusters in this project')
    console.log(`\n   Scanner output: ${stdoutTrimmed.split('\n')[0]}`)
    console.log('\n   No clusters found. Create regrets/manifest.json manually — see SKILL.md')
    process.exit(1)
  }

  if (!scannedManifest.clusters || scannedManifest.clusters.length === 0) {
    stepFail('Scan found 0 clusters')
    console.log('\n   No clusters found. Create regrets/manifest.json manually — see SKILL.md')
    process.exit(1)
  }

  // Write the manifest
  clustersCount = scannedManifest.clusters.length

  // Ensure regrets/ directory exists
  const regretsDir = resolve(projectRoot, 'regrets')
  if (!existsSync(regretsDir)) {
    mkdirSync(regretsDir, { recursive: true })
  }

  writeFileSync(manifestPath, JSON.stringify(scannedManifest, null, 2) + '\n', 'utf8')
  stepOk(`Scan found ${clustersCount} cluster(s) — wrote regrets/manifest.json`)
}

// ═══════════════════════════════════════════════════════════════════════════════
// STEP 2: Run check (pre-flight validation)
// ═══════════════════════════════════════════════════════════════════════════════

stepStart('2/5: Pre-flight check')

const manifestStacks = detectStackFromManifest() ?? ['js']
const needsPythonCheck = manifestStacks.includes('python')
const checkCmd = needsPythonCheck ? 'python3' : 'node'
const checkScript = needsPythonCheck ? `${SCRIPTS_DIR}/check.py` : `${SCRIPTS_DIR}/check.js`

const checkOk = runVisible(checkCmd, [checkScript])

if (!checkOk) {
  stepFail('Pre-flight check failed')
  console.log('\n   Fix the errors above before continuing. Common issues:')
  console.log('   • Entry function not found in module — check "file" and "entry" in manifest')
  console.log('   • Module import fails — check "module" path or install dependencies')
  console.log('   • For TypeScript projects, run: npm run build')
  console.log('\n   After fixing, re-run: node scripts/regret.js setup')
  process.exit(1)
}

stepOk('All clusters pass pre-flight check')

// ═══════════════════════════════════════════════════════════════════════════════
// STEP 3: Run preBuild if defined in manifest
// ═══════════════════════════════════════════════════════════════════════════════

if (!skipBuild) {
  try {
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
    if (manifest.preBuild) {
      stepStart('3/5: Running preBuild')
      console.log(`   🔧 ${manifest.preBuild}`)
      try {
        const [cmd, ...cmdArgs] = manifest.preBuild.split(' ')
        execFileSync(cmd, cmdArgs, { stdio: 'inherit', cwd: projectRoot })
        stepOk('preBuild succeeded')
      } catch {
        stepFail('preBuild failed — stopping setup')
        process.exit(1)
      }
    } else {
      stepStart('3/5: No preBuild defined — skipping')
      stepOk('No preBuild step needed')
    }
  } catch {
    stepStart('3/5: Could not read manifest for preBuild — skipping')
    stepOk('Skipped')
  }
} else {
  stepStart('3/5: Skipping preBuild (--skip-build)')
  stepOk('Skipped')
}

// ═══════════════════════════════════════════════════════════════════════════════
// STEP 4: Run capture
// ═══════════════════════════════════════════════════════════════════════════════

stepStart('4/5: Capturing fingerprints')

let captureOk = true
for (const stack of manifestStacks) {
  if (stack === 'js' || stack === 'ts') {
    captureOk = runVisible('node', [`${SCRIPTS_DIR}/capture.js`]) && captureOk
  } else if (stack === 'python') {
    captureOk = runVisible('python3', [`${SCRIPTS_DIR}/capture.py`]) && captureOk
  } else if (stack === 'react') {
    captureOk = runVisible('node', [`${SCRIPTS_DIR}/capture_react.mjs`]) && captureOk
  } else if (stack === 'php') {
    captureOk = runVisible('php', [`${SCRIPTS_DIR}/capture_php.php`]) && captureOk
  } else if (stack === 'rust') {
    captureOk = runVisible('bash', [`${SCRIPTS_DIR}/capture_rust.sh`, 'capture']) && captureOk
  } else if (stack === 'go') {
    captureOk = runVisible('bash', [`${SCRIPTS_DIR}/capture_go.sh`, 'capture']) && captureOk
  }
}

if (!captureOk) {
  stepFail('Capture failed for one or more stacks')
  console.log('\n   Check the errors above. Common issues:')
  console.log('   • Missing dependencies — run npm install or pip install')
  console.log('   • Invalid inputs in manifest — check "inputs" for each cluster')
  console.log('   • Runtime errors in the target module')
  process.exit(1)
}

stepOk('Fingerprints captured successfully')

// ═══════════════════════════════════════════════════════════════════════════════
// STEP 5: Run validate
// ═══════════════════════════════════════════════════════════════════════════════

stepStart('5/5: Validating fingerprints')

let validateOk = true
for (const stack of manifestStacks) {
  if (stack === 'js' || stack === 'ts' || stack === 'react') {
    validateOk = runVisible('node', [`${SCRIPTS_DIR}/validate.js`]) && validateOk
  } else if (stack === 'python') {
    validateOk = runVisible('python3', [`${SCRIPTS_DIR}/validate.py`]) && validateOk
  } else if (stack === 'php') {
    validateOk = runVisible('php', [`${SCRIPTS_DIR}/validate_php.php`]) && validateOk
  } else if (stack === 'rust') {
    validateOk = runVisible('bash', [`${SCRIPTS_DIR}/capture_rust.sh`, 'validate']) && validateOk
  } else if (stack === 'go') {
    validateOk = runVisible('bash', [`${SCRIPTS_DIR}/capture_go.sh`, 'validate']) && validateOk
  }
}

if (!validateOk) {
  stepFail('Validation failed for one or more stacks')
  console.log('\n   This can happen if the code produces non-deterministic output.')
  console.log('   Add normalize rules to manifest.json or check for flaky tests.')
  console.log('   Run: node scripts/regret.js health   for details')
} else {
  stepOk('All clusters validate successfully')
}

// ═══════════════════════════════════════════════════════════════════════════════
// SUMMARY
// ═══════════════════════════════════════════════════════════════════════════════

console.log('\n')
console.log('═'.repeat(60))
console.log('  SETUP COMPLETE')
console.log('═'.repeat(60))
console.log(`  Clusters captured: ${clustersCount}`)
console.log(`  Validate result:   ${validateOk ? '✅ ALL PASS' : '❌ SOME FAIL'}`)
console.log()
console.log('  Next steps:')
console.log('    1. Review .regret files in regrets/ directory')
console.log('    2. Run: node scripts/regret.js health')
console.log('    3. Before refactoring, run: node scripts/regret.js validate')
console.log('    4. See SKILL.md and references/ for full documentation')
console.log()

if (!validateOk) {
  process.exit(1)
}

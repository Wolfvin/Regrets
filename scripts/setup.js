#!/usr/bin/env node
// setup.js — One-command onboarding for Regrets
// Orchestrates: scan → check → capture → validate → summary
//
// Usage:
//   node scripts/regret.js setup
//   node scripts/regret.js setup --stack js
//   node scripts/regret.js setup --stack python
//   node scripts/regret.js setup --stack ts
//   node scripts/regret.js setup --dry-run          (preview steps without executing)
//   node scripts/regret.js setup --skip-build       (skip preBuild step)
//
// If regrets/manifest.json already exists → skip scan, go straight to check.
// If scan finds no clusters → print guidance and exit.
// Each step prints ✅ or ❌ with reason.
// --dry-run previews what would be done without writing files or running capture/validate.

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
const dryRun = args.includes('--dry-run')

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Run a command using execFileSync (no shell injection risk).
 * Captures both stdout and stderr.
 * @returns {{ ok: boolean, stdout: string, stderr: string }}
 */
function runCapture(cmd, cmdArgs) {
  try {
    const stdout = execFileSync(cmd, cmdArgs, {
      cwd: projectRoot,
      encoding: 'utf8',
      stdio: ['inherit', 'pipe', 'pipe'],
    })
    return { ok: true, stdout, stderr: '' }
  } catch (e) {
    return { ok: false, stdout: e.stdout ?? '', stderr: e.stderr ?? '' }
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

function dryRunLabel() {
  return dryRun ? ' [DRY RUN]' : ''
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

/**
 * Count clusters with missing inputs in a manifest.
 * @returns {{ total: number, emptyInputs: string[] }}
 */
function checkEmptyInputs(manifest) {
  const emptyInputs = []
  for (const cluster of manifest.clusters || []) {
    if (!cluster.inputs || (Array.isArray(cluster.inputs) && cluster.inputs.length === 0)) {
      emptyInputs.push(cluster.id)
    }
  }
  return { total: manifest.clusters?.length ?? 0, emptyInputs }
}

// ─── MAIN ─────────────────────────────────────────────────────────────────────

const manifestPath = resolve(projectRoot, 'regrets/manifest.json')
const manifestExists = existsSync(manifestPath)

console.log(`\n🚀 Regret Setup — One-command onboarding${dryRunLabel()}`)
console.log(`   Project: ${projectRoot}`)

if (dryRun) {
  console.log('   Mode: DRY RUN — previewing steps, no files will be written')
}

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
let scannedManifest = null

if (manifestExists) {
  stepStart(`1/5: Manifest already exists — skipping scan${dryRunLabel()}`)
  try {
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
    clustersCount = manifest.clusters?.length ?? 0
    stepOk(`manifest.json found with ${clustersCount} cluster(s)`)

    // Check for empty inputs even in existing manifests
    const { emptyInputs } = checkEmptyInputs(manifest)
    if (emptyInputs.length > 0) {
      console.log(`\n   ⚠️  ${emptyInputs.length} cluster(s) have no inputs: ${emptyInputs.join(', ')}`)
      console.log('   Capture will fail for clusters that require function arguments.')
      console.log('   Edit regrets/manifest.json to add "inputs" for each cluster before proceeding.')
    }
  } catch (e) {
    stepFail(`manifest.json exists but is invalid JSON: ${e.message}`)
    console.log('\n   Action: Fix the JSON syntax in regrets/manifest.json and re-run setup.')
    console.log('   Tip: Validate your JSON at jsonlint.com or run: node -e "JSON.parse(require(\'fs\').readFileSync(\'regrets/manifest.json\'))"')
    process.exit(1)
  }
} else {
  stepStart(`1/5: No manifest — running scan to discover clusters${dryRunLabel()}`)

  // Determine which scanner to use
  const scanStack = effectiveStack ?? 'js'

  if (dryRun) {
    // In dry-run mode, show what scan would do without executing
    if (scanStack === 'python') {
      const scanDir = existsSync(resolve(projectRoot, 'src')) ? 'src' : '.'
      console.log(`   Would run: python3 ${SCRIPTS_DIR}/scan.py ${scanDir} --recursive --manifest`)
    } else {
      const scanArgs = [`${SCRIPTS_DIR}/scan.js`, '--format', 'manifest']
      if (scanStack) scanArgs.push('--stack', scanStack)
      if (existsSync(resolve(projectRoot, 'src'))) scanArgs.push('--dir', 'src')
      console.log(`   Would run: node ${scanArgs.join(' ')}`)
    }
    console.log('   Would create: regrets/manifest.json')
    console.log('   Cannot preview clusters without running scan. Remove --dry-run to execute.')
    stepOk('Scan step previewed (dry-run)')

    // In dry-run, we cannot proceed without a manifest, so show remaining steps and exit
    console.log('\n   Remaining steps (not executed in dry-run):')
    console.log('     2/5: Pre-flight check (validate manifest structure + exports)')
    console.log('     3/5: Run preBuild if defined in manifest')
    console.log('     4/5: Capture fingerprints for all clusters')
    console.log('     5/5: Validate fingerprints against golden baselines')
    console.log('\n   Remove --dry-run to execute all steps.')
    process.exit(0)
  }

  let scanResult

  if (scanStack === 'python') {
    // Python scanner: scan.py --manifest (outputs JSON manifest format)
    const scanDir = existsSync(resolve(projectRoot, 'src')) ? 'src' : '.'
    scanResult = runCapture('python3', [`${SCRIPTS_DIR}/scan.py`, scanDir, '--recursive', '--manifest'])
  } else {
    // JS/TS scanner: scan.js --format manifest
    const scanArgs = [`${SCRIPTS_DIR}/scan.js`, '--format', 'manifest']
    if (scanStack) scanArgs.push('--stack', scanStack)
    if (existsSync(resolve(projectRoot, 'src'))) scanArgs.push('--dir', 'src')
    scanResult = runCapture('node', scanArgs)
  }

  // If scanner crashed (non-zero exit), show stderr for diagnosis
  if (!scanResult.ok && scanResult.stderr.trim()) {
    stepFail('Scanner exited with an error')
    const stderrLines = scanResult.stderr.trim().split('\n')
    // Show the most relevant error line (last line is usually the actual error)
    const errorLine = stderrLines[stderrLines.length - 1]
    console.log(`\n   Scanner error: ${errorLine}`)
    if (stderrLines.length > 1) {
      console.log('   Full error output:')
      for (const line of stderrLines.slice(-5)) {
        console.log(`     ${line}`)
      }
    }
    if (scanStack === 'python') {
      console.log('\n   Action: The Python scanner (scan.py) encountered an internal error.')
      console.log('   This may be a bug in scan.py. Try using the JS scanner instead:')
      console.log('     node scripts/regret.js setup --stack js')
      console.log('   Or create regrets/manifest.json manually — see SKILL.md for the format.')
    } else {
      console.log('\n   Action: Check that your source files export functions correctly.')
      console.log('   Make sure your entry file uses named exports (export function ...) or default exports.')
      console.log('   If using TypeScript, run "npm run build" first, then re-run setup.')
    }
    process.exit(1)
  }

  // The scanner may exit 0 but print a human-readable message instead of JSON
  // when no source files are found. Handle both cases.
  const stdoutTrimmed = scanResult.stdout.trim()
  if (!stdoutTrimmed) {
    stepFail('Scan produced no output — no clusters found in this project')
    console.log('\n   Action: No exported functions were found in your source files.')
    if (scanStack === 'js' || scanStack === 'ts') {
      console.log('   Make sure your source files export functions using:')
      console.log('     • ESM: export function myFunc() { ... }')
      console.log('     • CJS: module.exports = { myFunc }')
      console.log('     • TypeScript: export function myFunc() { ... } (then run npm run build)')
    } else if (scanStack === 'python') {
      console.log('   Make sure your Python files contain top-level functions (def my_func(): ...)')
      console.log('   Avoid wrapping all logic in if __name__ == "__main__" blocks.')
    }
    console.log('\n   Alternatively, create regrets/manifest.json manually — see SKILL.md for the format.')
    process.exit(1)
  }

  // Parse the scan output as JSON manifest.
  // scan.js may print header lines before the JSON object, so extract the
  // first '{' onward.
  try {
    const jsonStart = stdoutTrimmed.indexOf('{')
    if (jsonStart === -1) throw new Error('No JSON object found in scanner output')
    scannedManifest = JSON.parse(stdoutTrimmed.slice(jsonStart))
  } catch {
    // Scanner output was not JSON — likely a "no source files found" message
    stepFail('Scan found no clusters in this project')
    console.log(`\n   Scanner output: ${stdoutTrimmed.split('\n')[0]}`)
    console.log('\n   Action: No exported functions were found. Make sure your source files export functions.')
    console.log('   For JS: use "export function name() { ... }"')
    console.log('   For Python: use top-level "def name():" functions')
    console.log('   Alternatively, create regrets/manifest.json manually — see SKILL.md for the format.')
    process.exit(1)
  }

  if (!scannedManifest.clusters || scannedManifest.clusters.length === 0) {
    stepFail('Scan found 0 clusters')
    console.log('\n   Action: No exported functions were found in your source files.')
    console.log('   Make sure your entry file exports functions that can be scanned.')
    console.log('   If using TypeScript, run "npm run build" first, then re-run setup.')
    console.log('   Alternatively, create regrets/manifest.json manually — see SKILL.md for the format.')
    process.exit(1)
  }

  // Check if scanned clusters have empty inputs — warn before writing
  const { emptyInputs } = checkEmptyInputs(scannedManifest)
  if (emptyInputs.length > 0) {
    console.log(`\n   ⚠️  All ${emptyInputs.length} cluster(s) were auto-discovered without sample inputs.`)
    console.log('   This is normal — scan cannot infer what inputs your functions expect.')
    console.log('   You MUST add "inputs" to each cluster in regrets/manifest.json before capture can succeed.')
    console.log('   Example: "inputs": ["hello", "world"]  for a function that takes one string argument')
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

  // If all clusters have empty inputs, stop and tell user to edit manifest
  if (emptyInputs.length === clustersCount) {
    stepFail('All clusters have empty inputs — capture will fail')
    console.log('\n   ┌──────────────────────────────────────────────────────────────────┐')
    console.log('   │  ACTION REQUIRED: Edit regrets/manifest.json                    │')
    console.log('   │                                                                  │')
    console.log('   │  The auto-generated manifest has no sample inputs.              │')
    console.log('   │  Capture needs inputs to call your functions.                   │')
    console.log('   │                                                                  │')
    console.log('   │  For each cluster, add an "inputs" array, e.g.:                 │')
    console.log('   │    "inputs": ["hello", "world"]   ← single-arg function          │')
    console.log('   │    "inputs": [["a", "b"]]         ← multi-arg (multiArgs:true)  │')
    console.log('   │                                                                  │')
    console.log('   │  Then re-run: node scripts/regret.js setup                      │')
    console.log('   └──────────────────────────────────────────────────────────────────┘')
    process.exit(1)
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// STEP 2: Run check (pre-flight validation)
// ═══════════════════════════════════════════════════════════════════════════════

stepStart(`2/5: Pre-flight check${dryRunLabel()}`)

if (dryRun) {
  console.log('   Would validate manifest structure and verify all entry functions exist')
  stepOk('Pre-flight check previewed (dry-run)')
} else {
  const manifestStacks = detectStackFromManifest() ?? ['js']

  // Run check for each stack type in the manifest
  let allCheckOk = true
  for (const stack of manifestStacks) {
    const checkCmd = stack === 'python' ? 'python3' : 'node'
    const checkScript = stack === 'python' ? `${SCRIPTS_DIR}/check.py` : `${SCRIPTS_DIR}/check.js`
    const checkOk = runVisible(checkCmd, [checkScript])
    if (!checkOk) allCheckOk = false
  }

  if (!allCheckOk) {
    stepFail('Pre-flight check failed')
    console.log('\n   Action: Fix the errors above before continuing. Common issues:')
    console.log('   • Entry function not found in module — check "file" and "entry" in manifest')
    console.log('     Make sure the function name matches the export exactly (case-sensitive)')
    console.log('   • Module import fails — check "module" path or install dependencies')
    console.log('     Run: npm install  or  pip install -r requirements.txt')
    console.log('   • For TypeScript projects, compile first: npm run build')
    console.log('     Then make sure "file" points to the compiled .js output, not the .ts source')
    console.log('\n   After fixing, re-run: node scripts/regret.js setup')
    process.exit(1)
  }

  stepOk('All clusters pass pre-flight check')
}

// ═══════════════════════════════════════════════════════════════════════════════
// STEP 3: Run preBuild if defined in manifest
// ═══════════════════════════════════════════════════════════════════════════════

if (!skipBuild) {
  try {
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
    if (manifest.preBuild) {
      stepStart(`3/5: Running preBuild${dryRunLabel()}`)
      if (dryRun) {
        console.log(`   Would run: ${manifest.preBuild}`)
        stepOk('preBuild previewed (dry-run)')
      } else {
        console.log(`   🔧 ${manifest.preBuild}`)
        try {
          const [cmd, ...cmdArgs] = manifest.preBuild.split(' ')
          execFileSync(cmd, cmdArgs, { stdio: 'inherit', cwd: projectRoot })
          stepOk('preBuild succeeded')
        } catch (e) {
          stepFail('preBuild failed — stopping setup')
          console.log(`\n   Action: The preBuild command "${manifest.preBuild}" failed.`)
          console.log('   Common causes:')
          console.log('   • Missing dependencies — run npm install or pip install first')
          console.log('   • Build script has errors — run the build command manually to diagnose')
          console.log('   • Incorrect preBuild command in manifest — check the syntax')
          console.log('\n   To skip preBuild: node scripts/regret.js setup --skip-build')
          process.exit(1)
        }
      }
    } else {
      stepStart(`3/5: No preBuild defined — skipping${dryRunLabel()}`)
      stepOk('No preBuild step needed')
    }
  } catch {
    stepStart(`3/5: Could not read manifest for preBuild — skipping${dryRunLabel()}`)
    stepOk('Skipped')
  }
} else {
  stepStart(`3/5: Skipping preBuild (--skip-build)${dryRunLabel()}`)
  stepOk('Skipped')
}

// ═══════════════════════════════════════════════════════════════════════════════
// STEP 4: Run capture
// ═══════════════════════════════════════════════════════════════════════════════

stepStart(`4/5: Capturing fingerprints${dryRunLabel()}`)

if (dryRun) {
  const manifestStacks = detectStackFromManifest() ?? ['js']
  for (const stack of manifestStacks) {
    if (stack === 'js' || stack === 'ts') {
      console.log('   Would run: node scripts/capture.js')
    } else if (stack === 'python') {
      console.log('   Would run: python3 scripts/capture.py')
    } else if (stack === 'react') {
      console.log('   Would run: node scripts/capture_react.mjs')
    } else if (stack === 'php') {
      console.log('   Would run: php scripts/capture_php.php')
    } else if (stack === 'ruby') {
      console.log('   Would run: ruby scripts/capture_ruby.rb')
    } else if (stack === 'csharp') {
      console.log('   Would run: bash scripts/capture_csharp.sh')
    } else if (stack === 'rust') {
      console.log('   Would run: bash scripts/capture_rust.sh capture')
    } else if (stack === 'go') {
      console.log('   Would run: bash scripts/capture_go.sh capture')
    }
  }
  console.log('   Would create: regrets/<cluster-id>.regret files')
  stepOk('Capture step previewed (dry-run)')
} else {
  const manifestStacks = detectStackFromManifest() ?? ['js']

  // Before capture, check if any clusters have empty inputs
  try {
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
    const { emptyInputs } = checkEmptyInputs(manifest)
    if (emptyInputs.length > 0) {
      console.log(`\n   ⚠️  ${emptyInputs.length} cluster(s) have no inputs: ${emptyInputs.join(', ')}`)
      console.log('   These clusters will likely fail during capture if their functions require arguments.')
      console.log('   Consider adding "inputs" to regrets/manifest.json for these clusters.')
      console.log('   Continuing anyway — clusters with empty inputs may still work if their functions take no args.\n')
    }
  } catch { /* ignore */ }

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
    } else if (stack === 'ruby') {
      captureOk = runVisible('ruby', [`${SCRIPTS_DIR}/capture_ruby.rb`]) && captureOk
    } else if (stack === 'csharp') {
      captureOk = runVisible('bash', [`${SCRIPTS_DIR}/capture_csharp.sh`, 'capture']) && captureOk
    } else if (stack === 'rust') {
      captureOk = runVisible('bash', [`${SCRIPTS_DIR}/capture_rust.sh`, 'capture']) && captureOk
    } else if (stack === 'go') {
      captureOk = runVisible('bash', [`${SCRIPTS_DIR}/capture_go.sh`, 'capture']) && captureOk
    }
  }

  if (!captureOk) {
    stepFail('Capture failed for one or more stacks')
    console.log('\n   Action: Check the errors above. Common issues:')
    console.log('   • Missing sample inputs — scan generates clusters without "inputs"')
    console.log('     Edit regrets/manifest.json and add "inputs" for each cluster, e.g.:')
    console.log('       "inputs": ["hello", "world"]  for a function taking one string arg')
    console.log('       "inputs": [["a", 1], ["b", 2]] with "multiArgs": true  for multi-arg functions')
    console.log('   • Missing dependencies — run npm install or pip install')
    console.log('   • Runtime errors in the target module — test your function manually')
    console.log('     node -e "import(\'./src/myModule.js\').then(m => console.log(m.myFunc(\'test\')))"')
    console.log('\n   After fixing, re-run: node scripts/regret.js setup')
    process.exit(1)
  }

  stepOk('Fingerprints captured successfully')
}

// ═══════════════════════════════════════════════════════════════════════════════
// STEP 5: Run validate
// ═══════════════════════════════════════════════════════════════════════════════

stepStart(`5/5: Validating fingerprints${dryRunLabel()}`)

let validateOk = true

if (dryRun) {
  const manifestStacks = detectStackFromManifest() ?? ['js']
  for (const stack of manifestStacks) {
    if (stack === 'js' || stack === 'ts' || stack === 'react') {
      console.log('   Would run: node scripts/validate.js')
    } else if (stack === 'python') {
      console.log('   Would run: python3 scripts/validate.py')
    } else if (stack === 'php') {
      console.log('   Would run: php scripts/validate_php.php')
    } else if (stack === 'ruby') {
      console.log('   Would run: ruby scripts/validate_ruby.rb')
    } else if (stack === 'csharp') {
      console.log('   Would run: bash scripts/validate_csharp.sh')
    } else if (stack === 'rust') {
      console.log('   Would run: bash scripts/capture_rust.sh validate')
    } else if (stack === 'go') {
      console.log('   Would run: bash scripts/capture_go.sh validate')
    }
  }
  console.log('   Would validate all .regret files against fresh captures')
  stepOk('Validate step previewed (dry-run)')
} else {
  const manifestStacks = detectStackFromManifest() ?? ['js']

  for (const stack of manifestStacks) {
    if (stack === 'js' || stack === 'ts' || stack === 'react') {
      validateOk = runVisible('node', [`${SCRIPTS_DIR}/validate.js`]) && validateOk
    } else if (stack === 'python') {
      validateOk = runVisible('python3', [`${SCRIPTS_DIR}/validate.py`]) && validateOk
    } else if (stack === 'php') {
      validateOk = runVisible('php', [`${SCRIPTS_DIR}/validate_php.php`]) && validateOk
    } else if (stack === 'ruby') {
      validateOk = runVisible('ruby', [`${SCRIPTS_DIR}/validate_ruby.rb`]) && validateOk
    } else if (stack === 'csharp') {
      validateOk = runVisible('bash', [`${SCRIPTS_DIR}/validate_csharp.sh`]) && validateOk
    } else if (stack === 'rust') {
      validateOk = runVisible('bash', [`${SCRIPTS_DIR}/capture_rust.sh`, 'validate']) && validateOk
    } else if (stack === 'go') {
      validateOk = runVisible('bash', [`${SCRIPTS_DIR}/capture_go.sh`, 'validate']) && validateOk
    }
  }

  if (!validateOk) {
    stepFail('Validation failed for one or more stacks')
    console.log('\n   Action: Some clusters produce non-deterministic output.')
    console.log('   To fix:')
    console.log('   • Add "normalize" rules in manifest.json to strip volatile fields (timestamps, IDs)')
    console.log('   • Check for flaky tests or external API calls that vary between runs')
    console.log('   • Run: node scripts/regret.js health  for a detailed fragility report')
  } else {
    stepOk('All clusters validate successfully')
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// SUMMARY
// ═══════════════════════════════════════════════════════════════════════════════

console.log('\n')
console.log('═'.repeat(60))
if (dryRun) {
  console.log('  SETUP DRY RUN COMPLETE')
  console.log('═'.repeat(60))
  console.log('  No files were written or modified.')
  console.log('  Remove --dry-run to execute all steps.')
} else {
  console.log('  SETUP COMPLETE')
  console.log('═'.repeat(60))
  console.log(`  Clusters captured: ${clustersCount}`)
  console.log(`  Validate result:   ${validateOk ? '✅ ALL PASS' : '❌ SOME FAIL'}`)
  console.log()
  console.log('  Next steps:')
  console.log('    1. Review regrets/manifest.json — verify cluster definitions are correct')
  console.log('       Check "inputs" for each cluster: they must match function signatures')
  console.log('       Check "entry" names: they must match exported function names (case-sensitive)')
  console.log('    2. Review .regret files in regrets/ directory')
  console.log('    3. Run: node scripts/regret.js health   (fragility report)')
  console.log('    4. Before refactoring, run: node scripts/regret.js validate')
  console.log('    5. See SKILL.md and references/ for full documentation')
}
console.log()

if (!dryRun && !validateOk) {
  process.exit(1)
}

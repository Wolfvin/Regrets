#!/usr/bin/env node
// watch.js — file watcher for regret-based regression testing
// Watches source files and auto-runs `regret validate` on change.
//
// Usage:
//   node scripts/watch.js [--dir src/] [--stack js|python]
//
// Features:
//   - Debounces file changes (300ms) before triggering validate
//   - Ignores changes inside regrets/ directory
//   - Detects stack from manifest.json to dispatch to correct validate handler
//   - Clear output: file changed → re-validating → PASS/FAIL summary
//   - Ctrl+C to stop

import { readFileSync } from 'fs'
import { resolve, relative } from 'path'
import { execFileSync } from 'child_process'

// ─── CLI args ─────────────────────────────────────────────────────────────────

const args = process.argv.slice(2)

function getArg(flag) {
  const i = args.indexOf(flag)
  return i !== -1 ? args[i + 1] ?? null : null
}

const watchDir = getArg('--dir') || 'src'
const stackOverride = getArg('--stack')

// ─── Constants ────────────────────────────────────────────────────────────────

const DEBOUNCE_MS = 300

// ─── Chokidar import with helpful fallback ────────────────────────────────────

let chokidar
try {
  chokidar = await import('chokidar')
} catch {
  console.error(`
❌ chokidar is not installed.

   Install it with:
     npm install chokidar

   Then re-run:
     node scripts/regret.js watch${watchDir !== 'src' ? ` --dir ${watchDir}` : ''}
`)
  process.exit(1)
}

// ─── Detect stacks from manifest ──────────────────────────────────────────────

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

// ─── Run validate and capture JSON result ─────────────────────────────────────

function runValidate() {
  const stacks = stackOverride ? [stackOverride] : detectStacks()
  const scriptsDir = resolve(import.meta.dirname)

  let totalPassed = 0
  let totalFailed = 0
  const failedClusters = []

  for (const stack of stacks) {
    let cmd, cmdArgs

    if (stack === 'python') {
      cmd = 'python3'
      cmdArgs = [`${scriptsDir}/validate.py`, '--json']
    } else if (stack === 'php') {
      cmd = 'php'
      cmdArgs = [`${scriptsDir}/validate_php.php`, '--json']
    } else if (stack === 'go') {
      cmd = 'bash'
      cmdArgs = [`${scriptsDir}/capture_go.sh`, 'validate']
    } else if (stack === 'rust') {
      cmd = 'bash'
      cmdArgs = [`${scriptsDir}/capture_rust.sh`, 'validate']
    } else {
      // js, ts, react — all use validate.js
      cmd = 'node'
      cmdArgs = [`${scriptsDir}/validate.js`, '--json']
    }

    try {
      const stdout = execFileSync(cmd, cmdArgs, {
        cwd: process.cwd(),
        encoding: 'utf8',
        stdio: ['pipe', 'pipe', 'pipe']
      })

      // Parse JSON output from validate
      try {
        const result = JSON.parse(stdout.trim())
        totalPassed += result.passed || 0
        totalFailed += result.failed || 0
        if (result.clusters) {
          for (const c of result.clusters) {
            if (!c.pass) failedClusters.push(c.id)
          }
        }
      } catch {
        // Non-JSON output (e.g. Go/Rust bash scripts) — count as passed if exit 0
        totalPassed++
      }
    } catch (err) {
      // Validate exited non-zero — try to parse JSON from stdout
      const stdout = err.stdout || ''
      try {
        const result = JSON.parse(stdout.trim())
        totalPassed += result.passed || 0
        totalFailed += result.failed || 0
        if (result.clusters) {
          for (const c of result.clusters) {
            if (!c.pass) failedClusters.push(c.id)
          }
        }
      } catch {
        // Could not parse — report as a failure
        totalFailed++
        failedClusters.push('(parse error)')
      }
    }
  }

  return { totalPassed, totalFailed, failedClusters }
}

// ─── Debounce implementation ──────────────────────────────────────────────────
//
// When multiple file changes fire in quick succession (e.g. saving a file in an
// editor that writes temp files, or a build tool touching many files), we don't
// want to trigger validate for each one. Instead:
//
// 1. On first file change, start a 300ms timer
// 2. If another change arrives before the timer fires, reset the timer
// 3. When the timer finally fires (300ms after the LAST change), run validate
//
// This ensures we only validate once per "batch" of changes, and only after
// the changes have settled.

let debounceTimer = null
let pendingFiles = []
let validating = false

function triggerValidation(changedFile) {
  // Collect all changed files during debounce window
  if (!pendingFiles.includes(changedFile)) {
    pendingFiles.push(changedFile)
  }

  // Reset debounce timer — only fires 300ms after the LAST change
  if (debounceTimer) clearTimeout(debounceTimer)

  debounceTimer = setTimeout(() => {
    debounceTimer = null

    // Don't run if a validation is already in progress
    if (validating) return

    validating = true
    const files = pendingFiles.slice()
    pendingFiles = []

    // Print what changed
    const fileList = files.length === 1
      ? files[0]
      : `${files.length} files`
    console.log(`\n${'─'.repeat(60)}`)
    console.log(`📁 File changed: ${fileList} → re-validating...`)
    console.log(`${'─'.repeat(60)}`)

    // Run validate
    const startTime = Date.now()
    const { totalPassed, totalFailed, failedClusters } = runValidate()
    const elapsed = Date.now() - startTime

    // Print summary
    if (totalFailed === 0) {
      console.log(`\n✅ All green (${totalPassed} cluster${totalPassed !== 1 ? 's' : ''}) — ${elapsed}ms`)
    } else {
      console.log(`\n❌ ${totalFailed} cluster${totalFailed !== 1 ? 's' : ''} failed:`)
      for (const id of failedClusters) {
        console.log(`   • ${id}`)
      }
      console.log(`   (${totalPassed} passed, ${totalFailed} failed — ${elapsed}ms)`)
    }

    console.log(`\n👁️  Watching for changes... (Ctrl+C to stop)`)
    validating = false

    // If files changed during validation, trigger again
    if (pendingFiles.length > 0) {
      triggerValidation(pendingFiles[0])
    }
  }, DEBOUNCE_MS)
}

// ─── Set up chokidar watcher ──────────────────────────────────────────────────

const cwd = process.cwd()
const watchPath = resolve(cwd, watchDir)
const regretsDir = resolve(cwd, 'regrets')

console.log(`👁️  Regret Watch — starting...`)
console.log(`   Watching : ${watchDir}/`)
console.log(`   Ignoring : regrets/`)
console.log(`   Debounce : ${DEBOUNCE_MS}ms`)
console.log(`   Stack(s) : ${(stackOverride ? [stackOverride] : detectStacks()).join(', ')}`)
console.log(`${'─'.repeat(60)}`)

const watcher = chokidar.watch(watchPath, {
  ignored: [
    regretsDir,
    /(^|[/\\])regrets[/\\]/,       // any regrets/ dir anywhere
    /(^|[/\\])node_modules[/\\]/,  // node_modules
    /(^|[/\\])\.git[/\\]/,         // .git
    /\.\w*\.sw[a-z]$/,             // vim swap files
    /~$/,                          // editor backups
    /\.tmp$/                       // temp files
  ],
  persistent: true,
  ignoreInitial: true,             // don't trigger on initial scan
  awaitWriteFinish: {
    stabilityThreshold: 50,        // wait 50ms for write to finish
    pollInterval: 10
  }
})

watcher.on('change', (filePath) => {
  const relPath = relative(cwd, filePath)

  // Double-check: skip anything inside regrets/
  if (relPath.startsWith('regrets/') || relPath.startsWith('regrets\\')) {
    return
  }

  triggerValidation(relPath)
})

watcher.on('add', (filePath) => {
  const relPath = relative(cwd, filePath)
  if (relPath.startsWith('regrets/') || relPath.startsWith('regrets\\')) {
    return
  }
  triggerValidation(relPath)
})

watcher.on('ready', () => {
  console.log(`\n✨ Initial scan complete. Waiting for changes...`)
  console.log(`👁️  Watching for changes... (Ctrl+C to stop)`)
})

watcher.on('error', (error) => {
  console.error(`\n❌ Watcher error: ${error.message}`)
})

// ─── Graceful shutdown ────────────────────────────────────────────────────────

function shutdown() {
  console.log('\n\n👋 Regret Watch stopped.')
  if (debounceTimer) clearTimeout(debounceTimer)
  watcher.close()
  process.exit(0)
}

process.on('SIGINT', shutdown)   // Ctrl+C
process.on('SIGTERM', shutdown)  // kill signal

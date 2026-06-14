#!/usr/bin/env node
// risk.js — pre-refactor risk signal
// Reads a git diff, identifies modified functions, cross-references with
// cluster watches in manifest.json, and reports risk levels.
//
// Usage:
//   node scripts/risk.js                           diff from staged changes (git diff --staged)
//   node scripts/risk.js --since HEAD~1            diff from a commit range
//   node scripts/risk.js --diff patch.txt          diff from a unified diff file
//   node scripts/risk.js --json                    machine-readable output
//   node scripts/risk.js --since HEAD~1 --json     combined flags

import { readFileSync, existsSync } from 'fs'
import { resolve } from 'path'
import { execSync } from 'child_process'

// ─── CLI args ─────────────────────────────────────────────────────────────────

const args = process.argv.slice(2)
const jsonOutput = args.includes('--json')

// ─── Manifest loading ─────────────────────────────────────────────────────────

function loadManifest() {
  // Check regrets/manifest.json first (standard location), then manifest.json in cwd (proof/ layout)
  const standardPath = resolve(process.cwd(), 'regrets/manifest.json')
  const fallbackPath = resolve(process.cwd(), 'manifest.json')
  const manifestPath = existsSync(standardPath) ? standardPath : existsSync(fallbackPath) ? fallbackPath : null
  if (!manifestPath) {
    console.error('❌ regrets/manifest.json not found. Run regret init first.')
    process.exit(1)
  }
  return JSON.parse(readFileSync(manifestPath, 'utf8'))
}

// ─── Git diff acquisition ─────────────────────────────────────────────────────

function getDiffFromArgs(cliArgs) {
  // --diff <file>: read unified diff from file
  const diffIdx = cliArgs.indexOf('--diff')
  if (diffIdx !== -1) {
    const diffFile = cliArgs[diffIdx + 1]
    if (!diffFile) {
      console.error('❌ --diff requires a file path argument')
      process.exit(1)
    }
    const diffPath = resolve(process.cwd(), diffFile)
    if (!existsSync(diffPath)) {
      console.error(`❌ Diff file not found: ${diffPath}`)
      process.exit(1)
    }
    return readFileSync(diffPath, 'utf8')
  }

  // --since <ref>: git diff from a commit range
  const sinceIdx = cliArgs.indexOf('--since')
  if (sinceIdx !== -1) {
    const sinceRef = cliArgs[sinceIdx + 1]
    if (!sinceRef) {
      console.error('❌ --since requires a git ref argument (e.g., HEAD~1)')
      process.exit(1)
    }
    try {
      return execSync(`git diff ${sinceRef}`, { encoding: 'utf8', cwd: process.cwd() })
    } catch (err) {
      console.error(`❌ Failed to run git diff ${sinceRef}: ${err.message}`)
      process.exit(1)
    }
  }

  // Default: staged changes
  try {
    return execSync('git diff --staged', { encoding: 'utf8', cwd: process.cwd() })
  } catch (err) {
    console.error(`❌ Failed to run git diff --staged: ${err.message}`)
    process.exit(1)
  }
}

// ─── JS/TS function name detection patterns ───────────────────────────────────

const FUNC_PATTERNS = [
  // function declaration: function name(
  /^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s+\*?\s*(\w+)\s*\(/,
  // const/let/var name = (...) => or function(...)
  /^\s*(?:export\s+)?(?:const|let|var)\s+(\w+)\s*=\s*(?:async\s+)?(?:\([^)]*\)|[\w]+)\s*=>/,
  /^\s*(?:export\s+)?(?:const|let|var)\s+(\w+)\s*=\s*(?:async\s+)?function/,
  // method definition: name(...) {  (with optional async/static/get/set/*/prefix)
  /^\s+(?:(?:async|static|get|set|public|private|protected|readonly|abstract|override)\s+)*\*?\s*(\w+)\s*\([^)]*\)\s*(?:\{|:)/,
  // arrow function as object property: name: (...) =>
  /^\s+(\w+)\s*:\s*(?:async\s+)?(?:\([^)]*\)|[\w]+)\s*=>/,
]

// Keywords that look like method names but aren't function declarations
const JS_KEYWORDS = new Set([
  'if', 'else', 'for', 'while', 'switch', 'try', 'catch', 'finally',
  'return', 'throw', 'new', 'class', 'extends', 'import', 'export',
  'default', 'from', 'typeof', 'instanceof', 'void', 'delete', 'in',
  'of', 'do', 'break', 'continue', 'case', 'with', 'yield', 'super',
  'this', 'true', 'false', 'null', 'undefined', 'console',
])

/**
 * Try to extract a function name from a line of JS/TS code.
 * Returns the function name or null.
 */
function extractFuncName(line) {
  for (const pattern of FUNC_PATTERNS) {
    const m = line.match(pattern)
    if (m && !JS_KEYWORDS.has(m[1])) {
      return m[1]
    }
  }
  return null
}

// ─── Unified diff parser ──────────────────────────────────────────────────────

/**
 * Parse a unified diff and identify which functions were modified.
 *
 * Strategy:
 *   Walk through diff line-by-line, maintaining a stack of enclosing function
 *   names. Context lines (unchanged, starting with ' ') and hunk headers
 *   provide structural context. When we encounter a changed line (+/-), we
 *   attribute it to the current enclosing function.
 *
 * Returns: Array<{ file: string, functions: Set<string> }>
 */
function parseDiff(diffText) {
  const files = []
  let currentFile = null
  let currentFunctions = new Set()
  // Stack of enclosing function names in current hunk
  // Each entry is a function name; we push when entering and pop when we
  // see a closing brace that takes us back out. For simplicity we track
  // the last-seen function name as "current enclosing function".
  let enclosingFunc = null

  const lines = diffText.split('\n')

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]

    // File marker: +++ b/path/to/file.js
    const fileMatch = line.match(/^\+\+\+ b\/(.+)$/)
    if (fileMatch) {
      if (currentFile && currentFunctions.size > 0) {
        files.push({ file: currentFile, functions: currentFunctions })
      }
      currentFile = fileMatch[1]
      currentFunctions = new Set()
      enclosingFunc = null
      continue
    }

    // Skip --- a/ lines (old file)
    if (line.startsWith('--- a/')) continue

    // Hunk header: @@ -a,b +c,d @@ context
    const hunkMatch = line.match(/^@@\s+-\d+(?:,\d+)?\s+\d+(?:,\d+)?\s+@@\s*(.*)$/)
    if (hunkMatch) {
      enclosingFunc = null
      const context = hunkMatch[1].trim()
      if (context) {
        // Git shows function context like "@@ ... @@ function myFunc" or "@@ ... @@ className.methodName"
        const funcName = extractFuncName(context)
        if (funcName) {
          enclosingFunc = funcName
        } else {
          // Try to parse "functionName" or "className.functionName" from context
          const simpleMatch = context.match(/^(\w+)(?:\.\w+)?$/)
          if (simpleMatch && !JS_KEYWORDS.has(simpleMatch[1])) {
            enclosingFunc = simpleMatch[1]
          }
        }
      }
      continue
    }

    if (!currentFile) continue
    // Only process JS/TS files
    if (!/\.[mc]?[jt]sx?$/.test(currentFile)) continue

    // Context line (unchanged): ' ' prefix — may reveal enclosing function
    if (line.startsWith(' ') && line.length > 1) {
      const content = line.slice(1)
      const funcName = extractFuncName(content)
      if (funcName) {
        enclosingFunc = funcName
      }
      // Detect closing brace that exits a function (simple heuristic)
      if (/^\s*\}\s*$/.test(content)) {
        enclosingFunc = null
      }
      continue
    }

    // Changed line: '+' or '-'
    if ((line.startsWith('+') || line.startsWith('-')) && line.length > 1) {
      const content = line.slice(1)

      // Check if the changed line itself declares a function
      const funcName = extractFuncName(content)
      if (funcName) {
        currentFunctions.add(funcName)
        enclosingFunc = funcName
      } else if (enclosingFunc) {
        // Changed line is inside an enclosing function
        currentFunctions.add(enclosingFunc)
      }

      // Track closing braces in changed lines too
      if (/^\s*\}\s*$/.test(content)) {
        enclosingFunc = null
      }
    }
  }

  // Save last file
  if (currentFile && currentFunctions.size > 0) {
    files.push({ file: currentFile, functions: currentFunctions })
  }

  return files
}

// ─── Risk classification ──────────────────────────────────────────────────────

/**
 * Cross-reference modified functions with manifest clusters.
 *
 * Risk levels:
 *   high     — modified function is the ENTRY of the cluster
 *   medium   — modified function is in WATCHES but not the entry
 *   low      — cluster's file was touched but no function matches
 *   untracked — modified function not found in any cluster's watches
 */
function classifyRisk(manifest, fileChanges) {
  const high = new Set()
  const medium = new Set()
  const low = new Set()
  const trackedFunctions = new Set()

  // Collect all modified function names and touched files
  const allModifiedFunctions = new Set()
  const touchedFiles = new Set()
  for (const fc of fileChanges) {
    touchedFiles.add(fc.file)
    for (const fn of fc.functions) {
      allModifiedFunctions.add(fn)
    }
  }

  for (const cluster of manifest.clusters) {
    const clusterFile = cluster.file || ''
    const entry = cluster.entry || ''
    const watches = cluster.watches || []

    let clusterHasEntryMatch = false
    let clusterHasWatchMatch = false

    // File-level match
    const clusterFileTouched = clusterFile && touchedFiles.has(clusterFile)

    // Function-level match
    for (const modFn of allModifiedFunctions) {
      if (modFn === entry) {
        high.add(cluster.id)
        clusterHasEntryMatch = true
        trackedFunctions.add(modFn)
      }
      if (watches.includes(modFn) && modFn !== entry) {
        medium.add(cluster.id)
        clusterHasWatchMatch = true
        trackedFunctions.add(modFn)
      }
    }

    // Low risk: file touched but no function matched
    if (clusterFileTouched && !clusterHasEntryMatch && !clusterHasWatchMatch) {
      low.add(cluster.id)
    }
  }

  // Untracked: modified functions not in any cluster's watches or entry
  const untracked = [...allModifiedFunctions].filter(fn => !trackedFunctions.has(fn))

  return {
    high: [...high],
    medium: [...medium],
    low: [...low],
    untracked,
  }
}

// ─── Output formatting ────────────────────────────────────────────────────────

function formatHuman(result) {
  const { high, medium, low, untracked } = result

  console.log('\n⚠️  Regret Risk Assessment\n')

  if (high.length > 0) {
    console.log('  🔴 HIGH RISK — entry function modified (cluster output WILL change):')
    for (const id of high) console.log(`     • ${id}`)
    console.log()
  }

  if (medium.length > 0) {
    console.log('  🟡 MEDIUM RISK — watched function modified (cluster output MAY change):')
    for (const id of medium) console.log(`     • ${id}`)
    console.log()
  }

  if (low.length > 0) {
    console.log('  🟢 LOW RISK — file touched but no watched function modified:')
    for (const id of low) console.log(`     • ${id}`)
    console.log()
  }

  if (untracked.length > 0) {
    console.log('  ⚪ UNTRACKED — modified functions with no cluster coverage:')
    for (const fn of untracked) console.log(`     • ${fn}`)
    console.log()
  }

  // Summary
  const parts = []
  if (high.length > 0) parts.push(`${high.length} high-risk cluster${high.length > 1 ? 's' : ''}`)
  if (medium.length > 0) parts.push(`${medium.length} medium-risk cluster${medium.length > 1 ? 's' : ''}`)
  if (untracked.length > 0) parts.push(`${untracked.length} untracked function${untracked.length > 1 ? 's' : ''} with no coverage`)
  if (low.length > 0) parts.push(`${low.length} low-risk cluster${low.length > 1 ? 's' : ''}`)

  if (parts.length === 0) {
    console.log('  ✅ No risk detected — no clusters affected by current changes.\n')
  } else {
    console.log(`  📋 Summary: ${parts.join(', ')}\n`)
  }
}

function formatJson(result) {
  const summaryParts = []
  if (result.high.length > 0) summaryParts.push(`${result.high.length} high-risk cluster${result.high.length > 1 ? 's' : ''}`)
  if (result.medium.length > 0) summaryParts.push(`${result.medium.length} medium-risk cluster${result.medium.length > 1 ? 's' : ''}`)
  if (result.untracked.length > 0) summaryParts.push(`${result.untracked.length} untracked function${result.untracked.length > 1 ? 's' : ''} with no coverage`)
  if (result.low.length > 0) summaryParts.push(`${result.low.length} low-risk cluster${result.low.length > 1 ? 's' : ''}`)
  if (summaryParts.length === 0) summaryParts.push('no risk detected')

  const output = {
    high: result.high,
    medium: result.medium,
    low: result.low,
    untracked: result.untracked,
    summary: summaryParts.join(', '),
  }

  console.log(JSON.stringify(output, null, 2))
}

// ─── Main ─────────────────────────────────────────────────────────────────────

const diffText = getDiffFromArgs(args)

if (!diffText.trim()) {
  if (jsonOutput) {
    console.log(JSON.stringify({ high: [], medium: [], low: [], untracked: [], summary: 'no changes detected' }, null, 2))
  } else {
    console.log('\n✅ No changes detected — nothing to assess.\n')
  }
  process.exit(0)
}

const manifest = loadManifest()
const fileChanges = parseDiff(diffText)
const result = classifyRisk(manifest, fileChanges)

if (jsonOutput) {
  formatJson(result)
} else {
  formatHuman(result)
}

// Exit code: 1 if any high-risk clusters, 0 otherwise (for CI gating)
process.exit(result.high.length > 0 ? 1 : 0)

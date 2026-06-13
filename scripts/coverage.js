#!/usr/bin/env node
// coverage.js — Branch coverage analysis for regret clusters
// Reads source files and manifest to report how well clusters cover code branches.
//
// Usage:
//   node scripts/coverage.js
//   node scripts/coverage.js --cluster my-cluster
//   node scripts/coverage.js --verbose
//
// This tool helps agents understand whether their test inputs are sufficient
// to exercise all code paths in watched functions. A cluster with 1 input
// for a function with 5 branches is UNDER-COVERED — the fingerprint only
// protects one execution path, and a refactor could silently break the other four.

import { readFileSync, readdirSync, existsSync } from 'fs'
import { resolve, join, basename } from 'path'

const args = process.argv.slice(2)
const clusterFilter = args.includes('--cluster') ? args[args.indexOf('--cluster') + 1] : null
const verbose = args.includes('--verbose')
const manifestPath = args.includes('--manifest')
  ? args[args.indexOf('--manifest') + 1]
  : resolve(process.cwd(), 'regrets/manifest.json')
const regretDir = resolve(process.cwd(), 'regrets')

// ─── Load manifest ────────────────────────────────────────────────────────────

let manifest
try {
  manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
} catch {
  console.error(`❌ Could not read manifest: ${manifestPath}`)
  process.exit(1)
}

// ─── Branch counting ──────────────────────────────────────────────────────────
// Counts decision points in a function body:
// - if/else if/else
// - ternary operators (? :)
// - switch/case
// - early returns (return before end of function)
// - try/catch
// - && and || (short-circuit evaluation)
//
// This is a static approximation — it doesn't parse the AST, but uses
// regex-based heuristics that work well for most code patterns.

function countBranches(sourceCode, functionName) {
  // Extract the function body
  const fnBody = extractFunctionBody(sourceCode, functionName)
  if (!fnBody) return { branches: 0, details: 'function not found in source' }

  let branches = 0
  const details = []

  // Count if/else if/else
  const ifMatches = fnBody.match(/\bif\s*\(/g)
  if (ifMatches) {
    branches += ifMatches.length
    details.push(`${ifMatches.length} if-statement(s)`)
  }

  // Count else if (already counted in if, but note it)
  const elseIfMatches = fnBody.match(/\belse\s+if\s*\(/g)
  // No extra count — already in if count

  // Count standalone else
  const elseMatches = fnBody.match(/\belse\s*\{/g)
  if (elseMatches) {
    branches += elseMatches.length
    details.push(`${elseMatches.length} else-clause(s)`)
  }

  // Count ternary operators
  const ternaryMatches = fnBody.match(/\?\s*[^:]+\s*:/g)
  if (ternaryMatches) {
    branches += ternaryMatches.length
    details.push(`${ternaryMatches.length} ternary-branch(es)`)
  }

  // Count switch cases (excluding default)
  const caseMatches = fnBody.match(/\bcase\s+/g)
  if (caseMatches) {
    branches += caseMatches.length
    details.push(`${caseMatches.length} switch-case(s)`)
  }

  // Count early returns (return before the last line)
  const lines = fnBody.split('\n')
  const returnLines = lines.filter((l, i) =>
    i < lines.length - 1 && /\breturn\b/.test(l) && !l.trim().startsWith('//')
  )
  if (returnLines.length > 0) {
    branches += returnLines.length
    details.push(`${returnLines.length} early-return(s)`)
  }

  // Count try/catch
  const catchMatches = fnBody.match(/\bcatch\b/g)
  if (catchMatches) {
    branches += catchMatches.length
    details.push(`${catchMatches.length} catch-clause(s)`)
  }

  // Count && and || that create short-circuit paths
  const shortCircuitAnd = fnBody.match(/&&/g)
  const shortCircuitOr = fnBody.match(/\|\|/g)
  const shortCircuitCount = (shortCircuitAnd ? shortCircuitAnd.length : 0) +
                            (shortCircuitOr ? shortCircuitOr.length : 0)
  if (shortCircuitCount > 0) {
    branches += shortCircuitCount
    details.push(`${shortCircuitCount} short-circuit-path(s) (&& / ||)`)
  }

  return { branches, details: details.join(', ') || 'no branches detected' }
}

function extractFunctionBody(source, functionName) {
  // Try multiple patterns to find the function

  // Pattern 1: function declaration
  let match = source.match(
    new RegExp(`(?:export\\s+)?function\\s+${escapeRegex(functionName)}\\s*\\([^)]*\\)\\s*\\{`, 'm')
  )
  if (match) {
    return extractBlock(source, match.index + match[0].length - 1)
  }

  // Pattern 2: arrow function const/let/var
  match = source.match(
    new RegExp(`(?:export\\s+)?(?:const|let|var)\\s+${escapeRegex(functionName)}\\s*=\\s*(?:async\\s+)?(?:\\([^)]*\\)|[^=])\\s*=>\\s*\\{`, 'm')
  )
  if (match) {
    return extractBlock(source, match.index + match[0].length - 1)
  }

  // Pattern 3: method in class/object
  match = source.match(
    new RegExp(`(?:async\\s+)?${escapeRegex(functionName)}\\s*\\([^)]*\\)\\s*\\{`, 'm')
  )
  if (match) {
    return extractBlock(source, match.index + match[0].length - 1)
  }

  // Pattern 4: Python def (for reference in mixed codebases)
  match = source.match(
    new RegExp(`def\\s+${escapeRegex(functionName)}\\s*\\([^)]*\\)\\s*:`, 'm')
  )
  if (match) {
    const startIdx = match.index + match[0].length
    const lines = source.slice(startIdx).split('\n')
    const bodyLines = []
    const baseIndent = lines[0].search(/\S/)
    for (const line of lines) {
      const indent = line.search(/\S/)
      if (indent <= baseIndent && bodyLines.length > 0) break
      bodyLines.push(line)
    }
    return bodyLines.join('\n')
  }

  return null
}

function extractBlock(source, startBraceIdx) {
  let depth = 0
  let i = startBraceIdx
  for (; i < source.length; i++) {
    if (source[i] === '{') depth++
    else if (source[i] === '}') {
      depth--
      if (depth === 0) break
    }
  }
  return source.slice(startBraceIdx + 1, i)
}

function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

// ─── Calculate coverage score ────────────────────────────────────────────────

function coverageScore(inputCount, branchCount) {
  if (branchCount === 0) return 100  // no branches = fully covered
  const ratio = inputCount / branchCount
  return Math.min(100, Math.round(ratio * 100))
}

function coverageLabel(score) {
  if (score >= 80) return { label: 'WELL-COVERED', bar: '██████', color: '✅' }
  if (score >= 50) return { label: 'PARTIAL', bar: '███░░░', color: '🟡' }
  return { label: 'UNDER-COVERED', bar: '█░░░░░', color: '🔴' }
}

// ─── Main ─────────────────────────────────────────────────────────────────────

const clusters = clusterFilter
  ? manifest.clusters.filter(c => c.id === clusterFilter)
  : manifest.clusters

if (!clusters.length) {
  console.error(`❌ No clusters found${clusterFilter ? ` matching "${clusterFilter}"` : ''}`)
  process.exit(1)
}

console.log('\nBRANCH COVERAGE REPORT')
console.log('─'.repeat(80))
console.log(
  'cluster'.padEnd(32) +
  'inputs'.padEnd(8) +
  'branches'.padEnd(10) +
  'coverage'.padEnd(10) +
  'status'
)
console.log('─'.repeat(80))

const results = []

for (const cluster of clusters) {
  const { id, watches = [], file, inputs = [] } = cluster
  const inputCount = inputs.length

  // Try to read the source file
  let sourceCode = ''
  let totalBranches = 0
  const branchDetails = []

  const filePath = resolve(process.cwd(), file)
  if (existsSync(filePath)) {
    try {
      sourceCode = readFileSync(filePath, 'utf8')
    } catch {
      branchDetails.push('could not read source file')
    }
  } else {
    branchDetails.push('source file not found')
  }

  // Count branches for each watched function
  if (sourceCode) {
    for (const watchFn of watches) {
      const analysis = countBranches(sourceCode, watchFn)
      totalBranches += analysis.branches
      if (verbose && analysis.branches > 0) {
        branchDetails.push(`  ${watchFn}: ${analysis.branches} branches (${analysis.details})`)
      }
    }
  }

  const score = coverageScore(inputCount, totalBranches)
  const label = coverageLabel(score)

  console.log(
    id.padEnd(32) +
    String(inputCount).padEnd(8) +
    String(totalBranches).padEnd(10) +
    `${score}%`.padEnd(10) +
    `${label.color} ${label.label}`
  )

  if (verbose && branchDetails.length > 0) {
    for (const detail of branchDetails) {
      console.log(`  ${detail}`)
    }
  }

  results.push({ id, inputCount, totalBranches, score, label })
}

console.log('─'.repeat(80))

// ─── Recommendations ──────────────────────────────────────────────────────────

const underCovered = results.filter(r => r.score < 50)
const partial = results.filter(r => r.score >= 50 && r.score < 80)

if (underCovered.length || partial.length) {
  console.log('\n⚠️  Coverage Recommendations:')
  for (const r of underCovered) {
    const needed = r.totalBranches - r.inputCount
    if (needed > 0) {
      console.log(`  ${r.id.padEnd(32)} → add at least ${needed} more input(s) to cover branches`)
    } else {
      console.log(`  ${r.id.padEnd(32)} → inputs may not cover all branch combinations`)
    }
  }
  for (const r of partial) {
    console.log(`  ${r.id.padEnd(32)} → consider adding inputs for edge cases and error paths`)
  }
} else {
  console.log('\n✅ All clusters have good branch coverage.')
}

const wellCovered = results.filter(r => r.score >= 80)
if (wellCovered.length) {
  console.log('\nWell-covered clusters (refactor with confidence):')
  for (const r of wellCovered) {
    console.log(`  ${r.id}`)
  }
}

console.log()

// Exit with error if any cluster is under-covered
if (underCovered.length > 0) {
  console.log('❌ Under-covered clusters detected. Add more inputs before refactoring.\n')
  process.exit(1)
}

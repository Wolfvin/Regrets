#!/usr/bin/env node
// branch-map.js — Auto-generate regrets/branch-map.md from source analysis
// Reads manifest + source files to enumerate all branches and suggest inputs
// that cover each branch. This addresses the gap where agents had to manually
// create branch-map.md, which is error-prone and time-consuming.
//
// Usage:
//   node scripts/branch-map.js
//   node scripts/branch-map.js --cluster my-cluster
//   node scripts/branch-map.js --ts                    (TypeScript mode — reads .ts files)
//
// This tool was created because of the Coretax-Auto-Downloader case study,
// where the project uses TypeScript with compiled JS output. The branch-map
// needs to analyze the TypeScript SOURCE, not the minified JS output.

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs'
import { resolve, join, dirname, extname, relative } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))

const args = process.argv.slice(2)
const clusterFilter = args.includes('--cluster') ? args[args.indexOf('--cluster') + 1] : null
const tsMode = args.includes('--ts')
const manifestPath = args.includes('--manifest')
  ? args[args.indexOf('--manifest') + 1]
  : resolve(process.cwd(), 'regrets/manifest.json')

// ─── Load manifest ────────────────────────────────────────────────────────────

let manifest
try {
  manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
} catch {
  console.error(`❌ Could not read manifest: ${manifestPath}`)
  process.exit(1)
}

const clusters = clusterFilter
  ? manifest.clusters.filter(c => c.id === clusterFilter)
  : manifest.clusters

if (!clusters.length) {
  console.error(`❌ No clusters found${clusterFilter ? ` matching "${clusterFilter}"` : ''}`)
  process.exit(1)
}

// ─── Branch extraction ────────────────────────────────────────────────────────

/**
 * Extract branches from a function body using regex-based heuristics.
 * Works for both JS and TS source code.
 */
function extractBranches(sourceCode, functionName) {
  const fnBody = extractFunctionBody(sourceCode, functionName)
  if (!fnBody) return []

  const branches = []
  const lines = fnBody.split('\n')

  let lineNum = 0
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    lineNum = i + 1

    // if statements
    const ifMatch = line.match(/\bif\s*\(/)
    if (ifMatch) {
      // Extract the condition
      const condMatch = line.match(/\bif\s*\((.+?)\)\s*\{?/)
      const condition = condMatch ? condMatch[1].trim() : '(condition)'
      const hasElse = checkHasElse(lines, i)
      branches.push({
        type: 'if',
        line: lineNum,
        condition,
        hasElse,
        paths: hasElse ? 2 : 2, // if always creates 2 paths (true + fall-through)
        inputHint: suggestInputForCondition(condition)
      })
    }

    // else if
    const elseIfMatch = line.match(/\belse\s+if\s*\(/)
    if (elseIfMatch) {
      const condMatch = line.match(/\belse\s+if\s*\((.+?)\)\s*\{?/)
      const condition = condMatch ? condMatch[1].trim() : '(condition)'
      branches.push({
        type: 'else-if',
        line: lineNum,
        condition,
        inputHint: suggestInputForCondition(condition)
      })
    }

    // ternary
    const ternaryMatch = line.match(/\?\s*[^:]+\s*:/)
    if (ternaryMatch && !line.match(/\bif\s*\(/)) {
      branches.push({
        type: 'ternary',
        line: lineNum,
        condition: line.trim(),
        paths: 2,
        inputHint: 'Test both true and false branches of ternary'
      })
    }

    // switch/case
    const caseMatch = line.match(/\bcase\s+(.+?):/)
    if (caseMatch) {
      branches.push({
        type: 'case',
        line: lineNum,
        value: caseMatch[1].trim(),
        inputHint: `Input matching case ${caseMatch[1].trim()}`
      })
    }

    // early return
    if (/\breturn\b/.test(line) && !line.trim().startsWith('//') && i < lines.length - 2) {
      // Only count if it's not the last statement
      const nextNonEmpty = lines.slice(i + 1).find(l => l.trim() && !l.trim().startsWith('//'))
      if (nextNonEmpty) {
        branches.push({
          type: 'early-return',
          line: lineNum,
          condition: 'Input that triggers early return',
          paths: 1,
          inputHint: 'Input that triggers this early return path'
        })
      }
    }

    // catch clause
    const catchMatch = line.match(/\bcatch\b/)
    if (catchMatch) {
      branches.push({
        type: 'catch',
        line: lineNum,
        inputHint: 'Input that causes an exception'
      })
    }
  }

  return branches
}

/**
 * Check if an if-statement has a corresponding else clause.
 */
function checkHasElse(lines, ifLineIdx) {
  // Simple heuristic: look for 'else' at same or lower indentation within next few lines
  const ifIndent = lines[ifLineIdx].search(/\S/)
  let depth = 0
  for (let i = ifLineIdx; i < Math.min(lines.length, ifLineIdx + 50); i++) {
    const line = lines[i]
    if (line.includes('{')) depth++
    if (line.includes('}')) depth--
    if (depth === 0 && i > ifLineIdx) {
      // Check if the next non-empty line is 'else'
      const nextLine = lines.slice(i + 1).find(l => l.trim())
      if (nextLine && nextLine.trim().startsWith('else')) return true
      return false
    }
  }
  return false
}

/**
 * Suggest an input value that would trigger a specific condition.
 */
function suggestInputForCondition(condition) {
  // Common patterns and their trigger inputs
  const patterns = [
    { regex: /===?\s*null/, hint: 'null' },
    { regex: /===?\s*undefined/, hint: 'undefined' },
    { regex: /!dateStr|!value|!str|!input/, hint: 'null or empty string' },
    { regex: /typeof\s+\w+\s*===?\s*["']string["']/, hint: 'a string value' },
    { regex: /typeof\s+\w+\s*===?\s*["']number["']/, hint: 'a number value' },
    { regex: /\.length\s*===?\s*0/, hint: 'empty array/string' },
    { regex: /\.length\s*>\s*0/, hint: 'non-empty array/string' },
    { regex: />\s*0/, hint: 'positive number' },
    { regex: /<\s*0/, hint: 'negative number' },
    { regex: /===?\s*0/, hint: 'zero' },
    { regex: />=\s*\d+/, hint: 'number meeting the threshold' },
    { regex: /includes\s*\(/, hint: 'value in the includes set' },
    { regex: /startsWith\s*\(/, hint: 'string matching the prefix' },
    { regex: /has\.has\s*\(/, hint: 'field name in the Set' },
    { regex: /isEmpty|!.*\.length/, hint: 'empty value' },
    { regex: /isNaN/, hint: 'non-numeric value' },
  ]

  for (const { regex, hint } of patterns) {
    if (regex.test(condition)) return hint
  }

  return 'Input that makes this condition true'
}

function extractFunctionBody(source, functionName) {
  // Pattern 1: function declaration
  let match = source.match(
    new RegExp(`(?:export\\s+)?(?:async\\s+)?function\\s+${escapeRegex(functionName)}\\s*\\([^)]*\\)\\s*:\\s*[^{]*\\{`, 'm')
  )
  if (!match) {
    match = source.match(
      new RegExp(`(?:export\\s+)?(?:async\\s+)?function\\s+${escapeRegex(functionName)}\\s*\\([^)]*\\)\\s*\\{`, 'm')
    )
  }
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
    new RegExp(`(?:async\\s+)?${escapeRegex(functionName)}\\s*\\([^)]*\\)\\s*(:\\s*[^{]*)?\\{`, 'm')
  )
  if (match) {
    return extractBlock(source, match.index + match[0].length - 1)
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

/**
 * Resolve the source file path for a cluster.
 * In TypeScript projects, the manifest may reference compiled JS,
 * but we want to analyze the TypeScript source.
 */
function resolveSourceFile(cluster) {
  const file = cluster.file || cluster.module || ''
  const absPath = resolve(process.cwd(), file)

  if (tsMode) {
    // Try to find the TypeScript source instead of compiled JS
    const tsCandidates = [
      absPath.replace(/\/js\//, '/ts/').replace(/\.js$/, '.ts'),
      absPath.replace(/\.js$/, '.ts'),
      absPath.replace(/\/dist\//, '/src/').replace(/\.js$/, '.ts'),
      absPath.replace(/\/build\//, '/src/').replace(/\.js$/, '.ts'),
      absPath.replace(/\/out\//, '/src/').replace(/\.js$/, '.ts'),
    ]

    for (const candidate of tsCandidates) {
      if (existsSync(candidate)) {
        console.log(`   📝 TS mode: using ${relative(process.cwd(), candidate)} instead of ${relative(process.cwd(), absPath)}`)
        return candidate
      }
    }

    // Also try with extension_package → extension_source mapping
    const sourceMapping = absPath.replace('/extension_package/', '/extension_source/')
    const tsSourcePath = sourceMappingURL.replace(/\.js$/, '.ts')
    if (existsSync(tsSourcePath)) {
      console.log(`   📝 TS mode: using ${relative(process.cwd(), tsSourcePath)}`)
      return tsSourcePath
    }

    console.warn(`   ⚠️  TS mode: no TypeScript source found for ${file}, falling back to JS`)
  }

  return absPath
}

// ─── Main ─────────────────────────────────────────────────────────────────────

console.log('\n🗺️  Generating Branch Map...\n')

const branchMapSections = []
let totalBranches = 0
let totalCovered = 0
let totalUncovered = 0

for (const cluster of clusters) {
  const { id, entry, watches = [], inputs = [] } = cluster

  console.log(`📡 Analyzing: ${id}`)

  const sourcePath = resolveSourceFile(cluster)

  let sourceCode = ''
  try {
    sourceCode = readFileSync(sourcePath, 'utf8')
  } catch {
    console.warn(`   ⚠️  Could not read source: ${sourcePath}`)
    branchMapSections.push(`## ${id}\n\n⚠️ Source file not found: ${sourcePath}\n`)
    continue
  }

  const allFunctionsToAnalyze = [entry, ...watches.filter(w => w !== entry)]
  const clusterBranches = []
  let clusterTotalBranches = 0

  for (const fnName of allFunctionsToAnalyze) {
    const branches = extractBranches(sourceCode, fnName)
    if (branches.length > 0) {
      clusterBranches.push({ fn: fnName, branches })
      clusterTotalBranches += branches.length
    }
  }

  totalBranches += clusterTotalBranches
  const inputCount = inputs.length
  const uncoveredCount = Math.max(0, clusterTotalBranches - inputCount)
  totalUncovered += uncoveredCount
  totalCovered += Math.min(inputCount, clusterTotalBranches)

  // Build the markdown section
  let section = `## ${id}\n\n`
  section += `- **Entry**: \`${entry}\`\n`
  section += `- **Watches**: ${watches.map(w => `\`${w}\``).join(', ')}\n`
  section += `- **Total branches**: ${clusterTotalBranches}\n`
  section += `- **Current inputs**: ${inputCount}\n`
  section += `- **Coverage**: ${clusterTotalBranches === 0 ? '100% (no branches)' : `${Math.min(100, Math.round(inputCount / clusterTotalBranches * 100))}%`}\n\n`

  if (clusterBranches.length === 0) {
    section += `No branches detected — function appears to be a simple transformation.\n\n`
  } else {
    for (const { fn, branches } of clusterBranches) {
      section += `### ${fn}()\n\n`
      for (let i = 0; i < branches.length; i++) {
        const b = branches[i]
        section += `- **Branch ${i + 1}** (line ~${b.line}): ${b.type}`
        if (b.condition) section += ` — \`${b.condition.replace(/`/g, "'")}\``
        section += `\n`
        section += `  - Input needed: ${b.inputHint}\n`
      }
      section += `\n`
    }
  }

  branchMapSections.push(section)
  console.log(`   Found ${clusterTotalBranches} branch(es) across ${clusterBranches.length} function(s)`)
  if (uncoveredCount > 0) {
    console.log(`   ⚠️  Need at least ${uncoveredCount} more input(s) for full coverage`)
  }
}

// ─── Write branch-map.md ──────────────────────────────────────────────────────

const regretDir = resolve(process.cwd(), 'regrets')
mkdirSync(regretDir, { recursive: true })

const header = `# Branch Map

Auto-generated by \`regret branch-map\`${tsMode ? ' (TypeScript mode)' : ''}

This file maps all branches in watched functions and suggests inputs
to cover each branch. Use this to ensure your Regrets clusters have
sufficient inputs for full branch coverage.

**Summary**: ${totalBranches} total branches, ${totalCovered} covered by current inputs, ${totalUncovered} need additional inputs

---

`

const content = header + branchMapSections.join('---\n\n')

const outputPath = join(regretDir, 'branch-map.md')
writeFileSync(outputPath, content, 'utf8')

console.log(`\n${'─'.repeat(50)}`)
console.log(`📄 Branch map saved: regrets/branch-map.md`)
console.log(`   Total branches: ${totalBranches}`)
console.log(`   Covered: ${totalCovered}`)
console.log(`   Uncovered: ${totalUncovered}`)

if (totalUncovered > 0) {
  console.log(`\n⚠️  Add more inputs to your manifest to cover uncovered branches.`)
  console.log(`   See regrets/branch-map.md for specific input suggestions.`)
}

console.log()

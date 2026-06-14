#!/usr/bin/env node
// coverage.js — Branch coverage analysis for regret clusters
// Reads source files and manifest to report how well clusters cover code branches.
//
// Usage:
//   node scripts/coverage.js
//   node scripts/coverage.js --cluster my-cluster
//   node scripts/coverage.js --verbose
//   node scripts/coverage.js --suggest-inputs          (suggest concrete inputs for uncovered branches)
//   node scripts/coverage.js --suggest-inputs --cluster my-cluster
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
const suggestInputs = args.includes('--suggest-inputs')
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

// ─── Branch analysis with condition extraction ────────────────────────────────
// Extracts individual branch conditions from a function body to enable
// concrete input suggestion generation. This is the key gap filler:
// instead of just saying "you need more inputs", we analyze WHAT each
// branch checks and suggest a concrete input that exercises it.

function analyzeBranches(sourceCode, functionName) {
  const fnBody = extractFunctionBody(sourceCode, functionName)
  if (!fnBody) return []

  const branches = []
  const lines = fnBody.split('\n')

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    const trimmed = line.trim()

    // Skip comments
    if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')) continue

    // if (condition) — extract condition
    const ifMatch = trimmed.match(/^if\s*\((.+)\)\s*\{?\s*$/)
    if (ifMatch) {
      const condition = ifMatch[1].trim()
      const returnMatch = (lines[i + 1] || '').trim().match(/^return\s+(.+);?\s*$/)
      branches.push({
        type: 'if',
        line: i + 1,
        condition,
        returnExpr: returnMatch ? returnMatch[1] : null,
        negated: false,
        description: `if (${condition})`
      })
      continue
    }

    // else if (condition)
    const elseIfMatch = trimmed.match(/^else\s+if\s*\((.+)\)\s*\{?\s*$/)
    if (elseIfMatch) {
      const condition = elseIfMatch[1].trim()
      const returnMatch = (lines[i + 1] || '').trim().match(/^return\s+(.+);?\s*$/)
      branches.push({
        type: 'else-if',
        line: i + 1,
        condition,
        returnExpr: returnMatch ? returnMatch[1] : null,
        negated: false,
        description: `else if (${condition})`
      })
      continue
    }

    // else { ... }
    const elseMatch = trimmed.match(/^else\s*\{?\s*$/)
    if (elseMatch) {
      const returnMatch = (lines[i + 1] || '').trim().match(/^return\s+(.+);?\s*$/)
      branches.push({
        type: 'else',
        line: i + 1,
        condition: null,
        returnExpr: returnMatch ? returnMatch[1] : null,
        negated: false,
        description: 'else (fallback)'
      })
      continue
    }

    // Early return with condition on same line: if (!x) return y
    const earlyReturnMatch = trimmed.match(/^if\s*\((.+)\)\s+return\s+(.+);?\s*$/)
    if (earlyReturnMatch) {
      branches.push({
        type: 'early-return',
        line: i + 1,
        condition: earlyReturnMatch[1].trim(),
        returnExpr: earlyReturnMatch[2].trim(),
        negated: false,
        description: `if (${earlyReturnMatch[1].trim()}) return ${earlyReturnMatch[2].trim()}`
      })
      continue
    }

    // Ternary: condition ? a : b
    const ternaryMatch = trimmed.match(/(.+)\?\s*(.+)\s*:\s*(.+)/)
    if (ternaryMatch && !trimmed.includes('if')) {
      branches.push({
        type: 'ternary',
        line: i + 1,
        condition: ternaryMatch[1].trim(),
        returnExpr: ternaryMatch[2].trim(),
        negated: false,
        description: `ternary: ${ternaryMatch[1].trim()} ? ${ternaryMatch[2].trim()} : ${ternaryMatch[3].trim()}`
      })
      continue
    }

    // switch case
    const caseMatch = trimmed.match(/^case\s+(.+):/)
    if (caseMatch) {
      branches.push({
        type: 'case',
        line: i + 1,
        condition: caseMatch[1].trim(),
        returnExpr: null,
        negated: false,
        description: `case ${caseMatch[1].trim()}`
      })
      continue
    }
  }

  return branches
}

/**
 * Generate a concrete input suggestion for a branch condition.
 * Analyzes the condition pattern and produces a JSON-serializable input
 * that would exercise that branch.
 *
 * This is the critical gap-filler: "you need more inputs" becomes
 * "here's an input that exercises branch 3".
 */
function suggestInputForBranch(branch, existingInputs, paramHints) {
  const cond = branch.condition
  if (!cond) {
    // else/fallback branch — need an input that doesn't match any prior condition
    return { _note: `Fallback input — ensure no prior condition is true`, ...buildFallbackInput(existingInputs) }
  }

  const suggested = {}

  // Parse condition patterns and generate appropriate values
  // Pattern: !ctx.prop → set prop to false
  const negatedPropMatch = cond.match(/!(\w+)\.(\w+)/)
  if (negatedPropMatch) {
    const obj = negatedPropMatch[1]
    const prop = negatedPropMatch[2]
    suggested[prop] = false
    // Fill other props with defaults that make this branch reachable
    fillReachabilityDefaults(suggested, cond, paramHints)
    return suggested
  }

  // Pattern: ctx.prop → set prop to true
  const propMatch = cond.match(/(\w+)\.(\w+)/)
  if (propMatch && !cond.includes('!')) {
    const obj = propMatch[1]
    const prop = propMatch[2]
    suggested[prop] = true
    fillReachabilityDefaults(suggested, cond, paramHints)
    return suggested
  }

  // Pattern: x === "literal" / x == "literal"
  const strictEqMatch = cond.match(/(\w+)\s*===?\s*["'](.+)["']/)
  if (strictEqMatch) {
    suggested[strictEqMatch[1]] = strictEqMatch[2]
    return suggested
  }

  // Pattern: x !== "literal" / x != "literal"
  const strictNeqMatch = cond.match(/(\w+)\s*!==?\s*["'](.+)["']/)
  if (strictNeqMatch) {
    suggested[strictNeqMatch[1]] = `NOT_${strictNeqMatch[2]}`
    return suggested
  }

  // Pattern: x > N / x >= N / x < N / x <= N
  const comparisonMatch = cond.match(/(\w+)\s*(>|>=|<|<=)\s*(\d+)/)
  if (comparisonMatch) {
    const [, varName, op, numStr] = comparisonMatch
    const num = parseInt(numStr, 10)
    if (op === '>') suggested[varName] = num + 1
    else if (op === '>=') suggested[varName] = num
    else if (op === '<') suggested[varName] = num - 1
    else if (op === '<=') suggested[varName] = num
    return suggested
  }

  // Pattern: !param (simple boolean negation)
  const simpleNegMatch = cond.match(/^!(\w+)$/)
  if (simpleNegMatch) {
    suggested[simpleNegMatch[1]] = false
    return suggested
  }

  // Pattern: param (simple boolean truth)
  const simpleMatch = cond.match(/^(\w+)$/)
  if (simpleMatch) {
    suggested[simpleMatch[1]] = true
    return suggested
  }

  // Pattern: typeof x === "type"
  const typeofMatch = cond.match(/typeof\s+(\w+)\s*===?\s*["'](\w+)["']/)
  if (typeofMatch) {
    const typeMap = { string: "test", number: 42, boolean: true, object: {}, undefined: undefined }
    suggested[typeofMatch[1]] = typeMap[typeofMatch[2]] ?? null
    return suggested
  }

  // Pattern: Array.isArray(x) / x.length > 0
  const arrayMatch = cond.match(/Array\.isArray\((\w+)\)/)
  if (arrayMatch) {
    suggested[arrayMatch[1]] = [1, 2, 3]
    return suggested
  }

  // Fallback: can't parse condition, provide generic suggestion
  return { _note: `Could not auto-suggest input for condition: "${cond}". Analyze manually.`, _condition: cond }
}

/**
 * Fill in default values for parameters not explicitly set by the branch condition,
 * ensuring the input will actually reach the target branch.
 */
function fillReachabilityDefaults(suggested, fullCondition, paramHints) {
  // Use paramHints (extracted from function signature) to fill unset params
  for (const [param, defaultValue] of Object.entries(paramHints)) {
    if (!(param in suggested)) {
      // Set a value that doesn't trigger earlier conditions
      suggested[param] = defaultValue
    }
  }
}

/**
 * Build a fallback input that doesn't match any of the existing inputs' conditions.
 */
function buildFallbackInput(existingInputs) {
  // Return a generic "all defaults" input
  return { _note: 'Ensure this input does not match any prior branch condition' }
}

/**
 * Extract parameter names and type hints from a function signature.
 */
function extractParamHints(sourceCode, functionName) {
  const hints = {}

  // Try to find the function signature
  const fnMatch = sourceCode.match(
    new RegExp(`(?:export\\s+)?(?:async\\s+)?function\\s+${escapeRegex(functionName)}\\s*\\(([^)]*)\\)`, 'm')
  )
  || sourceCode.match(
    new RegExp(`(?:export\\s+)?(?:const|let|var)\\s+${escapeRegex(functionName)}\\s*=\\s*(?:async\\s*)?\\(([^)]*)\\)\\s*=>`, 'm')
  )

  if (!fnMatch) return hints

  const params = fnMatch[1].split(',').map(p => p.trim()).filter(Boolean)
  for (const param of params) {
    // Handle TypeScript: param: Type
    const tsMatch = param.match(/(\w+)(?::\s*(\w+))?(\??)/)
    if (tsMatch) {
      const name = tsMatch[1]
      const type = tsMatch[2]
      const optional = !!tsMatch[3]

      if (type === 'boolean') hints[name] = false
      else if (type === 'number') hints[name] = 0
      else if (type === 'string') hints[name] = ""
      else if (type === 'object') hints[name] = {}
      else if (optional) hints[name] = undefined
      else hints[name] = null
    }
  }

  return hints
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

// ─── Suggest Inputs Mode ──────────────────────────────────────────────────────
// This is the key improvement: instead of just saying "you need more inputs",
// we analyze each branch condition and suggest a concrete input that exercises it.
// This directly addresses the gap where "clusters only fingerprint one execution
// path; branching functions need inputs covering ALL branches."

if (suggestInputs) {
  console.log('\n\n' + '═'.repeat(80))
  console.log('SUGGESTED INPUTS — Concrete inputs to cover uncovered branches')
  console.log('═'.repeat(80))

  for (const cluster of clusters) {
    const { id, watches = [], file, inputs = [], entry } = cluster
    const filePath = resolve(process.cwd(), file)

    if (!existsSync(filePath)) {
      console.log(`\n📦 ${id}: source file not found — skipping suggestion`)
      continue
    }

    let sourceCode
    try {
      sourceCode = readFileSync(filePath, 'utf8')
    } catch {
      console.log(`\n📦 ${id}: could not read source — skipping suggestion`)
      continue
    }

    console.log(`\n📦 ${id} (entry: ${entry})`)

    // Analyze entry function first (most important for coverage)
    const entryBranches = analyzeBranches(sourceCode, entry)
    const paramHints = extractParamHints(sourceCode, entry)

    if (entryBranches.length === 0) {
      console.log(`   No branches detected in entry function — single input sufficient`)
      continue
    }

    console.log(`   ${entryBranches.length} branch(es) detected in ${entry}:\n`)

    const suggestedInputs = []
    for (let i = 0; i < entryBranches.length; i++) {
      const branch = entryBranches[i]
      const suggestion = suggestInputForBranch(branch, inputs, paramHints)

      console.log(`   Branch ${i + 1} (line ${branch.line}): ${branch.description}`)
      if (branch.returnExpr) {
        console.log(`     → returns: ${branch.returnExpr}`)
      }

      // Check if any existing input already exercises this branch
      const alreadyCovered = checkIfCovered(branch, inputs)
      if (alreadyCovered) {
        console.log(`     ✅ Already covered by existing input`)
      } else {
        const suggestionStr = JSON.stringify(suggestion)
        console.log(`     🆕 Suggested input: ${suggestionStr}`)
        suggestedInputs.push(suggestion)
      }
    }

    // Also analyze watched functions if verbose
    if (verbose) {
      for (const watchFn of watches) {
        if (watchFn === entry) continue
        const watchBranches = analyzeBranches(sourceCode, watchFn)
        if (watchBranches.length > 0) {
          console.log(`\n   ${watchFn} (${watchBranches.length} branches):`)
          for (let i = 0; i < watchBranches.length; i++) {
            const branch = watchBranches[i]
            const suggestion = suggestInputForBranch(branch, inputs, extractParamHints(sourceCode, watchFn))
            const alreadyCovered = checkIfCovered(branch, inputs)
            console.log(`     Branch ${i + 1}: ${branch.description}`)
            if (!alreadyCovered) {
              console.log(`       🆕 Suggested: ${JSON.stringify(suggestion)}`)
            } else {
              console.log(`       ✅ Covered`)
            }
          }
        }
      }
    }

    // Output manifest-ready input array
    if (suggestedInputs.length > 0) {
      console.log(`\n   ── Manifest inputs snippet ──`)
      const allInputs = [...inputs, ...suggestedInputs]
      console.log(`   "inputs": ${JSON.stringify(allInputs, null, 2).split('\n').map((l, i) => i === 0 ? l : '   ' + l).join('\n')}`)
    }
  }
}

/**
 * Check if an existing input likely covers a branch condition.
 * Simple heuristic: checks if any existing input satisfies the branch condition.
 */
function checkIfCovered(branch, existingInputs) {
  if (!branch.condition || existingInputs.length === 0) return false

  const cond = branch.condition

  for (const input of existingInputs) {
    if (input === null || input === undefined) continue

    // For object inputs, check if the condition's properties are present
    if (typeof input === 'object' && !Array.isArray(input)) {
      // !ctx.prop → input has prop: false
      const negatedPropMatch = cond.match(/!(\w+)\.(\w+)/)
      if (negatedPropMatch) {
        const prop = negatedPropMatch[2]
        if (input[prop] === false) return true
      }

      // ctx.prop → input has prop: true
      const propMatch = cond.match(/(\w+)\.(\w+)/)
      if (propMatch && !cond.includes('!')) {
        const prop = propMatch[2]
        if (input[prop] === true) return true
      }

      // x === "literal"
      const strictEqMatch = cond.match(/(\w+)\s*===?\s*["'](.+)["']/)
      if (strictEqMatch) {
        if (input[strictEqMatch[1]] === strictEqMatch[2]) return true
      }

      // x > N / x >= N etc.
      const comparisonMatch = cond.match(/(\w+)\s*(>|>=|<|<=)\s*(\d+)/)
      if (comparisonMatch) {
        const val = input[comparisonMatch[1]]
        const num = parseInt(comparisonMatch[3], 10)
        const op = comparisonMatch[2]
        if (typeof val === 'number') {
          if (op === '>' && val > num) return true
          if (op === '>=' && val >= num) return true
          if (op === '<' && val < num) return true
          if (op === '<=' && val <= num) return true
        }
      }

      // !param
      const simpleNegMatch = cond.match(/^!(\w+)$/)
      if (simpleNegMatch) {
        if (input[simpleNegMatch[1]] === false) return true
      }

      // param
      const simpleMatch = cond.match(/^(\w+)$/)
      if (simpleMatch) {
        if (input[simpleMatch[1]] === true) return true
      }
    }

    // For primitive inputs
    if (typeof input === 'string') {
      const strictEqMatch = cond.match(/(\w+)\s*===?\s*["'](.+)["']/)
      if (strictEqMatch && strictEqMatch[2] === input) return true
    }

    if (typeof input === 'number') {
      const comparisonMatch = cond.match(/(\w+)\s*(>|>=|<|<=)\s*(\d+)/)
      if (comparisonMatch) {
        const num = parseInt(comparisonMatch[3], 10)
        const op = comparisonMatch[2]
        if (op === '>' && input > num) return true
        if (op === '>=' && input >= num) return true
        if (op === '<' && input < num) return true
        if (op === '<=' && input <= num) return true
      }
    }
  }

  return false
}

console.log()

// Exit with error if any cluster is under-covered
if (underCovered.length > 0) {
  console.log('❌ Under-covered clusters detected. Add more inputs before refactoring.\n')
  process.exit(1)
}

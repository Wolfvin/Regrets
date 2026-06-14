#!/usr/bin/env node
// branches.js — static branch coverage analysis for regret clusters
// Detects conditional branches (if/else, switch/case, ternary, early return)
// in watched/entry functions and cross-references with manifest inputs to
// report which branches are covered and which need additional inputs.
//
// Usage:
//   node scripts/branches.js
//   node scripts/branches.js --cluster <id>
//   node scripts/branches.js --json
//   node scripts/branches.js --cluster <id> --json

import { readFileSync, existsSync } from 'fs'
import { resolve } from 'path'

// ─── CLI args ─────────────────────────────────────────────────────────────────

const args = process.argv.slice(2)
const jsonMode = args.includes('--json')
const clusterFlagIdx = args.indexOf('--cluster')
const targetCluster = clusterFlagIdx !== -1 ? args[clusterFlagIdx + 1] : null

// ─── Read manifest ────────────────────────────────────────────────────────────

const manifestPath = resolve(process.cwd(), 'regrets/manifest.json')
if (!existsSync(manifestPath)) {
  console.error('❌ regrets/manifest.json not found. Run `regret init` first.')
  process.exit(1)
}

const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
let clusters = manifest.clusters || []

if (targetCluster) {
  clusters = clusters.filter(c => c.id === targetCluster)
  if (clusters.length === 0) {
    console.error(`❌ Cluster "${targetCluster}" not found in manifest.`)
    process.exit(1)
  }
}

// ─── Regex-based JS function extractor ────────────────────────────────────────
// Extracts a named function (or arrow/variable assignment) from source code.
// Returns { body: string, startLine: number } or null if not found.

function extractFunction(source, funcName) {
  const lines = source.split('\n')

  // Strategy 1: exported function declaration
  // Matches: export function name(...) { ... } | function name(...) { ... }
  // Also matches: export async function name(...)
  const funcDeclRe = new RegExp(
    `(?:export\\s+)?(?:async\\s+)?function\\s+${escapeRegex(funcName)}\\s*\\(`,
  )

  // Strategy 2: const/let/var name = function/arrow
  // Matches: export const name = (...) => { | const name = function(
  const varFuncRe = new RegExp(
    `(?:export\\s+)?(?:const|let|var)\\s+${escapeRegex(funcName)}\\s*=\\s*(?:async\\s+)?(?:function\\s*\\(|[\\(])`,
  )

  // Strategy 3: method in object/class
  // Matches: name(...) { | async name(...) {
  const methodRe = new RegExp(
    `(?:^|\\s)${escapeRegex(funcName)}\\s*\\(`,
  )

  for (const re of [funcDeclRe, varFuncRe, methodRe]) {
    for (let i = 0; i < lines.length; i++) {
      if (re.test(lines[i])) {
        const body = extractBlockBody(lines, i)
        if (body) {
          return { body: body.text, startLine: i + 1 }
        }
      }
    }
  }

  return null
}

/**
 * Extract a balanced-brace block starting from the line that contains the
 * opening `{`. Returns the concatenated text of the block and its start line.
 */
function extractBlockBody(lines, startLineIdx) {
  let braceDepth = 0
  let foundOpen = false
  const bodyLines = []

  for (let i = startLineIdx; i < lines.length; i++) {
    const line = lines[i]
    for (let ch = 0; ch < line.length; ch++) {
      if (line[ch] === '{') {
        braceDepth++
        foundOpen = true
      } else if (line[ch] === '}') {
        braceDepth--
      }
    }
    bodyLines.push(line)
    if (foundOpen && braceDepth <= 0) {
      return { text: bodyLines.join('\n'), startLine: startLineIdx + 1 }
    }
    // Safety: don't read beyond 500 lines for a single function
    if (bodyLines.length > 500) return null
  }

  // If we never found an opening brace, it might be a single-expression arrow
  // e.g., const fn = (x) => x + 1  (no braces)
  if (!foundOpen && bodyLines.length > 0) {
    return { text: bodyLines.join('\n'), startLine: startLineIdx + 1 }
  }

  return null
}

// ─── Branch detector ──────────────────────────────────────────────────────────
// Parses a function body string and returns an array of detected branches.

function detectBranches(funcBody, startLine) {
  const branches = []
  const lines = funcBody.split('\n')

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    const trimmed = line.trim()
    const absLine = startLine + i

    // Skip comments and empty lines
    if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed === '') continue

    // ─── if statements ──────────────────────────────────────────────────
    // Matches: if (condition) {  |  if(condition) statement  |  if (cond) {
    // Also matches inline: if (cond) return ... | if (cond) throw ...
    const ifMatch = trimmed.match(/^if\s*\((.+?)\)\s*(?:\{.*|(?:throw\b|return\b).+|)$/)
    if (ifMatch) {
      branches.push({
        line: absLine,
        type: 'if',
        condition: ifMatch[1].trim(),
      })
      // Also detect inline throw/return after the if condition
      const inlineAfter = trimmed.match(/^if\s*\(.+?\)\s*(throw\b.+|return\b.+)/)
      if (inlineAfter) {
        const stmt = inlineAfter[1].trim()
        if (/^throw\b/.test(stmt)) {
          const throwMatch = stmt.match(/^throw\s+(.+?)\s*;?\s*$/)
          branches.push({
            line: absLine,
            type: 'throw',
            condition: throwMatch ? throwMatch[1].trim() : null,
          })
        } else if (/^return\b/.test(stmt)) {
          const returnMatch = stmt.match(/^return\s+(.+?)\s*;?\s*$/)
          branches.push({
            line: absLine,
            type: 'early-return',
            condition: returnMatch ? returnMatch[1].trim() : null,
          })
        }
      }
      continue
    }

    // ─── else if ────────────────────────────────────────────────────────
    const elseIfMatch = trimmed.match(/^else\s+if\s*\((.+?)\)\s*(?:\{.*)?$/)
    if (elseIfMatch) {
      branches.push({
        line: absLine,
        type: 'else-if',
        condition: elseIfMatch[1].trim(),
      })
      continue
    }

    // ─── else ───────────────────────────────────────────────────────────
    if (/^else\s*\{?\s*$/.test(trimmed)) {
      branches.push({
        line: absLine,
        type: 'else',
        condition: null,
      })
      continue
    }

    // ─── switch case ────────────────────────────────────────────────────
    const switchMatch = trimmed.match(/^switch\s*\((.+?)\)\s*\{?\s*$/)
    if (switchMatch) {
      branches.push({
        line: absLine,
        type: 'switch',
        condition: switchMatch[1].trim(),
      })
      continue
    }

    const caseMatch = trimmed.match(/^case\s+(.+?):\s*$/)
    if (caseMatch) {
      branches.push({
        line: absLine,
        type: 'case',
        condition: caseMatch[1].trim(),
      })
      continue
    }

    if (trimmed === 'default:') {
      branches.push({
        line: absLine,
        type: 'default',
        condition: null,
      })
      continue
    }

    // ─── ternary expressions ────────────────────────────────────────────
    // Simple detection: line contains ? and :
    const ternaryMatch = trimmed.match(/\?\s*(.+?)\s*:\s*(.+)/)
    if (ternaryMatch && !trimmed.startsWith('//')) {
      // Extract the condition part (before the ?)
      // Find the ? that starts the ternary
      const qIdx = findTernaryQuestionMark(trimmed)
      if (qIdx !== -1) {
        const condition = trimmed.substring(0, qIdx).trim()
        // Only report if it looks like a meaningful ternary (not inside a string)
        if (condition.length > 0 && !condition.startsWith('"') && !condition.startsWith("'")) {
          branches.push({
            line: absLine,
            type: 'ternary',
            condition,
          })
        }
      }
      continue
    }

    // ─── early return (guard clause) ────────────────────────────────────
    // Matches: return ...  inside an if block, or standalone guard return
    // We detect return statements that are NOT the final return of the function
    if (/^return\b/.test(trimmed) && i < lines.length - 1) {
      // This is a return that is not at the end of the function — likely a guard/early return
      const returnMatch = trimmed.match(/^return\s+(.+?)\s*;?\s*$/)
      branches.push({
        line: absLine,
        type: 'early-return',
        condition: returnMatch ? returnMatch[1].trim() : null,
      })
      continue
    }

    // ─── throw statements (guard clause) ────────────────────────────────
    if (/^throw\b/.test(trimmed)) {
      const throwMatch = trimmed.match(/^throw\s+(.+?)\s*;?\s*$/)
      branches.push({
        line: absLine,
        type: 'throw',
        condition: throwMatch ? throwMatch[1].trim() : null,
      })
      continue
    }
  }

  return branches
}

/**
 * Find the index of the ? that starts a ternary expression.
 * Handles nested parentheses and string literals (basic).
 */
function findTernaryQuestionMark(line) {
  let depth = 0
  let inString = false
  let stringChar = ''

  for (let i = 0; i < line.length; i++) {
    const ch = line[i]

    if (inString) {
      if (ch === stringChar && line[i - 1] !== '\\') inString = false
      continue
    }

    if (ch === '"' || ch === "'" || ch === '`') {
      inString = true
      stringChar = ch
      continue
    }

    if (ch === '(') { depth++; continue }
    if (ch === ')') { depth--; continue }

    // Only match ? outside of parentheses and not part of ?. or ?.
    if (ch === '?' && depth === 0 && i + 1 < line.length && line[i + 1] !== '.' && line[i + 1] !== '?') {
      // Ensure there's a colon later for it to be a ternary
      const rest = line.substring(i + 1)
      if (rest.includes(':')) {
        return i
      }
    }
  }

  return -1
}

// ─── Coverage heuristic ───────────────────────────────────────────────────────
// Given a branch and the manifest inputs, determine if it's likely covered.

function checkCoverage(branch, inputs) {
  if (!inputs || inputs.length === 0) {
    return { covered: false, coveredBy: null }
  }

  const cond = branch.condition

  switch (branch.type) {
    case 'if':
    case 'else-if':
      return checkConditionCoverage(cond, inputs)

    case 'else':
    case 'default':
      // else/default branches are covered if there's any input that doesn't match
      // the preceding if/switch conditions — hard to detect precisely, so mark
      // as covered if there are multiple inputs (heuristic)
      return {
        covered: inputs.length >= 2,
        coveredBy: inputs.length >= 2 ? JSON.stringify(inputs[inputs.length - 1]) : null,
      }

    case 'case':
      return checkCaseCoverage(cond, inputs)

    case 'ternary':
      return checkConditionCoverage(cond, inputs)

    case 'early-return':
      // Early returns are typically guard clauses: if (!x) return ...
      // They are covered if some input triggers the return
      return checkReturnCoverage(branch, inputs)

    case 'throw':
      return checkThrowCoverage(branch, inputs)

    case 'switch':
      // The switch itself is not a branch — the cases are
      return { covered: true, coveredBy: null }

    default:
      return { covered: false, coveredBy: null }
  }
}

/**
 * Heuristic: check if any input would make the condition truthy.
 * Covers common patterns like !x, x === 'value', x > N, x && y, etc.
 */
function checkConditionCoverage(condition, inputs) {
  for (const input of inputs) {
    // Handle expectThrow inputs
    const actualInput = input && input.__expectThrow ? input.value : input
    const inputStr = JSON.stringify(actualInput)

    // Pattern: !param — null/undefined/0/''/false would trigger this
    // NOTE: !param means the entire input (param) is falsy, not a key inside it.
    const negParamMatch = condition.match(/^!(\w+)$/)
    if (negParamMatch) {
      if (actualInput === null || actualInput === undefined || actualInput === 0 ||
          actualInput === '' || actualInput === false) {
        return { covered: true, coveredBy: inputStr }
      }
      // Do NOT check actualInput[param] — param is the function parameter,
      // the input IS the param value, not an object containing it as a key.
      continue
    }

    // Pattern: !param.subfield
    const negSubfieldMatch = condition.match(/^!(\w+)\.(\w+)$/)
    if (negSubfieldMatch) {
      if (actualInput === null || actualInput === undefined) {
        return { covered: true, coveredBy: inputStr }
      }
      if (actualInput && typeof actualInput === 'object') {
        const sub = actualInput[negSubfieldMatch[2]]
        if (sub === null || sub === undefined || sub === 0 || sub === '' || sub === false) {
          return { covered: true, coveredBy: inputStr }
        }
      }
      continue
    }

    // Pattern: param === 'value' or param == 'value'
    const strictEqMatch = condition.match(/^(\w+(?:\.\w+)*)\s*(?:===|==)\s*['"](.+?)['"]$/)
    if (strictEqMatch) {
      const path = strictEqMatch[1]
      const expectedVal = strictEqMatch[2]
      const resolved = resolvePath(actualInput, path)
      if (resolved === expectedVal) {
        return { covered: true, coveredBy: inputStr }
      }
      // Also check if the string value appears in the input JSON
      if (inputStr.includes(expectedVal)) {
        return { covered: true, coveredBy: inputStr }
      }
      continue
    }

    // Pattern: param !== 'value' or param != 'value'
    const neqMatch = condition.match(/^(\w+(?:\.\w+)*)\s*(?:!==|!=)\s*['"](.+?)['"]$/)
    if (neqMatch) {
      const path = neqMatch[1]
      const expectedVal = neqMatch[2]
      const resolved = resolvePath(actualInput, path)
      if (resolved !== undefined && resolved !== expectedVal) {
        return { covered: true, coveredBy: inputStr }
      }
      continue
    }

    // Pattern: param > N or param >= N
    const gtMatch = condition.match(/^(\w+(?:\.\w+)*)\s*(>=|>)\s*(\d+(?:\.\d+)?)$/)
    if (gtMatch) {
      const path = gtMatch[1]
      const op = gtMatch[2]
      const threshold = parseFloat(gtMatch[3])
      const resolved = resolvePath(actualInput, path)
      if (resolved !== undefined) {
        const numVal = Number(resolved)
        if (!isNaN(numVal) && (op === '>' ? numVal > threshold : numVal >= threshold)) {
          return { covered: true, coveredBy: inputStr }
        }
      }
      continue
    }

    // Pattern: param < N or param <= N
    const ltMatch = condition.match(/^(\w+(?:\.\w+)*)\s*(<=|<)\s*(\d+(?:\.\d+)?)$/)
    if (ltMatch) {
      const path = ltMatch[1]
      const op = ltMatch[2]
      const threshold = parseFloat(ltMatch[3])
      const resolved = resolvePath(actualInput, path)
      if (resolved !== undefined) {
        const numVal = Number(resolved)
        if (!isNaN(numVal) && (op === '<' ? numVal < threshold : numVal <= threshold)) {
          return { covered: true, coveredBy: inputStr }
        }
      }
      continue
    }

    // Pattern: typeof param === 'type'
    const typeofMatch = condition.match(/typeof\s+(\w+(?:\.\w+)*)\s*(?:===|==)\s*['"](\w+)['"]$/)
    if (typeofMatch) {
      const path = typeofMatch[1]
      const expectedType = typeofMatch[2]
      const resolved = resolvePath(actualInput, path)
      if (resolved !== undefined && typeof resolved === expectedType) {
        return { covered: true, coveredBy: inputStr }
      }
      continue
    }

    // Pattern: param && ... (truthy check)
    const truthyMatch = condition.match(/^(\w+(?:\.\w+)*)\s*&&/)
    if (truthyMatch) {
      const path = truthyMatch[1]
      const resolved = resolvePath(actualInput, path)
      if (resolved) {
        return { covered: true, coveredBy: inputStr }
      }
      continue
    }

    // Pattern: param || ... (falsy check for first part)
    const falsyMatch = condition.match(/^(\w+(?:\.\w+)*)\s*\|\|/)
    if (falsyMatch) {
      const path = falsyMatch[1]
      const resolved = resolvePath(actualInput, path)
      if (!resolved) {
        return { covered: true, coveredBy: inputStr }
      }
      continue
    }

    // Fallback: check if any identifier in the condition appears as a key in the input
    // This is conservative — only matches when the condition uses simple property access
    // that maps to keys in the input object. Does NOT match parameter names themselves.
    const identifiers = condition.match(/\b(\w+)\b/g) || []
    for (const id of identifiers) {
      // Skip JS keywords and operators
      if (['undefined', 'null', 'true', 'false', 'typeof', 'instanceof',
           'and', 'or', 'not', 'in', 'of', 'void', 'new', 'delete'].includes(id)) continue
      // Only consider identifiers that appear as keys in the actual input object
      if (actualInput && typeof actualInput === 'object' && !Array.isArray(actualInput)) {
        if (id in actualInput) {
          return { covered: true, coveredBy: inputStr }
        }
      }
    }
  }

  return { covered: false, coveredBy: null }
}

/**
 * Heuristic: check if any input matches a case value.
 */
function checkCaseCoverage(caseValue, inputs) {
  for (const input of inputs) {
    const actualInput = input && input.__expectThrow ? input.value : input
    const inputStr = JSON.stringify(actualInput)

    // Case value might be a string literal
    const caseStripped = caseValue.replace(/^['"]|['"]$/g, '')
    if (inputStr.includes(caseStripped)) {
      return { covered: true, coveredBy: inputStr }
    }

    // Case value might be a number
    const caseNum = Number(caseValue)
    if (!isNaN(caseNum)) {
      if (actualInput === caseNum) {
        return { covered: true, coveredBy: inputStr }
      }
      // Check nested values
      if (actualInput && typeof actualInput === 'object') {
        for (const val of Object.values(actualInput)) {
          if (val === caseNum) {
            return { covered: true, coveredBy: inputStr }
          }
        }
      }
    }
  }

  return { covered: false, coveredBy: null }
}

/**
 * Heuristic: check if early return is covered.
 */
function checkReturnCoverage(branch, inputs) {
  // Early returns are typically inside if blocks (guard clauses).
  // They're covered if there's an input that would make the guard true.
  // Since we already detected the if above, we just check if null/undefined/falsy input exists.
  for (const input of inputs) {
    const actualInput = input && input.__expectThrow ? input.value : input
    const inputStr = JSON.stringify(actualInput)

    // If the return is an Error or throw-like, it's covered by expectThrow inputs
    if (branch.condition && /Error|throw|new\s+Error/i.test(branch.condition)) {
      if (input && input.__expectThrow) {
        return { covered: true, coveredBy: inputStr }
      }
    }

    // Null/undefined inputs often trigger guard returns
    if (actualInput === null || actualInput === undefined) {
      return { covered: true, coveredBy: inputStr }
    }
  }

  return { covered: false, coveredBy: null }
}

/**
 * Heuristic: check if throw statement is covered (usually by expectThrow inputs).
 */
function checkThrowCoverage(branch, inputs) {
  for (const input of inputs) {
    if (input && input.__expectThrow) {
      return { covered: true, coveredBy: JSON.stringify(input) }
    }
  }

  // If no expectThrow inputs, check for null/undefined inputs that might trigger throws
  for (const input of inputs) {
    const actualInput = input && input.__expectThrow ? input.value : input
    if (actualInput === null || actualInput === undefined) {
      return { covered: true, coveredBy: JSON.stringify(input) }
    }
  }

  return { covered: false, coveredBy: null }
}

// ─── Suggested input generator ────────────────────────────────────────────────
// For uncovered branches, generate a suggested input based on the condition.

function suggestInput(branch) {
  const cond = branch.condition

  switch (branch.type) {
    case 'if':
    case 'else-if': {
      // Pattern: !param → suggest null (param is the function parameter)
      const negMatch = cond && cond.match(/^!(\w+)$/)
      if (negMatch) {
        return 'null'
      }

      // Pattern: !param.subfield → suggest object without that subfield
      const negSub = cond && cond.match(/^!(\w+)\.(\w+)$/)
      if (negSub) {
        return JSON.stringify({ [negSub[1]]: {} })
      }

      // Pattern: param === 'value' → suggest { param: 'value' }
      const eqMatch = cond && cond.match(/^(\w+(?:\.\w+)*)\s*(?:===|==)\s*['"](.+?)['"]$/)
      if (eqMatch) {
        const path = eqMatch[1]
        const val = eqMatch[2]
        if (path.includes('.')) {
          const parts = path.split('.')
          const obj = {}
          let ref = obj
          for (let i = 0; i < parts.length - 1; i++) {
            ref[parts[i]] = {}
            ref = ref[parts[i]]
          }
          ref[parts[parts.length - 1]] = val
          return JSON.stringify(obj)
        }
        return JSON.stringify({ [path]: val })
      }

      // Pattern: param > N → suggest { param: N + 1 }
      const gtMatch = cond && cond.match(/^(\w+(?:\.\w+)*)\s*(>=|>)\s*(\d+(?:\.\d+)?)$/)
      if (gtMatch) {
        const val = gtMatch[2] === '>' ? parseFloat(gtMatch[3]) + 1 : parseFloat(gtMatch[3])
        return JSON.stringify({ [gtMatch[1].split('.')[0]]: val })
      }

      // Pattern: typeof param === 'type' → suggest { param: type_default }
      const typeofMatch = cond && cond.match(/typeof\s+(\w+)\s*(?:===|==)\s*['"](\w+)['"]$/)
      if (typeofMatch) {
        const defaults = { string: 'test', number: 0, boolean: true, object: {}, function: '() => {}' }
        return JSON.stringify({ [typeofMatch[1]]: defaults[typeofMatch[2]] || null })
      }

      // Fallback: generic suggestion
      return cond ? `"input triggering: ${cond}"` : '{}'
    }

    case 'else':
    case 'default':
      return '"input not matching any other branch"'

    case 'case':
      return cond ? JSON.stringify(cond.replace(/^['"]|['"]$/g, '')) : '"case_value"'

    case 'ternary':
      return cond ? `"input making ${cond} truthy"` : '{}'

    case 'early-return':
      return cond ? `"input triggering return: ${cond}"` : 'null'

    case 'throw':
      return cond ? `"input triggering throw: ${cond}"` : 'null'

    default:
      return '{}'
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function resolvePath(obj, path) {
  if (obj === null || obj === undefined) return undefined
  const parts = path.split('.')
  let val = obj
  for (const p of parts) {
    if (val === null || val === undefined) return undefined
    val = val[p]
  }
  return val
}

// ─── Main analysis ────────────────────────────────────────────────────────────

const results = []
let totalBranches = 0
let totalCovered = 0

for (const cluster of clusters) {
  const { id, entry, file, stack, inputs = [] } = cluster

  // Only analyze JS/TS stacks (static analysis for JS source)
  if (stack && stack !== 'js' && stack !== 'ts') {
    if (!jsonMode) {
      console.log(`  ⏭️  ${id}: stack=${stack} — branch analysis only supports js/ts`)
    }
    continue
  }

  const filePath = resolve(process.cwd(), file)
  if (!existsSync(filePath)) {
    if (!jsonMode) {
      console.warn(`  ⚠️  ${id}: file not found: ${file}`)
    }
    results.push({
      id,
      entry,
      totalBranches: 0,
      coveredBranches: 0,
      coveragePercent: 0,
      status: 'file-not-found',
      branches: [],
      warning: `File not found: ${file}`,
    })
    continue
  }

  const source = readFileSync(filePath, 'utf8')

  // Extract the entry function
  const funcInfo = extractFunction(source, entry)
  if (!funcInfo) {
    if (!jsonMode) {
      console.warn(`  ⚠️  ${id}: function "${entry}" not found in ${file}`)
    }
    results.push({
      id,
      entry,
      totalBranches: 0,
      coveredBranches: 0,
      coveragePercent: 0,
      status: 'function-not-found',
      branches: [],
      warning: `Function "${entry}" not found in ${file}`,
    })
    continue
  }

  // Detect branches in the function
  const branches = detectBranches(funcInfo.body, funcInfo.startLine)

  // Check coverage for each branch
  const annotatedBranches = branches.map(b => {
    const { covered, coveredBy } = checkCoverage(b, inputs)
    const result = {
      line: b.line,
      type: b.type,
      condition: b.condition,
      covered,
    }
    if (covered && coveredBy !== null) {
      result.coveredBy = coveredBy
    }
    if (!covered) {
      result.suggestedInput = suggestInput(b)
    }
    return result
  })

  const coveredCount = annotatedBranches.filter(b => b.covered).length
  const coveragePercent = branches.length > 0
    ? Math.round((coveredCount / branches.length) * 100)
    : 100

  totalBranches += branches.length
  totalCovered += coveredCount

  let status = 'well-covered'
  if (branches.length === 0) {
    status = 'no-branches'
  } else if (coveragePercent < 100) {
    status = 'under-covered'
  }

  results.push({
    id,
    entry,
    file,
    totalBranches: branches.length,
    coveredBranches: coveredCount,
    coveragePercent,
    status,
    branches: annotatedBranches,
  })
}

// ─── Output ───────────────────────────────────────────────────────────────────

if (jsonMode) {
  const summaryPercent = totalBranches > 0
    ? Math.round((totalCovered / totalBranches) * 100)
    : 100

  const output = {
    clusters: results,
    summary: {
      total: totalBranches,
      covered: totalCovered,
      percent: summaryPercent,
    },
  }
  console.log(JSON.stringify(output, null, 2))
} else {
  // Human-readable output
  console.log('\n📊 Branch Coverage Analysis\n')

  for (const cluster of results) {
    console.log(`  cluster: ${cluster.id}`)
    if (cluster.file) {
      console.log(`    entry: ${cluster.entry}  file: ${cluster.file}`)
    }

    if (cluster.warning) {
      console.log(`    ⚠️  ${cluster.warning}`)
      console.log('')
      continue
    }

    if (cluster.totalBranches === 0) {
      console.log(`    No conditional branches detected in "${cluster.entry}"`)
      console.log('')
      continue
    }

    console.log(`    Branches detected: ${cluster.totalBranches}`)

    for (const branch of cluster.branches) {
      const icon = branch.covered ? '✅' : '❌'
      const conditionStr = branch.condition
        ? ` ${branch.condition}`
        : ''
      const typeLabel = branch.type !== 'if'
        ? `(${branch.type}) `
        : ''

      if (branch.covered) {
        const byStr = branch.coveredBy ? ` → covered by input: ${branch.coveredBy}` : ''
        console.log(`      ${icon} line ${branch.line}: ${typeLabel}${conditionStr}${byStr}`)
      } else {
        console.log(`      ${icon} line ${branch.line}: ${typeLabel}${conditionStr} → NOT COVERED — add input: ${branch.suggestedInput}`)
      }
    }

    console.log(`    Coverage: ${cluster.coveredBranches}/${cluster.totalBranches} (${cluster.coveragePercent}%)`)

    if (cluster.status === 'under-covered') {
      console.log(`    Status: UNDER-COVERED — add inputs for uncovered branches`)
    } else if (cluster.status === 'well-covered') {
      console.log(`    Status: WELL-COVERED`)
    }

    console.log('')
  }

  // Summary
  const summaryPercent = totalBranches > 0
    ? Math.round((totalCovered / totalBranches) * 100)
    : 100

  console.log(`  Summary: ${totalCovered}/${totalBranches} branches covered (${summaryPercent}%)`)

  if (results.some(r => r.status === 'under-covered')) {
    console.log(`  ⚠️  Some clusters are UNDER-COVERED — add inputs for uncovered branches`)
  } else if (results.every(r => r.status === 'well-covered' || r.status === 'no-branches')) {
    console.log(`  ✅ All clusters well-covered`)
  }
}

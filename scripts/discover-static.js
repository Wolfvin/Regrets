#!/usr/bin/env node
// discover-static.js — Zero-execution static analysis for regret discover
// Analyzes JS/TS source files without importing or executing them,
// finding function calls in the entry function body and cross-referencing
// with import declarations to suggest watches.
//
// Usage:
//   node scripts/discover-static.js --entry <fnName> --file <path>
//   node scripts/discover-static.js --entry <fnName> --file <path> --out regrets/manifest.json
//
// When to use --static instead of runtime discover:
//   - Module has heavy side effects on import
//   - Dependencies are not installed
//   - Agent wants a preview before running code

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs'
import { resolve, dirname } from 'path'

// ─── CLI args ─────────────────────────────────────────────────────────────────

const args = process.argv.slice(2)

function getFlagValue(flag) {
  const idx = args.indexOf(flag)
  return idx !== -1 && idx + 1 < args.length ? args[idx + 1] : null
}

const entryName = getFlagValue('--entry')
const filePath = getFlagValue('--file')
const outPath = getFlagValue('--out')

if (!entryName || !filePath) {
  console.error('❌ Usage: regret discover --static --entry <fnName> --file <path>')
  console.error('   Optional: --out regrets/manifest.json')
  process.exit(1)
}

const absFilePath = resolve(process.cwd(), filePath)

if (!existsSync(absFilePath)) {
  console.error(`❌ File not found: ${absFilePath}`)
  process.exit(1)
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * Extract a named function body from source code using regex + brace matching.
 * Same technique as branches.js extractFunction / extractBlockBody.
 * Returns { body: string, startLine: number } or null.
 */
function extractFunction(source, funcName) {
  const lines = source.split('\n')

  // Strategy 1: exported function declaration
  // Matches: export function name(...) { | function name(...) { | export async function name(...)
  const funcDeclRe = new RegExp(
    `(?:export\\s+)?(?:async\\s+)?function\\s+${escapeRegex(funcName)}\\s*\\(`
  )

  // Strategy 2: const/let/var name = function/arrow
  // Matches: export const name = (...) => { | const name = function(
  const varFuncRe = new RegExp(
    `(?:export\\s+)?(?:const|let|var)\\s+${escapeRegex(funcName)}\\s*=\\s*(?:async\\s+)?(?:function\\s*\\(|[\\(])`
  )

  // Strategy 3: method in object/class
  // Matches: name(...) { | async name(...) {
  const methodRe = new RegExp(
    `(?:^|\\s)${escapeRegex(funcName)}\\s*\\(`
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
 * Extract balanced-brace block starting from the line containing the function
 * declaration. Returns concatenated text and start line.
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

  // Single-expression arrow: const fn = (x) => x + 1  (no braces)
  if (!foundOpen && bodyLines.length > 0) {
    return { text: bodyLines.join('\n'), startLine: startLineIdx + 1 }
  }

  return null
}

// ─── Import extractor ─────────────────────────────────────────────────────────
// Parses import declarations from the source file.
// Returns Map<string, string[]> — module path → array of imported names

function extractImports(source) {
  const imports = new Map()

  // Match: import { a, b, c } from './module'
  // Match: import { a as alias, b } from './module'
  // Match: import defaultExport from './module'
  // Match: import * as ns from './module'
  const importRe = /import\s+([\s\S]*?)\s+from\s+['"]([^'"]+)['"]/g
  let match
  while ((match = importRe.exec(source)) !== null) {
    const specifier = match[1].trim()
    const modulePath = match[2]
    const names = []

    // Named imports: { a, b as alias, c }
    const namedMatch = specifier.match(/\{([^}]+)\}/)
    if (namedMatch) {
      const parts = namedMatch[1].split(',')
      for (const part of parts) {
        const trimmed = part.trim()
        if (!trimmed) continue
        // "a as alias" → take alias; "a" → take a
        const asMatch = trimmed.match(/^(\S+)\s+as\s+(\S+)$/)
        if (asMatch) {
          names.push(asMatch[2])  // use the local name (alias)
        } else {
          names.push(trimmed)
        }
      }
    }

    // Default import: import Foo from './module'
    const defaultMatch = specifier.match(/^(\w+)/)
    if (defaultMatch && !specifier.includes('{')) {
      names.push(defaultMatch[1])
    }

    // Namespace import: import * as ns from './module'
    const nsMatch = specifier.match(/\*\s+as\s+(\w+)/)
    if (nsMatch) {
      names.push(nsMatch[1])
    }

    if (names.length > 0) {
      imports.set(modulePath, names)
    }
  }

  // Also match require: const { a, b } = require('./module')
  const requireRe = /(?:const|let|var)\s+(?:\{([^}]+)\}|(\w+))\s*=\s*require\s*\(\s*['"]([^'"]+)['"]\s*\)/g
  while ((match = requireRe.exec(source)) !== null) {
    const namedPart = match[1]
    const defaultPart = match[2]
    const modulePath = match[3]
    const names = []

    if (namedPart) {
      const parts = namedPart.split(',')
      for (const part of parts) {
        const trimmed = part.trim()
        if (!trimmed) continue
        const asMatch = trimmed.match(/^(\S+)\s+as\s+(\S+)$/)
        if (asMatch) {
          names.push(asMatch[2])
        } else {
          names.push(trimmed)
        }
      }
    } else if (defaultPart) {
      names.push(defaultPart)
    }

    if (names.length > 0) {
      // Merge with existing imports from same module
      const existing = imports.get(modulePath) || []
      imports.set(modulePath, [...new Set([...existing, ...names])])
    }
  }

  return imports
}

// ─── Function call detector ──────────────────────────────────────────────────
// Finds all function calls in a function body via regex.
// Returns array of { name, kind } where kind is 'direct' | 'method' | 'awaited'

function detectCalls(funcBody, entryName) {
  const calls = []
  const seen = new Set()

  // Direct calls: fnName(...), but not keywords like if, while, for, switch, etc.
  const JS_KEYWORDS = new Set([
    'if', 'else', 'for', 'while', 'do', 'switch', 'case', 'return', 'throw',
    'try', 'catch', 'finally', 'new', 'typeof', 'instanceof', 'delete', 'void',
    'break', 'continue', 'class', 'extends', 'import', 'export', 'function',
    'const', 'let', 'var', 'async', 'await', 'yield', 'super', 'this',
    'console', 'require', 'module', 'exports', 'true', 'false', 'null', 'undefined'
  ])

  // Exclude the entry function itself (the declaration line matches fnName( patterns)
  const SKIP_NAMES = new Set([entryName])

  // await fn(...) — awaited direct calls
  const awaitCallRe = /await\s+([a-zA-Z_$][\w$]*)\s*\(/g
  let match
  while ((match = awaitCallRe.exec(funcBody)) !== null) {
    const name = match[1]
    if (!JS_KEYWORDS.has(name) && !SKIP_NAMES.has(name) && !seen.has(name)) {
      seen.add(name)
      calls.push({ name, kind: 'awaited' })
    }
  }

  // Method calls: obj.method(...)
  const methodCallRe = /([a-zA-Z_$][\w$]*)\.([a-zA-Z_$][\w$]*)\s*\(/g
  while ((match = methodCallRe.exec(funcBody)) !== null) {
    const obj = match[1]
    const method = match[2]
    // Skip known built-in methods
    const BUILTIN_OBJECTS = new Set([
      'console', 'Math', 'JSON', 'Object', 'Array', 'String', 'Number',
      'Promise', 'Map', 'Set', 'Date', 'Error', 'Symbol', 'RegExp',
      'parseInt', 'parseFloat', 'isNaN', 'isFinite'
    ])
    const BUILTIN_METHODS = new Set([
      'toString', 'valueOf', 'hasOwnProperty', 'length', 'constructor',
      'push', 'pop', 'shift', 'unshift', 'slice', 'splice', 'concat',
      'join', 'indexOf', 'forEach', 'map', 'filter', 'reduce', 'find',
      'some', 'every', 'includes', 'keys', 'values', 'entries',
      'replace', 'split', 'substring', 'trim', 'toLowerCase', 'toUpperCase',
      'parse', 'stringify', 'assign', 'freeze', 'create', 'defineProperty',
      'then', 'catch', 'finally', 'resolve', 'reject', 'all', 'race'
    ])
    if (!BUILTIN_OBJECTS.has(obj) && !BUILTIN_METHODS.has(method)) {
      const key = `${obj}.${method}`
      if (!seen.has(key)) {
        seen.add(key)
        calls.push({ name: method, fullName: key, kind: 'method' })
      }
    }
  }

  // Direct calls: fnName(...) — must come after await/method to avoid duplicates
  const directCallRe = /(?<![.\w$])([a-zA-Z_$][\w$]*)\s*\(/g
  while ((match = directCallRe.exec(funcBody)) !== null) {
    const name = match[1]
    if (!JS_KEYWORDS.has(name) && !SKIP_NAMES.has(name) && !seen.has(name)) {
      seen.add(name)
      calls.push({ name, kind: 'direct' })
    }
  }

  return calls
}

// ─── Execution mode inference ─────────────────────────────────────────────────

function inferMode(source) {
  const hints = []

  // Check for `new ClassName` usage
  const newRe = /new\s+([A-Z][\w$]*)\s*\(/
  const newMatch = source.match(newRe)
  if (newMatch) {
    hints.push({ mode: 'classMethod', detail: `Found "new ${newMatch[1]}(...)" — consider classMethod mode` })
  }

  // Check for `export class`
  const exportClassRe = /export\s+(?:default\s+)?class\s+([A-Z][\w$]*)/
  const exportClassMatch = source.match(exportClassRe)
  if (exportClassMatch) {
    hints.push({ mode: 'classExport', detail: `Found "export class ${exportClassMatch[1]}" — class export detected` })
  }

  // Check for async function
  const asyncRe = /(?:export\s+)?async\s+function\s/
  if (asyncRe.test(source)) {
    hints.push({ mode: 'async', detail: 'Async functions detected — ensure inputs cover async paths' })
  }

  if (hints.length === 0) {
    hints.push({ mode: 'function', detail: 'Default: function mode' })
  }

  return hints
}

// ─── Main analysis ────────────────────────────────────────────────────────────

const source = readFileSync(absFilePath, 'utf8')

console.log(`\n🔍 [STATIC] Analyzing: ${entryName}`)
console.log(`   File: ${filePath}\n`)

// Step 1: Extract entry function body
const funcInfo = extractFunction(source, entryName)
if (!funcInfo) {
  console.error(`❌ Could not find function "${entryName}" in ${filePath}`)
  console.error('   Static analysis requires the function to be defined in the file.')
  console.error('   Patterns supported: function name(){}, const name = () => {}, method(){}')
  process.exit(1)
}

console.log(`   Found "${entryName}" at line ${funcInfo.startLine}\n`)

// Step 2: Extract imports from the whole file
const imports = extractImports(source)
const importedNames = new Set()
for (const names of imports.values()) {
  for (const name of names) {
    importedNames.add(name)
  }
}

if (imports.size > 0) {
  console.log('   Imports detected:')
  for (const [mod, names] of imports) {
    console.log(`     ${mod} → ${names.join(', ')}`)
  }
  console.log()
}

// Step 3: Find function calls in entry body
const calls = detectCalls(funcInfo.body, entryName)

// Step 4: Cross-reference calls with imports → watches
const watches = []
const unresolveableCalls = []
const callAnnotations = new Map()  // name → annotation string

for (const call of calls) {
  const isImported = importedNames.has(call.name) ||
    (call.kind === 'method' && importedNames.has(call.fullName.split('.')[0]))

  if (isImported) {
    watches.push(call.name)
    const suffix = call.kind === 'awaited' ? ' (awaited)' : ''
    callAnnotations.set(call.name, `called in ${entryName} body (imported)${suffix}`)
  } else {
    unresolveableCalls.push(call)
  }
}

// Step 5: Infer execution mode
const modeHints = inferMode(source)

// ─── Output results ───────────────────────────────────────────────────────────

if (watches.length > 0) {
  console.log('   Found function calls (cross-referenced with imports):')
  for (const w of watches) {
    const annotation = callAnnotations.get(w) || `called in ${entryName} body (imported)`
    console.log(`     ${w}    ← ${annotation}`)
  }
  console.log()
}

if (unresolveableCalls.length > 0) {
  console.log('   Found function calls (source unclear — not in imports):')
  for (const call of unresolveableCalls) {
    const label = call.fullName || call.name
    let note = ''
    if (call.kind === 'method') {
      note = '(method — verify manually)'
    } else if (call.kind === 'awaited') {
      note = '(awaited — may be local or built-in)'
    } else {
      note = '(may be local or built-in)'
    }
    console.log(`     ${label}    ← called in ${entryName} body ${note}`)
  }
  console.log()
}

if (watches.length === 0 && unresolveableCalls.length === 0) {
  console.log('   No function calls found in entry body.\n')
}

// Mode hints
console.log('   Mode inference:')
for (const hint of modeHints) {
  console.log(`     [${hint.mode}] ${hint.detail}`)
}
console.log()

// Warnings
console.log('   ⚠️  Static analysis cannot verify: dynamic calls, computed property access,')
console.log('      Function.prototype.call/apply, eval(), conditional imports')
console.log('   ℹ️  Run without --static for runtime-verified discovery')
console.log()

// ─── Generate manifest ────────────────────────────────────────────────────────

const clusterId = entryName.replace(/([A-Z])/g, '-$1').toLowerCase().replace(/^-/, '')

const manifestEntry = {
  id: clusterId,
  entry: entryName,
  file: filePath,
  stack: filePath.endsWith('.ts') ? 'ts' : 'js',
  fingerprintLevel: watches.length > 0 ? 'entry' : 'entry',
  watches: watches,
  inputs: [null, {}],
  _note: 'Static analysis — verify watches before capture',
  description: `[STATIC] ${entryName} — auto-discovered via static analysis`
}

if (modeHints.some(h => h.mode === 'classMethod')) {
  const newMatch = source.match(/new\s+([A-Z][\w$]*)\s*\(/)
  if (newMatch) {
    manifestEntry.classMethod = entryName
    manifestEntry.constructor = newMatch[1]
  }
}

const manifest = {
  clusters: [manifestEntry]
}

// ─── Output or write manifest ─────────────────────────────────────────────────

if (outPath) {
  const absOutPath = resolve(process.cwd(), outPath)
  const outDir = dirname(absOutPath)

  // If file exists, merge into it
  if (existsSync(absOutPath)) {
    try {
      const existing = JSON.parse(readFileSync(absOutPath, 'utf8'))
      const existingIds = new Set((existing.clusters || []).map(c => c.id))
      if (existingIds.has(manifestEntry.id)) {
        console.log(`   ⚠️  Cluster "${manifestEntry.id}" already exists in ${outPath} — skipping merge`)
      } else {
        existing.clusters = [...(existing.clusters || []), manifestEntry]
        const merged = JSON.stringify(existing, null, 2)
        writeFileSync(absOutPath, merged, 'utf8')
        console.log(`   ✅ Appended cluster "${manifestEntry.id}" to ${outPath}`)
      }
    } catch {
      // If parsing fails, overwrite
      if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true })
      writeFileSync(absOutPath, JSON.stringify(manifest, null, 2), 'utf8')
      console.log(`   ✅ Wrote manifest to ${outPath}`)
    }
  } else {
    if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true })
    writeFileSync(absOutPath, JSON.stringify(manifest, null, 2), 'utf8')
    console.log(`   ✅ Wrote manifest to ${outPath}`)
  }
} else {
  console.log('   Draft manifest (use --out to save):')
  console.log(JSON.stringify(manifest, null, 2))
}

console.log()

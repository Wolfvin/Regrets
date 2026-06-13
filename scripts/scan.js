#!/usr/bin/env node
// scan.js — Project scanner that suggests regret clusters
// Analyzes source files and suggests clusters based on exported functions,
// file size, and function complexity.
//
// Usage:
//   node scripts/scan.js
//   node scripts/scan.js --dir src/
//   node scripts/scan.js --stack js
//   node scripts/scan.js --format manifest   (output as manifest.json snippet)
//
// This tool helps agents who are setting up Regrets for the first time.
// It scans the project, identifies refactor-candidate functions, and suggests
// cluster definitions. The agent still decides which clusters to create —
// this is a SUGGESTION, not a prescription.

import { readFileSync, readdirSync, existsSync, statSync } from 'fs'
import { resolve, join, extname, relative } from 'path'

const args = process.argv.slice(2)
const scanDir = args.includes('--dir') ? args[args.indexOf('--dir') + 1] : '.'
const stackFilter = args.includes('--stack') ? args[args.indexOf('--stack') + 1] : null
const formatManifest = args.includes('--format') && args[args.indexOf('--format') + 1] === 'manifest'
const projectRoot = process.cwd()

// ─── File discovery ───────────────────────────────────────────────────────────

const EXTENSIONS = {
  js: ['.js', '.mjs', '.cjs'],
  ts: ['.ts', '.tsx'],
  python: ['.py'],
  rust: ['.rs'],
  go: ['.go'],
  svelte: ['.svelte'],
}

function discoverFiles(dir, extensions) {
  const files = []
  try {
    const entries = readdirSync(dir, { withFileTypes: true })
    for (const entry of entries) {
      const fullPath = join(dir, entry.name)
      if (entry.isDirectory()) {
        // Skip common non-source directories
        if (['node_modules', '.git', 'dist', 'build', 'target', '__pycache__', 'regrets'].includes(entry.name)) continue
        files.push(...discoverFiles(fullPath, extensions))
      } else if (entry.isFile()) {
        const ext = extname(entry.name)
        if (extensions.includes(ext)) {
          files.push(fullPath)
        }
      }
    }
  } catch { /* skip unreadable dirs */ }
  return files
}

// ─── Function extraction ──────────────────────────────────────────────────────

function extractExportedFunctions(source, ext) {
  const fns = []

  if (ext === '.py') {
    // Python: top-level def statements
    const matches = source.matchAll(/^def\s+(\w+)\s*\(/gm)
    for (const m of matches) fns.push(m[1])
    // Class methods
    const classMatches = source.matchAll(/^\s+def\s+(\w+)\s*\(/gm)
    for (const m of matches) fns.push(m[1])
    return fns
  }

  if (ext === '.rs') {
    // Rust: pub fn
    const matches = source.matchAll(/pub\s+(?:async\s+)?fn\s+(\w+)/g)
    for (const m of matches) fns.push(m[1])
    return fns
  }

  if (ext === '.go') {
    // Go: func (receiver) Name
    const matches = source.matchAll(/func\s+(?:\([^)]+\)\s+)?([A-Z]\w*)/g)
    for (const m of matches) fns.push(m[1])
    return fns
  }

  // JS/TS: exported functions
  // Named export: export function name() / export const name = () => / export async function name()
  const namedExportFn = source.matchAll(/export\s+(?:async\s+)?function\s+(\w+)/g)
  for (const m of namedExportFn) fns.push(m[1])

  // Arrow function exports: export const name = () => { / export const name = (args) => {
  const arrowExports = source.matchAll(/export\s+const\s+(\w+)\s*=\s*(?:async\s*)?\(/g)
  for (const m of arrowExports) fns.push(m[1])

  // Default export function
  const defaultExportFn = source.matchAll(/export\s+default\s+function\s+(\w+)/g)
  for (const m of defaultExportFn) fns.push(m[1])

  // Module.exports style
  const moduleExports = source.matchAll(/module\.exports\.(\w+)\s*=/g)
  for (const m of moduleExports) fns.push(m[1])

  // Svelte component functions (from <script> blocks)
  if (ext === '.svelte') {
    const scriptMatch = source.match(/<script[^>]*>([\s\S]*?)<\/script>/)
    if (scriptMatch) {
      const innerFns = extractExportedFunctions(scriptMatch[1], '.js')
      fns.push(...innerFns)
    }
  }

  return [...new Set(fns)]
}

// ─── Complexity estimation ────────────────────────────────────────────────────

function estimateComplexity(source, functionName) {
  // Simple McCabe cyclomatic complexity approximation
  const fnBody = extractJsFunctionBody(source, functionName)
  if (!fnBody) return 1

  let complexity = 1
  const patterns = [
    /\bif\b/g,
    /\belse\s+if\b/g,
    /\belse\b/g,
    /\bfor\b/g,
    /\bwhile\b/g,
    /\bcase\b/g,
    /\bcatch\b/g,
    /&&/g,
    /\|\|/g,
    /\?\s*[^:]+\s*:/g,  // ternary
  ]
  for (const p of patterns) {
    const matches = fnBody.match(p)
    if (matches) complexity += matches.length
  }
  return complexity
}

function extractJsFunctionBody(source, functionName) {
  // Try to find function and extract its body
  const patterns = [
    new RegExp(`(?:export\\s+)?(?:async\\s+)?function\\s+${escapeRegex(functionName)}\\s*\\([^)]*\\)\\s*\\{`),
    new RegExp(`(?:export\\s+)?const\\s+${escapeRegex(functionName)}\\s*=\\s*(?:async\\s*)?\\([^)]*\\)\\s*=>\\s*\\{`),
    new RegExp(`(?:export\\s+)?const\\s+${escapeRegex(functionName)}\\s*=\\s*(?:async\\s*)?\\w+\\s*=>\\s*\\{`),
  ]

  for (const pattern of patterns) {
    const match = source.match(pattern)
    if (match) {
      let depth = 0
      let i = match.index + match[0].length - 1
      for (; i < source.length; i++) {
        if (source[i] === '{') depth++
        else if (source[i] === '}') {
          depth--
          if (depth === 0) break
        }
      }
      return source.slice(match.index + match[0].length, i)
    }
  }
  return null
}

function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

// ─── Determine stack from file extension ──────────────────────────────────────

function stackFromExt(ext) {
  if (['.js', '.mjs', '.cjs'].includes(ext)) return 'js'
  if (['.ts', '.tsx'].includes(ext)) return 'ts'
  if (ext === '.py') return 'python'
  if (ext === '.rs') return 'rust'
  if (ext === '.go') return 'go'
  if (ext === '.svelte') return 'js'  // Svelte compiles to JS
  return 'js'
}

// ─── Barrel file detection ────────────────────────────────────────────────────
// Detects files that re-export from other modules (barrel/index files).
// These are important for factory-pattern libraries like mathjs where
// individual source files export factory functions (not callable functions)
// and the barrel file exports the instantiated versions.

function isBarrelFile(source) {
  const reExportPatterns = [
    /export\s+\*\s+from\s+['"]/g,        // export * from '...'
    /export\s+\{[^}]+\}\s+from\s+['"]/g,  // export { x } from '...'
  ]
  let reExportCount = 0
  for (const pattern of reExportPatterns) {
    const matches = source.match(pattern)
    if (matches) reExportCount += matches.length
  }
  // A barrel file typically has many re-exports and little actual code
  const lines = source.split('\n').filter(l => l.trim() && !l.trim().startsWith('//')).length
  return reExportCount >= 5 && reExportCount / lines > 0.3
}

// ─── Factory pattern detection ────────────────────────────────────────────────
// Detects files that use a factory pattern (e.g., mathjs, where functions
// are created via factory(name, deps, createFn) and exported as createXxx).

function detectFactoryPattern(source) {
  const factoryPatterns = [
    /factory\s*\(\s*['"`]\w+['"`]\s*,/,              // factory('name', deps, fn)
    /export\s+(?:const|var|let)\s+create\w+\s*=\s*\/\*.*\*\/\s*factory\s*\(/,  // export const createX = factory(
    /create\w+\s*\.\s*isFactory\s*=\s*true/,          // createX.isFactory = true
  ]
  for (const pattern of factoryPatterns) {
    if (pattern.test(source)) return true
  }
  return false
}

// ─── Extract barrel exports ───────────────────────────────────────────────────
// From a barrel file, extract the names of exported functions.

function extractBarrelExports(source) {
  const exports = []

  // export { add, subtract, multiply } from '...'
  const namedExports = source.matchAll(/export\s+\{([^}]+)\}\s+from\s+['"][^'"]+['"]/g)
  for (const m of namedExports) {
    const names = m[1].split(',').map(n => n.trim().split(/\s+as\s+/).pop().trim()).filter(Boolean)
    exports.push(...names)
  }

  // export * from '...' (can't know names without importing)
  // We note these as wildcard exports
  const wildcardExports = source.matchAll(/export\s+\*\s+from\s+['"]([^'"]+)['"]/g)
  for (const m of wildcardExports) {
    exports.push(`*from:${m[1]}`)
  }

  // export var/function/const name = ...
  const directExports = source.matchAll(/export\s+(?:var|let|const|function)\s+(\w+)/g)
  for (const m of directExports) {
    exports.push(m[1])
  }

  return [...new Set(exports)]
}

// ─── Main ─────────────────────────────────────────────────────────────────────

console.log('\n📡 Scanning project for cluster suggestions...\n')

const allExtensions = Object.values(EXTENSIONS).flat()
const files = discoverFiles(resolve(projectRoot, scanDir), allExtensions)

if (!files.length) {
  console.log('No source files found. Try --dir to specify a different directory.')
  process.exit(0)
}

const suggestions = []
const barrelFiles = []
const factoryFiles = []

for (const filePath of files) {
  const ext = extname(filePath)
  const relPath = relative(projectRoot, filePath)
  const stack = stackFromExt(ext)

  if (stackFilter && stack !== stackFilter && !(stackFilter === 'js' && stack === 'ts')) continue

  let source
  try {
    source = readFileSync(filePath, 'utf8')
  } catch { continue }

  // Detect barrel files
  if (isBarrelFile(source)) {
    const barrelExports = extractBarrelExports(source)
    barrelFiles.push({ file: relPath, exportCount: barrelExports.length, exports: barrelExports.slice(0, 30) })
  }

  // Detect factory pattern
  if (detectFactoryPattern(source)) {
    factoryFiles.push(relPath)
  }

  const lines = source.split('\n').length
  const fns = extractExportedFunctions(source, ext)

  // Only suggest files with exported functions
  if (fns.length === 0) continue

  // Filter out obvious non-pure functions (heuristic)
  const pureFns = fns.filter(fn => {
    // Skip DOM/UI related functions
    const lowerFn = fn.toLowerCase()
    if (lowerFn.includes('render') || lowerFn.includes('component') ||
        lowerFn.includes('style') || lowerFn.includes('mount') ||
        lowerFn.includes('effect') || lowerFn.includes('layout')) return false
    return true
  })

  if (pureFns.length === 0) continue

  for (const fn of pureFns) {
    const complexity = estimateComplexity(source, fn)

    // Only suggest functions with some complexity (pure getters are boring)
    suggestions.push({
      function: fn,
      file: relPath,
      stack,
      complexity,
      fileSize: lines,
      isFactory: detectFactoryPattern(source),
    })
  }
}

// Sort by complexity (most complex = highest refactor priority)
suggestions.sort((a, b) => b.complexity - a.complexity)

if (formatManifest) {
  // Output as manifest.json snippet
  const clusters = suggestions.slice(0, 20).map((s, i) => ({
    id: s.function.replace(/([A-Z])/g, '-$1').toLowerCase().replace(/^-/, ''),
    entry: s.function,
    watches: [s.function],
    file: s.file,
    stack: s.stack,
    fingerprintLevel: 'entry',
    description: `Cluster for ${s.function} in ${s.file}`,
    inputs: [],
  }))

  console.log(JSON.stringify({ clusters }, null, 2))
} else {
  // Human-readable report
  console.log('CLUSTER SUGGESTIONS')
  console.log('─'.repeat(90))
  console.log(
    'function'.padEnd(30) +
    'file'.padEnd(35) +
    'complexity'.padEnd(12) +
    'stack'
  )
  console.log('─'.repeat(90))

  for (const s of suggestions.slice(0, 30)) {
    const complexityLabel = s.complexity >= 5 ? '🔴 HIGH' : s.complexity >= 3 ? '🟡 MED' : '✅ LOW'
    console.log(
      s.function.padEnd(30) +
      s.file.padEnd(35) +
      `${s.complexity} ${complexityLabel}`.padEnd(12) +
      s.stack
    )
  }

  console.log('─'.repeat(90))
  console.log(`\nFound ${suggestions.length} candidate function(s). Showing top ${Math.min(30, suggestions.length)}.`)

  const highComplexity = suggestions.filter(s => s.complexity >= 5)
  if (highComplexity.length > 0) {
    console.log(`\n🔴 High-complexity functions (refactor candidates):`)
    for (const s of highComplexity) {
      console.log(`  ${s.function} in ${s.file} (complexity: ${s.complexity})`)
    }
  }

  // Report barrel files
  if (barrelFiles.length > 0) {
    console.log(`\n📦 Barrel files detected (re-export aggregators):`)
    for (const b of barrelFiles) {
      console.log(`  ${b.file} (${b.exportCount} exports)`)
      if (b.exports.length > 0 && b.exports.length <= 10) {
        console.log(`    Exports: ${b.exports.join(', ')}`)
      } else if (b.exports.length > 10) {
        console.log(`    Exports: ${b.exports.slice(0, 10).join(', ')} ... (+${b.exportCount - 10} more)`)
      }
    }
    console.log(`\n  💡 Barrel files aggregate exports from sub-modules. For factory-pattern projects,`)
    console.log(`     use the barrel file as the 'file' in manifest.json — it exports instantiated functions.`)
    console.log(`     Example: { "file": "lib/esm/index.js", "entry": "add", ... }`)
  }

  // Report factory pattern files
  const factorySuggestions = suggestions.filter(s => s.isFactory)
  if (factorySuggestions.length > 0) {
    console.log(`\n🏭 Factory pattern detected in ${factoryFiles.length} file(s).`)
    console.log(`   ${factorySuggestions.length} function(s) use the factory pattern (e.g., createAdd, createMultiply).`)
    console.log(`   ⚠️  Factory exports are NOT directly callable — they need dependency injection first.`)
    console.log(`   Use the compiled barrel file (e.g., lib/esm/index.js) as the entry point instead.`)
    console.log(`   The barrel file exports the instantiated functions: add, multiply, sin, etc.`)
    console.log(`   Example manifest entry:`)
    console.log(`     { "id": "arithmetic-add", "entry": "add", "file": "lib/esm/index.js", `)
    console.log(`       "watches": ["add", "addScalar"], "outputTransform": "pojo" }`)
  }

  console.log(`\n💡 Tip: Run with --format manifest to generate a manifest.json starting point.`)
  console.log(`   Then edit the manifest to add representative inputs for each cluster.`)
  console.log()
}

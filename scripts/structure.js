#!/usr/bin/env node
// structure.js — Structural analysis for refactoring target identification
//
// Identifies God Objects, pure vs impure function classification,
// and refactoring priorities in a codebase. This fills the gap where
// `regret scan` finds candidate functions but doesn't help you understand
// the STRUCTURE of the codebase and where refactoring would be most impactful.
//
// Usage:
//   node scripts/structure.js
//   node scripts/structure.js --dir src/
//   node scripts/structure.js --threshold 300      (line count for God Object detection)
//   node scripts/structure.js --format json         (machine-readable output)
//   node scripts/structure.js --format manifest     (generate manifest.json for pure functions)
//
// This addresses the gap found in the Coretax-Auto-Downloader Chrome extension:
// When approaching a 2721-line God Object like sidepanel.ts, `regret scan` shows
// exported functions but doesn't tell you:
//   1. Which files are too large and need splitting
//   2. Which functions are pure (fingerprintable) vs. impure (DOM/chrome/network)
//   3. What the import dependency graph looks like
//   4. Which files have the highest coupling (import count)
//   5. Which refactoring targets would unlock the most clusters

import { readFileSync, readdirSync, existsSync, statSync } from 'fs'
import { resolve, join, extname, relative, basename, dirname } from 'path'

// ─── CLI args ─────────────────────────────────────────────────────────────────

const args = process.argv.slice(2)
const scanDir = args.includes('--dir') ? args[args.indexOf('--dir') + 1] : '.'
const threshold = parseInt(args[args.indexOf('--threshold') + 1] ?? '300', 10)
const formatArg = args.includes('--format') ? args[args.indexOf('--format') + 1] : null
const stackFilter = args.includes('--stack') ? args[args.indexOf('--stack') + 1] : null
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
        if (['node_modules', '.git', 'dist', 'build', 'target', '__pycache__', 'regrets', '.vscode', '.claude'].includes(entry.name)) continue
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

// ─── Impurity heuristics ──────────────────────────────────────────────────────
// Patterns that indicate a function or module has side effects or external
// dependencies that make it hard/impossible to fingerprint directly.

const IMPURITY_PATTERNS_JS = [
  /\bchrome\.\w+\b/,            // chrome.* APIs (storage, tabs, runtime, etc.)
  /\bdocument\.\w+\b/,          // DOM access
  /\bwindow\.\w+\b/,            // window global
  /\blocalStorage\b/,           // localStorage
  /\bsessionStorage\b/,         // sessionStorage
  /\bfetch\s*\(/,               // network requests
  /\bXMLHttpRequest\b/,         // network requests
  /\baddEventListener\b/,       // event listeners
  /\bremoveEventListener\b/,    // event listeners
  /\bsetTimeout\b/,             // timers
  /\bsetInterval\b/,            // timers
  /\bnew Worker\b/,             // web workers
  /\bimportScripts\b/,          // web workers
  /\bpostMessage\b/,            // message passing
  /\bnavigator\.\w+\b/,         // browser APIs
  /\bcrypto\.\w+\b/,            // crypto (non-deterministic)
  /\bMath\.random\b/,           // random
  /\bDate\.now\b/,              // current time
  /\bnew Date\(\)/,             // current time (without args)
  /\bconsole\.\w+\b/,           // console (side effect)
  /\.innerHTML\b/,              // DOM mutation
  /\.textContent\b/,            // DOM access
  /\.appendChild\b/,            // DOM mutation
  /\.removeChild\b/,            // DOM mutation
  /\.style\.\w+\b/,            // DOM styling
  /\.classList\b/,              // DOM classes
  /\brequestAnimationFrame\b/,  // animation frame
  /\bMutationObserver\b/,       // DOM observer
  /\bIntersectionObserver\b/,   // DOM observer
  /\bResizeObserver\b/,         // DOM observer
]

const IMPURITY_PATTERNS_TS = [
  ...IMPURITY_PATTERNS_JS,
  /\bangular\.\w+\b/,           // Angular APIs
  /\bReact\.\w+\b/,             // React top-level API
  /\buseEffect\b/,              // React hooks (side effects)
  /\buseLayoutEffect\b/,        // React hooks (side effects)
  /\buseRef\b/,                 // React ref (mutable)
  /\buseState\b/,               // React state (not pure)
]

const IMPURITY_PATTERNS_PY = [
  /\bimport\s+os\b/,            // OS access
  /\bimport\s+sys\b/,           // system access
  /\bimport\s+subprocess\b/,    // subprocess
  /\bopen\s*\(/,                // file I/O
  /\brequests\.\w+\b/,         // HTTP
  /\bos\.\w+\b/,                // OS access
  /\bsys\.\w+\b/,               // system access
  /\bprint\s*\(/,               // console output
  /\binput\s*\(/,               // console input
  /\brandom\.\w+\b/,            // random
  /\bdatetime\.datetime\.now/,  // current time
  /\bsocket\.\w+\b/,            // network
  /\bhttp\.\w+\b/,              // HTTP
  /\bflask\.\w+\b/,             // web framework
  /\bdjango\.\w+\b/,            // web framework
]

// ─── Import extraction ────────────────────────────────────────────────────────

function extractImports(source, ext) {
  const imports = []

  if (ext === '.py') {
    // Python imports
    const importMatches = source.matchAll(/^(?:from|import)\s+([.\w]+)/gm)
    for (const m of importMatches) imports.push(m[1])
    return [...new Set(imports)]
  }

  // JS/TS imports
  // Static imports
  const staticImportMatches = source.matchAll(/import\s+.*?\s+from\s+['"]([^'"]+)['"]/g)
  for (const m of staticImportMatches) imports.push(m[1])

  // Dynamic imports
  const dynamicImportMatches = source.matchAll(/import\s*\(\s*['"]([^'"]+)['"]\s*\)/g)
  for (const m of dynamicImportMatches) imports.push(m[1])

  // require() calls
  const requireMatches = source.matchAll(/require\s*\(\s*['"]([^'"]+)['"]\s*\)/g)
  for (const m of requireMatches) imports.push(m[1])

  return [...new Set(imports)]
}

// ─── Function extraction (enhanced) ───────────────────────────────────────────

function extractFunctions(source, ext) {
  const fns = []

  if (ext === '.py') {
    // Python: top-level def statements with decorators
    const matches = source.matchAll(/^(\s*@[\w.]+[\s\n]*)*\s*def\s+(\w+)\s*\(/gm)
    for (const m of matches) fns.push(m[2])
    return [...new Set(fns)]
  }

  // JS/TS: exported functions
  // Named export: export function name()
  const namedExportFn = source.matchAll(/export\s+(?:async\s+)?function\s+(\w+)/g)
  for (const m of namedExportFn) fns.push(m[1])

  // Arrow function exports: export const name = () =>
  const arrowExports = source.matchAll(/export\s+const\s+(\w+)\s*=\s*(?:async\s*)?\(/g)
  for (const m of arrowExports) fns.push(m[1])

  // Default export function
  const defaultExportFn = source.matchAll(/export\s+default\s+function\s+(\w+)/g)
  for (const m of defaultExportFn) fns.push(m[1])

  // Module.exports style
  const moduleExports = source.matchAll(/module\.exports\.(\w+)\s*=/g)
  for (const m of moduleExports) fns.push(m[1])

  // Export enum
  const enumExports = source.matchAll(/export\s+(?:const\s+)?enum\s+(\w+)/g)
  for (const m of enumExports) fns.push(m[1])

  // Export class
  const classExports = source.matchAll(/export\s+(?:default\s+)?(?:abstract\s+)?class\s+(\w+)/g)
  for (const m of classExports) fns.push(m[1])

  // Export const (non-function) — for type guards, constants
  const constExports = source.matchAll(/export\s+const\s+(\w+)\s*=\s*[^(\n]/g)
  for (const m of constExports) fns.push(m[1])

  // Export type/interface (for reference only)
  const typeExports = source.matchAll(/export\s+(?:type|interface)\s+(\w+)/g)
  for (const m of typeExports) fns.push(`[type] ${m[1]}`)

  return [...new Set(fns)]
}

// ─── Function purity analysis ─────────────────────────────────────────────────

function analyzeFunctionPurity(source, functionName, ext) {
  const fnBody = extractFunctionBody(source, functionName, ext)
  if (!fnBody) return { pure: false, reason: 'function body not found' }

  const patterns = ext === '.py' ? IMPURITY_PATTERNS_PY : IMPURITY_PATTERNS_TS

  const impurities = []
  for (const pattern of patterns) {
    if (pattern.test(fnBody)) {
      // Extract which pattern matched for reporting
      const match = fnBody.match(pattern)
      impurities.push(match[0].trim())
    }
  }

  if (impurities.length > 0) {
    return { pure: false, reason: `uses: ${[...new Set(impurities)].join(', ')}` }
  }

  return { pure: true, reason: 'no side-effect patterns detected' }
}

function extractFunctionBody(source, functionName, ext) {
  if (ext === '.py') {
    const match = source.match(
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

  // JS/TS function body extraction
  const patterns = [
    new RegExp(`(?:export\\s+)?(?:async\\s+)?function\\s+${escapeRegex(functionName)}\\s*\\([^)]*\\)\\s*\\{`, 'm'),
    new RegExp(`(?:export\\s+)?const\\s+${escapeRegex(functionName)}\\s*=\\s*(?:async\\s*)?\\([^)]*\\)\\s*=>\\s*\\{`, 'm'),
    new RegExp(`(?:export\\s+)?const\\s+${escapeRegex(functionName)}\\s*=\\s*(?:async\\s*)?\\w+\\s*=>\\s*\\{`, 'm'),
    // Arrow function with expression body (no braces)
    new RegExp(`(?:export\\s+)?const\\s+${escapeRegex(functionName)}\\s*=\\s*(?:async\\s*)?\\([^)]*\\)\\s*=>\\s*[^{]`, 'm'),
  ]

  for (const pattern of patterns) {
    const match = source.match(pattern)
    if (match) {
      // For expression-body arrows, return the whole line
      if (!source.slice(match.index + match[0].length).trimStart().startsWith('{')) {
        return source.slice(match.index, match.index + 500) // approximate
      }
      return extractBlock(source, match.index + match[0].length - 1)
    }
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

// ─── Module-level purity analysis ─────────────────────────────────────────────

function analyzeModulePurity(source, ext) {
  const patterns = ext === '.py' ? IMPURITY_PATTERNS_PY : IMPURITY_PATTERNS_TS
  const impurities = []

  for (const pattern of patterns) {
    const matches = source.match(pattern)
    if (matches) {
      impurities.push(matches[0].trim())
    }
  }

  return {
    impurities: [...new Set(impurities)],
    isPure: impurities.length === 0,
    impurityCount: impurities.length,
  }
}

// ─── File analysis ────────────────────────────────────────────────────────────

function analyzeFile(filePath, projectRoot) {
  const ext = extname(filePath)
  const relPath = relative(projectRoot, filePath)
  const stack = ext === '.py' ? 'python' : ext === '.rs' ? 'rust' : ext === '.go' ? 'go' : 'js'

  if (stackFilter && stack !== stackFilter && !(stackFilter === 'js' && (ext === '.ts' || ext === '.tsx'))) {
    return null
  }

  let source
  try {
    source = readFileSync(filePath, 'utf8')
  } catch { return null }

  const lines = source.split('\n').length
  const imports = extractImports(source, ext)
  const functions = extractFunctions(source, ext)
  const modulePurity = analyzeModulePurity(source, ext)

  // Filter out type-only exports for function count
  const realFunctions = functions.filter(f => !f.startsWith('[type] '))

  // Analyze purity of each function
  const functionAnalysis = []
  for (const fn of realFunctions) {
    const purity = analyzeFunctionPurity(source, fn, ext)
    functionAnalysis.push({
      name: fn,
      pure: purity.pure,
      reason: purity.reason,
    })
  }

  const pureFunctions = functionAnalysis.filter(f => f.pure).map(f => f.name)
  const impureFunctions = functionAnalysis.filter(f => !f.pure)

  // Classify file
  const isGodObject = lines >= threshold
  const isHighlyCoupled = imports.length >= 10
  const isExportHeavy = realFunctions.length >= 10

  return {
    file: relPath,
    stack,
    lines,
    imports: imports.length,
    importList: imports,
    exports: realFunctions.length,
    exportList: realFunctions,
    typeExports: functions.filter(f => f.startsWith('[type] ')).length,
    pureFunctions,
    pureFunctionCount: pureFunctions.length,
    impureFunctions: impureFunctions.map(f => ({ name: f.name, reason: f.reason })),
    impureFunctionCount: impureFunctions.length,
    modulePurity: modulePurity.isPure ? 'pure' : modulePurity.impurityCount <= 3 ? 'mostly-pure' : 'impure',
    moduleImpurities: modulePurity.impurities,
    isGodObject,
    isHighlyCoupled,
    isExportHeavy,
    refactorPriority: (isGodObject ? 3 : 0) + (isHighlyCoupled ? 2 : 0) + (isExportHeavy ? 1 : 0),
  }
}

// ─── Main ─────────────────────────────────────────────────────────────────────

console.log('\n🏗️  STRUCTURAL ANALYSIS — Refactoring Target Identification\n')

const allExtensions = Object.values(EXTENSIONS).flat()
const files = discoverFiles(resolve(projectRoot, scanDir), allExtensions)

if (!files.length) {
  console.log('No source files found. Try --dir to specify a different directory.')
  process.exit(0)
}

const analyses = []
for (const filePath of files) {
  const result = analyzeFile(filePath, projectRoot)
  if (result) analyses.push(result)
}

// Sort by refactor priority (highest first)
analyses.sort((a, b) => b.refactorPriority - a.refactorPriority)

// ─── JSON output ──────────────────────────────────────────────────────────────

if (formatArg === 'json') {
  console.log(JSON.stringify({ files: analyses, summary: {
    totalFiles: analyses.length,
    godObjects: analyses.filter(a => a.isGodObject).length,
    highlyCoupled: analyses.filter(a => a.isHighlyCoupled).length,
    pureModules: analyses.filter(a => a.modulePurity === 'pure').length,
    totalPureFunctions: analyses.reduce((sum, a) => sum + a.pureFunctionCount, 0),
    totalImpureFunctions: analyses.reduce((sum, a) => sum + a.impureFunctionCount, 0),
  }}, null, 2))
  process.exit(0)
}

// ─── Manifest generation ──────────────────────────────────────────────────────

if (formatArg === 'manifest') {
  const clusters = []
  for (const file of analyses) {
    for (const fn of file.pureFunctions) {
      clusters.push({
        id: fn.replace(/([A-Z])/g, '-$1').toLowerCase().replace(/^-/, ''),
        entry: fn,
        watches: [fn],
        file: file.file,
        stack: file.stack,
        fingerprintLevel: 'entry',
        description: `Auto-detected pure function: ${fn} in ${file.file}`,
        inputs: [], // Agent must fill these in
      })
    }
  }

  // Limit to top 30 to avoid overwhelming manifests
  const limited = clusters.slice(0, 30)
  console.log(JSON.stringify({ clusters: limited, _comment: `Generated ${limited.length} of ${clusters.length} total pure function clusters. Add representative inputs for each.` }, null, 2))
  process.exit(0)
}

// ─── Human-readable report ────────────────────────────────────────────────────

// Summary
const godObjects = analyses.filter(a => a.isGodObject)
const highlyCoupled = analyses.filter(a => a.isHighlyCoupled)
const pureModules = analyses.filter(a => a.modulePurity === 'pure')
const impureModules = analyses.filter(a => a.modulePurity === 'impure')
const totalPureFns = analyses.reduce((sum, a) => sum + a.pureFunctionCount, 0)
const totalImpureFns = analyses.reduce((sum, a) => sum + a.impureFunctionCount, 0)

console.log('SUMMARY')
console.log('─'.repeat(70))
console.log(`  Total source files:      ${analyses.length}`)
console.log(`  God Objects (>${threshold} lines): ${godObjects.length}`)
console.log(`  Highly coupled (≥10 imports): ${highlyCoupled.length}`)
console.log(`  Pure modules:            ${pureModules.length}`)
console.log(`  Impure modules:          ${impureModules.length}`)
console.log(`  Total pure functions:    ${totalPureFns}`)
console.log(`  Total impure functions:  ${totalImpureFns}`)

// God Objects
if (godObjects.length > 0) {
  console.log(`\n\n🔴 GOD OBJECTS (>${threshold} lines) — Split before clustering`)
  console.log('─'.repeat(70))
  for (const f of godObjects) {
    console.log(`  ${f.file}`)
    console.log(`    Lines: ${f.lines} | Imports: ${f.imports} | Exports: ${f.exports}`)
    console.log(`    Pure fns: ${f.pureFunctionCount} | Impure fns: ${f.impureFunctionCount} | Purity: ${f.modulePurity}`)
    if (f.impureFunctions.length > 0) {
      console.log(`    Impurity reasons: ${[...new Set(f.impureFunctions.map(imp => imp.reason.split(': ')[1] || imp.reason))].join(', ')}`)
    }
    if (f.pureFunctions.length > 0) {
      console.log(`    Extractable pure fns: ${f.pureFunctions.join(', ')}`)
    }
  }
}

// Highly coupled files
if (highlyCoupled.length > 0) {
  console.log(`\n\n🟡 HIGHLY COUPLED (≥10 imports) — Reduce dependencies`)
  console.log('─'.repeat(70))
  for (const f of highlyCoupled) {
    console.log(`  ${f.file} (${f.imports} imports)`)
  }
}

// Pure function candidates
const filesWithPureFns = analyses.filter(a => a.pureFunctionCount > 0)
if (filesWithPureFns.length > 0) {
  console.log(`\n\n✅ PURE FUNCTION CANDIDATES — Ready for fingerprinting`)
  console.log('─'.repeat(70))
  for (const f of filesWithPureFns) {
    console.log(`  ${f.file} (${f.pureFunctionCount} pure fn${f.pureFunctionCount !== 1 ? 's' : ''})`)
    for (const fn of f.pureFunctions) {
      console.log(`    • ${fn}`)
    }
  }
}

// Impure modules with extractable logic
const partiallyPure = analyses.filter(a => a.modulePurity !== 'pure' && a.pureFunctionCount > 0)
if (partiallyPure.length > 0) {
  console.log(`\n\n🔧 PARTIALLY PURE — Extract pure logic before clustering`)
  console.log('─'.repeat(70))
  for (const f of partiallyPure) {
    console.log(`  ${f.file}`)
    console.log(`    Module purity: ${f.modulePurity} | Impurities: ${f.moduleImpurities.join(', ')}`)
    console.log(`    Extractable pure fns: ${f.pureFunctions.join(', ')}`)
    console.log(`    → Pattern: Create *-logic.ts with pure fns, keep original as thin wrapper`)
  }
}

// Refactoring priority ranking
const priorityFiles = analyses.filter(a => a.refactorPriority > 0)
if (priorityFiles.length > 0) {
  console.log(`\n\n📊 REFACTORING PRIORITY (God Object×3 + Coupled×2 + Export Heavy×1)`)
  console.log('─'.repeat(70))
  for (const f of priorityFiles.slice(0, 15)) {
    const badges = []
    if (f.isGodObject) badges.push('GOD')
    if (f.isHighlyCoupled) badges.push('COUPLED')
    if (f.isExportHeavy) badges.push('EXPORT-HEAVY')
    console.log(`  ${String(f.refactorPriority).padStart(2)} pts  ${f.file}  [${badges.join(', ')}]`)
  }
}

// Recommendation
console.log(`\n\n💡 NEXT STEPS`)
console.log('─'.repeat(70))
if (godObjects.length > 0) {
  console.log(`  1. Split God Objects first — they block clustering of contained functions`)
  console.log(`     Start with: ${godObjects[0].file} (${godObjects[0].lines} lines)`)
  console.log(`     Extract these pure fns into new modules: ${godObjects[0].pureFunctions.slice(0, 5).join(', ')}${godObjects[0].pureFunctions.length > 5 ? '...' : ''}`)
}
console.log(`  2. Run 'regret scan --format manifest' to generate cluster definitions for pure functions`)
console.log(`  3. Add representative inputs to each cluster in manifest.json`)
console.log(`  4. Run 'regret capture' to capture fingerprints`)
console.log(`  5. Run 'regret drift' to verify stability`)
console.log()

// Export manifest snippet for pure functions if requested
console.log(`Tip: Run with --format manifest to generate a manifest.json starting point from pure functions.`)
console.log(`     Run with --format json for machine-readable output.`)
console.log()

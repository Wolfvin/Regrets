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

// ─── Chrome Extension detection ─────────────────────────────────────────────
// Detects Chrome extension projects and adds appropriate warnings/suggestions.
// Chrome extensions have content scripts that often use IIFEs with no exports,
// making them invisible to the standard export-based scanner.

const CHROME_EXTENSION_MARKERS = [
  'manifest.json',    // Chrome extension manifest
  'chrome.runtime',   // Chrome API usage
  'chrome.tabs',      // Chrome tabs API
  'chrome.scripting', // Chrome scripting API
]

function detectChromeExtension(rootDir) {
  const markers = []
  try {
    // Check for manifest.json with manifest_version
    const manifestPath = resolve(rootDir, 'manifest.json')
    if (existsSync(manifestPath)) {
      const content = readFileSync(manifestPath, 'utf8')
      const manifest = JSON.parse(content)
      if (manifest.manifest_version) {
        markers.push({
          type: 'chrome_extension',
          version: manifest.manifest_version,
          hasContentScripts: !!(manifest.content_scripts?.length),
          hasBackground: !!(manifest.background),
          hasSidePanel: !!(manifest.side_panel),
        })
      }
    }
  } catch { /* not a Chrome extension */ }

  // Also check subdirectories for manifest.json (monorepo pattern)
  try {
    const entries = readdirSync(rootDir, { withFileTypes: true })
    for (const entry of entries) {
      if (entry.isDirectory() && !['node_modules', '.git', 'dist', 'build'].includes(entry.name)) {
        const subManifest = resolve(rootDir, entry.name, 'manifest.json')
        if (existsSync(subManifest)) {
          try {
            const content = readFileSync(subManifest, 'utf8')
            const manifest = JSON.parse(content)
            if (manifest.manifest_version) {
              markers.push({
                type: 'chrome_extension',
                version: manifest.manifest_version,
                hasContentScripts: !!(manifest.content_scripts?.length),
                hasBackground: !!(manifest.background),
                hasSidePanel: !!(manifest.side_panel),
                subdir: entry.name,
              })
            }
          } catch { /* skip invalid */ }
        }
      }
    }
  } catch { /* skip */ }

  return markers
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

// ─── Non-exported / IIFE function detection ──────────────────────────────────
// Chrome extension content scripts and other self-contained modules often use
// IIFEs or non-exported functions. This extractor finds those functions so
// they don't get missed by the export-based scanner.
//
// Returns functions tagged as 'internal' (not exported) for the agent to
// evaluate — they may need an adapter module to be testable by Regrets.

function extractInternalFunctions(source, ext) {
  const fns = []

  if (ext === '.py' || ext === '.rs' || ext === '.go') return fns

  // Non-exported function declarations: function name() / async function name()
  const internalFn = source.matchAll(/(?:^|\n)(?:async\s+)?function\s+(\w+)\s*\(/g)
  for (const m of internalFn) {
    const name = m[1]
    // Skip if already in exported list (checked by caller)
    fns.push({ name, kind: 'function' })
  }

  // Non-exported const/let arrow functions
  const internalArrow = source.matchAll(/(?:^|\n)(?:const|let)\s+(\w+)\s*=\s*(?:async\s*)?\(/g)
  for (const m of internalArrow) {
    fns.push({ name: m[1], kind: 'arrow' })
  }

  // Chrome extension message handlers: chrome.runtime.onMessage.addListener
  const chromeHandlers = source.matchAll(/chrome\.\w+\.\w+\.addListener\s*\(\s*(?:async\s+)?(?:function\s+)?(\w*)/g)
  for (const m of chromeHandlers) {
    if (m[1]) fns.push({ name: m[1], kind: 'chrome-handler' })
  }

  // IIFE entry points: (async () => { ... })() or (function() { ... })()
  const hasIife = /(?:\(async\s*\(\)\s*=>|\(function\s*\(\))/g.test(source)
  if (hasIife) {
    fns.push({ name: '(IIFE)', kind: 'iife' })
  }

  return fns
}

// ─── Large file detection ───────────────────────────────────────────────────
// Files over 300 lines are refactor candidates even if they have no exported
// functions. This detects God Objects and monolithic files that need splitting.

function detectLargeFiles(files, projectRoot) {
  const LARGE_THRESHOLD = 300
  const GOD_OBJECT_THRESHOLD = 800
  const results = []

  for (const filePath of files) {
    const ext = extname(filePath)
    if (!['.js', '.mjs', '.cjs', '.ts', '.tsx'].includes(ext)) continue

    let source
    try {
      source = readFileSync(filePath, 'utf8')
    } catch { continue }

    const lines = source.split('\n').length
    if (lines < LARGE_THRESHOLD) continue

    const relPath = relative(projectRoot, filePath)
    const isGodObject = lines >= GOD_OBJECT_THRESHOLD

    // Count function declarations for context
    const fnCount = (source.match(/(?:function\s+\w+|const\s+\w+\s*=\s*(?:async\s*)?\()/g) || []).length

    // Count imports for coupling analysis
    const importCount = (source.match(/(?:import\s|from\s+['"])/g) || []).length

    // Count mutable module-level variables
    const mutableVars = (source.match(/^(?:let|var)\s+/gm) || []).length

    results.push({
      file: relPath,
      lines,
      functions: fnCount,
      imports: importCount,
      mutableVars,
      isGodObject,
      severity: isGodObject ? 'CRITICAL' : 'WARNING',
    })
  }

  return results.sort((a, b) => b.lines - a.lines)
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

// ─── Zustand store detection ──────────────────────────────────────────────────
// Detects Zustand create() patterns and extracts action names with complexity.
// Zustand stores contain pure logic hidden inside closures — these are prime
// candidates for extraction (see references/zustand-store.md).

function extractZustandActions(source, ext) {
  const actions = []

  // Only scan JS/TS files for Zustand patterns
  if (!['.js', '.mjs', '.ts', '.tsx'].includes(ext)) return actions

  // Check if file imports from 'zustand'
  if (!source.includes('zustand') && !source.includes('create<')) return actions

  // Pattern: actionName: (args) => set((s) => { ... })
  // Pattern: actionName: (args) => { ... set({ ... }) ... }
  const actionPattern = /(\w+):\s*\([^)]*\)\s*=>\s*(?:set\(|\{)/g
  let match
  while ((match = actionPattern.exec(source)) !== null) {
    const actionName = match[1]
    // Skip common non-action properties
    if (['set', 'get', 'create', 'use'].includes(actionName)) continue
    // Skip state fields (lowercase, no parens after)
    const afterMatch = source.slice(match.index + match[0].length, match.index + match[0].length + 50)
    // Check that this is inside a create() block
    const beforeMatch = source.slice(Math.max(0, match.index - 500), match.index)
    if (!beforeMatch.includes('create<') && !beforeMatch.includes('create(')) continue

    // Estimate complexity of the action
    const actionBody = extractZustandActionBody(source, match.index)
    const complexity = actionBody ? estimateZustandComplexity(actionBody) : 1

    // Only suggest actions with meaningful logic (not just simple setters)
    if (complexity >= 2) {
      actions.push({ name: actionName, complexity })
    }
  }

  return actions
}

function extractZustandActionBody(source, startIndex) {
  // Find the end of the arrow function body
  let depth = 0
  let braceStart = -1
  let i = startIndex

  // Find the first opening brace
  while (i < source.length && source[i] !== '{') i++
  if (i >= source.length) return null
  braceStart = i

  // Match braces to find the end
  for (; i < source.length; i++) {
    if (source[i] === '{') depth++
    else if (source[i] === '}') {
      depth--
      if (depth === 0) break
    }
  }

  return source.slice(braceStart + 1, i)
}

function estimateZustandComplexity(body) {
  let complexity = 1
  const patterns = [
    /\bif\b/g,
    /\belse\b/g,
    /\bfor\b/g,
    /\bwhile\b/g,
    /\bcase\b/g,
    /&&/g,
    /\|\|/g,
    /\?\s*[^:]+\s*:/g,
    /\.forEach\(/g,
    /\.map\(/g,
    /\.filter\(/g,
    /\.reduce\(/g,
    /new Set/g,
    /Math\./g,
  ]
  for (const p of patterns) {
    const matches = body.match(p)
    if (matches) complexity += matches.length
  }
  return complexity
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

// ─── Chrome Extension detection ──────────────────────────────────────────────

const chromeExtensions = detectChromeExtension(projectRoot)
if (chromeExtensions.length > 0) {
  console.log('🔧 Chrome Extension detected!\n')
  for (const ext of chromeExtensions) {
    const dir = ext.subdir ? ` (${ext.subdir}/)` : ''
    console.log(`   Manifest V${ext.version}${dir}`)
    if (ext.hasContentScripts) console.log('   ⚠️  Content scripts found — may use IIFEs with no exports')
    if (ext.hasBackground) console.log('   ⚠️  Background service worker — uses message passing')
    if (ext.hasSidePanel) console.log('   ⚠️  Side panel — uses chrome.runtime messaging')
    console.log()
  }
  console.log('   💡 Chrome extension content scripts often use IIFEs and have no exports.')
  console.log('      Consider creating adapter modules that wrap internal functions for Regrets.')
  console.log('      See references/chrome-extension.md for patterns.\n')
}

// ─── Large file / God Object detection ───────────────────────────────────────

const largeFiles = detectLargeFiles(files, projectRoot)
if (largeFiles.length > 0) {
  console.log('📏 Large file / God Object detection\n')
  console.log('  ' + 'file'.padEnd(50) + 'lines'.padEnd(8) + 'fns'.padEnd(5) + 'imports'.padEnd(8) + 'vars'.padEnd(6) + 'severity')
  console.log('  ' + '─'.repeat(85))
  for (const lf of largeFiles.slice(0, 20)) {
    const icon = lf.isGodObject ? '🔴' : '🟡'
    console.log(`  ${icon} ${lf.file.padEnd(48)}${String(lf.lines).padEnd(8)}${String(lf.functions).padEnd(5)}${String(lf.imports).padEnd(8)}${String(lf.mutableVars).padEnd(6)}${lf.severity}`)
  }
  console.log()
  if (largeFiles.some(f => f.isGodObject)) {
    console.log('  🔴 God Objects (>800 lines) — split before refactoring')
  }
  console.log('  🟡 Large files (300-800 lines) — consider splitting\n')
}

const suggestions = []
const internalOnlyFiles = []  // Files with internal functions but no exports
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

  // Also scan for internal/non-exported functions
  const internalFns = extractInternalFunctions(source, ext)

  // Also detect Zustand store actions (functions inside create() blocks)
  const zustandActions = extractZustandActions(source, ext)

  // Track files with only internal functions (no exports)
  if (fns.length === 0 && internalFns.length > 0) {
    const exportedNames = new Set(fns)
    const pureInternal = internalFns.filter(f => f.kind !== 'iife' && !exportedNames.has(f.name))
    if (pureInternal.length > 0) {
      internalOnlyFiles.push({
        file: relPath,
        stack,
        lines,
        internalFunctions: pureInternal,
        hasIife: internalFns.some(f => f.kind === 'iife'),
      })
    }
  }

  // Only suggest files with exported functions or Zustand actions
  if (fns.length === 0 && zustandActions.length === 0) continue

  // Filter out obvious non-pure functions (heuristic)
  const pureFns = fns.filter(fn => {
    // Skip DOM/UI related functions
    const lowerFn = fn.toLowerCase()
    if (lowerFn.includes('render') || lowerFn.includes('component') ||
        lowerFn.includes('style') || lowerFn.includes('mount') ||
        lowerFn.includes('effect') || lowerFn.includes('layout')) return false
    return true
  })

  for (const fn of pureFns) {
    const complexity = estimateComplexity(source, fn)

    suggestions.push({
      function: fn,
      file: relPath,
      stack,
      complexity,
      fileSize: lines,
      isZustand: false,
      isFactory: detectFactoryPattern(source),
    })
  }

  // Add Zustand action suggestions with extraction note
  for (const action of zustandActions) {
    suggestions.push({
      function: action.name,
      file: relPath,
      stack,
      complexity: action.complexity,
      fileSize: lines,
      isZustand: true,
      isFactory: false,
      note: 'Extract pure logic to *-logic.ts before fingerprinting (see references/zustand-store.md)',
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

  const zustandActions = suggestions.filter(s => s.isZustand)
  if (zustandActions.length > 0) {
    console.log(`\n🏪 Zustand store actions detected (need extraction before fingerprinting):`)
    for (const s of zustandActions) {
      console.log(`  ${s.function} in ${s.file} (complexity: ${s.complexity})`)
      if (s.note) console.log(`     → ${s.note}`)
    }
    console.log(`\n  See references/zustand-store.md for the extraction pattern.`)
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
  console.log(`   Run with regret coverage --suggest-inputs to get concrete input suggestions.`)

  // Report files with only internal functions (not exported, potentially missed)
  if (internalOnlyFiles.length > 0) {
    console.log(`\n🔒 Files with internal-only functions (no exports detected):`)
    console.log(`   These files contain functions that Regrets cannot directly test.`)
    console.log(`   You may need to create adapter modules to expose them.\n`)
    for (const f of internalOnlyFiles.slice(0, 15)) {
      const iifeTag = f.hasIife ? ' [IIFE]' : ''
      console.log(`   ${f.file} (${f.lines} lines, ${f.internalFunctions.length} internal fns${iifeTag})`)
      for (const fn of f.internalFunctions.slice(0, 5)) {
        console.log(`     • ${fn.name} (${fn.kind})`)
      }
      if (f.internalFunctions.length > 5) {
        console.log(`     ... and ${f.internalFunctions.length - 5} more`)
      }
    }
    if (internalOnlyFiles.length > 15) {
      console.log(`   ... and ${internalOnlyFiles.length - 15} more files`)
    }
  }

  console.log()
}

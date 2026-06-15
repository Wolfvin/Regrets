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
//   node scripts/scan.js --generate-adapters (generate regret-adapters.mjs + manifest skeleton)
//
// This tool helps agents who are setting up Regrets for the first time.
// It scans the project, identifies refactor-candidate functions, and suggests
// cluster definitions. The agent still decides which clusters to create —
// this is a SUGGESTION, not a prescription.

import { readFileSync, readdirSync, existsSync, statSync, writeFileSync, mkdirSync } from 'fs'
import { resolve, join, extname, relative } from 'path'

const args = process.argv.slice(2)
const scanDir = args.includes('--dir') ? args[args.indexOf('--dir') + 1] : '.'
const stackFilter = args.includes('--stack') ? args[args.indexOf('--stack') + 1] : null
const formatManifest = args.includes('--format') && args[args.indexOf('--format') + 1] === 'manifest'
const generateAdapters = args.includes('--generate-adapters')
const jsonOutput = args.includes('--json')
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

// ─── React Monorepo detection ─────────────────────────────────────────────
// Detects React monorepo projects (like react-jsonschema-form, react-select,
// MUI, etc.) that have packages/ directories with multiple React packages.
// These repos need special cluster suggestions because:
// 1. Pure utility functions in packages/utils can be fingerprinted directly
// 2. React components need the 'react' stack for render capture
// 3. Validator packages often have pure logic that can be tested separately

function detectReactMonorepo(rootDir) {
  const markers = []

  // Check for packages/ directory with React dependencies
  const packagesDir = resolve(rootDir, 'packages')
  try {
    const entries = readdirSync(packagesDir, { withFileTypes: true })
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      const pkgJson = resolve(packagesDir, entry.name, 'package.json')
      try {
        const content = readFileSync(pkgJson, 'utf8')
        const pkg = JSON.parse(content)
        const deps = { ...pkg.dependencies, ...pkg.devDependencies, ...pkg.peerDependencies }
        const hasReact = Object.keys(deps).some(d => d === 'react' || d.startsWith('react-') || d.startsWith('@react-'))
        if (hasReact) {
          markers.push({
            package: entry.name,
            hasReact: true,
            hasUtils: entry.name.includes('utils') || entry.name.includes('shared') || entry.name.includes('common'),
            hasValidator: entry.name.includes('validator'),
            hasCore: entry.name.includes('core'),
            hasTheme: !entry.name.includes('utils') && !entry.name.includes('validator') && !entry.name.includes('core'),
          })
        }
      } catch { /* skip invalid package.json */ }
    }
  } catch { /* no packages/ dir */ }

  // Check root package.json for React dependency
  try {
    const rootPkg = JSON.parse(readFileSync(resolve(rootDir, 'package.json'), 'utf8'))
    const deps = { ...rootPkg.dependencies, ...rootPkg.devDependencies }
    if (deps['react'] || deps['react-dom']) {
      markers.push({ package: '(root)', hasReact: true, hasUtils: false, hasValidator: false, hasCore: false, hasTheme: false })
    }
  } catch { /* no root package.json */ }

  return markers
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

// ─── CJS object export helpers ─────────────────────────────────────────────────
// Handles: module.exports = { add, multiply } / { add: addFn } / { ...other, fn }

function splitObjectProperties(body) {
  const parts = []
  let depth = 0
  let current = ''
  let inString = false
  let stringChar = ''

  for (let i = 0; i < body.length; i++) {
    const ch = body[i]

    if (inString) {
      current += ch
      if (ch === '\\') {
        i++
        if (i < body.length) current += body[i]
        continue
      }
      if (ch === stringChar) inString = false
      continue
    }

    if (ch === '"' || ch === "'" || ch === '`') {
      inString = true
      stringChar = ch
      current += ch
    } else if (ch === '(' || ch === '[' || ch === '{') {
      depth++
      current += ch
    } else if (ch === ')' || ch === ']' || ch === '}') {
      depth--
      current += ch
    } else if (ch === ',' && depth === 0) {
      parts.push(current)
      current = ''
    } else {
      current += ch
    }
  }

  if (current.trim()) parts.push(current)
  return parts
}

function extractCjsObjectExports(source) {
  const names = []
  const re = /module\.exports\s*=\s*\{/g
  let match

  while ((match = re.exec(source)) !== null) {
    const start = match.index + match[0].length
    let depth = 1
    let i = start

    // Find matching closing brace (handle nested braces & string literals)
    while (i < source.length && depth > 0) {
      const ch = source[i]
      if (ch === '{') depth++
      else if (ch === '}') depth--
      else if (ch === '"' || ch === "'" || ch === '`') {
        const quote = ch
        i++
        while (i < source.length) {
          if (source[i] === '\\') { i += 2; continue }
          if (source[i] === quote) break
          i++
        }
      }
      i++
    }

    if (depth !== 0) continue
    const body = source.slice(start, i - 1)

    // Remove comments before parsing
    const cleaned = body
      .replace(/\/\/.*$/gm, '')
      .replace(/\/\*[\s\S]*?\*\//g, '')

    const properties = splitObjectProperties(cleaned)

    for (const prop of properties) {
      const trimmed = prop.trim()
      if (!trimmed) continue

      // Skip spread: ...expr
      if (trimmed.startsWith('...')) continue

      // Explicit property: key: value
      const explicitMatch = trimmed.match(/^([a-zA-Z_$][\w$]*)\s*:/)
      if (explicitMatch) {
        // Filter out JS keywords that appear before colons in other contexts
        const JS_KEYWORDS = new Set([
          'function', 'async', 'get', 'set', 'static', 'if', 'else', 'for',
          'while', 'return', 'new', 'class', 'const', 'let', 'var',
          'true', 'false', 'null', 'undefined',
        ])
        if (!JS_KEYWORDS.has(explicitMatch[1])) {
          names.push(explicitMatch[1])
        }
        continue
      }

      // Shorthand property: just an identifier
      const shorthandMatch = trimmed.match(/^([a-zA-Z_$][\w$]*)$/)
      if (shorthandMatch) {
        names.push(shorthandMatch[1])
        continue
      }

      // Computed property or other expression: skip
    }
  }

  return names
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

  // ── CJS (CommonJS) patterns ──────────────────────────────────────────────
  // These are critical for older Node.js projects like natural, underscore, etc.

  // module.exports.Name = require(...)
  // module.exports.Name = ClassName
  // module.exports.Name = function() {...}
  const moduleExports = source.matchAll(/module\.exports\.(\w+)\s*=/g)
  for (const m of moduleExports) fns.push(m[1])

  // exports.Name = require(...)
  const exportsAssign = source.matchAll(/^exports\.(\w+)\s*=/gm)
  for (const m of exportsAssign) fns.push(m[1])

  // module.exports = function Name(...) — single function export with a name
  const cjsNamedFn = source.matchAll(/module\.exports\s*=\s*function\s+(\w+)/g)
  for (const m of cjsNamedFn) fns.push(m[1])

  // module.exports = ClassName — single class export
  const cjsClassExport = source.matchAll(/module\.exports\s*=\s*(\w+)/g)
  for (const m of cjsClassExport) {
    // Skip if it's 'require' or common keywords
    if (!['require', 'undefined', 'null', 'true', 'false'].includes(m[1])) {
      fns.push(m[1])
    }
  }

  // ── CJS singleton method detection ─────────────────────────────────────
  // Pattern: const X = new SomeConstructor() → X is a singleton with methods
  // These appear in files like porter_stemmer.js: module.exports = new Stemmer()
  // The scanner can't call .stem() on them, but it CAN detect the export name
  // and flag it as a singletonMethod candidate.

  // Prototype method definitions: Name.prototype.method = function()
  const protoMethods = source.matchAll(/(\w+)\.prototype\.(\w+)\s*=\s*function/g)
  for (const m of protoMethods) {
    fns.push(`${m[1]}.prototype.${m[2]}`)
  }

  // this.method = function() — inside constructor/mixin functions
  const thisMethods = source.matchAll(/this\.(\w+)\s*=\s*(?:function|async\s+function)/g)
  for (const m of thisMethods) fns.push(m[1])

  // CJS: module.exports = { add, multiply } / { add: addFn } / { ...other, fn }
  const cjsObjExports = extractCjsObjectExports(source)
  for (const name of cjsObjExports) fns.push(name)

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
  // Supports ESM, CJS, prototype methods, and this.method assignments
  const patterns = [
    // ESM: export function name() {
    new RegExp(`(?:export\\s+)?(?:async\\s+)?function\\s+${escapeRegex(functionName)}\\s*\\([^)]*\\)\\s*\\{`),
    // ESM arrow: export const name = () => {
    new RegExp(`(?:export\\s+)?const\\s+${escapeRegex(functionName)}\\s*=\\s*(?:async\\s*)?\\([^)]*\\)\\s*=>\\s*\\{`),
    // ESM short arrow: export const name = x => {
    new RegExp(`(?:export\\s+)?const\\s+${escapeRegex(functionName)}\\s*=\\s*(?:async\\s*)?\\w+\\s*=>\\s*\\{`),
    // CJS: Name.prototype.method = function() {
    new RegExp(`\\w+\\.prototype\\.${escapeRegex(functionName)}\\s*=\\s*(?:async\\s+)?function\\s*\\([^)]*\\)\\s*\\{`),
    // CJS mixin: this.method = function() {
    new RegExp(`this\\.${escapeRegex(functionName)}\\s*=\\s*(?:async\\s+)?function\\s*\\([^)]*\\)\\s*\\{`),
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

// ─── Block extraction helper ──────────────────────────────────────────────────
// Extracts a brace-delimited block from source starting at the given index.
// Finds the first `{` at or after startIndex, then counts braces to find
// the matching `}`. Returns the body between the braces, or null on failure.

function extractBlock(source, startIndex) {
  let i = startIndex
  // Find the first opening brace
  while (i < source.length && source[i] !== '{') i++
  if (i >= source.length) return null

  const braceStart = i
  let depth = 0
  for (; i < source.length; i++) {
    if (source[i] === '{') depth++
    else if (source[i] === '}') {
      depth--
      if (depth === 0) break
    }
  }

  return source.slice(braceStart + 1, i)
}

// ─── Static class method detection ────────────────────────────────────────────
// Detects exported classes with static methods. Static methods like
// `CronExpressionParser.parse()` are functionally similar to exported functions
// but require an adapter or the classMethod pattern to be invoked by Regrets.

function extractStaticClassMethods(source, ext) {
  const results = []

  // Only scan JS/TS files
  if (!['.js', '.mjs', '.cjs', '.ts', '.tsx'].includes(ext)) return results

  // Find export class declarations
  const classPattern = /export\s+(?:default\s+)?class\s+(\w+)\s*(?:extends\s+\w+\s*)?\{/g
  let match
  while ((match = classPattern.exec(source)) !== null) {
    const className = match[1]
    const classBody = extractBlock(source, match.index + match[0].length - 1)
    if (!classBody) continue

    // Find static method declarations within the class body
    const staticPattern = /static\s+(?:async\s+)?(\w+)\s*\(/g
    let staticMatch
    while ((staticMatch = staticPattern.exec(classBody)) !== null) {
      const methodName = staticMatch[1]
      // Skip constructor-like names
      if (methodName === 'constructor') continue
      results.push({
        className,
        methodName,
        fullName: `${className}.${methodName}`,
      })
    }
  }

  return results
}

// ─── Stateful iterator detection ──────────────────────────────────────────────
// Detects classes that implement the iterator pattern — they have a next()
// method AND either [Symbol.iterator], take(), hasNext(), or hasPrev().
// These are stateful iterators that require an adapter to materialize the
// sequence for Regrets fingerprinting (see references/stateful-iterator.md).

function detectStatefulIterators(source, ext) {
  const results = []

  // Only scan JS/TS files
  if (!['.js', '.mjs', '.cjs', '.ts', '.tsx'].includes(ext)) return results

  // Find all class declarations (exported or not)
  const classPattern = /(?:export\s+(?:default\s+)?)?class\s+(\w+)\s*(?:extends\s+\w+\s*)?\{/g
  let match
  while ((match = classPattern.exec(source)) !== null) {
    const className = match[1]
    const classBody = extractBlock(source, match.index + match[0].length - 1)
    if (!classBody) continue

    // Check for next() method
    const hasNextMethod = /\bnext\s*\(/.test(classBody)
    if (!hasNextMethod) continue

    // Check for iterator marker methods
    const detectedMethods = []
    if (/\[Symbol\.iterator\]/.test(classBody)) detectedMethods.push('[Symbol.iterator]')
    if (/\btake\s*\(/.test(classBody)) detectedMethods.push('take')
    if (/\bhasNext\s*\(/.test(classBody)) detectedMethods.push('hasNext')
    if (/\bhasPrev\s*\(/.test(classBody)) detectedMethods.push('hasPrev')

    if (detectedMethods.length === 0) continue

    results.push({
      className,
      methods: ['next', ...detectedMethods],
      isIterator: true,
    })
  }

  return results
}

// ─── Adapter-needed detection ─────────────────────────────────────────────
// Detects functions that take parameters typed as interfaces or complex objects
// that can't be expressed as JSON in manifest.json inputs.
// These functions need an adapter module to construct the required dependencies.
// Discovered while trying to cluster isMultiSelect(validator, schema, rootSchema)
// in rjsf — the validator parameter is a class instance with methods, impossible
// to represent as plain JSON.

function detectAdapterNeeded(source, functionName) {
  const reasons = []

  // Find the function signature
  const fnPattern = new RegExp(
    `(?:export\\s+)?(?:async\\s+)?function\\s+${escapeRegex(functionName)}\\s*\\(([^)]*)\\)`, 'm'
  )
  const arrowPattern = new RegExp(
    `(?:export\\s+)?const\\s+${escapeRegex(functionName)}\\s*=\\s*(?:async\\s*)?\\(([^)]*)\\)\\s*=>`, 'm'
  )

  let params = null
  const fnMatch = source.match(fnPattern)
  const arrowMatch = source.match(arrowPattern)

  if (fnMatch) params = fnMatch[1]
  else if (arrowMatch) params = arrowMatch[1]
  else return reasons

  // Check for parameter names that indicate complex interface objects
  const adapterHints = [
    { pattern: /\bvalidator\b/i, reason: 'validator parameter (needs ValidatorType instance)' },
    { pattern: /\bregistry\b/i, reason: 'registry parameter (needs RegistryType instance)' },
    { pattern: /\bcontext\b/i, reason: 'context parameter (needs FormContext instance)' },
    { pattern: /\bstore\b/i, reason: 'store parameter (needs store instance)' },
    { pattern: /\bclient\b/i, reason: 'client parameter (needs API client instance)' },
    { pattern: /\bconnection\b/i, reason: 'connection parameter (needs DB/connection instance)' },
  ]

  for (const hint of adapterHints) {
    if (hint.pattern.test(params)) {
      reasons.push(hint.reason)
    }
  }

  // Check if function has 3+ parameters that include 'schema' and 'rootSchema'
  // This is a common pattern in JSON Schema libraries where a validator is needed
  if (/\bschema\b/.test(params) && /\brootSchema\b/.test(params)) {
    if (!reasons.some(r => r.includes('validator'))) {
      reasons.push('schema + rootSchema pattern (may need validator)')
    }
  }

  return reasons
}

// ─── TypeScript preBuild auto-detection ─────────────────────────────────────
// Detects whether the project is a TypeScript project and suggests a preBuild
// command for manifest.json. Checks for tsconfig.json and package.json build
// scripts.

function detectPreBuild(rootDir) {
  const tsconfigPath = resolve(rootDir, 'tsconfig.json')
  const isTypeScript = existsSync(tsconfigPath)
  let preBuild = null
  let buildScript = null

  if (isTypeScript) {
    // Check package.json for a "build" script
    const pkgPath = resolve(rootDir, 'package.json')
    if (existsSync(pkgPath)) {
      try {
        const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'))
        if (pkg.scripts?.build) {
          buildScript = pkg.scripts.build
          preBuild = 'npm run build'
        }
      } catch { /* skip invalid package.json */ }
    }
  }

  return { isTypeScript, preBuild, buildScript }
}

// ─── Adapter skeleton generation ─────────────────────────────────────────────
// Generates a regret-adapters.mjs file with adapter functions for static class
// methods and stateful iterators. These adapter functions bridge the gap between
// class-based APIs and Regrets' function-oriented capture system.

function generateAdapterSkeleton(staticMethods, iterators, projectRoot) {
  const adapterPath = resolve(projectRoot, 'regret-adapters.mjs')

  // Don't overwrite existing file
  if (existsSync(adapterPath)) {
    console.log('\n⚠️  regret-adapters.mjs already exists — skipping adapter generation.')
    console.log('   Delete the file and re-run if you want to regenerate it.\n')
    return null
  }

  const lines = [
    '// Auto-generated adapter module for Regrets regression testing',
    '// This module bridges class-based APIs to standalone functions',
    '// that can be wrapped by the Ghost Proxy.',
    '//',
    '// Next steps:',
    '//   1. Uncomment the CJS bridge import below (adjust the path to your compiled output)',
    '//   2. Fill in the adapter function bodies',
    '//   3. Reference these adapter functions in regrets/manifest.json',
    '',
    "import { createRequire } from 'module';",
    'const require = createRequire(import.meta.url);',
    '// const module = require(\'./dist/index.js\');',
    '',
  ]

  // Generate adapter functions for static class methods
  for (const sm of staticMethods) {
    const fnName = `adapt${sm.className}${sm.methodName.charAt(0).toUpperCase()}${sm.methodName.slice(1)}`
    lines.push(`export function ${fnName}(input) {`)
    lines.push(`  // TODO: Call ${sm.className}.${sm.methodName}(input) and serialize result`)
    lines.push(`  // const result = ${sm.className}.${sm.methodName}(input);`)
    lines.push(`  // return result;`)
    lines.push(`}`)
    lines.push('')
  }

  // Generate adapter functions for stateful iterators
  for (const it of iterators) {
    const fnName = `adapt${it.className}Iterate`
    lines.push(`export function ${fnName}(input) {`)
    lines.push(`  // TODO: Construct iterator and call next() N times`)
    lines.push(`  // const instance = FactoryClass.factoryMethod(input.expression, input.options);`)
    lines.push(`  // const results = [];`)
    lines.push(`  // for (let i = 0; i < input.iterations; i++) {`)
    lines.push(`  //   results.push(instance.next().toISOString()); // Adjust serialization as needed`)
    lines.push(`  // }`)
    lines.push(`  // return results;`)
    lines.push(`}`)
    lines.push('')
  }

  const content = lines.join('\n')
  writeFileSync(adapterPath, content, 'utf8')
  return adapterPath
}

// ─── Manifest generation with adapters ──────────────────────────────────────
// Generates a regrets/manifest.json skeleton that includes cluster entries for
// each adapter function, with auto-detected preBuild and empty inputs arrays.

function generateManifestWithAdapters(suggestions, staticMethods, iterators, projectRoot) {
  const regretsDir = resolve(projectRoot, 'regrets')
  const manifestPath = resolve(regretsDir, 'manifest.json')

  // Don't overwrite existing manifest
  if (existsSync(manifestPath)) {
    console.log('\n⚠️  regrets/manifest.json already exists — skipping manifest generation.')
    console.log('   Delete the file and re-run if you want to regenerate it.\n')
    return null
  }

  // Auto-detect preBuild
  const { preBuild } = detectPreBuild(projectRoot)

  const manifest = {
    version: 1,
  preBuild: preBuild || '',
    clusters: [],
  }

  // Add clusters for regular suggestions (top 20)
  for (const s of suggestions.slice(0, 20)) {
    if (s.isStaticMethod || s.isIterator) continue  // Handled separately below
    manifest.clusters.push({
      id: s.function.replace(/([A-Z])/g, '-$1').toLowerCase().replace(/^-/, ''),
      entry: s.function,
      watches: [s.function],
      file: s.file,
      stack: s.stack,
      fingerprintLevel: 'entry',
      description: `Cluster for ${s.function} in ${s.file}`,
      inputs: [],
    })
  }

  // Add clusters for static method adapters
  for (const sm of staticMethods) {
    const fnName = `adapt${sm.className}${sm.methodName.charAt(0).toUpperCase()}${sm.methodName.slice(1)}`
    manifest.clusters.push({
      id: `${sm.className.toLowerCase()}-${sm.methodName.toLowerCase()}`,
      entry: fnName,
      watches: [fnName],
      file: 'regret-adapters.mjs',
      stack: sm.stack,
      fingerprintLevel: 'entry',
      description: `Adapter for ${sm.className}.${sm.methodName} (static method)`,
      inputs: [],
    })
  }

  // Add clusters for stateful iterator adapters
  for (const it of iterators) {
    const fnName = `adapt${it.className}Iterate`
    manifest.clusters.push({
      id: `${it.className.toLowerCase()}-iterate`,
      entry: fnName,
      watches: [fnName],
      file: 'regret-adapters.mjs',
      stack: it.stack,
      fingerprintLevel: 'entry',
      description: `Adapter for ${it.className} iterator (materialize sequence)`,
      inputs: [],
    })
  }

  // Ensure regrets/ directory exists
  if (!existsSync(regretsDir)) {
    mkdirSync(regretsDir, { recursive: true })
  }

  const content = JSON.stringify(manifest, null, 2) + '\n'
  writeFileSync(manifestPath, content, 'utf8')
  return manifestPath
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

if (!jsonOutput) console.log('\n📡 Scanning project for cluster suggestions...\n')

const allExtensions = Object.values(EXTENSIONS).flat()
const files = discoverFiles(resolve(projectRoot, scanDir), allExtensions)

if (!files.length) {
  console.log('No source files found. Try --dir to specify a different directory.')
  process.exit(0)
}

// ─── Chrome Extension detection ──────────────────────────────────────────────

const chromeExtensions = detectChromeExtension(projectRoot)
if (chromeExtensions.length > 0 && !jsonOutput) {
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

// ─── React Monorepo detection ──────────────────────────────────────────────

const reactMonorepo = detectReactMonorepo(projectRoot)
if (reactMonorepo.length > 0 && !jsonOutput) {
  console.log('⚛️  React Monorepo detected!\n')
  for (const pkg of reactMonorepo) {
    const tags = []
    if (pkg.hasUtils) tags.push('utils')
    if (pkg.hasValidator) tags.push('validator')
    if (pkg.hasCore) tags.push('core')
    if (pkg.hasTheme) tags.push('theme')
    console.log(`   packages/${pkg.package}${tags.length ? ` [${tags.join(', ')}]` : ''}`)
  }
  console.log()
  const utilsPkgs = reactMonorepo.filter(p => p.hasUtils)
  const validatorPkgs = reactMonorepo.filter(p => p.hasValidator)
  if (utilsPkgs.length > 0) {
    console.log('   💡 Utils packages contain pure functions — best starting point for clustering.')
    console.log('      Use stack: "js" for these, not "react" — no rendering needed.')
    console.log('      Add normalize: ["incrementingIds"] if the utils generate unique IDs.')
  }
  if (validatorPkgs.length > 0) {
    console.log('   💡 Validator packages contain pure validation logic — fingerprint with stack: "js".')
    console.log('      Pass a pre-constructed validator instance as input to test validation methods.')
  }
  console.log('   ⚠️  React components need stack: "react" for render-to-HTML fingerprinting.')
  console.log('      Use normalize: ["incrementingIds"] if components use uniqueId for keys.\n')
}

// ─── TypeScript preBuild detection ───────────────────────────────────────────

const { isTypeScript, preBuild, buildScript } = detectPreBuild(projectRoot)
if (isTypeScript && !jsonOutput) {
  console.log('🔷 TypeScript project detected — preBuild will be needed in manifest.json')
  if (buildScript) {
    console.log(`   Suggested preBuild: "npm run build" (package.json scripts.build: "${buildScript}")`)
  } else {
    console.log('   ⚠️  No "build" script found in package.json — add one and re-run')
  }
  console.log()
}

// ─── Large file / God Object detection ───────────────────────────────────────

const largeFiles = detectLargeFiles(files, projectRoot)
if (largeFiles.length > 0 && !jsonOutput) {
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
const staticClassMethods = []  // Exported classes with static methods
const statefulIterators = []   // Classes implementing the iterator pattern

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

  // Detect exported classes with static methods
  const staticMethods = extractStaticClassMethods(source, ext)

  // Detect stateful iterator pattern
  const iterators = detectStatefulIterators(source, ext)

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

  // Only suggest files with exported functions, Zustand actions, static methods, or iterators
  if (fns.length === 0 && zustandActions.length === 0 && staticMethods.length === 0 && iterators.length === 0) continue

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

    // Check if this function takes parameters that look like interface objects
    // (e.g., validator, schema, rootSchema) — these need an adapter module
    const needsAdapter = detectAdapterNeeded(source, fn)

    suggestions.push({
      function: fn,
      file: relPath,
      stack,
      complexity,
      fileSize: lines,
      isZustand: false,
      isFactory: detectFactoryPattern(source),
      needsAdapter: needsAdapter.length > 0,
      adapterReason: needsAdapter.length > 0 ? needsAdapter.join(', ') : undefined,
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

  // Add static class method suggestions
  for (const sm of staticMethods) {
    const complexity = estimateComplexity(source, sm.methodName) || 1
    suggestions.push({
      function: sm.fullName,
      file: relPath,
      stack,
      complexity,
      fileSize: lines,
      isStaticMethod: true,
      note: 'Static method — use adapter or classMethod pattern to invoke (see references/static-class-method.md)',
    })
    staticClassMethods.push({ ...sm, file: relPath, stack })
  }

  // Add stateful iterator suggestions
  for (const it of iterators) {
    suggestions.push({
      function: it.className,
      file: relPath,
      stack,
      complexity: 1,
      fileSize: lines,
      isIterator: true,
      note: 'Use adapter pattern to materialize iterator sequences (see references/stateful-iterator.md)',
    })
    statefulIterators.push({ ...it, file: relPath, stack })
  }
}

// Sort by complexity (most complex = highest refactor priority)
suggestions.sort((a, b) => b.complexity - a.complexity)

if (jsonOutput) {
  // JSON output mode — output discovered functions per file
  const fileMap = {}
  for (const s of suggestions) {
    if (!fileMap[s.file]) fileMap[s.file] = []
    fileMap[s.file].push(s.function)
  }
  const discovered = Object.entries(fileMap).map(([file, functions]) => ({ file, functions }))
  console.log(JSON.stringify({ discovered }, null, 0))
  process.exit(0)
}

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

  const manifestOutput = { clusters }
  // Include preBuild for TypeScript projects
  if (preBuild) {
    manifestOutput.preBuild = preBuild
  }
  console.log(JSON.stringify(manifestOutput, null, 2))
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

  const needsAdapterFns = suggestions.filter(s => s.needsAdapter)
  if (needsAdapterFns.length > 0) {
    console.log(`\n🔌 Functions needing adapter module (complex parameters):`)
    for (const s of needsAdapterFns) {
      console.log(`  ${s.function} in ${s.file} — ${s.adapterReason}`)
      console.log(`     → Create an adapter module and use the "adapter" field in manifest.json`)
    }
    console.log(`  See references/react-monorepo.md for the adapter pattern.`)
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

  // Report static class methods
  if (staticClassMethods.length > 0) {
    console.log(`\n⚙️  STATIC CLASS METHODS`)
    console.log('─'.repeat(90))
    console.log(
    'class'.padEnd(25) +
    'method'.padEnd(25) +
    'full name'.padEnd(35) +
    'file'
    )
    console.log('─'.repeat(90))
    for (const sm of staticClassMethods) {
    console.log(
      sm.className.padEnd(25) +
      sm.methodName.padEnd(25) +
      sm.fullName.padEnd(35) +
      sm.file
    )
    }
    console.log('─'.repeat(90))
    console.log(`  Found ${staticClassMethods.length} static method(s). These require an adapter or classMethod pattern.`)
  }

  // Report stateful iterators
  if (statefulIterators.length > 0) {
    console.log(`\n🔁 STATEFUL ITERATORS`)
    console.log('─'.repeat(90))
    console.log(
    'class'.padEnd(25) +
    'methods'.padEnd(40) +
    'file'
    )
    console.log('─'.repeat(90))
    for (const it of statefulIterators) {
    console.log(
      it.className.padEnd(25) +
      it.methods.join(', ').padEnd(40) +
      it.file
    )
    }
    console.log('─'.repeat(90))
    console.log(`  Found ${statefulIterators.length} iterator class(es). Use adapter pattern to materialize sequences.`)
    console.log('  See references/stateful-iterator.md for the adapter pattern.')
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

  // ─── Adapter generation (--generate-adapters) ──────────────────────────────────
  if (generateAdapters && (staticClassMethods.length > 0 || statefulIterators.length > 0)) {
    console.log('\n🏗️  Generating adapter skeletons...')

    const adapterPath = generateAdapterSkeleton(staticClassMethods, statefulIterators, projectRoot)
    const manifestPath = generateManifestWithAdapters(suggestions, staticClassMethods, statefulIterators, projectRoot)

    if (adapterPath) {
      console.log(`\n✅ Adapter module generated: regret-adapters.mjs`)
      console.log(`   Contains ${staticClassMethods.length} static method adapter(s) and ${statefulIterators.length} iterator adapter(s)`)
    }

    if (manifestPath) {
      console.log(`\n✅ Manifest skeleton generated: regrets/manifest.json`)
      if (preBuild) {
        console.log(`   preBuild auto-detected: "${preBuild}"`)
      }
    }

    console.log('\n📋 Next steps:')
    console.log('   1. Edit regret-adapters.mjs — uncomment the CJS bridge import and fill in adapter bodies')
    console.log('   2. Edit regrets/manifest.json — fill in the empty "inputs" arrays for each cluster')
    console.log('   3. Run: node scripts/capture.js to capture baseline fingerprints')
    console.log('   4. Run: node scripts/fingerprint.js to verify fingerprints')
  } else if (generateAdapters) {
    console.log('\nℹ️  --generate-adapters was specified, but no static methods or iterators were found.')
    console.log('   Adapter generation is only needed when static class methods or stateful iterators are detected.')
  }

  console.log()
}

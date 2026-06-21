#!/usr/bin/env node
// install.js — Auto-discover + capture entire project in one command
//
// The vision: "Mau refactor? Pasang regrets → refactor → cabut regrets."
// This command eliminates the manual setup barrier by:
//   1. Scanning all source files for exported functions
//   2. Generating a manifest.json with one cluster per function
//   3. Running capture automatically
//   4. Reporting what worked, what skipped, and next steps
//
// Usage:
//   node scripts/install.js
//   node scripts/install.js --dir src/
//   node scripts/install.js --stack js
//   node scripts/install.js --depth 2
//   node scripts/install.js --dry-run     (preview only, no write/capture)
//   node scripts/install.js --skip-capture (write manifest but skip capture)
//   node scripts/install.js --scope src/utils/math.js   (single file)
//   node scripts/install.js --scope src/utils/          (directory, recursive by default)
//   node scripts/install.js --scope src/utils/ --flat   (directory, flat — no recursion)
//   node scripts/install.js --scope packages/           (workspace/monorepo)

import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, statSync } from 'fs'
import { resolve, join, extname, relative } from 'path'
import { execFileSync } from 'child_process'
import { fileURLToPath, pathToFileURL } from 'url'
import { dirname } from 'path'
import { mergeCjsModule } from './cjs-merge.js'
import { analyzeScope, detectLanguage } from './analyzer.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const SCRIPTS_DIR = __dirname

// ─── CLI args ─────────────────────────────────────────────────────────────────

function getArg(args, flag) {
  const i = args.indexOf(flag)
  return i !== -1 ? args[i + 1] ?? null : null
}

const args = process.argv.slice(2)

// --help
if (args.includes('--help') || args.includes('-h')) {
  console.log(`
regret install — Auto-discover + capture entire project in one command

USAGE:
  regret install [options]

OPTIONS:
  --dir <path>         Directory to scan (default: cwd)
  --scope <path>       Target a specific file, directory, or workspace
                         File:       --scope src/utils/math.js
                                     Only scan that file, manifest at regrets/
                         Directory:  --scope src/utils/
                                     Scan all JS/TS/PY files in that dir RECURSIVELY
                                     Manifest at <dir>/regrets/
                                     Use --flat to scan only the top level (no recursion)
                         Workspace:  --scope packages/
                                     Each subfolder with package.json gets its own
                                     manifest at <subfolder>/regrets/
                       Cannot be used together with --dir
  --flat               With --scope <dir>: scan only the top level (no recursion).
                       Restores the pre-#323 flat-directory behavior.
  --stack <stack>      Only scan files for this stack (js, ts, python)
  --depth <n>          Max directory depth (default: 3)
  --dry-run            Preview only — no files written, no capture
  --skip-capture       Write manifest but skip the capture step
  --skip-build         Skip preBuild step
  --quiet              Only print summary line
  --json               With --dry-run: emit ONLY the proposed manifest as JSON to
                         stdout (no human-readable text). Useful for CI review.

EXAMPLES:
  regret install                              Scan cwd, capture all
  regret install --dir src/                   Scan src/ recursively
  regret install --scope src/utils/math.js    Only math.js
  regret install --scope src/utils/           All files in utils/ (recursive)
  regret install --scope src/utils/ --flat    All files in utils/ (top level only)
  regret install --scope packages/            Monorepo: each package gets its own manifest
  regret install --dry-run                    Preview what would be installed
`)
  process.exit(0)
}

const scopePath = getArg(args, '--scope')
const scanDir = getArg(args, '--dir') || '.'
const stackFilter = getArg(args, '--stack')
const depth = parseInt(getArg(args, '--depth') || '3', 10)
const dryRun = args.includes('--dry-run')
const skipCapture = args.includes('--skip-capture')
const skipBuild = args.includes('--skip-build')
const quiet = args.includes('--quiet')
const jsonOutput = args.includes('--json')
// #323: --flat restores the pre-recursive flat-directory behavior for --scope <dir>.
// By default, --scope <dir> now scans recursively (matching user expectations).
const flatScope = args.includes('--flat')

// --json is currently only meaningful in --dry-run mode (manifest preview).
// In other modes it is accepted but ignored, to keep CLI parsing permissive.
if (jsonOutput && !dryRun) {
  console.error('⚠️  --json is currently only supported with --dry-run. Ignoring --json.')
}

// In --dry-run --json mode, suppress all human-readable stdout so the JSON
// manifest is the ONLY thing on stdout — making it safe to pipe to `jq` or
// capture from CI. console.error stays untouched so warnings/errors still
// surface on stderr. We restore the original console.log right before we
// emit the JSON payload (see "Step 6: Dry-run preview" below).
const _originalConsoleLog = console.log
const _originalConsoleInfo = console.info
if (dryRun && jsonOutput) {
  console.log = () => {}
  console.info = () => {}
}

const projectRoot = process.cwd()

// --scope and --dir are mutually exclusive
if (scopePath && args.includes('--dir')) {
  console.error('❌ --scope and --dir cannot be used together.')
  console.error('   Use --scope to target a specific file/directory/workspace,')
  console.error('   or --dir to set the scan root for default discovery.')
  process.exit(1)
}

// ─── Constants ─────────────────────────────────────────────────────────────────

const EXTENSIONS = {
  js: ['.js', '.mjs', '.cjs'],
  ts: ['.ts', '.tsx'],
  python: ['.py'],
}

const SKIP_DIRS = new Set([
  'node_modules', '.git', 'dist', 'build', 'target', '__pycache__',
  'regrets', '.next', '.nuxt', 'coverage', '.cache', '.turbo',
  'vendor', '.venv', 'venv', 'env',
])

const CAPTURE_TIMEOUT_MS = 10_000
const PROBE_TIMEOUT_MS = 5_000

// #319: Default probe inputs for the trivial-output guard. Previously just
// [null, {}], which almost never exercises string-first / numeric APIs.
// The expanded set covers strings, numbers, objects, arrays, and null —
// a cluster is trivial-skipped only if ALL of these produce trivial output
// (null / undefined / NaN / throws). If ANY input produces meaningful output,
// the cluster is kept.
const DEFAULT_PROBE_INPUTS = ['', 'test', 0, 1, {}, [], null]

// ─── File discovery (with depth limit) ─────────────────────────────────────────

function discoverFiles(dir, extensions, maxDepth, currentDepth = 0) {
  const files = []
  if (currentDepth > maxDepth) return files

  let entries
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch { return files }

  for (const entry of entries) {
    const fullPath = join(dir, entry.name)
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue
      // Also skip hidden directories
      if (entry.name.startsWith('.') && entry.name !== '.github') continue
      files.push(...discoverFiles(fullPath, extensions, maxDepth, currentDepth + 1))
    } else if (entry.isFile()) {
      const ext = extname(entry.name)
      if (extensions.includes(ext)) {
        files.push(fullPath)
      }
    }
  }
  return files
}

// ─── .gitignore-aware filtering ────────────────────────────────────────────────
// Simple .gitignore parser — skips files/dirs matching common patterns.
// This is not a full .gitignore implementation, but covers the most common cases.

function loadGitignore(rootDir) {
  const giPath = resolve(rootDir, '.gitignore')
  const patterns = []
  try {
    const content = readFileSync(giPath, 'utf8')
    for (const line of content.split('\n')) {
      const trimmed = line.trim()
      if (!trimmed || trimmed.startsWith('#')) continue
      patterns.push(trimmed)
    }
  } catch { /* no .gitignore */ }
  return patterns
}

function isGitignored(relPath, patterns) {
  for (const pattern of patterns) {
    if (pattern.endsWith('/')) {
      // Directory pattern
      if (relPath.startsWith(pattern) || relPath.includes('/' + pattern)) return true
    } else if (pattern.startsWith('*')) {
      // Wildcard — simple suffix match
      if (relPath.endsWith(pattern.slice(1))) return true
    } else {
      // Exact match or prefix
      if (relPath === pattern || relPath.startsWith(pattern + '/') || relPath.includes('/' + pattern + '/')) return true
    }
  }
  return false
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

// #289: Indirect object export pattern
  //   const mod = { add: ..., mul: ... }
  //   module.exports = mod          // ← identifier, not literal object
  // For each captured identifier, scan for an earlier `const|let|var <id> = { ... }`
  // declaration and parse its object literal body using the same property-name
  // extraction logic as above. Mirrors the same extension in api.js so the
  // CLI (`regret install`) and MCP tool (`regrets_scan`) produce identical
  // results for the indirect export pattern used in the original #289 repro.
  const indirectRe = /module\.exports\s*=\s*([a-zA-Z_$][\w$]*)\s*(?:;|$|\/)/gm
  let indirectMatch
  while ((indirectMatch = indirectRe.exec(source)) !== null) {
    const identifier = indirectMatch[1]

    // Find `const|let|var <identifier> = { ... }` earlier in the source
    const declRe = new RegExp(
      `(?:const|let|var)\\s+${identifier}\\s*=\\s*\\{`,
      'g'
    )
    let declMatch
    while ((declMatch = declRe.exec(source)) !== null) {
      if (declMatch.index >= indirectMatch.index) continue // must be BEFORE the export
      const bodyStart = declMatch.index + declMatch[0].length
      let depth = 1
      let i = bodyStart
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
      const body = source.slice(bodyStart, i - 1)
      const cleaned = body
        .replace(/\/\/.*$/gm, '')
        .replace(/\/\*[\s\S]*?\*\//g, '')
      const properties = splitObjectProperties(cleaned)
      for (const prop of properties) {
        const trimmed = prop.trim()
        if (!trimmed) continue
        if (trimmed.startsWith('...')) continue
        const explicitMatch = trimmed.match(/^([a-zA-Z_$][\w$]*)\s*:/)
        if (explicitMatch) {
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
        const shorthandMatch = trimmed.match(/^([a-zA-Z_$][\w$]*)$/)
        if (shorthandMatch) {
          names.push(shorthandMatch[1])
          continue
        }
      }
    }
  }


  return names
}

// ─── Static function extraction (from scan.js) ────────────────────────────────

function extractExportedFunctions(source, ext) {
  const fns = []

  if (ext === '.py') {
    // Python: top-level def statements
    const matches = source.matchAll(/^def\s+(\w+)\s*\(/gm)
    for (const m of matches) fns.push(m[1])
    return fns
  }

  // #286: Strip comment lines so regex patterns don't match inside comments.
  // We remove // comments and /* ... */ block comments before applying
  // the extraction regexes. This prevents false positives like:
  //   // export function fakeFn()
  //   /* export function alsoFake() */
  const strippedSource = source
    .replace(/\/\/.*$/gm, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')

  // JS/TS: exported functions
  // Named export: export function name() / export async function name()
  const namedExportFn = strippedSource.matchAll(/export\s+(?:async\s+)?function\s+(\w+)/g)
  for (const m of namedExportFn) fns.push(m[1])

  // Arrow function exports: export const name = () => {
  const arrowExports = strippedSource.matchAll(/export\s+const\s+(\w+)\s*=\s*(?:async\s*)?\(/g)
  for (const m of arrowExports) fns.push(m[1])

  // Default export function
  const defaultExportFn = strippedSource.matchAll(/export\s+default\s+function\s+(\w+)/g)
  for (const m of defaultExportFn) fns.push(m[1])

  // #292: export class X and export default class X
  // Class-only files should not report 0 functions — the class name
  // is an exported symbol worth tracking.
  const namedExportClass = strippedSource.matchAll(/export\s+class\s+(\w+)/g)
  for (const m of namedExportClass) fns.push(m[1])

  const defaultExportClass = strippedSource.matchAll(/export\s+default\s+class\s+(\w+)/g)
  for (const m of defaultExportClass) fns.push(m[1])

  // #317: export default { foo, bar } — named exports via default export object.
  // Each property name in the object literal is an exported function name.
  // (Distinct from `export { foo, bar }` named-export list below — the
  // `default` keyword sits between `export` and `{`, so the namedExportList
  // regex does not match this pattern.)
  const defaultExportObj = strippedSource.matchAll(/export\s+default\s+\{([^}]*)\}/g)
  for (const m of defaultExportObj) {
    const body = m[1]
    const properties = splitObjectProperties(body)
    for (const prop of properties) {
      const trimmed = prop.trim()
      if (!trimmed) continue
      if (trimmed.startsWith('...')) continue
      const explicitMatch = trimmed.match(/^([a-zA-Z_$][\w$]*)\s*:/)
      if (explicitMatch) { fns.push(explicitMatch[1]); continue }
      const shorthandMatch = trimmed.match(/^([a-zA-Z_$][\w$]*)$/)
      if (shorthandMatch) { fns.push(shorthandMatch[1]); continue }
    }
  }

  // #271: Named export list: export { foo, bar }
  // This pattern exports previously declared names. We extract each
  // identifier from the brace-enclosed list.
  const namedExportList = strippedSource.matchAll(/export\s*\{([^}]*)\}/g)
  for (const m of namedExportList) {
    const body = m[1]
    // Split by comma, extract identifiers
    const items = body.split(',')
    for (const item of items) {
      const trimmed = item.trim()
      if (!trimmed) continue
      // Handle "foo as bar" — export name is "bar"
      // Handle "foo" — export name is "foo"
      const asMatch = trimmed.match(/\bas\s+(\w+)$/)
      if (asMatch) {
        fns.push(asMatch[1])
      } else {
        const identMatch = trimmed.match(/^(\w+)$/)
        if (identMatch) {
          fns.push(identMatch[1])
        }
      }
    }
  }

  // CJS: module.exports.Name = ...
  const moduleExports = strippedSource.matchAll(/module\.exports\.(\w+)\s*=/g)
  for (const m of moduleExports) fns.push(m[1])

  // CJS: exports.Name = ...
  const exportsAssign = strippedSource.matchAll(/^exports\.(\w+)\s*=/gm)
  for (const m of exportsAssign) fns.push(m[1])

  // CJS: module.exports = function Name(...)
  const cjsNamedFn = strippedSource.matchAll(/module\.exports\s*=\s*function\s+(\w+)/g)
  for (const m of cjsNamedFn) fns.push(m[1])

  // CJS: module.exports = { add, multiply } / { add: addFn } / { ...other, fn }
  // Note: extractCjsObjectExports has its own comment-stripping logic,
  // but passing the already-stripped source is harmless.
  const cjsObjExports = extractCjsObjectExports(strippedSource)
  for (const name of cjsObjExports) fns.push(name)

  return [...new Set(fns)]
}

// ─── Auto-detect stack from extension ──────────────────────────────────────────

function detectStack(ext) {
  if (EXTENSIONS.python.includes(ext)) return 'python'
  if (EXTENSIONS.ts.includes(ext)) return 'ts'
  return 'js'
}

// ─── Class & class-method detection (Issue #270) ──────────────────────────────
//
// Problem: `extractExportedFunctions` only matches top-level export patterns
// (export function, module.exports.X, ...). It does NOT walk class bodies,
// so when a class is exported via `module.exports = { Calculator }` or
// `export class Calculator`, only the class name `Calculator` ends up in
// `publicFns` — the methods (`add`, `multiply`, ...) are invisible to the
// install.js callee-computation loop.
//
// Meanwhile, `analyzer.js` registers class methods as `method_definition`
// nodes and emits call edges like `{ from: 'multiply', to: 'add' }` for
// `this.add(...)` inside `multiply`. These edges are dropped by install.js's
// filter `edges.filter(e => e.from === fnName)` because no `fnName` in
// `publicFns` matches a method name.
//
// Fix: when computing callees for a cluster whose `entry` is a class name,
// include edges whose `from` is ANY method of that class (and whose `to` is
// in `definedNames`, so external method names like `arr.map` are still
// filtered out). This surfaces the analyzer's work in the manifest so the
// user can see "Calculator has internal method calls to: add" instead of
// silently getting no callees.
//
// This is a conservative fix — we don't try to emit per-method clusters
// (which would require deeper changes to capture.js's classMethod handling).
// We only preserve the callee information for the class-level cluster.

/**
 * Detect top-level class declarations in a JS/TS source file and collect
 * each class's public method names. Returns a Map<string, string[]> where
 * the key is the class name and the value is an array of method names.
 *
 * Recognized patterns:
 *   - `class Foo { ... }`                  → Foo: [method names]
 *   - `export class Foo { ... }`           → Foo: [method names]
 *   - `export default class Foo { ... }`   → Foo: [method names]
 *
 * Method detection: simple regex over the class body — matches lines like
 *   `methodName(...) {`    `async methodName(...) {`
 *   `static methodName(...) {`    `get methodName() {`    `set methodName(...) {`
 * Skips constructor, private (#prefixed), and underscore-prefixed methods
 * (consistent with extractExportedFunctions's underscore-skip policy).
 *
 * For Python: returns an empty Map — Python class methods are tracked
 * separately via `def` inside `class`, and analyzer.js already registers
 * them as functions. The install.js callee loop will pick them up via the
 * normal `edges.filter(e => e.from === fnName)` path because Python's
 * `extractExportedFunctions` returns ALL top-level `def`s including class
 * methods (a known quirk; not the bug being fixed here).
 */
function detectClassMethods(source, ext) {
  const classes = new Map()
  if (ext !== '.js' && ext !== '.mjs' && ext !== '.cjs' && ext !== '.ts' && ext !== '.tsx') {
    return classes
  }

  // Find each `class Name {` declaration (with optional `export`/`export default`).
  // We use a simple brace-matching walk to extract the class body, then
  // regex-scan the body for method definitions.
  const classDeclRe = /(?:export\s+(?:default\s+)?)?class\s+([A-Z_$][\w$]*)\s*(?:extends\s+[A-Z_$][\w$.]*)?\s*\{/g
  let match
  while ((match = classDeclRe.exec(source)) !== null) {
    const className = match[1]
    const bodyStart = match.index + match[0].length - 1  // position of `{`
    // Walk to find the matching closing brace, respecting strings and comments.
    let depth = 1
    let i = bodyStart + 1
    let inString = false
    let stringChar = ''
    let inLineComment = false
    let inBlockComment = false
    while (i < source.length && depth > 0) {
      const ch = source[i]
      const next = source[i + 1]

      if (inLineComment) {
        if (ch === '\n') inLineComment = false
        i++
        continue
      }
      if (inBlockComment) {
        if (ch === '*' && next === '/') { inBlockComment = false; i += 2; continue }
        i++
        continue
      }
      if (inString) {
        if (ch === '\\') { i += 2; continue }
        if (ch === stringChar) inString = false
        i++
        continue
      }

      if (ch === '/' && next === '/') { inLineComment = true; i += 2; continue }
      if (ch === '/' && next === '*') { inBlockComment = true; i += 2; continue }
      if (ch === '"' || ch === "'" || ch === '`') { inString = true; stringChar = ch; i++; continue }

      if (ch === '{') depth++
      else if (ch === '}') depth--
      i++
    }

    const body = source.slice(bodyStart + 1, i - 1)
    // Match method definitions: optional modifiers, name, optional params, `{`
    // Examples we want to match:
    //   add(a, b) {
    //   async add(a, b) {
    //   static add(a, b) {
    //   get value() {
    //   set value(v) {
    //   #private() {          ← skipped (private)
    //   _internal() {         ← skipped (underscore prefix)
    //   constructor() {       ← skipped
    const methodRe = /(?:^|\n)\s*(?:static\s+)?(?:async\s+)?(?:get\s+|set\s+)?([a-zA-Z_$][\w$]*)\s*\([^)]*\)\s*\{/g
    const methods = []
    let m
    while ((m = methodRe.exec(body)) !== null) {
      const name = m[1]
      if (name === 'constructor') continue
      if (name.startsWith('_')) continue
      // Skip getter/setter accessor names that share the method-re — they're
      // valid method names but install.js only wraps function-like callees.
      // (No change in behavior here — we keep them; analyzer edges for
      //  `this.foo` inside a getter would be matched anyway.)
      methods.push(name)
    }

    // Dedupe while preserving first-appearance order.
    const seen = new Set()
    const unique = []
    for (const m of methods) {
      if (!seen.has(m)) { seen.add(m); unique.push(m) }
    }
    if (unique.length > 0) {
      classes.set(className, unique)
    }
  }

  return classes
}

// ─── Python module path resolver ──────────────────────────────────────────────
//
// Issue #279: capture.py expects a Python cluster to declare `module` as a
// dotted import path (e.g. `invoice.processor`) plus an optional `pythonPath`
// pointing at the package root (e.g. `src`). Previously install.js emitted
// `file: "src/invoice/processor.py"` for every stack, which capture.py then
// passed verbatim to `importlib.import_module(...)` → ModuleNotFoundError
// (issue #274). This helper converts the discovered file path into the
// `module` + `pythonPath` pair the Python capture pipeline actually consumes.
//
// Rules:
//   - `<root>/transforms.py`           → { module: "transforms",           pythonPath: "" }
//   - `<root>/pkg/mod.py`              → { module: "pkg.mod",              pythonPath: "" }
//   - `<root>/src/invoice/processor.py`→ { module: "invoice.processor",   pythonPath: "src" }
//   - `<root>/src/utils/__init__.py`   → { module: "utils",                pythonPath: "src" }
//   - `<root>/tests/conftest.py`       → { module: "conftest",             pythonPath: "tests" }
//
// `pythonPath` is the FIRST directory component of the relative path — this
// matches the SKILL.md guidance to declare the package root (not each nested
// subfolder). An empty `pythonPath` means the module lives at the project
// root and `cwd` (which capture.py inserts into sys.path) is sufficient.
//
// The helper is pure and exported for unit testing.

function filePathToPythonModule(relPath) {
  // Normalize to forward slashes regardless of platform separators
  const normalized = relPath.replace(/\\/g, '/')
  // Strip extension
  const withoutExt = normalized.replace(/\.py$/i, '')
  const parts = withoutExt.split('/').filter(Boolean)

  // Drop `__init__` segments — the package itself is importable without it.
  // e.g. `src/pkg/__init__.py` → module `pkg`, pythonPath `src`.
  const cleaned = parts.filter(p => p !== '__init__')

  if (cleaned.length === 0) {
    // Edge case: relPath was just `__init__.py` at the root.
    return { module: '', pythonPath: '' }
  }

  if (cleaned.length === 1) {
    // File at project root, e.g. `transforms.py` → module `transforms`
    return { module: cleaned[0], pythonPath: '' }
  }

  // File in a subdirectory: first segment becomes pythonPath, rest is the
  // dotted module path. This matches the convention documented in SKILL.md
  // (pythonPath = package root, module = relative dotted path inside it).
  const pythonPath = cleaned[0]
  const module = cleaned.slice(1).join('.')
  return { module, pythonPath }
}

// ─── Generate cluster ID ───────────────────────────────────────────────────────

function generateClusterId(fnName, relPath) {
  // Convert fnName to kebab-case
  const kebabFn = fnName
    .replace(/([a-z])([A-Z])/g, '$1-$2')
    .replace(/[_\s]+/g, '-')
    .toLowerCase()

  // Include a short path hint to avoid collisions across files
  // e.g., src/utils/parse.js → utils-parse
  const parts = relPath.replace(/\.\w+$/, '').split('/')
  // Remove 'src', 'lib', 'dist' prefix
  const significantParts = parts.filter(p => !['src', 'lib', 'dist', 'index'].includes(p))
  const pathHint = significantParts.slice(-2).join('-')

  // If pathHint already contains the fn name, don't duplicate
  if (pathHint.includes(kebabFn)) return kebabFn
  return pathHint ? `${pathHint}-${kebabFn}` : kebabFn
}

// ─── Trivial-inputs guard ──────────────────────────────────────────────────────
//
// When install auto-generates [null, {}] as inputs, the resulting outputs are
// often meaningless for regression testing. There are two failure modes:
//
//   1. All outputs identical:  add(null,null)→NaN, add({},undefined)→NaN
//      → same fingerprint for every function, validate always GREEN
//
//   2. Outputs differ but meaningless:  add(null)→NaN, add({})→"[object Object]undefined"
//      → different outputs LOOK meaningful, but NaN and coerced strings are
//        unreliable — after refactoring add→subtract, NaN stays NaN and the
//        string output is an accidental coercion, not a meaningful contract.
//        validate may still produce false positives.
//
// Policy: if ANY auto-generated input produces null, undefined, NaN, or throws,
// the cluster is considered trivial — auto-generated inputs are not meaningful
// for this function. Skip it and ask the user to provide real inputs.

/**
 * Check if inputs are the auto-generated default probe set (#319).
 *
 * The default is DEFAULT_PROBE_INPUTS = ['', 'test', 0, 1, {}, [], null].
 * We compare by JSON serialization so empty objects and arrays match
 * correctly (=== would fail for distinct {} / [] instances).
 */
const _DEFAULT_PROBE_SERIALIZED = JSON.stringify(DEFAULT_PROBE_INPUTS)
function isAutoGeneratedInputs(inputs) {
  return Array.isArray(inputs)
    && JSON.stringify(inputs) === _DEFAULT_PROBE_SERIALIZED
}

/**
 * Check if a single output value is a trivial/unmeaningful result
 * that indicates auto-generated inputs are not exercising the function
 * meaningfully. Returns a reason string if trivial, or null if meaningful.
 *
 * Trivial outputs: null, undefined, NaN, the function threw, OR the output
 * is a stream/async-iterable/generator that hasn't been consumed (#256).
 *
 * Streams, async iterables, and generator objects are truthy objects but
 * don't represent the function's actual output contract — they're
 * lazy producers that need to be consumed (read/iterated) before the real
 * output is observable. Fingerprinting the producer object itself is
 * meaningless: the same function returning the same stream will produce
 * a different object identity each call, but the same bytes when consumed.
 *
 * These are not useful for regression fingerprints — they don't reflect
 * the function's real contract.
 */
function trivialOutputReason(output, threw) {
  if (threw) return 'throws on auto-generated input'
  if (output === undefined) return 'output is undefined — inputs likely not meaningful'
  if (output === null) return 'output is null — inputs likely not meaningful'
  if (Number.isNaN(output)) return 'output is NaN — inputs likely not meaningful'

  // #256 — Stream / async-iterable / generator detection.
  // These objects are truthy but their "output" is lazy — the real contract
  // is what they emit when consumed, not the producer object itself.
  // Auto-generated inputs [null, {}] almost never exercise the consumption
  // path, so any function returning these patterns is not meaningfully
  // fingerprinted without user-provided inputs.

  // Generator objects (from `function*`): have a `next` method and
  // `[Symbol.toStringTag] === 'Generator'`. Also catches async generator
  // objects (from `async function*`) which have the tag 'AsyncGenerator'.
  if (output && typeof output === 'object' && typeof output.next === 'function') {
    const tag = output[Symbol.toStringTag]
    if (tag === 'Generator') {
      return 'output is a Generator object — auto-generated inputs do not exercise the iteration contract; add meaningful inputs that consume the generator'
    }
    if (tag === 'AsyncGenerator') {
      return 'output is an AsyncGenerator object — auto-generated inputs do not exercise the async iteration contract; add meaningful inputs that consume the generator'
    }
  }

  // Async iterables: any object with an `[Symbol.asyncIterator]` method.
  // Includes ReadableStream (web), Node.js Readable streams (post-Node 16
  // they implement Symbol.asyncIterator), and user-defined async iterables.
  if (output && typeof output === 'object' && typeof output[Symbol.asyncIterator] === 'function') {
    return 'output is an async iterable (has Symbol.asyncIterator) — auto-generated inputs do not exercise the async iteration contract; add meaningful inputs that consume the iterable'
  }

  // Node.js Readable streams (pre-Symbol.asyncIterator era, or streams
  // without async iterator support): the canonical interface is
  // `pipe()` + `on('data', ...)`. We check for the `pipe` method AND
  // either `read` (Readable) or `write` (Writable) to be specific.
  if (output && typeof output === 'object'
      && typeof output.pipe === 'function'
      && (typeof output.read === 'function' || typeof output.write === 'function')) {
    return 'output is a Node.js stream (has pipe + read/write) — auto-generated inputs do not exercise the stream consumption contract; add meaningful inputs that consume the stream'
  }

  // Web ReadableStream / WritableStream / TransformStream (browser + Node 18+):
  // these have a `getReader` / `getWriter` method but no `pipe` method.
  if (output && typeof output === 'object'
      && (typeof output.getReader === 'function'
          || typeof output.getWriter === 'function')) {
    return 'output is a web stream (has getReader/getWriter) — auto-generated inputs do not exercise the stream consumption contract; add meaningful inputs that consume the stream'
  }

  // Synchronous iterators (Iterator protocol): an object with a `next`
  // method but no `[Symbol.iterator]` self-reference. We catch only the
  // plain iterator case here — iterables (objects with Symbol.iterator)
  // are common and legitimate (e.g. Map, Set, Array), so we don't flag
  // those.
  if (output && typeof output === 'object'
      && typeof output.next === 'function'
      && typeof output.return !== 'function'  // generators have return; plain iterators may not
      && !Array.isArray(output)) {
    // Heuristic: a plain iterator object (not a generator, not an iterable).
    // Be conservative — only flag if there's no other obvious type.
    const tag = output[Symbol.toStringTag]
    if (tag === 'Iterator' || (tag == null && !output[Symbol.iterator])) {
      return 'output is an Iterator object (has next, no Symbol.iterator) — auto-generated inputs do not exercise the iteration contract; add meaningful inputs that consume the iterator'
    }
  }

  return null  // output looks meaningful
}

/**
 * Serialize an output value for comparison. Handles null, undefined, NaN,
 * and normal values. Returns a string that can be compared for equality.
 */
function serializeOutput(val) {
  if (val === undefined) return '__undefined__'
  if (val === null) return '__null__'
  if (Number.isNaN(val)) return '__NaN__'
  if (val instanceof Error) return `__ERROR__:${val.constructor.name}:${val.message}`
  try {
    return JSON.stringify(val)
  } catch {
    return String(val)
  }
}

/**
 * Probe a cluster by executing its entry function with auto-generated inputs.
 * Returns { trivial: true, reason } if the cluster should be skipped,
 * or { trivial: false } if outputs look meaningful (or probing is not possible).
 *
 * A cluster is trivial if ANY auto-generated input produces a meaningless
 * output: null, undefined, NaN, or the function throws. These outputs don't
 * reflect the function's real contract, so fingerprints based on them would
 * produce false positives (regressions go undetected).
 *
 * Only probes JS/TS clusters with auto-generated [null, {}] inputs.
 * Skips Python, clusters with user-provided inputs, and clusters whose
 * module cannot be imported.
 */
async function probeTrivialOutputs(cluster, baseDir = projectRoot) {
  // Only probe clusters with auto-generated default inputs
  if (!isAutoGeneratedInputs(cluster.inputs)) return { trivial: false }

  // Only JS/TS clusters — Python probing is not supported here
  if (cluster.stack === 'python' || cluster.stack === 'rust' || cluster.stack === 'go' || cluster.stack === 'php') {
    return { trivial: false }
  }

  // Issue #265 / #294: resolve `cluster.file` relative to the scope's
  // capture cwd (the package subfolder in workspace mode, the scoped
  // directory in flat-directory mode), NOT the global projectRoot.
  // `cluster.file` is stored relative to `scopeRoot` (passed to
  // installForScope), which may differ from `process.cwd()` when the
  // user runs `regret install --scope <subdir>` from a parent dir.
  // Using the wrong base → existsSync() returns false → guard silently
  // returns `{ trivial: false }` → cluster is captured with NaN/null
  // outputs.
  const absPath = resolve(baseDir, cluster.file)
  if (!existsSync(absPath)) return { trivial: false }

  let rawModule
  try {
    const moduleUrl = pathToFileURL(absPath).href + `?_probe=${Date.now()}`
    rawModule = await import(moduleUrl)
    rawModule = mergeCjsModule(rawModule)
  } catch {
    // Can't import — let capture handle it later
    return { trivial: false }
  }

  // Resolve entry function (same logic as capture.js)
  const entryFn = rawModule[cluster.entry]
    ?? rawModule.default?.[cluster.entry]
    ?? ((cluster.entry === 'default' || cluster.entry === 'module.exports') && typeof rawModule.default === 'function' ? rawModule.default : null)

  if (typeof entryFn !== 'function') return { trivial: false }

  const probeResults = []
  for (const input of cluster.inputs) {
    let threw = false
    let output
    try {
      // Match capture.js behavior: single input passed as first arg
      output = await Promise.race([
        Promise.resolve(entryFn(input)),
        new Promise((_, reject) => setTimeout(() => reject(new Error('probe timeout')), PROBE_TIMEOUT_MS)),
      ])
    } catch {
      threw = true
      output = undefined  // placeholder for threw case
    }
    probeResults.push({ input, output, threw })
  }

  // Need at least 2 probe results to analyze
  if (probeResults.length < 2) return { trivial: false }

  // #319: Skip only if ALL inputs produce trivial output. If ANY input
  // produces a meaningful (non-null / non-undefined / non-NaN / non-throw)
  // output, the cluster is worth capturing — the expanded default probe set
  // ('', 'test', 0, 1, {}, [], null) covers string-first, numeric, and
  // object-first APIs, so a function that produces meaningful output for
  // ANY of these inputs has a testable contract.
  let trivialCount = 0
  let lastReason = null
  for (const { output, threw } of probeResults) {
    const reason = trivialOutputReason(output, threw)
    if (reason) {
      trivialCount++
      lastReason = reason
    }
  }
  if (trivialCount === probeResults.length) {
    return { trivial: true, reason: lastReason }
  }

  return { trivial: false }
}

// ─── Capture a single cluster with timeout ─────────────────────────────────────
//
// Issue #264: previously this function treated ANY exit code 0 from capture.js
// as success. But capture.js exited 0 even when it skipped a cluster whose
// stack it does not support (python/rust/go/etc) — no .regret file was
// actually written. install.js then printed "✅ captured", creating a silent
// false success. The fix has two layers:
//
//   1. Detect capture.js's new non-zero exit codes for unsupported stacks
//      (exit 2 = all skipped, exit 3 = mixed). The stderr emitted by
//      capture.js carries the marker `regrets-unsupported-stack: <stack> —`
//      so we can attribute the skip to a specific stack.
//
//   2. Belt-and-suspenders: even when capture.js exits 0, verify the
//      .regret file actually exists on disk. If it doesn't, surface a
//      clear "no .regret file written" failure rather than claiming
//      success. This protects against any future silent-skip regression.

function captureCluster(clusterId, manifestPath, cwd) {
  return new Promise((resolve) => {
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      resolve({ ok: false, reason: 'timeout' })
    }, CAPTURE_TIMEOUT_MS)

    // Where capture.js writes its .regret output. Mirrors the path logic
    // in capture.js (outDir = cwd/regrets, filename = `<id>.regret`).
    const captureCwd = cwd || projectRoot
    const expectedRegretPath = join(captureCwd, 'regrets', `${clusterId}.regret`)

    try {
      execFileSync('node', [`${SCRIPTS_DIR}/capture.js`, '--cluster', clusterId], {
        stdio: 'pipe',
        cwd: captureCwd,
        timeout: CAPTURE_TIMEOUT_MS,
      })
      clearTimeout(timer)
      if (timedOut) return

      // Belt-and-suspenders (issue #264): even with exit 0, a missing
      // .regret file means the capture silently did nothing. Report a
      // clear failure rather than a false success.
      if (!existsSync(expectedRegretPath)) {
        resolve({
          ok: false,
          reason: 'no-regret-file',
          detail: `capture.js exited 0 but regrets/${clusterId}.regret was not written`,
        })
        return
      }
      resolve({ ok: true })
    } catch (err) {
      clearTimeout(timer)
      if (timedOut) return // already resolved

      const stderr = err.stderr ? err.stderr.toString() : ''
      const exitCode = err.status ?? 0

      // Issue #264: capture.js exits 2 (all skipped) or 3 (mixed) when a
      // cluster's stack is not supported. Detect via either the exit code
      // or the stderr marker, whichever is available.
      const isUnsupportedStack =
        exitCode === 2 || exitCode === 3 ||
        stderr.includes('regrets-unsupported-stack:')

      const reason = isUnsupportedStack
        ? 'unsupported-stack'
        : stderr.includes('timeout') || err.killed
          ? 'timeout'
          : stderr.includes('ECONNREFUSED') || stderr.includes('fetch')
            ? 'network'
            : stderr.includes('ENOENT')
              ? 'import-error'
              : 'runtime-error'
      resolve({ ok: false, reason, detail: stderr.slice(0, 200) })
    }
  })
}

// ─── Scope-aware install logic ──────────────────────────────────────────────────
//
// Core install flow extracted into a reusable function so that:
//   - Default mode (--dir or cwd) calls it once
//   - Workspace mode (--scope with subfolders) calls it once per subfolder
//
// Parameters:
//   scopeDir      — absolute path to the directory to scan for files
//   manifestDir   — absolute path to the regrets/ output directory
//   scopeRoot     — directory that manifest file paths should be relative to
//   cwdForCapture — working directory for running capture.js
//   scopeLabel    — human-readable label for this scope (for display)
//   isSingleFile  — true when --scope points to a single file (mode 1)
//   singleFilePath— absolute path of the single file (mode 1 only)
//   flatDirMode   — true when --scope points to a flat dir (mode 2, non-recursive)
//   extensions    — file extensions to scan
//   maxDepth      — max directory depth for file discovery

async function installForScope({
  scopeDir,
  manifestDir,
  scopeRoot,
  cwdForCapture,
  scopeLabel,
  isSingleFile,
  singleFilePath,
  flatDirMode,
  extensions,
  maxDepth,
}) {
  // ── Step 3: Discover files ──────────────────────────────────────────────────
  const gitignorePatterns = loadGitignore(scopeRoot)
  let allFiles

  if (isSingleFile && singleFilePath) {
    // Mode 1: only the specified file
    allFiles = [singleFilePath]
  } else {
    allFiles = discoverFiles(scopeDir, extensions, maxDepth)
  }

  // Filter out gitignored files.
  // #320: In single-file mode (--scope <file.js>), the user explicitly
  // pointed at one file — do NOT apply the .gitignore filter. A .gitignore
  // entry like `*.js` or `test.js` would otherwise silently filter out the
  // explicitly-requested file, producing "Found 0 functions across 0 files".
  if (!isSingleFile) {
    allFiles = allFiles.filter(f => {
      const rel = relative(scopeRoot, f)
      return !isGitignored(rel, gitignorePatterns)
    })
  }

  // Group by stack for display
  const jsFiles = allFiles.filter(f => [...EXTENSIONS.js, ...EXTENSIONS.ts].includes(extname(f)))
  const pyFiles = allFiles.filter(f => EXTENSIONS.python.includes(extname(f)))

  const stackLabel = pyFiles.length > 0 && jsFiles.length > 0
    ? 'JS/TS/Python'
    : pyFiles.length > 0 ? 'Python' : 'JS/TS'

  console.log(`Scanning: ${scopeLabel} (${stackLabel})`)

  // ── Step 4: Extract exported functions from each file ───────────────────────
  const clusters = []
  let totalFunctions = 0

  for (const filePath of allFiles) {
    let source
    try {
      source = readFileSync(filePath, 'utf8')
    } catch { continue }

    const ext = extname(filePath)
    const relPath = relative(scopeRoot, filePath)

    // #280: Prefer tree-sitter (analyzeScope) as the source of truth for
    // function names when the language is supported. The regex-based
    // extractExportedFunctions is used only as a fallback for unsupported
    // languages or when tree-sitter returns no results (e.g. parse errors).
    // This prevents false positives like unclosed strings being interpreted
    // as function declarations by the regex extractor.
    //
    // #270 (#312 merge): When a file contains exported classes, the regex
    // extractor returns the CLASS NAMES (e.g. `Calculator`) while tree-sitter
    // returns the METHOD NAMES (e.g. `add`, `multiply`). The callee-tracking
    // logic below (`detectClassMethods` + `callerNames`) depends on class
    // names being in `publicFns` so it can look up the class's methods.
    // Strategy: run both extractors. If `extractExportedFunctions` returns
    // any class names (detected via `detectClassMethods`), prefer the regex
    // result — that's the only way to surface class-as-cluster behavior.
    // Otherwise prefer tree-sitter (more accurate for plain function files).
    //
    // We compute `classMethodsMap` ONCE here and reuse it in the callee
    // phase below — avoids a second regex scan of the same source.
    const classMethodsMap = detectClassMethods(source, ext)
    const lang = await detectLanguage(filePath)
    let fns
    if (lang !== 'unknown') {
      const scope = await analyzeScope(filePath)
      const scopeFns = scope.functions.map(f => f.name)
      const regexFns = extractExportedFunctions(source, ext)
      if (classMethodsMap.size > 0 && regexFns.length > 0) {
        // Class-based file: regex returns class names (the exported entities).
        // Use regex result so the class becomes the cluster, and its methods
        // are tracked as callees via classMethodsMap downstream.
        fns = regexFns
      } else {
        // #317: Only include functions that are actually exported. The
        // analyzer (analyzeScope) returns ALL function definitions in the
        // AST — including internal/private helpers, closure-private inner
        // functions, and non-exported top-level functions. Filter scopeFns
        // to only those whose names appear in the regex-extracted export
        // list (which checks module.exports, export, exports.X patterns).
        // If the filter produces an empty list (e.g. export pattern the
        // regex doesn't cover but the analyzer found), fall back to regexFns.
        const exportedSet = new Set(regexFns)
        const filtered = scopeFns.filter(name => exportedSet.has(name))
        fns = filtered.length > 0 ? filtered : regexFns
      }
    } else {
      fns = extractExportedFunctions(source, ext)
    }

    // Filter: skip functions starting with _
    const publicFns = fns.filter(fn => !fn.startsWith('_'))

    // ── Phase 3: Auto-populate callees via static call-graph analysis ────────
    //
    // analyzeScope(filePath) returns { functions, edges } where:
    //   - functions: [{ name, file, line }] — names defined in this file
    //   - edges:     [{ from, to }]         — call edges (caller → callee)
    //
    // For each public function we discover, compute the list of callees:
    //   1. Take every edge whose `from` === fnName → its `to` is a direct callee
    //   2. Filter to only callees that ALSO appear in `functions` — this
    //      drops external identifiers (readdirSync, join, npm imports, etc.)
    //      which are not defined in the same file and therefore cannot be
    //      wrapped as ghost callees anyway.
    //
    // Issue #270 — class-based code: `extractExportedFunctions` returns
    // class NAMES (e.g. `Calculator`) but NOT class METHOD names. The
    // analyzer, however, registers methods as `method_definition` and
    // emits edges like `{ from: 'multiply', to: 'add' }` for `this.add()`
    // inside `multiply`. The basic `e.from === fnName` filter would miss
    // these edges because no `fnName` matches a method name.
    //
    // Fix: when `fnName` is a class name (detected via `detectClassMethods`),
    // ALSO include edges whose `from` is any method of that class — the
    // methods are the actual call sites inside the class, and their `to`
    // callees (filtered to in-file defined names) are what the user wants
    // to see as "Calculator has internal calls to: add, ...".
    //
    // Failure contract: analyzeScope returns { functions: [], edges: [] }
    // for unknown languages, parse errors, missing WASM grammars, or I/O
    // errors. In all those cases calleesByFn stays empty, no `callees`
    // field is added to any cluster, and install proceeds exactly as it
    // did in Phase 1/2 — backward compatible.
    //
    // We analyze the file once (not once per function) since the AST is
    // shared across all functions in the file. analyzeScope is async
    // (lazy WASM init), so this loop is awaited.
    // `classMethodsMap` was already computed above (during function-list
    // resolution) — we reuse it here to avoid a second regex scan.
    const calleesByFn = new Map()
    try {
      const { functions: analysisFns, edges } = await analyzeScope(filePath)
      if (analysisFns.length > 0) {
        const definedNames = new Set(analysisFns.map(f => f.name))
        for (const fnName of publicFns) {
          // Build the list of "caller names" whose edges we want to include
          // for this cluster. Normally just [fnName]. But when fnName is a
          // class, we also include the class's method names — analyzer
          // edges have `from: <methodName>`, not `from: <className>`, so
          // we must match on method names to surface class-internal calls.
          const callerNames = new Set([fnName])
          const methods = classMethodsMap.get(fnName)
          if (methods) {
            for (const m of methods) callerNames.add(m)
          }

          const callees = edges
            // #312 (#270): include edges from any caller in `callerNames`
            // (fnName itself PLUS class method names when fnName is a class
            // — analyzer edges have `from: <methodName>`, not `from:
            // <className>`, so we must match on method names to surface
            // class-internal calls). This is a SUPERSET of the simpler
            // `e.from === fnName` filter that origin/main used pre-#312.
            .filter(e => callerNames.has(e.from))
            // #308 (#287): When an edge is a method call (isMethod: true)
            // on an object that is NOT `this` or `super`, it should NOT be
            // matched to a bare function with the same name. For example,
            // `obj.process()` should not resolve to the standalone `process`
            // function. Method calls on `this`/`super` ARE included because
            // they likely refer to class methods defined in the same file.
            // This filter composes with the `callerNames` filter above —
            // both must pass for the edge to be included.
            .filter(e => {
              if (!e.isMethod) return true // bare call — always include
              // Method call: only include if receiver is `this` or `super`
              return e.methodReceiver === 'this' || e.methodReceiver === 'super'
            })
            .map(e => e.to)
            .filter(name => definedNames.has(name))
          // Dedupe while preserving first-appearance order. Multiple call
          // sites to the same callee are common; the manifest only needs
          // the unique set.
          const seen = new Set()
          const unique = []
          for (const c of callees) {
            if (!seen.has(c)) {
              seen.add(c)
              unique.push(c)
            }
          }
          if (unique.length > 0) calleesByFn.set(fnName, unique)
        }
      }
    } catch {
      // Silently skip — install proceeds without callees for this file.
      // This matches analyzeScope's own no-throw contract; we double-guard
      // here in case a future change breaks that invariant.
    }

    for (const fnName of publicFns) {
      const stack = detectStack(ext)
      const clusterId = generateClusterId(fnName, relPath)

      // For TS files, try to find the compiled JS path
      let filePathForManifest = relPath
      if (ext === '.ts' || ext === '.tsx') {
        const compiledPath = relPath
          .replace(/^src\//, 'dist/')
          .replace(/\.tsx?$/, '.js')
        if (existsSync(resolve(scopeRoot, compiledPath))) {
          filePathForManifest = compiledPath
        }
      }

      const cluster = {
        id: clusterId,
        entry: fnName,
        watches: [],
        stack,
        fingerprintLevel: 'entry',
        inputs: DEFAULT_PROBE_INPUTS.map(v =>
          Array.isArray(v) ? [...v] : (v !== null && typeof v === 'object' ? { ...v } : v)
        ),
      }

      // #279 / #309: For Python clusters, emit `module` (dotted import path)
      // and optional `pythonPath` (package root) instead of `file`. capture.py
      // expects `module` and falls back to `file` only as a last resort —
      // but the fallback path uses importlib.import_module(file) which
      // crashes with ModuleNotFoundError for paths like "src/foo.py" (issue
      // #274). The `file` field is intentionally omitted for Python clusters
      // so the contract is unambiguous: `module` is authoritative.
      if (stack === 'python') {
        const { module: pyModule, pythonPath: pyPath } = filePathToPythonModule(filePathForManifest)
        cluster.module = pyModule
        // Only attach pythonPath when it's non-empty — keeps the manifest
        // minimal and matches the convention that root-level modules need
        // no pythonPath (cwd is on sys.path automatically).
        if (pyPath) cluster.pythonPath = pyPath
      } else {
        cluster.file = filePathForManifest
      }

      // Phase 3: attach the auto-computed callees list. Only add the
      // field when non-empty — preserves backward compatibility with
      // existing manifests (Phase 1/2 never had a `callees` key, and
      // capture.js treats absent `callees` the same as `callees: []`).
      const callees = calleesByFn.get(fnName)
      if (callees && callees.length > 0) {
        cluster.callees = callees
      }

      clusters.push(cluster)

      totalFunctions++
    }
  }

  const totalFiles = allFiles.length
  console.log(`Found ${totalFunctions} exported functions across ${totalFiles} files\n`)

  // Issue #296 — empty folder (or folder with only non-source files):
  // explicitly tell the user no files were found and that no manifest will
  // be written. Returning `noFiles: true` lets the caller (main / workspace
  // summary) skip the misleading "Next steps: regret validate" section.
  if (totalFiles === 0) {
    console.log(`ℹ️  No source files found in '${scopeLabel}' — manifest not created.`)
    console.log('   Supported extensions: .js, .mjs, .cjs, .ts, .tsx, .py\n')
    return {
      totalFiles: 0,
      totalFunctions: 0,
      captured: 0,
      skipped: 0,
      trivialSkipped: 0,
      skippedDetails: [],
      noFiles: true,
    }
  }

  if (totalFunctions === 0) {
    console.log('⚠️  No exported functions found.')
    console.log('   Make sure your files use export statements (ESM) or module.exports (CJS).')
    console.log('   Functions starting with _ are automatically skipped.\n')
    return { totalFunctions: 0, captured: 0, skipped: 0, trivialSkipped: 0, skippedDetails: [], totalFiles }
  }

  // ── Step 5: Handle existing manifest ────────────────────────────────────────
  const manifestPath = resolve(manifestDir, 'manifest.json')
  let existingClusters = []

  if (existsSync(manifestPath)) {
    try {
      const existing = JSON.parse(readFileSync(manifestPath, 'utf8'))
      existingClusters = existing.clusters || []
      console.warn(`⚠️  ${relative(projectRoot, manifestPath)} already exists (${existingClusters.length} clusters)`)
      console.warn('   Merging: new clusters will be added, existing ones preserved.\n')
    } catch {
      console.warn('⚠️  Existing manifest.json is invalid — overwriting.\n')
    }
  }

  // Merge: add new clusters, skip if cluster ID already exists
  const existingIds = new Set(existingClusters.map(c => c.id))
  let newClusters = clusters.filter(c => !existingIds.has(c.id))

  // ── Step 5b: Trivial-inputs guard ────────────────────────────────────────────
  let trivialSkipped = 0
  const trivialSkippedIds = []
  // Issue #268 — preserve the full cluster objects that get trivial-skipped
  // (with their auto-detected callees intact). When ALL new clusters are
  // trivial-skipped and there are no existing clusters, we write these
  // definitions to install-skipped.txt so the user can review/edit/re-run
  // without losing the analyzer's auto-detected callees info.
  const trivialSkippedClusters = []

  if (newClusters.length > 0 && !dryRun) {
    console.log('Probing auto-generated inputs for trivial output...\n')

    const probeResults = []
    for (const cluster of newClusters) {
      // Issue #265 / #294 — pass cwdForCapture (the scope's capture base
      // dir) so probeTrivialOutputs resolves `cluster.file` against the
      // correct directory. Without this, workspace mode resolves against
      // the workspace root (which doesn't contain the package's relative
      // `cluster.file` path), existsSync() returns false, and the guard
      // silently returns `{ trivial: false }` — bypassing the trivial
      // check entirely.
      const probe = await probeTrivialOutputs(cluster, cwdForCapture)
      probeResults.push({ cluster, probe })
    }

    const kept = []
    for (const { cluster, probe } of probeResults) {
      if (probe.trivial) {
        trivialSkipped++
        trivialSkippedIds.push(cluster.id)
        trivialSkippedClusters.push({ cluster, reason: probe.reason })
        process.stderr.write(
          `⚠️  Cluster "${cluster.entry}" skipped — ${probe.reason}. Add meaningful inputs manually in regrets/manifest.json.\n`
        )
      } else {
        kept.push(cluster)
      }
    }

    newClusters = kept

    if (trivialSkipped > 0) {
      console.log('')
    }
  }

  // Issue #268 — when ALL new clusters are trivial-skipped and no existing
  // clusters are present, do NOT write an empty manifest. Instead:
  //   1. Write install-skipped.txt with each skipped cluster's full
  //      definition (preserving auto-detected callees) so the user can
  //      manually edit inputs and re-run, or paste into manifest.json.
  //   2. Print a clear summary explaining what happened and where to look.
  //   3. Skip the capture step entirely (no point capturing with [null, {}]
  //      inputs — they would all fail again).
  //
  // When there are existing clusters, we still write the manifest (with
  // only existing clusters, since newClusters is empty). The user has
  // already opted into that manifest, so writing it is not "empty without
  // explanation" — the existing clusters ARE the manifest content.
  const allNewTrivialSkipped =
    newClusters.length === 0 &&
    trivialSkipped > 0 &&
    existingClusters.length === 0

  if (allNewTrivialSkipped && !dryRun) {
    const skipLogPath = resolve(manifestDir, 'install-skipped.txt')
    mkdirSync(manifestDir, { recursive: true })
    const lines = [
      'Regrets Install — All Clusters Trivial-Skipped',
      '================================================',
      `Date: ${new Date().toISOString()}`,
      `Scope: ${scopeLabel}`,
      `Functions found: ${totalFunctions}`,
      `All ${trivialSkipped} cluster(s) skipped — auto-generated probe inputs`,
      `(${JSON.stringify(DEFAULT_PROBE_INPUTS)}) produced trivial outputs (null/undefined/NaN/throws).`,
      '',
      'The cluster definitions below are preserved WITH their auto-detected',
      'callees so you can manually edit inputs and re-run. To proceed:',
      '',
      '  1. Pick a cluster definition from below.',
      `  2. Edit "inputs": ${JSON.stringify(DEFAULT_PROBE_INPUTS)} to meaningful values for that function.`,
      '  3. Paste the edited cluster into regrets/manifest.json (create the',
      '     file if needed, with format: { "clusters": [ <cluster>, ... ] }).',
      '  4. Run: regret capture --cluster <cluster-id>',
      '',
      'Or run `regret install` again after adding meaningful inputs to a',
      'manifest.json you create manually — install will detect existing',
      'clusters by ID and skip re-probing, then capture with your inputs.',
      '',
      '═══════════════════════════════════════════════════════════════════════',
      '',
    ]
    for (const { cluster, reason } of trivialSkippedClusters) {
      lines.push(`Cluster: ${cluster.id}`)
      lines.push(`Entry:   ${cluster.entry}`)
      lines.push(`File:    ${cluster.file}`)
      lines.push(`Stack:   ${cluster.stack}`)
      lines.push(`Reason:  ${reason}`)
      if (cluster.callees && cluster.callees.length > 0) {
        lines.push(`Callees: ${cluster.callees.join(', ')}`)
      } else {
        lines.push(`Callees: (none auto-detected)`)
      }
      lines.push('')
      lines.push('Cluster definition (JSON):')
      lines.push(JSON.stringify(cluster, null, 2))
      lines.push('')
      lines.push('───────────────────────────────────────────────────────────────────────')
      lines.push('')
    }
    writeFileSync(skipLogPath, lines.join('\n'), 'utf8')

    console.log(`ℹ️  All ${trivialSkipped} cluster(s) skipped due to trivial inputs.`)
    console.log(`   No manifest written — cluster definitions (with auto-detected callees)`)
    console.log(`   saved to: ${relative(projectRoot, skipLogPath)}`)
    console.log(`   Edit inputs in the cluster definitions, paste into regrets/manifest.json,`)
    console.log(`   then run: regret capture\n`)

    return {
      totalFunctions,
      totalFiles,
      captured: 0,
      skipped: 0,
      trivialSkipped,
      skippedDetails: [],
      allTrivialSkipped: true,
    }
  }

  const mergedClusters = [...existingClusters, ...newClusters]

  const manifest = { clusters: mergedClusters }

  // ── Step 6: Dry-run preview ─────────────────────────────────────────────────
  if (dryRun) {
    // --json mode (CI-friendly): emit ONLY the proposed manifest as JSON to
    // stdout. No human-readable text, so the output can be piped to `jq` or
    // captured by CI for review. New clusters only — existing clusters are
    // omitted to keep the output focused on what install would add.
    if (jsonOutput) {
      // We use process.stdout.write directly here. console.log stays
      // suppressed (set near the top of the file) for the entire run so
      // downstream code (e.g. printScopeSummary in main()) cannot pollute
      // stdout with human-readable text. console.error is untouched so
      // warnings/errors still surface on stderr.
      process.stdout.write(JSON.stringify({ clusters: newClusters }, null, 2) + '\n')
      return { totalFunctions, captured: 0, skipped: 0, trivialSkipped, skippedDetails: [], totalFiles }
    }
    console.log('📋 DRY RUN — preview only (no files written, no capture)\n')
    console.log('Manifest that would be generated:')
    console.log(JSON.stringify({ clusters: newClusters }, null, 2))
    console.log(`\n${newClusters.length} new clusters would be added`)
    if (existingIds.size > 0) {
      console.log(`${existingIds.size} existing clusters preserved`)
    }
    if (trivialSkipped > 0) {
      console.log(`${trivialSkipped} cluster(s) would be trivial-skipped (not added to manifest)`)
    }
    console.log('\nRun without --dry-run to write manifest and capture fingerprints.')
    return { totalFunctions, captured: 0, skipped: 0, trivialSkipped, skippedDetails: [], totalFiles }
  }

  // ── Step 7: Write manifest ──────────────────────────────────────────────────
  mkdirSync(manifestDir, { recursive: true })
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), 'utf8')

  if (newClusters.length > 0) {
    console.log(`Generating manifest...`)
    const manifestRelPath = relative(projectRoot, manifestPath)
    console.log(`✅ ${manifestRelPath} written (${mergedClusters.length} clusters, ${newClusters.length} new)\n`)
  } else {
    console.log('No new clusters to add — all functions already in manifest.\n')
  }

  // Issue #268 (partial-skip case) — also surface trivial-skipped cluster
  // definitions in install-skipped.txt so the user can review them even
  // when some clusters DID make it into the manifest.
  if (trivialSkipped > 0 && !allNewTrivialSkipped) {
    const skipLogPath = resolve(manifestDir, 'install-skipped.txt')
    const lines = [
      'Regrets Install — Trivial-Skipped Clusters',
      '============================================',
      `Date: ${new Date().toISOString()}`,
      `Scope: ${scopeLabel}`,
      '',
      'The following clusters were skipped because auto-generated inputs',
      `Default probe inputs (${JSON.stringify(DEFAULT_PROBE_INPUTS)}) produced trivial outputs (null/undefined/NaN/throws).`,
      'Other clusters from this scope WERE captured — check manifest.json.',
      '',
      'Cluster definitions are preserved below with auto-detected callees',
      'so you can manually edit inputs and capture them later.',
      '',
      '═══════════════════════════════════════════════════════════════════════',
      '',
    ]
    for (const { cluster, reason } of trivialSkippedClusters) {
      lines.push(`Cluster: ${cluster.id}`)
      lines.push(`Entry:   ${cluster.entry}`)
      lines.push(`File:    ${cluster.file}`)
      lines.push(`Stack:   ${cluster.stack}`)
      lines.push(`Reason:  ${reason}`)
      if (cluster.callees && cluster.callees.length > 0) {
        lines.push(`Callees: ${cluster.callees.join(', ')}`)
      } else {
        lines.push(`Callees: (none auto-detected)`)
      }
      lines.push('')
      lines.push('Cluster definition (JSON):')
      lines.push(JSON.stringify(cluster, null, 2))
      lines.push('')
      lines.push('───────────────────────────────────────────────────────────────────────')
      lines.push('')
    }
    // If install-skipped.txt already exists (from runtime-skipped clusters),
    // append rather than overwrite — both kinds of skips belong together.
    let existingLog = ''
    try { existingLog = readFileSync(skipLogPath, 'utf8') } catch { /* no existing log */ }
    const newContent = lines.join('\n')
    if (existingLog) {
      writeFileSync(skipLogPath, existingLog + '\n\n' + newContent, 'utf8')
    } else {
      writeFileSync(skipLogPath, newContent, 'utf8')
    }
  }

  // ── Step 8: Run capture ─────────────────────────────────────────────────────
  if (skipCapture) {
    console.log('⏩ Skipping capture (--skip-capture flag)')
    console.log('\nNext steps:')
    console.log('• regret capture — capture fingerprints for all clusters')
    console.log('• regret validate — verify all GREEN before starting work')
    return { totalFunctions, captured: 0, skipped: 0, trivialSkipped, skippedDetails: [], totalFiles }
  }

  // Run preBuild if configured
  if (manifest.preBuild && !skipBuild) {
    console.log(`\n🔧 Running preBuild: ${manifest.preBuild}`)
    try {
      const [cmd, ...cmdArgs] = manifest.preBuild.split(' ')
      execFileSync(cmd, cmdArgs, { stdio: 'inherit', cwd: cwdForCapture })
      console.log('   ✅ preBuild succeeded\n')
    } catch {
      console.error('   ❌ preBuild failed — continuing anyway\n')
    }
  }

  console.log('Capturing fingerprints...\n')

  let captured = 0
  let skipped = 0
  const skippedDetails = []
  // #327: Track captured clusters to compute callee-coverage breakdown.
  const capturedClusters = []

  for (const cluster of newClusters) {
    // Display label: prefer `file` for JS/TS clusters (filesystem path),
    // fall back to `module` for Python clusters (dotted module path). Issue #279:
    // Python clusters no longer carry a `file` field, so use `module` here.
    const relPath = cluster.file || cluster.module || cluster.id
    process.stdout.write(`  `)

    const result = await captureCluster(cluster.id, manifestPath, cwdForCapture)

    if (result.ok) {
      captured++
      capturedClusters.push(cluster)
      console.log(`✅ ${cluster.id} [${relPath}] captured`)
    } else {
      skipped++
      const reason = result.reason
      let reasonLabel
      if (reason === 'timeout') reasonLabel = 'timeout (needs network/IO)'
      else if (reason === 'network') reasonLabel = 'network error'
      else if (reason === 'import-error') reasonLabel = 'import error'
      else if (reason === 'unsupported-stack') {
        // Parse the stack name from capture.js's stderr marker
        // (`regrets-unsupported-stack: <stack> —`) so we can show the
        // specific capture command inline, not just a generic hint.
        const stackMatch = (result.detail || '').match(/regrets-unsupported-stack:\s*(\w+)/)
        const stackName = stackMatch ? stackMatch[1] : null
        const stackCmds = {
          python: 'python3 scripts/capture.py',
          rust: 'bash scripts/capture_rust.sh capture',
          go: 'bash scripts/capture_go.sh capture',
          react: 'node scripts/capture_react.mjs',
        }
        const cmd = stackName && stackCmds[stackName]
          ? stackCmds[stackName]
          : 'the stack-specific capture script (see install-skipped.txt)'
        reasonLabel = `unsupported stack "${stackName || '?'}" — use: ${cmd}`
      }
      else if (reason === 'no-regret-file') reasonLabel = 'capture reported success but no .regret file was written'
      else reasonLabel = 'runtime error'

      console.log(`⚠️  ${cluster.id} [${relPath}] skipped — ${reasonLabel}`)
      skippedDetails.push({
        id: cluster.id,
        file: relPath,
        reason: reasonLabel,
        detail: result.detail || '',
      })
    }
  }

  // ── Step 9: Write skipped log ───────────────────────────────────────────────
  if (skippedDetails.length > 0) {
    const skipLogPath = resolve(manifestDir, 'install-skipped.txt')
    const lines = [
      'Regrets Install — Skipped Clusters',
      '====================================',
      `Date: ${new Date().toISOString()}`,
      '',
    ]
    for (const s of skippedDetails) {
      lines.push(`Cluster: ${s.id}`)
      lines.push(`File:    ${s.file}`)
      lines.push(`Reason:  ${s.reason}`)
      if (s.detail) lines.push(`Detail:  ${s.detail}`)
      lines.push('')
    }
    lines.push('These clusters need manual review. Common fixes:')
    lines.push('• Network/IO: add mock data or use --skip-capture + manual inputs')
    lines.push('• Import error: check compiled output path in manifest')
    lines.push('• Runtime error: add proper inputs in manifest.json')
    lines.push('• Unsupported stack: capture.js only handles js/ts/css. For other stacks,')
    lines.push('  run the stack-specific capture script directly:')
    lines.push('    - Python:  python3 scripts/capture.py')
    lines.push('    - Rust:    bash scripts/capture_rust.sh capture')
    lines.push('    - Go:      bash scripts/capture_go.sh capture')
    lines.push('    - React:   node scripts/capture_react.mjs')
    lines.push('• "no .regret file was written": capture.js reported success but did')
    lines.push('  not actually write the .regret file. This is a bug — please report it.')

    writeFileSync(skipLogPath, lines.join('\n'), 'utf8')
  }

  // #327: Compute callee-coverage breakdown for the install summary.
  // For each captured cluster, check whether its declared callees have
  // corresponding .regret files on disk. Install only captures the parent
  // cluster — callee .regret files are created later by `regret capture` /
  // `regret update`. So clusters with callees will typically be "partial"
  // right after install, transitioning to "fully verified" as callee
  // contracts are captured.
  let fullyVerified = 0
  let partialCallees = 0
  let parentOnly = 0
  const partialClusterDetails = []

  for (const cluster of capturedClusters) {
    const callees = cluster.callees || []
    if (callees.length === 0) {
      parentOnly++
    } else {
      let contracted = 0
      for (const callee of callees) {
        const calleeRegretPath = join(cwdForCapture, 'regrets', `${cluster.id}.calls.${callee}.regret`)
        if (existsSync(calleeRegretPath)) contracted++
      }
      if (contracted === callees.length) {
        fullyVerified++
      } else {
        partialCallees++
        partialClusterDetails.push({ id: cluster.id, contracted, total: callees.length })
      }
    }
  }

  return {
    totalFunctions, captured, skipped, trivialSkipped, skippedDetails, totalFiles,
    fullyVerified, partialCallees, parentOnly, partialClusterDetails,
  }
}

// ─── Print summary for a single scope ────────────────────────────────────────

function printScopeSummary(result, scopeLabel) {
  const {
    totalFiles,
    totalFunctions,
    captured,
    skipped,
    trivialSkipped,
    skippedDetails,
    noFiles,
    allTrivialSkipped,
    fullyVerified = 0,
    partialCallees = 0,
    parentOnly = 0,
  } = result

  console.log('')
  console.log('📊 Install Summary')
  console.log(`   Files scanned: ${totalFiles}`)
  console.log(`   Functions found: ${totalFunctions}`)
  console.log(`   Clusters captured: ${captured}`)
  // #327: Breakdown of captured clusters by callee-coverage status.
  if (captured > 0) {
    console.log(`     ↳ fully verified (all declared callees contracted):  ${fullyVerified}`)
    console.log(`     ↳ partial (some callees not contracted):             ${partialCallees}`)
    console.log(`     ↳ parent only (no callees declared):                 ${parentOnly}`)
    if (partialCallees > 0) {
      console.log(`   ⚠️  ${partialCallees} cluster(s) have partial callee coverage — run \`regret validate\` for details.`)
    }
  }
  const totalSkipped = skipped + trivialSkipped
  if (totalSkipped > 0) {
    console.log(`   Skipped: ${totalSkipped}`)
    if (trivialSkipped > 0) {
      console.log(`     • ${trivialSkipped} trivial inputs (output is null/undefined/NaN/throws)`)
    }
    if (skipped > 0) {
      // Group runtime skips by reason
      const byReason = {}
      for (const s of (skippedDetails || [])) {
        const r = s.reason || 'unknown'
        byReason[r] = (byReason[r] || 0) + 1
      }
      for (const [reason, count] of Object.entries(byReason)) {
        console.log(`     • ${count} ${reason}`)
      }
    }
  } else {
    console.log(`   Skipped: 0`)
  }

  // Issue #296 — empty folder: do NOT print "Next steps: regret validate".
  // There is no manifest to validate, so suggesting validate is misleading.
  if (noFiles) {
    console.log('')
    console.log(`ℹ️  No source files found in '${scopeLabel}' — nothing to validate.`)
    console.log('   Add source files (.js, .mjs, .cjs, .ts, .tsx, .py) and re-run.')
    return
  }

  // Issue #268 — all clusters trivial-skipped: do NOT suggest validate
  // (there is no manifest). Direct the user to install-skipped.txt instead.
  if (allTrivialSkipped) {
    console.log('')
    console.log('Next steps:')
    console.log('• Review install-skipped.txt — cluster definitions with auto-detected callees')
    console.log('• Edit "inputs" in a cluster definition to meaningful values')
    console.log('• Paste the edited cluster into regrets/manifest.json')
    console.log('• Run: regret capture --cluster <cluster-id>')
    return
  }

  console.log('')
  console.log('Next steps:')
  console.log('• Review manifest.json — add more inputs for better coverage')
  console.log('• regret validate — verify all GREEN before starting work')
  if (skipped > 0) {
    console.log('• Check install-skipped.txt — fix skipped clusters')
  }
  if (trivialSkipped > 0) {
    console.log(`• ${trivialSkipped} cluster(s) skipped due to trivial inputs — add meaningful inputs manually in manifest.json`)
  }
  console.log('• regret uninstall — when done, clean up')
}

// ─── Main install flow ──────────────────────────────────────────────────────────

async function main() {
  console.log('\n🔧 Installing Regrets safety net...\n')

  // ── Step 1: Determine which extensions to scan ──────────────────────────────
  let extensions = []
  if (stackFilter) {
    extensions = EXTENSIONS[stackFilter] || []
    if (extensions.length === 0) {
      console.error(`❌ Unknown stack: ${stackFilter}. Supported: js, ts, python`)
      process.exit(1)
    }
  } else {
    // Auto-detect: scan all supported types
    extensions = [...EXTENSIONS.js, ...EXTENSIONS.ts, ...EXTENSIONS.python]
  }

  // ── Step 2: Route based on --scope or default ──────────────────────────────
  if (scopePath) {
    const absScopePath = resolve(projectRoot, scopePath)
    if (!existsSync(absScopePath)) {
      console.error(`❌ Scope path not found: ${scopePath}`)
      process.exit(1)
    }

    const stat = statSync(absScopePath)

    if (stat.isFile()) {
      // ── Mode 1: --scope points to a single file ───────────────────────────
      //
      // Issue #297 — file without extension (or with an unsupported extension)
      // must NOT silently be parsed as JavaScript. Previously, install.js set
      // `allFiles = [singleFilePath]` without any extension check, so files
      // like `Makefile`, `Dockerfile`, `LICENSE`, or `noext` would fall into
      // `extractExportedFunctions` with `ext = ''` and the internal regex
      // could match `function foo()` patterns — producing bogus clusters.
      //
      // Fix: validate the extension BEFORE handing off to installForScope.
      // If the file's extension is not in the supported set (respecting the
      // `--stack` filter if provided), exit with a clear error. This makes
      // single-file mode consistent with directory mode (which filters by
      // extension in `discoverFiles`).
      const fileExt = extname(absScopePath)
      const allSupportedExts = [...EXTENSIONS.js, ...EXTENSIONS.ts, ...EXTENSIONS.python]
      if (!allSupportedExts.includes(fileExt)) {
        const extLabel = fileExt === '' ? 'no extension' : `'${fileExt}'`
        console.error(`❌ Scope path '${scopePath}' has unsupported file extension (${extLabel}).`)
        console.error(`   Supported: ${allSupportedExts.join(', ')}`)
        console.error(`   If this file truly contains JS/TS/Python source, rename it to use a supported extension.`)
        process.exit(1)
      }
      // If --stack was specified, additionally check the file matches that stack.
      if (stackFilter && !(EXTENSIONS[stackFilter] || []).includes(fileExt)) {
        const actualStack = detectStack(fileExt)
        console.error(`❌ Scope path '${scopePath}' is a '${actualStack}' file but --stack ${stackFilter} was specified.`)
        console.error(`   Either drop --stack or point --scope at a ${stackFilter} file.`)
        process.exit(1)
      }

      console.log(`Scope: single file — ${scopePath}\n`)

      const result = await installForScope({
        scopeDir: dirname(absScopePath),
        manifestDir: resolve(projectRoot, 'regrets'),
        scopeRoot: projectRoot,
        cwdForCapture: projectRoot,
        scopeLabel: scopePath,
        isSingleFile: true,
        singleFilePath: absScopePath,
        flatDirMode: false,
        extensions,
        maxDepth: depth,
      })

      printScopeSummary(result, scopePath)

    } else if (stat.isDirectory()) {
      // Detect workspace (subfolders with package.json) vs flat directory
      const entries = readdirSync(absScopePath, { withFileTypes: true })
      const subfolders = entries.filter(e =>
        e.isDirectory() && !SKIP_DIRS.has(e.name) && !e.name.startsWith('.')
      )
      const subfoldersWithPackageJson = subfolders.filter(sf =>
        existsSync(join(absScopePath, sf.name, 'package.json'))
      )

      if (subfoldersWithPackageJson.length > 0) {
        // ── Mode 3: workspace / monorepo ────────────────────────────────────
        console.log(`Scope: workspace — ${subfoldersWithPackageJson.length} package(s) found in ${scopePath}\n`)

        const allResults = []
        for (const sf of subfoldersWithPackageJson) {
          const subfolderPath = join(absScopePath, sf.name)
          const label = relative(projectRoot, subfolderPath) || sf.name

          console.log(`\n📦 Processing package: ${sf.name}`)

          const result = await installForScope({
            scopeDir: subfolderPath,
            manifestDir: join(subfolderPath, 'regrets'),
            scopeRoot: subfolderPath,
            cwdForCapture: subfolderPath,
            scopeLabel: label,
            isSingleFile: false,
            singleFilePath: null,
            flatDirMode: false,
            extensions,
            maxDepth: depth,
          })
          allResults.push({ name: sf.name, path: subfolderPath, result })
        }

        // ── Workspace summary ───────────────────────────────────────────────
        console.log('\n' + '═'.repeat(60))
        console.log('WORKSPACE SUMMARY')
        console.log('═'.repeat(60))

        let totalPackages = allResults.length
        let packagesWithCaptures = 0
        let totalCaptured = 0
        let totalSkipped = 0
        let totalTrivial = 0
        let totalFunctions = 0
        let grandTotalFiles = 0
        let packagesWithNoFiles = 0
        let packagesAllTrivialSkipped = 0
        // #327: aggregate callee-coverage breakdown across packages
        let totalFullyVerified = 0
        let totalPartialCallees = 0
        let totalParentOnly = 0

        for (const { name, result } of allResults) {
          // Issue #296 — distinguish "no files in this package" from
          // "files present but 0 functions". Both currently get ⏭️, but
          // the no-files case is more concerning (user pointed --scope at
          // the wrong folder).
          let status
          if (result.noFiles) {
            status = '⏭️ '
            packagesWithNoFiles++
          } else if (result.allTrivialSkipped) {
            status = '⚠️ '
            packagesAllTrivialSkipped++
          } else if (result.captured > 0) {
            status = '✅'
          } else if (result.totalFunctions === 0) {
            status = '⏭️ '
          } else {
            status = '⚠️ '
          }
          const skipParts = []
          if (result.skipped > 0) skipParts.push(`${result.skipped} runtime`)
          if (result.trivialSkipped > 0) skipParts.push(`${result.trivialSkipped} trivial`)
          const skipStr = skipParts.length > 0 ? `, ${skipParts.join(' + ')} skipped` : ''
          const noFilesStr = result.noFiles ? ', no source files' : ''
          console.log(`  ${status} ${name}: ${result.captured} captured, ${result.totalFiles} file(s)${skipStr}${noFilesStr}`)
          totalCaptured += result.captured
          totalSkipped += result.skipped
          totalTrivial += result.trivialSkipped
          totalFunctions += result.totalFunctions
          grandTotalFiles += result.totalFiles
          totalFullyVerified += result.fullyVerified || 0
          totalPartialCallees += result.partialCallees || 0
          totalParentOnly += result.parentOnly || 0
          if (result.captured > 0) packagesWithCaptures++
        }

        console.log('')
        console.log('📊 Workspace Totals')
        console.log(`   Packages: ${totalPackages}`)
        console.log(`   Files scanned: ${grandTotalFiles}`)
        console.log(`   Functions found: ${totalFunctions}`)
        console.log(`   Clusters captured: ${totalCaptured}`)
        if (totalCaptured > 0) {
          console.log(`     ↳ fully verified (all declared callees contracted):  ${totalFullyVerified}`)
          console.log(`     ↳ partial (some callees not contracted):             ${totalPartialCallees}`)
          console.log(`     ↳ parent only (no callees declared):                 ${totalParentOnly}`)
          if (totalPartialCallees > 0) {
            console.log(`   ⚠️  ${totalPartialCallees} cluster(s) have partial callee coverage — run \`regret validate\` for details.`)
          }
        }
        const allSkipped = totalSkipped + totalTrivial
        if (allSkipped > 0) {
          console.log(`   Skipped: ${allSkipped}`)
          if (totalTrivial > 0) {
            console.log(`     • ${totalTrivial} trivial inputs (output is null/undefined/NaN/throws)`)
          }
          if (totalSkipped > 0) {
            console.log(`     • ${totalSkipped} runtime error/timeout — see install-skipped.txt in respective package directories`)
          }
        } else {
          console.log(`   Skipped: 0`)
        }
        console.log(`   ${packagesWithCaptures}/${totalPackages} package(s) have clusters installed`)

        // Issue #296 / #268 — when EVERY package came back empty or all-
        // trivial-skipped, do not leave the user with the impression that
        // `regret validate` is the next step. There is no manifest to
        // validate in any package.
        if (packagesWithCaptures === 0 && packagesWithNoFiles + packagesAllTrivialSkipped === totalPackages) {
          console.log('')
          if (packagesWithNoFiles === totalPackages) {
            console.log(`ℹ️  No source files found in any of the ${totalPackages} package(s) — nothing to validate.`)
            console.log('   Add source files (.js, .mjs, .cjs, .ts, .tsx, .py) and re-run.')
          } else if (packagesAllTrivialSkipped === totalPackages) {
            console.log(`ℹ️  All ${totalTrivial} cluster(s) across all packages were trivial-skipped.`)
            console.log('   See install-skipped.txt in each package directory for cluster definitions.')
            console.log('   Edit inputs, paste into manifest.json, then run: regret capture')
          } else {
            console.log(`ℹ️  No clusters were captured across the ${totalPackages} package(s).`)
            console.log('   See per-package messages above for details.')
          }
        }

      } else {
        // ── Mode 2: directory (recursive by default, --flat for old behavior) ─
        // #323: --scope <dir> now scans recursively by default (maxDepth = depth).
        // Use --flat to restore the pre-#323 flat-directory behavior (maxDepth = 0).
        const dirModeLabel = flatScope
          ? `directory (flat — no recursion) — ${scopePath}`
          : `directory (recursive) — ${scopePath}`
        console.log(`Scope: ${dirModeLabel}\n`)

        const result = await installForScope({
          scopeDir: absScopePath,
          manifestDir: join(absScopePath, 'regrets'),
          scopeRoot: absScopePath,
          cwdForCapture: absScopePath,
          scopeLabel: scopePath,
          isSingleFile: false,
          singleFilePath: null,
          flatDirMode: flatScope,
          extensions,
          maxDepth: flatScope ? 0 : depth,
        })

        printScopeSummary(result, scopePath)
      }
    } else {
      console.error(`❌ Scope path is neither a file nor a directory: ${scopePath}`)
      process.exit(1)
    }

  } else {
    // ── Default mode: scan from cwd (or --dir) ─────────────────────────────────
    const absScanDir = resolve(projectRoot, scanDir)
    if (!existsSync(absScanDir)) {
      console.error(`❌ Directory not found: ${scanDir}`)
      process.exit(1)
    }

    const result = await installForScope({
      scopeDir: absScanDir,
      manifestDir: resolve(projectRoot, 'regrets'),
      scopeRoot: projectRoot,
      cwdForCapture: projectRoot,
      scopeLabel: scanDir,
      isSingleFile: false,
      singleFilePath: null,
      flatDirMode: false,
      extensions,
      maxDepth: depth,
    })

    printScopeSummary(result, scanDir)
  }
}

// ─── CLI entry point guard ────────────────────────────────────────────────────
//
// install.js is both a CLI tool and (after the #279 fix) the home of the
// `filePathToPythonModule` helper, which is unit-tested directly via ESM
// import. To prevent `main()` from running when the file is imported (e.g.
// by tests/install-python-manifest.test.js or tests/trivial-guard-streams.test.js),
// we only invoke it when this file is the actual entry point — i.e. when
// `import.meta.url` matches the URL form of `process.argv[1]`. This is the
// standard ESM equivalent of `if __name__ == '__main__'` in Python.
const __entryUrl = pathToFileURL(process.argv[1]).href
if (import.meta.url === __entryUrl) {
  main().catch(err => {
    console.error(`❌ Install failed: ${err.message}`)
    process.exit(1)
  })
}

// ─── Exports for unit testing ─────────────────────────────────────────────────
//
// `filePathToPythonModule` is a pure function (file path → {module, pythonPath})
// used by the cluster-builder. Exported so tests can verify the path → dotted
// module conversion without spawning install.js as a subprocess.
//
// `trivialOutputReason`, `isAutoGeneratedInputs`, and `serializeOutput` are
// exported (#256) so unit tests can exercise the trivial-output guard logic
// directly without spawning a subprocess. The exports do not affect CLI
// behavior — `main()` above is what runs when install.js is invoked as a
// script.
export { filePathToPythonModule, trivialOutputReason, isAutoGeneratedInputs, serializeOutput }

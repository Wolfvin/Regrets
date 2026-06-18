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
//   node scripts/install.js --scope src/utils/          (flat directory)
//   node scripts/install.js --scope packages/           (workspace/monorepo)

import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, statSync } from 'fs'
import { resolve, join, extname, relative } from 'path'
import { execFileSync } from 'child_process'
import { fileURLToPath, pathToFileURL } from 'url'
import { dirname } from 'path'
import { mergeCjsModule } from './cjs-merge.js'

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
                                     Scan all JS/TS/PY files in that dir (1 level)
                                     Manifest at <dir>/regrets/
                         Workspace:  --scope packages/
                                     Each subfolder with package.json gets its own
                                     manifest at <subfolder>/regrets/
                       Cannot be used together with --dir
  --stack <stack>      Only scan files for this stack (js, ts, python)
  --depth <n>          Max directory depth (default: 3)
  --dry-run            Preview only — no files written, no capture
  --skip-capture       Write manifest but skip the capture step
  --skip-build         Skip preBuild step
  --quiet              Only print summary line

EXAMPLES:
  regret install                              Scan cwd, capture all
  regret install --dir src/                   Scan src/ recursively
  regret install --scope src/utils/math.js    Only math.js
  regret install --scope src/utils/           All files in utils/ (1 level)
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

  // JS/TS: exported functions
  // Named export: export function name() / export async function name()
  const namedExportFn = source.matchAll(/export\s+(?:async\s+)?function\s+(\w+)/g)
  for (const m of namedExportFn) fns.push(m[1])

  // Arrow function exports: export const name = () => {
  const arrowExports = source.matchAll(/export\s+const\s+(\w+)\s*=\s*(?:async\s*)?\(/g)
  for (const m of arrowExports) fns.push(m[1])

  // Default export function
  const defaultExportFn = source.matchAll(/export\s+default\s+function\s+(\w+)/g)
  for (const m of defaultExportFn) fns.push(m[1])

  // CJS: module.exports.Name = ...
  const moduleExports = source.matchAll(/module\.exports\.(\w+)\s*=/g)
  for (const m of moduleExports) fns.push(m[1])

  // CJS: exports.Name = ...
  const exportsAssign = source.matchAll(/^exports\.(\w+)\s*=/gm)
  for (const m of exportsAssign) fns.push(m[1])

  // CJS: module.exports = function Name(...)
  const cjsNamedFn = source.matchAll(/module\.exports\s*=\s*function\s+(\w+)/g)
  for (const m of cjsNamedFn) fns.push(m[1])

  // CJS: module.exports = { add, multiply } / { add: addFn } / { ...other, fn }
  const cjsObjExports = extractCjsObjectExports(source)
  for (const name of cjsObjExports) fns.push(name)

  return [...new Set(fns)]
}

// ─── Auto-detect stack from extension ──────────────────────────────────────────

function detectStack(ext) {
  if (EXTENSIONS.python.includes(ext)) return 'python'
  if (EXTENSIONS.ts.includes(ext)) return 'ts'
  return 'js'
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
 * Check if inputs are the auto-generated default [null, {}].
 */
function isAutoGeneratedInputs(inputs) {
  return Array.isArray(inputs)
    && inputs.length === 2
    && inputs[0] === null
    && inputs !== null
    && typeof inputs[1] === 'object'
    && inputs[1] !== null
    && Object.keys(inputs[1]).length === 0
}

/**
 * Check if a single output value is a trivial/unmeaningful result
 * that indicates auto-generated inputs are not exercising the function
 * meaningfully. Returns a reason string if trivial, or null if meaningful.
 *
 * Trivial outputs: null, undefined, NaN, or the function threw.
 * These are not useful for regression fingerprints — they don't reflect
 * the function's real contract.
 */
function trivialOutputReason(output, threw) {
  if (threw) return 'throws on auto-generated input'
  if (output === undefined) return 'output is undefined — inputs likely not meaningful'
  if (output === null) return 'output is null — inputs likely not meaningful'
  if (Number.isNaN(output)) return 'output is NaN — inputs likely not meaningful'
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
async function probeTrivialOutputs(cluster) {
  // Only probe clusters with auto-generated default inputs
  if (!isAutoGeneratedInputs(cluster.inputs)) return { trivial: false }

  // Only JS/TS clusters — Python probing is not supported here
  if (cluster.stack === 'python' || cluster.stack === 'rust' || cluster.stack === 'go' || cluster.stack === 'php') {
    return { trivial: false }
  }

  const absPath = resolve(projectRoot, cluster.file)
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

  // New policy: if ANY output is null/undefined/NaN/throws → trivial
  for (const { output, threw } of probeResults) {
    const reason = trivialOutputReason(output, threw)
    if (reason) {
      return { trivial: true, reason }
    }
  }

  return { trivial: false }
}

// ─── Capture a single cluster with timeout ─────────────────────────────────────

function captureCluster(clusterId, manifestPath, cwd) {
  return new Promise((resolve) => {
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      resolve({ ok: false, reason: 'timeout' })
    }, CAPTURE_TIMEOUT_MS)

    try {
      execFileSync('node', [`${SCRIPTS_DIR}/capture.js`, '--cluster', clusterId], {
        stdio: 'pipe',
        cwd: cwd || projectRoot,
        timeout: CAPTURE_TIMEOUT_MS,
      })
      clearTimeout(timer)
      if (!timedOut) {
        resolve({ ok: true })
      }
    } catch (err) {
      clearTimeout(timer)
      if (timedOut) return // already resolved

      const stderr = err.stderr ? err.stderr.toString() : ''
      const reason = stderr.includes('timeout') || err.killed
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

  // Filter out gitignored files
  allFiles = allFiles.filter(f => {
    const rel = relative(scopeRoot, f)
    return !isGitignored(rel, gitignorePatterns)
  })

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
    const fns = extractExportedFunctions(source, ext)

    // Filter: skip functions starting with _
    const publicFns = fns.filter(fn => !fn.startsWith('_'))

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

      clusters.push({
        id: clusterId,
        entry: fnName,
        watches: [],
        file: filePathForManifest,
        stack,
        fingerprintLevel: 'entry',
        inputs: [null, {}],
      })

      totalFunctions++
    }
  }

  const totalFiles = allFiles.length
  console.log(`Found ${totalFunctions} exported functions across ${totalFiles} files\n`)

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

  if (newClusters.length > 0 && !dryRun) {
    console.log('Probing auto-generated inputs for trivial output...\n')

    const probeResults = []
    for (const cluster of newClusters) {
      const probe = await probeTrivialOutputs(cluster)
      probeResults.push({ cluster, probe })
    }

    const kept = []
    for (const { cluster, probe } of probeResults) {
      if (probe.trivial) {
        trivialSkipped++
        trivialSkippedIds.push(cluster.id)
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

  const mergedClusters = [...existingClusters, ...newClusters]

  const manifest = { clusters: mergedClusters }

  // ── Step 6: Dry-run preview ─────────────────────────────────────────────────
  if (dryRun) {
    console.log('📋 DRY RUN — preview only (no files written, no capture)\n')
    console.log('Manifest that would be generated:')
    console.log(JSON.stringify({ clusters: newClusters }, null, 2))
    console.log(`\n${newClusters.length} new clusters would be added`)
    if (existingIds.size > 0) {
      console.log(`${existingIds.size} existing clusters preserved`)
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

  for (const cluster of newClusters) {
    const relPath = cluster.file
    process.stdout.write(`  `)

    const result = await captureCluster(cluster.id, manifestPath, cwdForCapture)

    if (result.ok) {
      captured++
      console.log(`✅ ${cluster.id} [${relPath}] captured`)
    } else {
      skipped++
      const reason = result.reason
      let reasonLabel
      if (reason === 'timeout') reasonLabel = 'timeout (needs network/IO)'
      else if (reason === 'network') reasonLabel = 'network error'
      else if (reason === 'import-error') reasonLabel = 'import error'
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

    writeFileSync(skipLogPath, lines.join('\n'), 'utf8')
  }

  return { totalFunctions, captured, skipped, trivialSkipped, skippedDetails, totalFiles }
}

// ─── Print summary for a single scope ────────────────────────────────────────

function printScopeSummary(result, scopeLabel) {
  const { totalFiles, totalFunctions, captured, skipped, trivialSkipped, skippedDetails } = result

  console.log('')
  console.log('📊 Install Summary')
  console.log(`   Files scanned: ${totalFiles}`)
  console.log(`   Functions found: ${totalFunctions}`)
  console.log(`   Clusters captured: ${captured}`)
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

        for (const { name, result } of allResults) {
          const status = result.captured > 0 ? '✅' : (result.totalFunctions === 0 ? '⏭️ ' : '⚠️ ')
          const skipParts = []
          if (result.skipped > 0) skipParts.push(`${result.skipped} runtime`)
          if (result.trivialSkipped > 0) skipParts.push(`${result.trivialSkipped} trivial`)
          const skipStr = skipParts.length > 0 ? `, ${skipParts.join(' + ')} skipped` : ''
          console.log(`  ${status} ${name}: ${result.captured} captured, ${result.totalFiles} file(s)${skipStr}`)
          totalCaptured += result.captured
          totalSkipped += result.skipped
          totalTrivial += result.trivialSkipped
          totalFunctions += result.totalFunctions
          grandTotalFiles += result.totalFiles
          if (result.captured > 0) packagesWithCaptures++
        }

        console.log('')
        console.log('📊 Workspace Totals')
        console.log(`   Packages: ${totalPackages}`)
        console.log(`   Files scanned: ${grandTotalFiles}`)
        console.log(`   Functions found: ${totalFunctions}`)
        console.log(`   Clusters captured: ${totalCaptured}`)
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

      } else {
        // ── Mode 2: flat directory ──────────────────────────────────────────
        console.log(`Scope: directory — ${scopePath}\n`)

        const result = await installForScope({
          scopeDir: absScopePath,
          manifestDir: join(absScopePath, 'regrets'),
          scopeRoot: absScopePath,
          cwdForCapture: absScopePath,
          scopeLabel: scopePath,
          isSingleFile: false,
          singleFilePath: null,
          flatDirMode: true,
          extensions,
          maxDepth: 0,
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

main().catch(err => {
  console.error(`❌ Install failed: ${err.message}`)
  process.exit(1)
})

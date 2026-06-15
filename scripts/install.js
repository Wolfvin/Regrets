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

import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, statSync } from 'fs'
import { resolve, join, extname, relative } from 'path'
import { execFileSync } from 'child_process'
import { fileURLToPath } from 'url'
import { dirname } from 'path'

const __dirname = dirname(fileURLToPath(import.meta.url))
const SCRIPTS_DIR = __dirname

// ─── CLI args ─────────────────────────────────────────────────────────────────

function getArg(args, flag) {
  const i = args.indexOf(flag)
  return i !== -1 ? args[i + 1] ?? null : null
}

const args = process.argv.slice(2)
const scanDir = getArg(args, '--dir') || '.'
const stackFilter = getArg(args, '--stack')
const depth = parseInt(getArg(args, '--depth') || '3', 10)
const dryRun = args.includes('--dry-run')
const skipCapture = args.includes('--skip-capture')
const skipBuild = args.includes('--skip-build')
const quiet = args.includes('--quiet')
const projectRoot = process.cwd()

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

// ─── Capture a single cluster with timeout ─────────────────────────────────────

function captureCluster(clusterId, manifestPath) {
  return new Promise((resolve) => {
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      resolve({ ok: false, reason: 'timeout' })
    }, CAPTURE_TIMEOUT_MS)

    try {
      execFileSync('node', [`${SCRIPTS_DIR}/capture.js`, '--cluster', clusterId], {
        stdio: 'pipe',
        cwd: projectRoot,
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

// ─── Main install flow ──────────────────────────────────────────────────────────

async function main() {
  console.log('\n🔧 Installing Regrets safety net...\n')

  // ── Step 1: Resolve scan directory ──────────────────────────────────────────
  const absScanDir = resolve(projectRoot, scanDir)
  if (!existsSync(absScanDir)) {
    console.error(`❌ Directory not found: ${scanDir}`)
    process.exit(1)
  }

  // ── Step 2: Determine which extensions to scan ──────────────────────────────
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

  // ── Step 3: Discover files ──────────────────────────────────────────────────
  const gitignorePatterns = loadGitignore(projectRoot)
  let allFiles = discoverFiles(absScanDir, extensions, depth)

  // Filter out gitignored files
  allFiles = allFiles.filter(f => {
    const rel = relative(projectRoot, f)
    return !isGitignored(rel, gitignorePatterns)
  })

  // Group by stack for display
  const jsFiles = allFiles.filter(f => [...EXTENSIONS.js, ...EXTENSIONS.ts].includes(extname(f)))
  const pyFiles = allFiles.filter(f => EXTENSIONS.python.includes(extname(f)))

  const stackLabel = pyFiles.length > 0 && jsFiles.length > 0
    ? 'JS/TS/Python'
    : pyFiles.length > 0 ? 'Python' : 'JS/TS'

  console.log(`Scanning: ${scanDir} (${stackLabel})`)

  // ── Step 4: Extract exported functions from each file ───────────────────────
  const clusters = []
  let totalFunctions = 0

  for (const filePath of allFiles) {
    let source
    try {
      source = readFileSync(filePath, 'utf8')
    } catch { continue }

    const ext = extname(filePath)
    const relPath = relative(projectRoot, filePath)
    const fns = extractExportedFunctions(source, ext)

    // Filter: skip functions starting with _
    const publicFns = fns.filter(fn => !fn.startsWith('_'))

    for (const fnName of publicFns) {
      const stack = detectStack(ext)
      const clusterId = generateClusterId(fnName, relPath)

      // For TS files, try to find the compiled JS path
      let filePathForManifest = relPath
      if (ext === '.ts' || ext === '.tsx') {
        // Common patterns: src/x.ts → dist/x.js, build/x.js, lib/x.js
        const compiledPath = relPath
          .replace(/^src\//, 'dist/')
          .replace(/\.tsx?$/, '.js')
        if (existsSync(resolve(projectRoot, compiledPath))) {
          filePathForManifest = compiledPath
        }
        // If no compiled output found, keep the TS path — capture.js will handle it
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
    process.exit(0)
  }

  // ── Step 5: Handle existing manifest ────────────────────────────────────────
  const manifestDir = resolve(projectRoot, 'regrets')
  const manifestPath = resolve(manifestDir, 'manifest.json')
  let existingClusters = []

  if (existsSync(manifestPath)) {
    try {
      const existing = JSON.parse(readFileSync(manifestPath, 'utf8'))
      existingClusters = existing.clusters || []
      console.warn(`⚠️  regrets/manifest.json already exists (${existingClusters.length} clusters)`)
      console.warn('   Merging: new clusters will be added, existing ones preserved.\n')
    } catch {
      console.warn('⚠️  Existing manifest.json is invalid — overwriting.\n')
    }
  }

  // Merge: add new clusters, skip if cluster ID already exists
  const existingIds = new Set(existingClusters.map(c => c.id))
  const newClusters = clusters.filter(c => !existingIds.has(c.id))
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
    return
  }

  // ── Step 7: Write manifest ──────────────────────────────────────────────────
  mkdirSync(manifestDir, { recursive: true })
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), 'utf8')

  if (newClusters.length > 0) {
    console.log(`Generating manifest...`)
    console.log(`✅ manifest.json written (${mergedClusters.length} clusters, ${newClusters.length} new)\n`)
  } else {
    console.log('No new clusters to add — all functions already in manifest.\n')
  }

  // ── Step 8: Run capture ─────────────────────────────────────────────────────
  if (skipCapture) {
    console.log('⏩ Skipping capture (--skip-capture flag)')
    console.log('\nNext steps:')
    console.log('• regret capture — capture fingerprints for all clusters')
    console.log('• regret validate — verify all GREEN before starting work')
    return
  }

  // Run preBuild if configured
  if (manifest.preBuild && !skipBuild) {
    console.log(`\n🔧 Running preBuild: ${manifest.preBuild}`)
    try {
      const [cmd, ...cmdArgs] = manifest.preBuild.split(' ')
      execFileSync(cmd, cmdArgs, { stdio: 'inherit', cwd: projectRoot })
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

    const result = await captureCluster(cluster.id, manifestPath)

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

  // ── Step 10: Summary ────────────────────────────────────────────────────────
  console.log('')
  if (captured > 0 && skipped === 0) {
    console.log(`✅ Regrets installed: ${captured}/${totalFunctions} clusters captured`)
  } else if (captured > 0) {
    console.log(`✅ Regrets installed: ${captured}/${totalFunctions} clusters captured`)
    console.log(`${skipped} skipped — see regrets/install-skipped.txt`)
  } else if (skipped > 0) {
    console.log(`⚠️  Regrets installed: 0/${totalFunctions} clusters captured`)
    console.log(`${skipped} skipped — see regrets/install-skipped.txt for details`)
  }

  console.log('')
  console.log('Next steps:')
  console.log('• Review regrets/manifest.json — add more inputs for better coverage')
  console.log('• regret validate — verify all GREEN before starting work')
  if (skipped > 0) {
    console.log('• Check regrets/install-skipped.txt — fix skipped clusters')
  }
  console.log('• regret uninstall — when done, clean up')
}

main().catch(err => {
  console.error(`❌ Install failed: ${err.message}`)
  process.exit(1)
})

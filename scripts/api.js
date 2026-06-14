// api.js — High-level programmatic API for regret-testing
// Usage:
//   import { capture, validate, scan, check } from 'regret-testing'
//
// These functions reuse the same core logic as the CLI scripts
// (parseRegret, runCluster, fingerprint, createGhost, etc.)
// without spawning child processes.

import { readFileSync, writeFileSync, readdirSync, existsSync, mkdirSync } from 'fs'
import { resolve, join, basename } from 'path'
import { pathToFileURL } from 'url'
import { parseRegret, runCluster, runReactCluster, formatDiffOutput, jsonDiff, generateJUnitXml } from './validate.js'
import { fingerprint, fingerprintSequence, extractSchema, getEnvSnapshot, stableStringify } from './fingerprint.js'
import { createGhost, deepClone, consumeIterator } from './ghost.js'
import { mergeCjsModule } from './cjs-merge.js'
import { applyOutputTransformAsync } from './outputTransform.js'

// ─── Shared helpers ───────────────────────────────────────────────────────────

function loadManifest(manifestPath) {
  const abs = resolve(manifestPath)
  return JSON.parse(readFileSync(abs, 'utf8'))
}

function findRegretFiles(regretDir, filterId) {
  if (!existsSync(regretDir)) return []
  return readdirSync(regretDir)
    .filter(f => f.endsWith('.regret'))
    .filter(f => !filterId || f === `${filterId}.regret`)
}

// ─── validate() ───────────────────────────────────────────────────────────────

/**
 * Validate captured fingerprints against live code output.
 * Reuses parseRegret and runCluster from validate.js — no child process spawn.
 *
 * @param {object} options
 * @param {string} [options.manifestPath='./regrets/manifest.json'] - Path to manifest.json
 * @param {string} [options.cluster] - Validate only this cluster ID
 * @param {boolean} [options.failFast=false] - Stop on first failure
 * @param {number} [options.runs=1] - Number of validation runs per cluster
 * @param {boolean} [options.includeDiff=true] - Include diff details for FAIL results
 * @param {string} [options.cwd=process.cwd()] - Working directory
 * @returns {Promise<{passed: number, failed: number, results: Array<{id: string, pass: boolean, expected?: string, actual?: string, diff?: string, error?: string, skipped?: boolean}>}>}
 *
 * @example
 * const result = await validate({ manifestPath: './regrets/manifest.json', failFast: true })
 * console.log(`${result.passed} passed, ${result.failed} failed`)
 */
export async function validate(options = {}) {
  const {
    manifestPath = 'regrets/manifest.json',
    cluster: clusterFilter,
    failFast = false,
    runs = 1,
    includeDiff = true,
    cwd = process.cwd(),
  } = options

  const absManifest = resolve(cwd, manifestPath)
  const regretDir = resolve(cwd, 'regrets')

  let manifest
  try {
    manifest = loadManifest(absManifest)
  } catch (err) {
    return { passed: 0, failed: 0, results: [], error: `Could not read manifest: ${err.message}` }
  }

  const regretFiles = findRegretFiles(regretDir, clusterFilter)
  if (!regretFiles.length) {
    return { passed: 0, failed: 0, results: [], error: `No .regret files found${clusterFilter ? ` for "${clusterFilter}"` : ''}` }
  }

  const results = []

  for (const file of regretFiles) {
    const id = basename(file, '.regret')
    const regretPath = join(regretDir, file)
    const regret = parseRegret(readFileSync(regretPath, 'utf8'))
    const def = manifest.clusters.find(c => c.id === id)
    if (!def) { results.push({ id, pass: true, skipped: true }); continue }

    try {
      const runOptions = { runs }
      const clusterResult = (def.stack === 'react')
        ? await runReactCluster(def, regret, runOptions)
        : await runCluster(def, regret, runOptions)

      if (clusterResult.skipped) { results.push({ id, pass: true, skipped: true }); continue }

      const liveHash = clusterResult.hashes[0]
      const isMatch = liveHash === regret.goldenHash

      const entry = { id, pass: isMatch, expected: regret.goldenHash, actual: liveHash }

      if (!isMatch && includeDiff && regret.output != null && clusterResult.lastOutput != null) {
        entry.diff = formatDiffOutput(regret.output, clusterResult.lastOutput, { verbose: false })
      }

      results.push(entry)
    } catch (err) {
      results.push({ id, pass: false, error: err.message })
    }

    if (!results.at(-1).pass && failFast) break
  }

  const passed = results.filter(r => r.pass).length
  const failed = results.filter(r => !r.pass).length
  return { passed, failed, results }
}

// ─── capture() ────────────────────────────────────────────────────────────────

/**
 * Capture fingerprints for clusters defined in the manifest.
 * Reuses the same building blocks as capture.js (fingerprint, createGhost, etc.)
 * without spawning child processes.
 *
 * @param {object} options
 * @param {string} [options.manifestPath='./regrets/manifest.json'] - Path to manifest.json
 * @param {string} [options.cluster] - Capture only this cluster ID
 * @param {string} [options.cwd=process.cwd()] - Working directory
 * @returns {Promise<{passed: number, failed: number, clusters: Array<{id: string, pass: boolean, fingerprint?: string, error?: string}>}>}
 *
 * @example
 * const result = await capture({ manifestPath: './regrets/manifest.json' })
 * result.clusters.forEach(c => console.log(`${c.id}: ${c.fingerprint}`))
 */
export async function capture(options = {}) {
  const {
    manifestPath = 'regrets/manifest.json',
    cluster: clusterFilter,
    cwd = process.cwd(),
  } = options

  const absManifest = resolve(cwd, manifestPath)
  const regretDir = resolve(cwd, 'regrets')

  let manifest
  try {
    manifest = loadManifest(absManifest)
  } catch (err) {
    return { passed: 0, failed: 0, clusters: [], error: `Could not read manifest: ${err.message}` }
  }

  const clusters = clusterFilter
    ? manifest.clusters.filter(c => c.id === clusterFilter)
    : manifest.clusters

  if (!clusters.length) {
    return { passed: 0, failed: 0, clusters: [], error: `No clusters found${clusterFilter ? ` matching "${clusterFilter}"` : ''}` }
  }

  mkdirSync(regretDir, { recursive: true })

  const results = []

  for (const cluster of clusters) {
    const { id, entry, watches = [], file, stack, normalize = [], ignoreFields = [],
            ignorePaths = [], fingerprintLevel = 'entry', fingerprintMode = 'value',
            valuePaths = [], inputs, classMethod, constructor: constructorName,
            constructorArgs, setup, instanceMethods = {}, kwargs = false,
            outputTransform = null, materializeOutput = false, seed,
            singletonMethod, singletonName, storeDispatch, initialState } = cluster

    // Skip non-JS stacks
    if (stack && stack !== 'js' && stack !== 'ts' && stack !== 'css') {
      results.push({ id, pass: true, fingerprint: null, skipped: true, note: `stack=${stack} requires native capture script` })
      continue
    }

    try {
      // Seed random for deterministic output
      const origRandom = Math.random
      if (seed != null) {
        let s = seed | 0
        Math.random = () => {
          s |= 0; s = s + 0x6D2B79F5 | 0
          let t = Math.imul(s ^ s >>> 15, 1 | s)
          t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t
          return ((t ^ t >>> 14) >>> 0) / 4294967296
        }
      }

      const absPath = resolve(cwd, file)
      const moduleUrl = pathToFileURL(absPath).href
      let rawModule = await import(moduleUrl)
      rawModule = mergeCjsModule(rawModule)

      const input = (inputs && inputs.length > 0) ? inputs[0] : null

      let output
      let fp

      if (storeDispatch) {
        // Store dispatch mode
        const storeExport = rawModule[storeDispatch.store] ?? rawModule.default?.[storeDispatch.store]
        if (!storeExport) throw new Error(`Store "${storeDispatch.store}" not found in ${file}`)

        let dispatchFn, getStateFn
        if (typeof storeExport.dispatch === 'function' && typeof storeExport.value !== 'undefined') {
          dispatchFn = storeExport.dispatch.bind(storeExport)
          getStateFn = () => storeExport.value
        } else if (typeof storeExport.dispatch === 'function' && typeof storeExport.getState === 'function') {
          dispatchFn = storeExport.dispatch.bind(storeExport)
          getStateFn = storeExport.getState
        } else if (typeof storeExport.setState === 'function') {
          dispatchFn = storeExport.setState.bind(storeExport)
          getStateFn = () => storeExport.getState()
        } else {
          throw new Error(`Store "${storeDispatch.store}" does not match any known store pattern.`)
        }

        if (initialState) {
          if (typeof storeExport.setState === 'function') {
            storeExport.setState(deepClone(initialState), true)
          }
        }

        const inputForArgs = deepClone(input)
        if (typeof storeExport.dispatch === 'function' && typeof storeExport.getState === 'function') {
          dispatchFn({ type: storeDispatch.action, payload: inputForArgs })
        } else {
          dispatchFn(storeDispatch.action, inputForArgs)
        }

        output = deepClone(getStateFn())
      } else if (classMethod) {
        // Class-based entry
        const Cls = rawModule[constructorName ?? entry] ?? rawModule.default?.[constructorName ?? entry]
        if (typeof Cls !== 'function') throw new Error(`Constructor "${constructorName ?? entry}" not found in ${file}`)
        const cArgs = constructorArgs ? deepClone(constructorArgs) : []
        const instance = new Cls(...cArgs)

        if (setup && setup.length > 0) {
          for (const step of setup) {
            instance[step.method](...(step.args ? deepClone(step.args) : []))
          }
        }

        const inputForArgs = deepClone(input)
        const args_ = kwargs && typeof inputForArgs === 'object' && inputForArgs !== null
          ? [inputForArgs]
          : [inputForArgs]
        output = await instance[classMethod](...args_)
      } else if (singletonMethod) {
        const sName = singletonName || entry
        let singleton = rawModule[sName] ?? rawModule.default?.[sName]
        if (!singleton && rawModule.default && typeof rawModule.default === 'object' && typeof rawModule.default[singletonMethod] === 'function') {
          singleton = rawModule.default
        }
        if (!singleton) throw new Error(`Singleton "${sName}" not found in ${file}`)
        const inputForArgs = deepClone(input)
        output = await singleton[singletonMethod](inputForArgs)
      } else {
        // Function-based entry
        const recorder = []
        const ghostModule = createGhost(rawModule, watches, recorder, instanceMethods)
        const entryFn = ghostModule[entry]
          ?? rawModule[entry]
          ?? rawModule.default?.[entry]
          ?? ((entry === 'default' || entry === 'module.exports') && typeof rawModule.default === 'function' ? rawModule.default : null)
        if (typeof entryFn !== 'function') throw new Error(`Entry "${entry}" not found in ${file}`)
        const inputForArgs = deepClone(input)
        output = await entryFn(inputForArgs)
      }

      // Consume iterators
      if (output && typeof output[Symbol.iterator] === 'function' &&
          typeof output.next === 'function' && !Array.isArray(output) &&
          !(output instanceof Map) && !(output instanceof Set)) {
        output = [...output]
      }

      // Apply outputTransform
      if (outputTransform) {
        output = await applyOutputTransformAsync(output, outputTransform)
      }

      // Compute fingerprint
      const fpConfig = { normalize, ignoreFields, ignorePaths }
      if (fingerprintMode === 'schema') {
        const schema = extractSchema(output)
        fp = fingerprint(input, schema, fpConfig)
      } else if (fingerprintMode === 'mixed') {
        const schema = extractSchema(output)
        const selectedValues = {}
        for (const path of (valuePaths || [])) {
          const key = path.replace(/^\$\./, '')
          const parts = key.split('.')
          let val = output
          for (const p of parts) { val = val?.[p] }
          if (val !== undefined) selectedValues[path] = val
        }
        fp = fingerprint(input, { schema, values: selectedValues }, fpConfig)
      } else {
        fp = fingerprintLevel === 'entry'
          ? fingerprint(input, output, fpConfig)
          : fingerprintSequence(recorder || [], fpConfig)
      }

      // Write .regret file
      const regretPath = join(regretDir, `${id}.regret`)
      const now = new Date().toISOString()
      const env = getEnvSnapshot()
      const content = [
        `cluster: ${id}`,
        `version: 1`,
        `fingerprint: ${fp}`,
        `captured: ${now}`,
        `watches: [${watches.join(', ')}]`,
        `entry: ${entry}`,
        `stack: ${stack || 'js'}`,
        `fingerprintLevel: ${fingerprintLevel}`,
        kwargs ? `kwargs: true` : null,
        materializeOutput ? `materializeOutput: true` : null,
        outputTransform ? `outputTransform: ${outputTransform}` : null,
        ignoreFields.length ? `ignoreFields: [${ignoreFields.join(', ')}]` : null,
        ignorePaths.length ? `ignorePaths: [${ignorePaths.join(', ')}]` : null,
        `env: ${JSON.stringify(env)}`,
        `---`,
        `INPUT  ${JSON.stringify(input ?? null)}`,
        `OUTPUT ${JSON.stringify(output ?? null)}`,
        `HASH   ${fp}`,
      ].filter(Boolean).join('\n')

      writeFileSync(regretPath, content, 'utf8')

      // Restore Math.random
      if (seed != null) Math.random = origRandom

      results.push({ id, pass: true, fingerprint: fp })
    } catch (err) {
      results.push({ id, pass: false, error: err.message })
    }
  }

  const passed = results.filter(r => r.pass).length
  const failed = results.filter(r => !r.pass).length
  return { passed, failed, clusters: results }
}

// ─── scan() ───────────────────────────────────────────────────────────────────

/**
 * Scan a project directory for cluster suggestions.
 * Identifies exported functions and suggests regret cluster definitions.
 *
 * @param {object} options
 * @param {string} [options.dir='.'] - Directory to scan
 * @param {string} [options.stack] - Filter by stack (js, ts, python)
 * @param {string} [options.cwd=process.cwd()] - Working directory
 * @returns {Promise<{suggestions: Array<{id: string, entry: string, file: string, stack: string, watches: string[]}>}>}
 *
 * @example
 * const { suggestions } = await scan({ dir: 'src/', stack: 'js' })
 * suggestions.forEach(s => console.log(`${s.id}: ${s.entry} in ${s.file}`))
 */
export async function scan(options = {}) {
  const {
    dir = '.',
    stack: stackFilter,
    cwd = process.cwd(),
  } = options

  const scanDir = resolve(cwd, dir)
  const EXTENSIONS = {
    js: ['.js', '.mjs', '.cjs'],
    ts: ['.ts', '.tsx'],
    python: ['.py'],
  }

  const suggestions = []

  // Recursively find source files
  function findFiles(dirPath, exts, depth = 0) {
    if (depth > 10) return []  // safety limit
    const entries = []
    try {
      const dirEntries = readdirSync(dirPath, { withFileTypes: true })
      for (const entry of dirEntries) {
        if (entry.name.startsWith('.') || entry.name === 'node_modules' || entry.name === 'dist') continue
        const fullPath = join(dirPath, entry.name)
        if (entry.isDirectory()) {
          entries.push(...findFiles(fullPath, exts, depth + 1))
        } else if (exts.some(ext => entry.name.endsWith(ext))) {
          entries.push(fullPath)
        }
      }
    } catch { /* skip unreadable dirs */ }
    return entries
  }

  const stacks = stackFilter ? [stackFilter] : ['js', 'ts']

  for (const stack of stacks) {
    const exts = EXTENSIONS[stack] || EXTENSIONS.js
    const files = findFiles(scanDir, exts)

    for (const filePath of files) {
      try {
        const content = readFileSync(filePath, 'utf8')
        const relPath = relative(cwd, filePath)

        // Find exported function names (simple regex-based scan)
        const exportPatterns = [
          /export\s+function\s+(\w+)/g,
          /export\s+const\s+(\w+)\s*=\s*(?:\([^)]*\)\s*=>|function)/g,
          /export\s+async\s+function\s+(\w+)/g,
          /exports\.(\w+)\s*=\s*function/g,
          /module\.exports\.(\w+)\s*=\s*function/g,
        ]

        const fns = new Set()
        for (const pattern of exportPatterns) {
          let match
          while ((match = pattern.exec(content)) !== null) {
            fns.add(match[1])
          }
        }

        for (const fnName of fns) {
          const clusterId = fnName.replace(/([A-Z])/g, '-$1').toLowerCase().replace(/^-/, '')
          suggestions.push({
            id: clusterId,
            entry: fnName,
            file: relPath,
            stack,
            watches: [fnName],
          })
        }
      } catch { /* skip unreadable files */ }
    }
  }

  return { suggestions }
}

// ─── check() ──────────────────────────────────────────────────────────────────

/**
 * Validate manifest structure and verify that entry functions exist
 * in the compiled output. Reuses mergeCjsModule from cjs-merge.js.
 *
 * @param {object} options
 * @param {string} [options.manifestPath='./regrets/manifest.json'] - Path to manifest.json
 * @param {string} [options.cluster] - Check only this cluster ID
 * @param {string} [options.cwd=process.cwd()] - Working directory
 * @returns {Promise<{valid: boolean, errors: Array<{clusterId: string, message: string}>, warnings: Array<{clusterId: string, message: string}>, checked: number}>}
 *
 * @example
 * const result = await check({ manifestPath: './regrets/manifest.json' })
 * if (!result.valid) result.errors.forEach(e => console.error(`[${e.clusterId}] ${e.message}`))
 */
export async function check(options = {}) {
  const {
    manifestPath = 'regrets/manifest.json',
    cluster: clusterFilter,
    cwd = process.cwd(),
  } = options

  const absManifest = resolve(cwd, manifestPath)

  let manifest
  try {
    manifest = loadManifest(absManifest)
  } catch (err) {
    return { valid: false, errors: [{ clusterId: '-', message: `Could not read manifest: ${err.message}` }], warnings: [], checked: 0 }
  }

  const clusters = clusterFilter
    ? manifest.clusters.filter(c => c.id === clusterFilter)
    : manifest.clusters

  const VALID_STACKS = ['js', 'ts', 'python', 'react', 'go', 'php', 'rust']
  const VALID_FP_LEVELS = ['entry', 'full', 'watched']

  const errors = []
  const warnings = []

  // Phase 1: Structure validation
  const idCounts = new Map()
  for (const cluster of clusters) {
    const id = cluster.id || '-'
    idCounts.set(id, (idCounts.get(id) || 0) + 1)
  }
  for (const [id, count] of idCounts) {
    if (count > 1) errors.push({ clusterId: id, message: `Duplicate cluster id: '${id}'` })
  }

  for (let i = 0; i < clusters.length; i++) {
    const cluster = clusters[i]
    const cid = cluster.id || `index-${i}`

    for (const field of ['id', 'entry', 'stack']) {
      if (!cluster[field]) errors.push({ clusterId: cid, message: `Missing required field: ${field}` })
    }

    if (cluster.stack && !VALID_STACKS.includes(cluster.stack)) {
      errors.push({ clusterId: cid, message: `Unknown stack '${cluster.stack}'` })
    }
    if (cluster.fingerprintLevel && !VALID_FP_LEVELS.includes(cluster.fingerprintLevel)) {
      errors.push({ clusterId: cid, message: `Invalid fingerprintLevel '${cluster.fingerprintLevel}'` })
    }
    if (!cluster.inputs && !cluster.multiArgs) {
      warnings.push({ clusterId: cid, message: `No inputs — fingerprint will be empty` })
    }
    if (cluster.fingerprintLevel === 'full' && (!cluster.watches || !cluster.watches.length)) {
      errors.push({ clusterId: cid, message: `watches required for fingerprintLevel:'full'` })
    }
  }

  if (errors.length > 0) {
    return { valid: false, errors, warnings, checked: clusters.length }
  }

  // Phase 2: Export existence validation (JS/TS only)
  const fileMap = new Map()
  for (const cluster of clusters) {
    const { file, stack } = cluster
    if (stack && stack !== 'js' && stack !== 'ts') continue
    if (!fileMap.has(file)) fileMap.set(file, [])
    fileMap.get(file).push(cluster)
  }

  for (const [file, fileClusters] of fileMap) {
    let mod
    try {
      const absPath = resolve(cwd, file)
      const moduleUrl = pathToFileURL(absPath).href
      const rawModule = await import(moduleUrl)
      mod = mergeCjsModule(rawModule)
    } catch (e) {
      for (const c of fileClusters) {
        errors.push({ clusterId: c.id, message: `Cannot import module: ${e.message}` })
      }
      continue
    }

    const availableExports = Object.keys(mod).filter(k => typeof mod[k] === 'function')

    for (const cluster of fileClusters) {
      const { id, entry, watches = [] } = cluster

      const entryFn = mod[entry] ?? mod.default?.[entry]
        ?? ((entry === 'default' || entry === 'module.exports') && typeof mod.default === 'function' ? mod.default : null)

      if (typeof entryFn !== 'function') {
        const suggestions = availableExports.filter(k =>
          k.toLowerCase().includes(entry.toLowerCase().slice(0, 5)) ||
          entry.toLowerCase().includes(k.toLowerCase().slice(0, 5))
        )
        const hint = suggestions.length ? ` (did you mean: ${suggestions.join(', ')}?)` : ''
        errors.push({ clusterId: id, message: `Entry "${entry}" not found${hint}` })
        continue
      }

      const missingWatches = watches.filter(w => typeof mod[w] !== 'function')
      if (missingWatches.length > 0) {
        warnings.push({ clusterId: id, message: `Watch target(s) not found as functions: ${missingWatches.join(', ')}` })
      }
    }
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings,
    checked: clusters.length,
  }
}

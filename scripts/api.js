// api.js — High-level programmatic API for regret-testing
// Usage:
//   import { capture, validate, scan, check } from 'regret-testing'
//
// These functions reuse the same core logic as the CLI scripts
// (parseRegret, runCluster, fingerprint, createGhost, etc.)
// without spawning child processes.

import { readFileSync, writeFileSync, readdirSync, existsSync, mkdirSync } from 'fs'
import { resolve, join, basename, relative, dirname } from 'path'
import { pathToFileURL, fileURLToPath } from 'url'
import { execFile } from 'child_process'
import { parseRegret, runCluster, runReactCluster, formatDiffOutput, formatSideEffectDiff, jsonDiff, generateJUnitXml } from './validate.js'
import { fingerprint, fingerprintSequence, extractSchema, getEnvSnapshot, stableStringify } from './fingerprint.js'
import { createGhost, deepClone, consumeIterator } from './ghost.js'
import { mergeCjsModule } from './cjs-merge.js'
import { applyOutputTransformAsync } from './outputTransform.js'
// #289: scan() must emit the same cluster shape as install.js, including
// best-effort callee detection via analyzeScope (Phase 3, PR #241).
import { analyzeScope } from './analyzer.js'

// #289: Default probe inputs must match install.js's DEFAULT_PROBE_INPUTS
// (defined in scripts/install.js:151 as ['', 'test', 0, 1, {}, [], null]).
// We duplicate the constant here so api.js remains a standalone module
// (install.js is a CLI entry point with side effects on import).
const DEFAULT_PROBE_INPUTS = ['', 'test', 0, 1, {}, [], null]

// ─── Shared helpers ───────────────────────────────────────────────────────────

function loadManifest(manifestPath) {
  const abs = resolve(manifestPath)
  let raw
  try {
    raw = readFileSync(abs, 'utf8')
  } catch (e) {
    if (e.code === 'ENOENT') throw new Error(`manifest.json not found at ${abs}. Run 'regret init' first.`)
    throw new Error(`Cannot read manifest at ${abs}: ${e.message}`)
  }
  try {
    return JSON.parse(raw)
  } catch (e) {
    throw new Error(`Invalid JSON in ${abs}: ${e.message}. Fix the syntax and retry.`)
  }
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

      // Include side effect diff if applicable
      if (!isMatch && clusterResult.goldenSideEffects) {
        const seDiff = formatSideEffectDiff(
          clusterResult.goldenSideEffects,
          clusterResult.lastSideEffectRecording,
          regret.normalize ?? [],
          regret.ignoreFields ?? [],
          regret.ignorePaths ?? []
        )
        if (seDiff) entry.sideEffectDiff = seDiff
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
            singletonMethod, singletonName, storeDispatch, initialState,
            multiArgs = false, deepCloneInput = true, resetState = null,
            trackMutation = false, adapter = null, outputEncoding = null,
            sideEffectWatches = [] } = cluster

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

      // Mirror capture.js: testInputs is the full array, defaulting to [undefined]
      const testInputs = (inputs && inputs.length > 0) ? inputs : [undefined]
      const runResults = []   // collects { input, output, fp, calls } per input
      const recorder = []     // ghost proxy call recorder

      const fpConfig = { normalize, ignoreFields, ignorePaths }

      if (storeDispatch) {
        // ── storeDispatch mode ─────────────────────────────────────────────
        const storeExport = rawModule[storeDispatch.store] ?? rawModule.default?.[storeDispatch.store]
        if (!storeExport) throw new Error(`Store "${storeDispatch.store}" not found in ${file}`)

        let dispatchFn, getStateFn, storeType
        if (typeof storeExport.dispatch === 'function' && typeof storeExport.value !== 'undefined') {
          dispatchFn = storeExport.dispatch.bind(storeExport)
          getStateFn = () => storeExport.value
          storeType = 'dispatching'
        } else if (typeof storeExport.dispatch === 'function' && typeof storeExport.getState === 'function') {
          dispatchFn = storeExport.dispatch.bind(storeExport)
          getStateFn = storeExport.getState
          storeType = 'redux'
        } else if (typeof storeExport.setState === 'function') {
          dispatchFn = storeExport.setState.bind(storeExport)
          getStateFn = () => storeExport.getState()
          storeType = 'zustand'
        } else {
          throw new Error(`Store "${storeDispatch.store}" does not match any known store pattern (DispatchingStore, Redux, Zustand).`)
        }

        for (const input of testInputs) {
          recorder.length = 0

          // Reset to initialState if provided
          if (initialState) {
            if (storeType === 'dispatching') {
              if (typeof storeExport.subject?.next === 'function') {
                storeExport.subject.next(deepClone(initialState))
              }
            } else if (storeType === 'zustand') {
              storeExport.setState(deepClone(initialState), true)
            }
          }

          const inputForRecord = deepClone(input)
          const inputForArgs = deepClone(input)

          if (storeType === 'redux') {
            dispatchFn({ type: storeDispatch.action, payload: inputForArgs })
          } else if (storeType === 'dispatching') {
            dispatchFn(storeDispatch.action, inputForArgs)
          } else if (storeType === 'zustand') {
            dispatchFn(inputForArgs)
          }

          const rawOutput = getStateFn()
          const { result: consumedOutput } = await consumeIterator(rawOutput)
          let transformedOutput = await applyOutputTransformAsync(consumedOutput, outputTransform, cwd)
          const output = deepClone(transformedOutput)

          let fp
          if (fingerprintMode === 'schema') {
            fp = fingerprint(inputForRecord, extractSchema(output), fpConfig)
          } else if (fingerprintMode === 'mixed') {
            const schema = extractSchema(output)
            const selectedValues = {}
            for (const p of (valuePaths || [])) {
              const key = p.replace(/^\$\./, '')
              const parts = key.split('.')
              let val = output
              for (const part of parts) { val = val?.[part] }
              if (val !== undefined) selectedValues[p] = val
            }
            fp = fingerprint(inputForRecord, { schema, values: selectedValues }, fpConfig)
          } else {
            fp = fingerprintLevel === 'entry'
              ? fingerprint(inputForRecord, output, fpConfig)
              : fingerprintSequence(recorder, fpConfig)
          }

          runResults.push({ input: inputForRecord, output, fp, calls: [...recorder] })
        }
      } else if (classMethod) {
        // ── Class-based entry ──────────────────────────────────────────────
        const Cls = rawModule[constructorName ?? entry] ?? rawModule.default?.[constructorName ?? entry]
        if (typeof Cls !== 'function') throw new Error(`Constructor "${constructorName ?? entry}" not found or not a class in ${file}`)
        const cArgs = constructorArgs ? deepClone(constructorArgs) : []

        for (const input of testInputs) {
          recorder.length = 0
          const instance = new Cls(...cArgs)

          // Apply ghost proxy to instance methods for watch recording
          for (const watchFn of watches) {
            if (typeof instance[watchFn] === 'function') {
              const original = instance[watchFn].bind(instance)
              instance[watchFn] = new Proxy(original, {
                apply(target, thisArg, args) {
                  const result = target(...args)
                  recorder.push({ fn: watchFn, args: deepClone(args), result: deepClone(result) })
                  return result
                }
              })
            }
          }

          if (setup && setup.length > 0) {
            for (const step of setup) {
              instance[step.method](...(step.args ? deepClone(step.args) : []))
            }
          }

          const inputForRecord = deepClone(input)
          const inputForArgs = deepClone(input)
          const args_ = multiArgs && Array.isArray(inputForArgs) ? [...inputForArgs] : [inputForArgs]
          const rawOutput = await instance[classMethod](...args_)

          const { result: consumedOutput } = await consumeIterator(rawOutput)
          let transformedOutput = await applyOutputTransformAsync(consumedOutput, outputTransform, cwd)

          let inputAfterCall = null
          if (trackMutation) {
            inputAfterCall = deepClone(inputForArgs)
          }

          const output = deepClone(transformedOutput)

          let fp
          if (fingerprintMode === 'schema') {
            fp = fingerprint(inputForRecord, extractSchema(output), fpConfig)
          } else if (fingerprintMode === 'mixed') {
            const schema = extractSchema(output)
            const selectedValues = {}
            for (const p of (valuePaths || [])) {
              const key = p.replace(/^\$\./, '')
              const parts = key.split('.')
              let val = output
              for (const part of parts) { val = val?.[part] }
              if (val !== undefined) selectedValues[p] = val
            }
            fp = fingerprint(inputForRecord, { schema, values: selectedValues }, fpConfig)
          } else {
            fp = fingerprintLevel === 'entry'
              ? fingerprint(inputForRecord, output, fpConfig)
              : fingerprintSequence(recorder, fpConfig)
          }

          const resultEntry = { input: inputForRecord, output, fp, calls: [...recorder] }
          if (trackMutation && inputAfterCall !== null) {
            const beforeStr = stableStringify(inputForRecord)
            const afterStr = stableStringify(inputAfterCall)
            resultEntry.inputMutated = beforeStr !== afterStr
            resultEntry.mutationFingerprint = fingerprint(inputForRecord, inputAfterCall, fpConfig)
            resultEntry.mutationBefore = inputForRecord
            resultEntry.mutationAfter = inputAfterCall
          }
          runResults.push(resultEntry)
        }
      } else if (singletonMethod) {
        // ── Singleton method entry ──────────────────────────────────────────
        const singletonExportName = singletonName ?? entry
        let singleton = rawModule[singletonExportName] ?? rawModule.default?.[singletonExportName]
        if (!singleton && rawModule.default && typeof rawModule.default === 'object' && typeof rawModule.default[singletonMethod] === 'function') {
          singleton = rawModule.default
        }
        if (!singleton || typeof singleton !== 'object') {
          throw new Error(`Singleton "${singletonExportName}" not found or not an object in ${file}`)
        }
        if (typeof singleton[singletonMethod] !== 'function') {
          throw new Error(`Method "${singletonMethod}" not found on singleton "${singletonExportName}" in ${file}`)
        }

        for (const input of testInputs) {
          recorder.length = 0
          const inputForRecord = deepClone(input)
          const inputForArgs = deepClone(input)
          const args_ = multiArgs && Array.isArray(inputForArgs) ? [...inputForArgs] : [inputForArgs]
          const rawOutput = await singleton[singletonMethod](...args_)

          const { result: consumedOutput } = await consumeIterator(rawOutput)
          const transformedOutput = await applyOutputTransformAsync(consumedOutput, outputTransform, cwd)
          const output = deepClone(transformedOutput)

          let fp
          if (fingerprintMode === 'schema') {
            fp = fingerprint(inputForRecord, extractSchema(output), fpConfig)
          } else if (fingerprintMode === 'mixed') {
            const schema = extractSchema(output)
            const selectedValues = {}
            for (const p of (valuePaths || [])) {
              const key = p.replace(/^\$\./, '')
              const parts = key.split('.')
              let val = output
              for (const part of parts) { val = val?.[part] }
              if (val !== undefined) selectedValues[p] = val
            }
            fp = fingerprint(inputForRecord, { schema, values: selectedValues }, fpConfig)
          } else {
            fp = fingerprintLevel === 'entry'
              ? fingerprint(inputForRecord, output, fpConfig)
              : fingerprintSequence(recorder, fpConfig)
          }

          runResults.push({ input: inputForRecord, output, fp, calls: [...recorder] })
        }
      } else {
        // ── Function-based entry ────────────────────────────────────────────
        let entryFn
        if (adapter) {
          const adapterPath = resolve(cwd, adapter)
          const adapterUrl = pathToFileURL(adapterPath).href
          const adapterModule = await import(adapterUrl)
          const adapterFn = adapterModule.default ?? adapterModule.createAdapter
          if (typeof adapterFn !== 'function') {
            throw new Error(`Adapter "${adapter}" must export a function (default or createAdapter)`)
          }
          const adapterResult = adapterFn(rawModule)
          entryFn = adapterResult.entryFn
          if (!entryFn) {
            throw new Error(`Adapter "${adapter}" returned no entryFn`)
          }
          if (adapterResult.defaultInputs && (!inputs || inputs.length === 0)) {
            testInputs.splice(0, testInputs.length, ...adapterResult.defaultInputs)
          }
        } else {
          const ghostModule = createGhost(rawModule, watches, recorder, instanceMethods)
          entryFn = ghostModule[entry]
            ?? rawModule[entry]
            ?? rawModule.default?.[entry]
            ?? ((entry === 'default' || entry === 'module.exports') && typeof rawModule.default === 'function' ? rawModule.default : null)
        }
        if (typeof entryFn !== 'function') throw new Error(`Entry "${entry}" not found or not a function in ${file}`)

        for (const input of testInputs) {
          recorder.length = 0

          // resetState: reset module-level mutable state before each run
          if (resetState) {
            const resetFn = rawModule[resetState] ?? rawModule.default?.[resetState]
            if (typeof resetFn === 'function') resetFn()
          }

          const inputForRecord = deepCloneInput ? deepClone(input) : input
          const inputForArgs = deepCloneInput ? deepClone(input) : input
          const args_ = multiArgs && Array.isArray(inputForArgs) ? [...inputForArgs] : [inputForArgs]
          const rawOutput = await entryFn(...args_)

          // Consume generators/iterators
          const { result: consumedOutput } = await consumeIterator(rawOutput, null, { materialize: materializeOutput })

          const transformedOutput = await applyOutputTransformAsync(consumedOutput, outputTransform, cwd)

          let inputAfterCall = null
          if (trackMutation) {
            inputAfterCall = deepClone(inputForArgs)
          }

          const output = deepClone(transformedOutput)

          let fp
          if (fingerprintMode === 'schema') {
            fp = fingerprint(inputForRecord, extractSchema(output), fpConfig)
          } else if (fingerprintMode === 'mixed') {
            const schema = extractSchema(output)
            const selectedValues = {}
            for (const p of (valuePaths || [])) {
              const key = p.replace(/^\$\./, '')
              const parts = key.split('.')
              let val = output
              for (const part of parts) { val = val?.[part] }
              if (val !== undefined) selectedValues[p] = val
            }
            fp = fingerprint(inputForRecord, { schema, values: selectedValues }, fpConfig)
          } else {
            fp = fingerprintLevel === 'entry'
              ? fingerprint(inputForRecord, output, fpConfig)
              : fingerprintSequence(recorder, fpConfig)
          }

          const resultEntry = { input: inputForRecord, output, fp, calls: [...recorder] }
          if (trackMutation && inputAfterCall !== null) {
            const beforeStr = stableStringify(inputForRecord)
            const afterStr = stableStringify(inputAfterCall)
            resultEntry.inputMutated = beforeStr !== afterStr
            resultEntry.mutationFingerprint = fingerprint(inputForRecord, inputAfterCall, fpConfig)
            resultEntry.mutationBefore = inputForRecord
            resultEntry.mutationAfter = inputAfterCall
          }
          runResults.push(resultEntry)
        }
      }

      // Use first run as the golden (representative) for the .regret file —
      // identical to capture.js line 876
      const { input, output, fp } = runResults[0]
      const mutationFingerprint = runResults[0]?.mutationFingerprint ?? null
      const mutationBefore = runResults[0]?.mutationBefore
      const mutationAfter = runResults[0]?.mutationAfter

      // Write .regret file
      const regretPath = join(regretDir, `${id}.regret`)
      const now = new Date().toISOString()
      const env = getEnvSnapshot()

      let outputForFile = output
      if (outputEncoding === 'base64' && Array.isArray(output) && output.every(v => typeof v === 'number' && v >= 0 && v <= 255)) {
        try {
          outputForFile = Buffer.from(output).toString('base64')
        } catch { /* keep as array */ }
      }

      const content = [
        `cluster: ${id}`,
        `version: 1`,
        `fingerprint: ${fp}`,
        `captured: ${now}`,
        `watches: [${watches.join(', ')}]`,
        storeDispatch ? `store: ${storeDispatch.store}` : (classMethod ? `constructor: ${constructorName ?? entry}` : `entry: ${entry}`),
        storeDispatch ? `dispatch: ${storeDispatch.action}` : null,
        classMethod && !storeDispatch ? `classMethod: ${classMethod}` : null,
        singletonMethod ? `singletonName: ${singletonName ?? entry}` : null,
        singletonMethod ? `singletonMethod: ${singletonMethod}` : null,
        `stack: ${stack || 'js'}`,
        `fingerprintLevel: ${fingerprintLevel}`,
        fingerprintMode !== 'value' ? `fingerprintMode: ${fingerprintMode}` : null,
        valuePaths.length ? `valuePaths: [${valuePaths.join(', ')}]` : null,
        normalize.length ? `normalize: [${normalize.join(', ')}]` : null,
        ignoreFields.length ? `ignoreFields: [${ignoreFields.join(', ')}]` : null,
        ignorePaths.length ? `ignorePaths: [${ignorePaths.join(', ')}]` : null,
        initialState ? `initialState: ${JSON.stringify(initialState)}` : null,
        outputTransform ? `outputTransform: ${outputTransform}` : null,
        constructorArgs?.length ? `constructorArgs: ${JSON.stringify(constructorArgs)}` : null,
        setup?.length ? `setup: ${JSON.stringify(setup)}` : null,
        Object.keys(instanceMethods).length ? `instanceMethods: ${JSON.stringify(instanceMethods)}` : null,
        kwargs ? `kwargs: ${kwargs}` : null,
        materializeOutput ? `materializeOutput: true` : null,
        trackMutation ? `trackMutation: true` : null,
        runResults.some(r => r.inputMutated) ? `inputMutated: true` : null,
        mutationFingerprint ? `mutationFingerprint: ${mutationFingerprint}` : null,
        outputEncoding ? `outputEncoding: ${outputEncoding}` : null,
        resetState ? `resetState: ${resetState}` : null,
        !deepCloneInput ? `deepCloneInput: false` : null,
        seed != null ? `seed: ${seed}` : null,
        `env: ${JSON.stringify(env)}`,
        `---`,
        `INPUT  ${JSON.stringify(input ?? null)}`,
        `OUTPUT ${JSON.stringify(outputForFile ?? null)}`,
        `HASH   ${fp}`,
        mutationBefore !== undefined ? `MUTATION_BEFORE ${JSON.stringify(mutationBefore)}` : null,
        mutationAfter !== undefined ? `MUTATION_AFTER ${JSON.stringify(mutationAfter)}` : null,
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

  // #289 (parity with install.js): Indirect object export pattern
  //   const mod = { add: ..., mul: ... }
  //   module.exports = mod          // ← identifier, not literal object
  // For each captured identifier, scan for an earlier `const|let|var <id> = { ... }`
  // declaration and parse its object literal body using the same property-name
  // extraction logic as above. Mirrors install.js's extension for the original
  // #289 repro (which uses exactly this pattern).
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

// ─── extractExportedFunctionsApi — parity with install.js#extractExportedFunctions ──
// #289: api.js#scan() must detect the same set of exported functions as
// install.js. Previously api.js used a simpler regex set that missed:
//   - export default function Name
//   - export default class X (#292)
//   - export class X (#292)
//   - export default { foo, bar } (#317)
//   - export { foo, bar } named-export list (#271)
//   - module.exports = function Name (CJS named function)
//   - comment-stripping (#286) so export patterns inside // or /* */ don't match
//
// This helper mirrors install.js:336-441 (extractExportedFunctions) for the
// JS/TS branch only — api.js does not handle Python (Python detection in
// scan() is limited to file-extension filtering).

function extractExportedFunctionsApi(source) {
  const fns = []

  // #286: Strip comment lines so regex patterns don't match inside comments.
  const strippedSource = source
    .replace(/\/\/.*$/gm, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')

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
  const namedExportClass = strippedSource.matchAll(/export\s+class\s+(\w+)/g)
  for (const m of namedExportClass) fns.push(m[1])

  const defaultExportClass = strippedSource.matchAll(/export\s+default\s+class\s+(\w+)/g)
  for (const m of defaultExportClass) fns.push(m[1])

  // #317: export default { foo, bar } — named exports via default export object.
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
  const namedExportList = strippedSource.matchAll(/export\s*\{([^}]*)\}/g)
  for (const m of namedExportList) {
    const body = m[1]
    const items = body.split(',')
    for (const item of items) {
      const trimmed = item.trim()
      if (!trimmed) continue
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
  // AND: module.exports = <identifier> (indirect export — see extractCjsObjectExports)
  const cjsObjExports = extractCjsObjectExports(strippedSource)
  for (const name of cjsObjExports) fns.push(name)

  return [...new Set(fns)]
}

// ─── generateClusterIdApi — parity with install.js#generateClusterId ──────────
// #289: scan() must produce the same cluster id format as install.js
// (path-hinted kebab-case, e.g. "api-add" for fnName "add" in file "api.cjs").
// Mirrors install.js:645-660.

function generateClusterIdApi(fnName, relPath) {
  const kebabFn = fnName
    .replace(/([a-z])([A-Z])/g, '$1-$2')
    .replace(/[_\s]+/g, '-')
    .toLowerCase()

  const parts = relPath.replace(/\.\w+$/, '').split('/')
  const significantParts = parts.filter(p => !['src', 'lib', 'dist', 'index'].includes(p))
  const pathHint = significantParts.slice(-2).join('-')

  if (pathHint.includes(kebabFn)) return kebabFn
  return pathHint ? `${pathHint}-${kebabFn}` : kebabFn
}

// ─── scan() ───────────────────────────────────────────────────────────────────

/**
 * Scan a project directory for cluster suggestions.
 * Identifies exported functions and suggests regret cluster definitions.
 *
 * #289: scan() emits the SAME cluster shape as `regret install` (install.js):
 *   {
 *     id:                "<path-hint>-<kebab-name>",   // e.g. "api-add"
 *     entry:             "<fnName>",
 *     watches:           [],                            // NOT [fnName] — fp:entry mode
 *     file:              "<relPath>",
 *     stack:             "js" | "ts",
 *     fingerprintLevel:  "entry",
 *     inputs:            ["", "test", 0, 1, {}, [], null],   // DEFAULT_PROBE_INPUTS
 *     callees:           ["..."],                       // best-effort via analyzeScope
 *                                                       //   (omitted when empty, matching install.js)
 *   }
 *
 * Detection parity with install.js#extractExportedFunctions:
 *   - export function / export async function / export default function Name
 *   - export class X / export default class X (#292)
 *   - export default { foo, bar } (#317)
 *   - export { foo, bar } named-export list (#271)
 *   - module.exports.X = ... / exports.X = ...
 *   - module.exports = function Name (CJS named function)
 *   - module.exports = { ... } (literal object)
 *   - module.exports = <identifier> (indirect object export — original #289 repro)
 *   - comment-stripping (#286) so patterns inside line-comments or block-comments don't match
 *
 * @param {object} options
 * @param {string} [options.dir='.'] - Directory to scan
 * @param {string} [options.stack] - Filter by stack (js, ts, python)
 * @param {string} [options.cwd=process.cwd()] - Working directory
 * @returns {Promise<{suggestions: Array<{id: string, entry: string, file: string, stack: string, watches: string[], fingerprintLevel: string, inputs: Array, callees?: string[]}>}>}
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

        // #289: Use the same extractor as install.js — handles all export
        // patterns (named/default/class/named-list/CJS/indirect) and applies
        // comment-stripping (#286) to avoid false positives.
        const fns = extractExportedFunctionsApi(content)

        // #289: Best-effort callee detection via analyzeScope (Phase 3, PR #241).
        // Mirrors install.js:1138-1196. analyzeScope returns { functions, edges }:
        //   - functions: [{ name, ... }] — names defined in this file
        //   - edges:     [{ from, to, isMethod?, methodReceiver? }]
        // We filter edges whose `from` matches one of our publicFns, drop
        // method-call edges on non-`this`/`super` receivers (#287 parity),
        // and keep only callees whose names appear in the file's defined
        // functions (drops external identifiers like readdirSync).
        //
        // analyzeScope is async (lazy WASM init). It has a no-throw contract:
        // returns { functions: [], edges: [] } on parse errors, missing WASM
        // grammars, or I/O errors. We double-guard with try/catch so a future
        // bug never breaks scan().
        let calleesByFn = new Map()
        try {
          const { functions: analysisFns, edges } = await analyzeScope(filePath)
          if (analysisFns.length > 0) {
            const definedNames = new Set(analysisFns.map(f => f.name))
            const fnSet = new Set(fns)
            for (const fnName of fns) {
              const callees = edges
                .filter(e => e.from === fnName)
                // #287 parity: drop method calls on non-this/super receivers
                .filter(e => {
                  if (!e.isMethod) return true
                  return e.methodReceiver === 'this' || e.methodReceiver === 'super'
                })
                .map(e => e.to)
                .filter(name => definedNames.has(name) && name !== fnName)
                // Also drop names that aren't in our public fn list — install.js
                // keeps them when definedNames contains them, but for scan()
                // suggestions we only surface callees that are themselves
                // exported (otherwise the manifest references ghost callees
                // that don't have their own cluster).
                .filter(name => fnSet.has(name))
              // Dedupe while preserving first-appearance order
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
          // Silently skip — scan proceeds without callees for this file.
        }

        for (const fnName of fns) {
          const clusterId = generateClusterIdApi(fnName, relPath)
          // #289: shape MUST match install.js — watches: [] (not [fnName]),
          // fingerprintLevel: 'entry', inputs: DEFAULT_PROBE_INPUTS (deep copy),
          // callees only when non-empty.
          const suggestion = {
            id: clusterId,
            entry: fnName,
            watches: [],
            file: relPath,
            stack,
            fingerprintLevel: 'entry',
            inputs: DEFAULT_PROBE_INPUTS.map(v =>
              Array.isArray(v) ? [...v] : (v !== null && typeof v === 'object' ? { ...v } : v)
            ),
          }
          const callees = calleesByFn.get(fnName)
          if (callees && callees.length > 0) {
            suggestion.callees = callees
          }
          suggestions.push(suggestion)
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

  const VALID_STACKS = ['js', 'ts', 'python', 'react', 'vue', 'go', 'php', 'rust', 'ruby', 'perl', 'lua', 'kotlin', 'scala', 'dart', 'java', 'c', 'cpp', 'csharp', 'bash', 'awk', 'nim', 'zig', 'crystal', 'fsharp', 'css']
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

// ─── chain() ───────────────────────────────────────────────────────────────

/**
 * Run chain testing (capture or validate mode) by spawning contest.mjs.
 * Returns a structured result object instead of raw stdout.
 *
 * @param {object} options
 * @param {'capture'|'validate'} [options.mode='validate'] - Chain mode
 * @param {string} [options.chain] - Run only this chain ID (optional filter)
 * @param {string} [options.cwd] - Working directory containing regrets/ folder
 * @returns {Promise<{passed: number, failed: number, chains: Array<{id: string, status: 'passed'|'failed', chainHash?: string, reason?: string, error?: string}>}>}
 */
export async function chain(options = {}) {
  const { mode = 'validate', chain, cwd } = options

  const workDir = resolve(cwd || process.cwd())
  const scriptDir = dirname(fileURLToPath(import.meta.url))
  const contestScript = join(scriptDir, 'contest.mjs')

  const modeFlag = mode === 'capture' ? '--capture' : '--validate'
  const args = [contestScript, modeFlag]
  if (chain) {
    args.push('--chain', chain)
  }

  // #285: Capture stderr too. Previously this Promise resolved with only
  // `stdout`, which meant any error message contest.mjs wrote to stderr
  // (e.g. `console.error(`❌ Chain failed: ${err.message}`)` for an
  // uncaught exception, or Node's own stack traces) was discarded by
  // `resolve(stdout || '')`. When stdout parsing then failed to find a
  // result line for the current chain, the user got the unhelpful
  // "no result line found in output" reason with no way to see the real
  // error. We now resolve with `{ stdout, stderr }` so the parser can
  // include the actual stderr content in the failure reason. Closes #285.
  const { stdout, stderr } = await new Promise((resolve, reject) => {
    execFile('node', args, {
      cwd: workDir,
      maxBuffer: 10 * 1024 * 1024,
      encoding: 'utf8',
    }, (err, stdout, stderr) => {
      if (err && err.code !== 1) {
        // Exit code 1 means some chains failed — that's a valid result.
        // Other errors (ENOENT, etc.) are real failures.
        reject(new Error(`chain() failed: ${err.message}\n${stderr}`))
        return
      }
      resolve({ stdout: stdout || '', stderr: stderr || '' })
    })
  })

  // Parse stdout into structured result
  // contest.mjs outputs lines like:
  //   ⛓  Chain: <id> (<n> steps)
  //   Step <n>: <cluster> → <fingerprint>
  //   Chain hash: <hash>
  //   ✅ Captured → <path>        (capture mode, passed)
  //   ✅ Match                     (validate mode, passed)
  //   ❌ Mismatch — <reason>       (validate mode, failed)
  //   ❌ Chain failed: <error>     (error)
  //   ──────────────────────────────────────────────────
  //   Chain capture|validate: <n> passed, <n> failed

  const chains = []
  let currentChainId = null
  let currentChainHash = null

  for (const line of stdout.split('\n')) {
    const trimmed = line.trim()

    // Detect chain start: "⛓  Chain: <id> (<n> steps)"
    const chainMatch = trimmed.match(/^⛓\s+Chain:\s+(\S+)/)
    if (chainMatch) {
      currentChainId = chainMatch[1]
      currentChainHash = null
      continue
    }

    // Detect chain hash: "Chain hash: <hash>"
    const hashMatch = trimmed.match(/^Chain hash:\s+(\S+)/)
    if (hashMatch && currentChainId) {
      currentChainHash = hashMatch[1]
      continue
    }

    // Detect pass: "✅ Captured → <path>" or "✅ Match"
    if (trimmed.includes('✅') && currentChainId) {
      chains.push({
        id: currentChainId,
        status: 'passed',
        ...(currentChainHash ? { chainHash: currentChainHash } : {}),
      })
      currentChainId = null
      currentChainHash = null
      continue
    }

    // Detect fail: "❌ Mismatch — <reason>"
    const mismatchMatch = trimmed.match(/^❌\s+Mismatch\s+—\s+(.+)$/)
    if (mismatchMatch && currentChainId) {
      chains.push({
        id: currentChainId,
        status: 'failed',
        reason: mismatchMatch[1],
        ...(currentChainHash ? { chainHash: currentChainHash } : {}),
      })
      currentChainId = null
      currentChainHash = null
      continue
    }

    // Detect error: "❌ Chain failed: <error>"
    const errorMatch = trimmed.match(/^❌\s+Chain failed:\s+(.+)$/)
    if (errorMatch && currentChainId) {
      chains.push({
        id: currentChainId,
        status: 'failed',
        error: errorMatch[1],
      })
      currentChainId = null
      currentChainHash = null
      continue
    }
  }

  // If a chain was started but never concluded (edge case), mark it failed.
  // #285: when this happens, include the captured stderr in the failure
  // reason so the user can see the actual error message that contest.mjs
  // wrote to stderr (e.g. an uncaught exception's stack trace, or a
  // Python subprocess error). Previously this branch always returned the
  // opaque "no result line found in output" string with no diagnostic
  // value. Closes #285.
  if (currentChainId) {
    const stderrTrimmed = (stderr || '').trim()
    const reason = stderrTrimmed
      ? `no result line found in output — stderr: ${stderrTrimmed}`
      : 'no result line found in output'
    chains.push({
      id: currentChainId,
      status: 'failed',
      reason,
      ...(currentChainHash ? { chainHash: currentChainHash } : {}),
      ...(stderrTrimmed ? { stderr: stderrTrimmed } : {}),
    })
  }

  const passed = chains.filter(c => c.status === 'passed').length
  const failed = chains.filter(c => c.status === 'failed').length

  return { passed, failed, chains }
}

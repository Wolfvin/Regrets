#!/usr/bin/env node
// validate.js — regression validator
// Usage:
//   node scripts/validate.js
//   node scripts/validate.js --runs 5
//   node scripts/validate.js --cluster transform-user-data
//   node scripts/validate.js --update transform-user-data --reason "tax rate changed to 12%"
//   node scripts/validate.js --fail-fast
//   node scripts/validate.js --no-diff
//   node scripts/validate.js --quiet           Only print summary line
//   node scripts/validate.js --verbose         Print extra detail (input, output, calls)
//   node scripts/validate.js --reporter junit

import { readFileSync, writeFileSync, readdirSync, appendFileSync, existsSync } from 'fs'
import { createHash } from 'crypto'
import { resolve, join, basename } from 'path'
import { pathToFileURL } from 'url'
import { fingerprint, fingerprintSequence, extractSchema, getEnvSnapshot, stableStringify } from './fingerprint.js'
import { createGhost, deepClone, normalizeHtml, consumeIterator } from './ghost.js'
import { mergeCjsModule } from './cjs-merge.js'
import { applyOutputTransformAsync } from './outputTransform.js'

// ─── CLI args ─────────────────────────────────────────────────────────────────

function getArg(args, flag) {
  const i = args.indexOf(flag)
  return i !== -1 ? args[i + 1] ?? null : null
}

const args          = process.argv.slice(2)
const clusterFilter = getArg(args, '--cluster')
const failFast      = args.includes('--fail-fast')
const runs          = parseInt(getArg(args, '--runs') ?? '1')
const updateTarget  = getArg(args, '--update')
const updateReason  = getArg(args, '--reason')
const manifestPath  = getArg(args, '--manifest') ?? resolve(process.cwd(), 'regrets/manifest.json')
const regretDir     = resolve(process.cwd(), 'regrets')
const auditLog      = join(regretDir, 'audit.log')
const jsonOutput    = args.includes('--json')
const noDiff        = args.includes('--no-diff')
const reporter      = getArg(args, '--reporter') ?? null  // 'junit' | null

// ─── --quiet / --verbose flags ─────────────────────────────────────────────────

let quiet   = args.includes('--quiet')
let verbose = args.includes('--verbose')

if (quiet && verbose) {
  console.warn('⚠️  --quiet and --verbose are mutually exclusive; using --quiet')
  verbose = false
}

// --json already implies quiet for human-readable output; --quiet/--verbose don't affect JSON
// quiet: only print summary line
// verbose: print everything + extra detail (input, full output, call sequence)
// default (neither): current behavior unchanged

// ─── Validate --update usage ──────────────────────────────────────────────────

if (updateTarget && !updateReason) {
  if (jsonOutput) {
    console.log(JSON.stringify({ error: '--update requires --reason' }))
  } else {
    console.error(`❌ --update requires --reason`)
    console.error(`   Example: --update ${updateTarget} --reason "describe why behavior changed"`)
  }
  process.exit(1)
}

if (updateReason && updateReason.split(' ').length < 4) {
  if (jsonOutput) {
    console.log(JSON.stringify({ error: `--reason is too vague: "${updateReason}"` }))
  } else {
    console.error(`❌ --reason is too vague: "${updateReason}"`)
    console.error(`   Be specific. e.g. "tax rate updated from 11% to 12% per new regulation"`)
  }
  process.exit(1)
}

// ─── Parse a .regret file ─────────────────────────────────────────────────────

function parseRegret(content) {
  const [metaSection, dataSection] = content.split('\n---\n')
  const meta = {}
  for (const line of metaSection.split('\n')) {
    const colonIdx = line.indexOf(': ')
    if (colonIdx === -1) continue
    const key = line.slice(0, colonIdx)
    const val = line.slice(colonIdx + 2).trim()
    if (key === 'watches') meta.watches = val.slice(1, -1).split(', ').filter(Boolean)
    else if (key === 'normalize') meta.normalize = val.slice(1, -1).split(', ').filter(Boolean)
    else if (key === 'ignoreFields') meta.ignoreFields = val.slice(1, -1).split(', ').filter(Boolean)
    else if (key === 'ignorePaths') meta.ignorePaths = val.slice(1, -1).split(', ').filter(Boolean)
    else if (key === 'fingerprintMode') meta.fingerprintMode = val
    else if (key === 'valuePaths') meta.valuePaths = val.slice(1, -1).split(', ').filter(Boolean)
    else if (key === 'outputTransform') meta.outputTransform = val
    else if (key === 'env') {
      try { meta.env = JSON.parse(val) } catch { meta.env = val }
    }
    else if (key === 'kwargs') meta.kwargs = val === 'true'
    else if (key === 'materializeOutput') meta.materializeOutput = val === 'true'
    else if (key === 'trackMutation') meta.trackMutation = val === 'true'
    else if (key === 'inputMutated') meta.inputMutated = val === 'true'
    else if (key === 'mutationFingerprint') meta.mutationFingerprint = val
    else if (key === 'version') meta.version = Number(val)
    else if (key === 'constructorArgs' || key === 'setup' || key === 'initialState') meta[key] = JSON.parse(val)
    else if (key === 'instanceMethods') {
      try { meta.instanceMethods = JSON.parse(val) } catch { meta.instanceMethods = {} }
    }
    else if (key === 'singletonMethod') meta.singletonMethod = val
    else if (key === 'singletonName') meta.singletonName = val
    else if (key === 'dispatch') meta.dispatch = val
    else meta[key] = val
  }
  const lines = dataSection?.split('\n') ?? []
  const inputLine  = lines.find(l => l.startsWith('INPUT '))
  const outputLine = lines.find(l => l.startsWith('OUTPUT '))
  const hashLine   = lines.find(l => l.startsWith('HASH '))
  // Parse INPUT/OUTPUT lines — handle undefined output gracefully
  // (JSON.stringify(undefined) produces the literal string "undefined", not valid JSON)
  let parsedInput = null
  let parsedOutput = null
  if (inputLine) {
    const inputStr = inputLine.replace(/^INPUT\s+/, '')
    parsedInput = inputStr === 'undefined' ? undefined : JSON.parse(inputStr)
  }
  if (outputLine) {
    const outputStr = outputLine.replace(/^OUTPUT\s+/, '')
    parsedOutput = outputStr === 'undefined' ? undefined : JSON.parse(outputStr)
  }
  // Parse MUTATION_BEFORE/AFTER lines
  const mutationBeforeLine = lines.find(l => l.startsWith('MUTATION_BEFORE '))
  const mutationAfterLine = lines.find(l => l.startsWith('MUTATION_AFTER '))
  return {
    ...meta,
    input:      parsedInput,
    output:     parsedOutput,
    goldenHash: hashLine   ? hashLine.replace(/^HASH\s+/, '').trim()          : null,
    mutationBefore: mutationBeforeLine ? JSON.parse(mutationBeforeLine.replace(/^MUTATION_BEFORE\s+/, '')) : null,
    mutationAfter:  mutationAfterLine  ? JSON.parse(mutationAfterLine.replace(/^MUTATION_AFTER\s+/, ''))   : null,
    raw:        content
  }
}

// Ghost proxy imported from ghost.js

function clone(v) { return deepClone(v) }

// ─── JSON Diff — recursive comparison of golden vs live output ───────────────

function jsonDiff(golden, live, prefix = '') {
  const diffs = []

  // Both null/undefined
  if (golden == null && live == null) return diffs

  // Type mismatch
  if (typeof golden !== typeof live) {
    diffs.push({ path: prefix || '(root)', golden: truncate(String(golden)), live: truncate(String(live)) })
    return diffs
  }

  // Primitive comparison
  if (golden === live) return diffs

  // String comparison
  if (typeof golden === 'string') {
    if (golden !== live) {
      diffs.push({ path: prefix || '(root)', golden: truncate(golden), live: truncate(live) })
    }
    return diffs
  }

  // Number comparison (handle NaN)
  if (typeof golden === 'number') {
    if (Number.isNaN(golden) !== Number.isNaN(live) || golden !== live) {
      diffs.push({ path: prefix || '(root)', golden: String(golden), live: String(live) })
    }
    return diffs
  }

  // Boolean
  if (typeof golden === 'boolean') {
    if (golden !== live) {
      diffs.push({ path: prefix || '(root)', golden: String(golden), live: String(live) })
    }
    return diffs
  }

  // Array comparison
  if (Array.isArray(golden) || Array.isArray(live)) {
    if (!Array.isArray(golden) || !Array.isArray(live)) {
      diffs.push({ path: prefix || '(root)', golden: truncate(JSON.stringify(golden)), live: truncate(JSON.stringify(live)) })
      return diffs
    }
    const maxLen = Math.max(golden.length, live.length)
    for (let i = 0; i < maxLen; i++) {
      const subPrefix = prefix ? `${prefix}[${i}]` : `[${i}]`
      if (i >= golden.length) {
        diffs.push({ path: subPrefix, golden: '(missing)', live: truncate(JSON.stringify(live[i])) })
      } else if (i >= live.length) {
        diffs.push({ path: subPrefix, golden: truncate(JSON.stringify(golden[i])), live: '(missing)' })
      } else {
        diffs.push(...jsonDiff(golden[i], live[i], subPrefix))
      }
    }
    return diffs
  }

  // Object comparison
  if (typeof golden === 'object' && typeof live === 'object') {
    const allKeys = new Set([...Object.keys(golden), ...Object.keys(live)])
    for (const key of allKeys) {
      const subPrefix = prefix ? `${prefix}.${key}` : key
      if (!(key in golden)) {
        diffs.push({ path: subPrefix, golden: '(missing)', live: truncate(JSON.stringify(live[key])) })
      } else if (!(key in live)) {
        diffs.push({ path: subPrefix, golden: truncate(JSON.stringify(golden[key])), live: '(missing)' })
      } else {
        diffs.push(...jsonDiff(golden[key], live[key], subPrefix))
      }
    }
    return diffs
  }

  return diffs
}

function truncate(str) {
  if (typeof str !== 'string') str = String(str)
  if (str.length > 200) return str.slice(0, 200) + '...'
  return str
}

function formatDiffOutput(goldenOutput, liveOutput) {
  // Try JSON diff first
  let goldenObj, liveObj
  try {
    goldenObj = typeof goldenOutput === 'string' ? JSON.parse(goldenOutput) : goldenOutput
  } catch { goldenObj = null }
  try {
    liveObj = typeof liveOutput === 'string' ? JSON.parse(liveOutput) : liveOutput
  } catch { liveObj = null }

  // Both parseable as JSON → structured diff
  if (goldenObj !== null && liveObj !== null) {
    const diffs = jsonDiff(goldenObj, liveObj)
    if (diffs.length === 0) return null  // no diff found (shouldn't happen if hashes differ)

    const lines = []
    lines.push(`     Expected: ${truncate(JSON.stringify(goldenObj))}`)
    lines.push(`     Actual:   ${truncate(JSON.stringify(liveObj))}`)
    lines.push('     Diff:')
    for (const d of diffs) {
      lines.push(`       ${d.path}: ${d.golden} → ${d.live}`)
    }
    return lines.join('\n')
  }

  // Fallback: string diff for non-JSON output
  const gStr = truncate(JSON.stringify(goldenOutput))
  const lStr = truncate(JSON.stringify(liveOutput))
  if (gStr === lStr) return null
  return `     Expected: ${gStr}\n     Actual:   ${lStr}`
}

// ─── Load manifest ────────────────────────────────────────────────────────────

let manifest
try { manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) }
catch {
  if (jsonOutput) {
    console.log(JSON.stringify({ error: `Could not read manifest: ${manifestPath}` }))
  } else {
    console.error(`❌ Could not read manifest: ${manifestPath}`)
  }
  process.exit(1)
}

// ─── Find .regret files ───────────────────────────────────────────────────────

const filterId = clusterFilter ?? updateTarget ?? null
let regretFiles
try {
  regretFiles = readdirSync(regretDir)
    .filter(f => f.endsWith('.regret'))
    .filter(f => !filterId || f === `${filterId}.regret`)
} catch {
  if (jsonOutput) {
    console.log(JSON.stringify({ error: 'regrets/ not found. Run capture.js first.' }))
  } else {
    console.error(`❌ regrets/ not found. Run capture.js first.`)
  }
  process.exit(1)
}

if (!regretFiles.length) {
  if (jsonOutput) {
    console.log(JSON.stringify({ error: `No .regret files found${filterId ? ` for "${filterId}"` : ''}.` }))
  } else {
    console.error(`❌ No .regret files found${filterId ? ` for "${filterId}"` : ''}.`)
  }
  process.exit(1)
}

// ─── React cluster runner ─────────────────────────────────────────────────────

async function runReactCluster(clusterDef, regret) {
  const { entry, file, normalize: normRules = [], ignoreFields = [],
          stripAttrs = [], fingerprintMode: fpMode = 'value', valuePaths = [] } = clusterDef
  const mode = regret.fingerprintMode || fpMode || 'value'
  const paths = regret.valuePaths || valuePaths || []

  let React, renderToStaticMarkup
  try {
    React = (await import('react')).default
    renderToStaticMarkup = (await import('react-dom/server.js')).renderToStaticMarkup
  } catch {
    throw new Error('React not available. Install react and react-dom for React cluster validation.')
  }

  const absPath = resolve(process.cwd(), file)
  let moduleUrl
  try {
    const { readFileSync } = await import('fs')
    readFileSync(absPath)
    moduleUrl = pathToFileURL(absPath).href
  } catch {
    const jsPath = absPath.replace(/\.(tsx|jsx)$/, '.js')
    moduleUrl = pathToFileURL(jsPath).href
  }

  const mod = await import(moduleUrl)
  const Component = mod[entry] ?? mod.default?.[entry] ?? mod.default
  if (!Component) throw new Error(`Component "${entry}" not found in ${file}`)

  const hashes = []
  let lastOutput = null

  for (let i = 0; i < runs; i++) {
    const goldenInput = regret.input
    const element = React.createElement(Component, goldenInput)
    const rawHtml = renderToStaticMarkup(element)
    const html = normalizeHtml(rawHtml, stripAttrs)

    let fp
    if (mode === 'schema') {
      const schema = extractSchema(html)
      fp = fingerprint(goldenInput, schema, { normalize: normRules, ignoreFields })
    } else if (mode === 'mixed') {
      const schema = extractSchema(html)
      const selectedValues = {}
      for (const path of paths) {
        const key = path.replace(/^\$\./, '')
        const parts = key.split('.')
        let val = html
        for (const p of parts) { val = val?.[p] }
        if (val !== undefined) selectedValues[path] = val
      }
      const combined = { schema, values: selectedValues }
      fp = fingerprint(goldenInput, combined, { normalize: normRules, ignoreFields })
    } else {
      fp = fingerprint(goldenInput, html, { normalize: normRules, ignoreFields })
    }

    hashes.push(fp)
    lastOutput = html
  }

  return { hashes, lastOutput }
}

// ─── Run cluster N times ──────────────────────────────────────────────────────

async function runCluster(clusterDef, regret) {
  const { entry, file, normalize = [], ignoreFields = [], ignorePaths = [],
          fingerprintLevel = 'entry',
          multiArgs = false, fingerprintMode = 'value', valuePaths = [], stack,
          classMethod, constructor: constructorName, constructorArgs, setup,
          instanceMethods = {}, outputTransform: manifestOutputTransform = null,
          resetState, deepCloneInput = true, seed, singletonMethod, singletonName,
          storeDispatch, initialState } = clusterDef
  const materializeOutputFlag = regret.materializeOutput || clusterDef.materializeOutput || false
  // trackMutation: check from .regret metadata first, then cluster config
  const trackMutation = regret.trackMutation || clusterDef.trackMutation || false
  const goldenMutationFingerprint = regret.mutationFingerprint || null

  // Check environment snapshot if present in .regret file
  if (regret.env && typeof regret.env === 'object') {
    const currentEnv = getEnvSnapshot()
    for (const [k, v] of Object.entries(regret.env)) {
      if (currentEnv[k] !== v) {
        console.warn(`  ⚠️  ${clusterDef.id}: environment changed: ${k} was ${v}, now ${currentEnv[k]}`)
      }
    }
  }

  // Skip stacks not handled by this validator
  if (stack === 'python') {
    console.log(`  ⏭️  ${clusterDef.id}: stack=python — use validate.py`)
    return { hashes: [regret.goldenHash], lastOutput: null, skipped: true }
  }
  if (stack === 'rust') {
    console.log(`  ⏭️  ${clusterDef.id}: stack=rust — use capture_rust.sh validate`)
    return { hashes: [regret.goldenHash], lastOutput: null, skipped: true }
  }
  if (stack === 'go') {
    console.log(`  ⏭️  ${clusterDef.id}: stack=go — use capture_go.sh validate`)
    return { hashes: [regret.goldenHash], lastOutput: null, skipped: true }
  }

  // React stack: re-render component and compare
  if (stack === 'react') {
    return await runReactCluster(clusterDef, regret)
  }

  let mod = await import(pathToFileURL(resolve(process.cwd(), file)).href)

  // Handle CJS modules — merge default exports for consistent access
  mod = mergeCjsModule(mod)

  const hashes = []           // flat list of all hashes (for backward compat)
  const hashesPerInput = {}   // { inputKey: [hash_run1, hash_run2, ...] } for per-input drift
  let lastOutput = null
  // trackMutation: collect mutation fingerprints across all runs/inputs
  let mutationMatch = true
  let mutationDetected = false
  let liveMutationFingerprint = null

  // Determine which inputs to validate: golden from .regret + all from manifest
  // Note: empty array `[]` in manifest is treated as "no inputs specified"
  const allInputs = (clusterDef.inputs && clusterDef.inputs.length > 0) ? clusterDef.inputs : [regret.input]
  const inputsToValidate = [regret.input]  // Always validate golden first
  for (const inp of allInputs) {
    if (JSON.stringify(inp) !== JSON.stringify(regret.input)) {
      inputsToValidate.push(inp)
    }
  }

  for (let i = 0; i < runs; i++) {
    for (const currentInput of inputsToValidate) {
      const recorder = []
      let output
      let fpInput

      // trackMutation: snapshot input state BEFORE call to detect mutations
      let inputSnapshotBefore = null
      let inputForArgsRef = null  // reference to the actual args object passed to the function
      if (trackMutation) {
        inputSnapshotBefore = deepClone(deepCloneInput ? deepClone(currentInput) : currentInput)
      }

      // Determine fingerprint mode (from .regret or manifest)
      const mode = regret.fingerprintMode || fingerprintMode || 'value'
      const paths = regret.valuePaths || valuePaths || []

      if (storeDispatch) {
        // ── storeDispatch mode ──────────────────────────────────────────────
        const storeExport = mod[storeDispatch.store] ?? mod.default?.[storeDispatch.store]
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
          throw new Error(`Store "${storeDispatch.store}" does not match any known store pattern.`)
        }

        // Reset to initialState if provided
        const stateInit = regret.initialState || initialState
        if (stateInit) {
          if (storeType === 'dispatching' && typeof storeExport.subject?.next === 'function') {
            storeExport.subject.next(deepClone(stateInit))
          } else if (storeType === 'zustand') {
            storeExport.setState(deepClone(stateInit), true)
          }
        }

        const inputForFp = deepClone(currentInput)
        const inputForArgs = deepClone(currentInput)
        inputForArgsRef = inputForArgs  // trackMutation: keep reference for post-call snapshot

        if (storeType === 'redux') {
          dispatchFn({ type: storeDispatch.action, payload: inputForArgs })
        } else if (storeType === 'dispatching') {
          dispatchFn(storeDispatch.action, inputForArgs)
        } else if (storeType === 'zustand') {
          dispatchFn(inputForArgs)
        }

        const rawOutput = getStateFn()
        const { result: consumedOutput } = await consumeIterator(rawOutput)

        const outputTransform = regret.outputTransform || manifestOutputTransform || null
        const transformedOutput = await applyOutputTransformAsync(consumedOutput, outputTransform, process.cwd())

        output = deepClone(transformedOutput)
        lastOutput = output
        fpInput = inputForFp
      } else if (classMethod) {
        // ── Class-based entry ─────────────────────────────────────────────
        const Cls = mod[constructorName ?? entry] ?? mod.default?.[constructorName ?? entry]
        if (typeof Cls !== 'function') throw new Error(`Constructor "${constructorName ?? entry}" not found in ${file}`)
        const cArgs = constructorArgs ? deepClone(constructorArgs) : []
        const instance = new Cls(...cArgs)

        // Apply ghost proxy to instance methods
        for (const watchFn of (regret.watches ?? clusterDef.watches)) {
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

        // Run setup methods
        if (setup && setup.length > 0) {
          for (const step of setup) {
            instance[step.method](...(step.args ? deepClone(step.args) : []))
          }
        }

        // Call target method
        const inputForFp = deepClone(currentInput)
        const inputForArgs = deepClone(currentInput)
        inputForArgsRef = inputForArgs  // trackMutation: keep reference for post-call snapshot
        const args_ = multiArgs && Array.isArray(inputForArgs) ? [...inputForArgs] : [inputForArgs]
        const rawOutput = await instance[classMethod](...args_)

        // Materialize generator/iterator output if configured
        const { result: consumedOutput } = await consumeIterator(rawOutput, null, { materialize: materializeOutputFlag })

        // Apply outputTransform if specified (from .regret or manifest)
        const outputTransform = regret.outputTransform || manifestOutputTransform || null
        const transformedOutput = await applyOutputTransformAsync(consumedOutput, outputTransform, process.cwd())

        output = deepClone(transformedOutput)
        lastOutput = output
        fpInput = multiArgs && Array.isArray(inputForFp) ? inputForFp : inputForFp
      } else if (singletonMethod || regret.singletonMethod) {
        // ── Singleton method entry ────────────────────────────────────────────
        // For CJS modules that export a singleton object with methods.
        // Example: module.exports = new Stemmer() → PorterStemmer.stem("running")
        const sMethod = regret.singletonMethod || singletonMethod
        const sName = regret.singletonName || singletonName || entry
        let singleton = mod[sName] ?? mod.default?.[sName]
        // CJS fallback: when module.exports = new Constructor(), the singleton IS the default export
        if (!singleton && mod.default && typeof mod.default === 'object' && typeof mod.default[sMethod] === 'function') {
          singleton = mod.default
        }
        if (!singleton || typeof singleton !== 'object') {
          throw new Error(`Singleton "${sName}" not found or not an object in ${file}`)
        }
        if (typeof singleton[sMethod] !== 'function') {
          throw new Error(`Method "${sMethod}" not found on singleton "${sName}" in ${file}`)
        }
        const inputForFp = deepClone(currentInput)
        const inputForArgs = deepClone(currentInput)
        inputForArgsRef = inputForArgs  // trackMutation: keep reference for post-call snapshot
        const args_ = multiArgs && Array.isArray(inputForArgs) ? [...inputForArgs] : [inputForArgs]
        const rawOutput = await singleton[sMethod](...args_)

        // Consume generators/iterators
        const { result: consumedOutput } = await consumeIterator(rawOutput)

        // Apply outputTransform
        const outputTransform = regret.outputTransform || manifestOutputTransform || null
        const transformedOutput = await applyOutputTransformAsync(consumedOutput, outputTransform, process.cwd())

        output = deepClone(transformedOutput)
        lastOutput = output
        fpInput = multiArgs && Array.isArray(inputForFp) ? inputForFp : inputForFp
      } else {
        // ── Function-based entry (original behavior) ──────────────────────

        // ─── Seed random number generator for deterministic output ────────
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

        // ─── resetState: reset module-level mutable state before each run ───
        if (resetState) {
          const resetFn = mod[resetState] ?? mod.default?.[resetState]
          if (typeof resetFn === 'function') resetFn()
        }

        const ghost    = createGhost(mod, regret.watches ?? clusterDef.watches, recorder, regret.instanceMethods || instanceMethods)
        // Resolve entry function with CJS module.exports = function support
        const entryFn  = ghost[entry]
          ?? mod[entry]
          ?? mod.default?.[entry]
          ?? ((entry === 'default' || entry === 'module.exports') && typeof mod.default === 'function' ? mod.default : null)
        if (typeof entryFn !== 'function') throw new Error(`Entry "${entry}" not found in ${file}`)
        const inputForFp = deepCloneInput ? deepClone(currentInput) : currentInput
        const inputForArgs = deepCloneInput ? deepClone(currentInput) : currentInput
        inputForArgsRef = inputForArgs  // trackMutation: keep reference for post-call snapshot
        const args_ = multiArgs && Array.isArray(inputForArgs) ? [...inputForArgs] : [inputForArgs]
        const rawOutput = await entryFn(...args_)

        // Restore original Math.random after the call
        if (seed != null) Math.random = origRandom

        // Materialize generator/iterator output if configured
        const { result: consumedOutput } = await consumeIterator(rawOutput, null, { materialize: materializeOutputFlag })

        // Apply outputTransform if specified (from .regret or manifest)
        const outputTransform = regret.outputTransform || manifestOutputTransform || null
        const transformedOutput = await applyOutputTransformAsync(consumedOutput, outputTransform, process.cwd())

        output = deepClone(transformedOutput)
        lastOutput = output
        fpInput = multiArgs && Array.isArray(inputForFp) ? inputForFp : inputForFp
      }

      // ── trackMutation: snapshot input state AFTER call to detect mutations ──
      if (trackMutation && inputSnapshotBefore !== null && inputForArgsRef !== null) {
        // Snapshot the actual args object after the function call
        // inputForArgsRef points to the same object that was passed to the entry function,
        // so if the function mutated it in-place, we'll detect the difference.
        const inputSnapshotAfter = deepClone(inputForArgsRef)
        const beforeStr = stableStringify(inputSnapshotBefore)
        const afterStr = stableStringify(inputSnapshotAfter)
        const isMutated = beforeStr !== afterStr

        if (isMutated) {
          mutationDetected = true
        }

        // Compute mutation fingerprint (same method as capture.js)
        const mutFpConfig = { normalize, ignoreFields, ignorePaths: regret.ignorePaths || ignorePaths }
        liveMutationFingerprint = fingerprint(inputSnapshotBefore, inputSnapshotAfter, mutFpConfig)

        // Compare with golden mutation fingerprint from .regret file
        if (goldenMutationFingerprint) {
          if (liveMutationFingerprint !== goldenMutationFingerprint) {
            mutationMatch = false
          }
        } else {
          // .regret file has no mutation fingerprint (old capture) → skip mutation check, print warning
          // Only warn once (first run, first input)
          if (i === 0 && currentInput === inputsToValidate[0]) {
            console.warn(`  ⚠️  ${clusterDef.id}: trackMutation enabled but .regret file has no mutationFingerprint — skipping mutation comparison`)
            console.warn(`      Re-run capture.js to generate mutation fingerprint`)
          }
        }
      }

      // Compute fingerprint
      const fpConfig = { normalize, ignoreFields, ignorePaths }
      let fp
      if (mode === 'schema') {
        const schema = extractSchema(output)
        fp = fingerprint(fpInput, schema, fpConfig)
      } else if (mode === 'mixed') {
        const schema = extractSchema(output)
        const selectedValues = {}
        for (const path of paths) {
          const key = path.replace(/^\$\./, '')
          const parts = key.split('.')
          let val = output
          for (const p of parts) {
            val = val?.[p]
          }
          if (val !== undefined) selectedValues[path] = val
        }
        const combined = { schema, values: selectedValues }
        fp = fingerprint(fpInput, combined, fpConfig)
      } else {
        fp = fingerprintLevel === 'entry'
          ? fingerprint(fpInput, output, fpConfig)
          : fingerprintSequence(recorder, fpConfig)
      }
      hashes.push(fp)

      // Track per-input hashes for drift detection
      const inputKey = JSON.stringify(currentInput)
      if (!hashesPerInput[inputKey]) hashesPerInput[inputKey] = []
      hashesPerInput[inputKey].push(fp)
    } // end for each input
  } // end for each run
  return { hashes, hashesPerInput, lastOutput, mutationMatch, mutationDetected, liveMutationFingerprint }
}

// ─── Update a .regret ─────────────────────────────────────────────────────────

/**
 * Parse a .regret file into structured sections for targeted field updates.
 *
 * The file format is:
 *   <metadata lines>     — key: value pairs, one per line
 *   ---                  — separator
 *   INPUT  <json>
 *   OUTPUT <json>        ← may span multiple lines (pretty-printed JSON)
 *   HASH   <hash>
 *
 * The line-by-line parser avoids regex .replace() which has two bugs:
 *   1. /^OUTPUT .+$/m only matches the FIRST line of multiline OUTPUT,
 *      silently dropping subsequent lines.
 *   2. /^fingerprint: .+$/m can match a line inside OUTPUT data that
 *      happens to start with "fingerprint:", corrupting the file.
 */
function parseRegretStructure(raw) {
  const lines = raw.split('\n')
  const metaLines = []
  const dataLines = []
  let pastSeparator = false
  let outputStartIdx = -1  // index within dataLines where OUTPUT begins
  let hashIdx = -1         // index within dataLines where HASH begins

  for (const line of lines) {
    if (line === '---') {
      pastSeparator = true
      continue
    }
    if (!pastSeparator) {
      metaLines.push(line)
    } else {
      if (line.startsWith('OUTPUT ') && outputStartIdx === -1) {
        outputStartIdx = dataLines.length
      }
      if (line.startsWith('HASH ') && hashIdx === -1) {
        hashIdx = dataLines.length
      }
      dataLines.push(line)
    }
  }

  return { metaLines, dataLines, outputStartIdx, hashIdx }
}

/**
 * Reconstruct a .regret file from its parsed structure,
 * applying targeted field updates.
 *
 * Updates are applied by key matching on metadata lines (startsWith check)
 * and by section-boundary-aware replacement for OUTPUT (which may be multiline).
 */
function reconstructRegret(structure, updates) {
  const { metaLines, dataLines, outputStartIdx, hashIdx } = structure

  // Update metadata lines — only replace lines whose key STARTS WITH the target
  const updatedMeta = metaLines.map(line => {
    for (const [key, value] of Object.entries(updates.meta)) {
      // Match "fingerprint: " at the start of the line (not inside data body)
      if (line.startsWith(key + ': ')) {
        return `${key}: ${value}`
      }
    }
    return line
  })

  // Update data lines
  const updatedData = [...dataLines]

  // Replace OUTPUT section: from the OUTPUT line to (but not including) the HASH line
  if (outputStartIdx !== -1 && 'output' in updates) {
    const endIdx = hashIdx !== -1 ? hashIdx : dataLines.length
    // Remove all lines from OUTPUT start up to HASH
    updatedData.splice(outputStartIdx, endIdx - outputStartIdx)
    // Insert the new OUTPUT line(s) at the same position
    updatedData.splice(outputStartIdx, 0, updates.output)
  }

  // Replace HASH line
  if (hashIdx !== -1 && 'hash' in updates) {
    // Recalculate hashIdx in case OUTPUT changed the array length
    const adjustedHashIdx = updatedData.findIndex(l => l.startsWith('HASH '))
    if (adjustedHashIdx !== -1) {
      updatedData[adjustedHashIdx] = updates.hash
    }
  }

  return [...updatedMeta, '---', ...updatedData].join('\n')
}

function updateRegret(regretPath, regret, newHash, liveOutput, reason) {
  const oldHash = regret.goldenHash
  const now = new Date().toISOString()
  // Sanitize reason: replace newlines to prevent audit.log corruption
  const safeReason = reason.replace(/[\r\n]+/g, ' ')
  // Convert TypedArrays to regular arrays for JSON serialization
  const serializableOutput = ArrayBuffer.isView(liveOutput) && !(liveOutput instanceof DataView)
    ? Array.from(liveOutput)
    : liveOutput

  const structure = parseRegretStructure(regret.raw)
  const newContent = reconstructRegret(structure, {
    meta: {
      fingerprint: newHash,
      captured: now,
    },
    output: `OUTPUT ${JSON.stringify(serializableOutput)}`,
    hash: `HASH   ${newHash}`,
  })
  writeFileSync(regretPath, newContent, 'utf8')

  // ─── Hash chain ────────────────────────────────────────────────────────────
  let prevChain = '0000000'  // genesis
  if (existsSync(auditLog)) {
    const logContent = readFileSync(auditLog, 'utf8').trim()
    if (logContent) {
      const lines = logContent.split('\n')
      // Walk backwards to find the last chain hash
      for (let i = lines.length - 1; i >= 0; i--) {
        const m = lines[i].match(/^\s*chain:\s*(\S+)/)
        if (m) { prevChain = m[1]; break }
      }
    }
  }

  const clusterId = basename(regretPath, '.regret')
  const newEntryContent = `${now}  UPDATE  ${clusterId}\n  old: ${oldHash}\n  new: ${newHash}\n  reason: ${safeReason}\n  by: AI refactor session`
  const chainHash = createHash('sha256').update(prevChain + newEntryContent).digest('hex').slice(0, 7)

  const entry = `\n${newEntryContent}\n  chain: ${chainHash}`
  appendFileSync(auditLog, entry, 'utf8')
  return { oldHash, newHash }
}

// ─── Main ─────────────────────────────────────────────────────────────────────

const updateMode = !!updateTarget
const driftMode  = runs > 1 && !updateMode

if (jsonOutput) {
  // silent in JSON mode
} else if (quiet) {
  // quiet mode: no per-cluster output, only summary at the end
} else if (updateMode)     console.log(`\n🔄 Update mode — cluster: ${updateTarget}\n   Reason: ${updateReason}\n`)
else if (driftMode) console.log(`\n🔍 Drift detection — ${runs} runs per cluster...\n`)
else                console.log(`\n🔍 Validating ${regretFiles.length} cluster(s)...\n`)

const results = []

// Track start time for JUnit XML time field
globalThis._validateStartTime = Date.now()

for (const file of regretFiles) {
  const id         = basename(file, '.regret')
  const regretPath = join(regretDir, file)
  const regret     = parseRegret(readFileSync(regretPath, 'utf8'))
  const def        = manifest.clusters.find(c => c.id === id)
  if (!def) {
    if (!quiet && !jsonOutput) console.warn(`  ⚠️  ${id}: not in manifest — skipping`)
    continue
  }

  try {
    const { hashes, hashesPerInput, lastOutput, skipped,
            mutationMatch: clusterMutationMatch,
            mutationDetected: clusterMutationDetected,
            liveMutationFingerprint: clusterLiveMutationFp } = await runCluster(def, regret)
    if (skipped) { results.push({ id, pass: true, skipped: true }); continue }

    // ── trackMutation check: mutation mismatch takes priority over fingerprint match ──
    // If the .regret file has a mutationFingerprint and the live one differs, FAIL immediately.
    // This catches the case where a refactoring introduces a mutation that wasn't there before.
    const trackMutationFlag = regret.trackMutation || def.trackMutation || false
    const goldenMutationFp = regret.mutationFingerprint || null
    if (trackMutationFlag && goldenMutationFp && !clusterMutationMatch) {
      if (!jsonOutput) {
        if (!regret.inputMutated && clusterMutationDetected) {
          console.log(`  ❌ ${id.padEnd(35)} INPUT MUTATION DETECTED — function now mutates argument (was pure)`)
        } else {
          console.log(`  ❌ ${id.padEnd(35)} MUTATION MISMATCH  golden=${goldenMutationFp} live=${clusterLiveMutationFp}`)
        }
      }
      results.push({ id, pass: false, mutationMismatch: true, mutationDetected: clusterMutationDetected })
      if (failFast) {
        if (!jsonOutput) console.log(`\n  --fail-fast: stopping.`)
        break
      }
      continue
    }

    const liveHash = hashes[0]
    const isMatch  = liveHash === regret.goldenHash
    const isDrift  = driftMode && Object.values(hashesPerInput).some(inputHashes => new Set(inputHashes).size > 1)

    // ─── Verbose: print extra detail before status line ────────────────────
    if (verbose && !jsonOutput) {
      console.log(`  ┌─ ${id} ────────────────────────────────────`)
      console.log(`  │ Input:      ${JSON.stringify(regret.input)}`)
      console.log(`  │ Expected:   ${regret.goldenHash}`)
      console.log(`  │ Actual:     ${liveHash}`)
      console.log(`  │ Output:     ${JSON.stringify(lastOutput)?.slice(0, 200)}${JSON.stringify(lastOutput)?.length > 200 ? '…' : ''}`)
      if (regret.watches?.length) {
        console.log(`  │ Watches:    ${regret.watches.join(', ')}`)
      }
      if (driftMode && hashesPerInput && Object.keys(hashesPerInput).length > 0) {
        console.log(`  │ Per-input:  ${JSON.stringify(hashesPerInput)}`)
      }
      console.log(`  └────────────────────────────────────────────`)
    }

    if (updateMode) {
      if (isMatch) {
        if (!jsonOutput && !quiet) console.log(`  ℹ️  ${id.padEnd(35)} unchanged — no update needed`)
        results.push({ id, pass: true })
      } else {
        const { oldHash, newHash } = updateRegret(regretPath, regret, liveHash, lastOutput, updateReason)
        if (!jsonOutput && !quiet) console.log(`  ✅ ${id.padEnd(35)} ${oldHash} → ${newHash}  UPDATED`)
        results.push({ id, pass: true, updated: true })
      }
    } else if (driftMode) {
      if (isDrift) {
        if (!jsonOutput && !quiet) {
          console.log(`  ❌ ${id.padEnd(35)} DRIFT  [${hashes.join(' / ')}]`)
          if (!noDiff && regret.output != null && lastOutput != null) {
            const diff = formatDiffOutput(regret.output, lastOutput)
            if (diff) console.log(diff)
          }
        }
        results.push({ id, pass: false, drift: true, goldenOutput: regret.output, liveOutput: lastOutput })
      } else {
        if (!jsonOutput && !quiet) {
          const icon = isMatch ? '✅' : '❌'
          console.log(`  ${icon} ${id.padEnd(35)} ${liveHash}  × ${runs}  ${isMatch ? 'PASS+STABLE' : 'FAIL'}`)
          if (!isMatch && !noDiff && regret.output != null && lastOutput != null) {
            const diff = formatDiffOutput(regret.output, lastOutput)
            if (diff) console.log(diff)
          }
        }
        results.push({ id, pass: isMatch, goldenOutput: regret.output, liveOutput: lastOutput })
      }
    } else {
      if (!jsonOutput && !quiet) {
        const icon = isMatch ? '✅' : '❌'
        const hstr = isMatch ? regret.goldenHash : `${regret.goldenHash} → ${liveHash}`
        console.log(`  ${icon} ${id.padEnd(35)} ${hstr.padEnd(22)} ${isMatch ? 'PASS' : 'FAIL'}`)
        if (!isMatch && !noDiff && regret.output != null && lastOutput != null) {
          const diff = formatDiffOutput(regret.output, lastOutput)
          if (diff) console.log(diff)
        }
      }
      results.push({ id, pass: isMatch, expected: regret.goldenHash, actual: liveHash, goldenOutput: regret.output, liveOutput: lastOutput })
    }

  } catch (err) {
    if (!jsonOutput && !quiet) console.log(`  ❌ ${id.padEnd(35)} ERROR: ${err.message}`)
    results.push({ id, pass: false, error: err.message })
  }

  if (!results.at(-1).pass && failFast) {
    if (!jsonOutput && !quiet) console.log(`\n  --fail-fast: stopping.`)
    break
  }
}

// ─── JUnit XML output ─────────────────────────────────────────────────────────

function escapeXml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
}

function generateJUnitXml(results) {
  const activeResults = results.filter(r => !r.skipped)
  const tests = activeResults.length
  const failures = activeResults.filter(r => !r.pass).length
  const time = (Date.now() - (globalThis._validateStartTime ?? Date.now())) / 1000

  let xml = '<?xml version="1.0" encoding="UTF-8"?>\n'
  xml += `<testsuite name="regrets" tests="${tests}" failures="${failures}" time="${time.toFixed(3)}">\n`

  for (const r of activeResults) {
    xml += `  <testcase classname="regrets" name="${escapeXml(r.id)}" time="0.000">`
    if (!r.pass) {
      const message = r.error
        ? escapeXml(r.error)
        : r.drift
          ? `Drift detected: hashes vary across runs`
          : `Fingerprint mismatch: expected ${r.expected ?? 'unknown'}, got ${r.actual ?? 'unknown'}`
      xml += `\n    <failure message="${escapeXml(message)}">${escapeXml(message)}</failure>\n  `
    }
    xml += `</testcase>\n`
  }

  xml += '</testsuite>\n'
  return xml
}

// ─── Summary ──────────────────────────────────────────────────────────────────

const passed  = results.filter(r => r.pass).length
const failed  = results.filter(r => !r.pass).length
const drifted = results.filter(r => r.drift).length

if (reporter === 'junit') {
  // Write JUnit XML to regrets/results.xml
  const junitXml = generateJUnitXml(results)
  const resultsPath = join(regretDir, 'results.xml')
  try {
    writeFileSync(resultsPath, junitXml, 'utf8')
  } catch (err) {
    console.error(`❌ Failed to write JUnit XML: ${err.message}`)
    process.exit(1)
  }
  // Still show console output
  console.log(`\n${'─'.repeat(60)}`)
  if (failed === 0) {
    console.log(`✅ All ${passed} tests passed. Refactor is safe.`)
  } else {
    console.log(`❌ ${failed}/${results.length} FAILED.`)
  }
  console.log(`\n📊 JUnit XML written to: ${resultsPath}`)
  process.exit(failed > 0 ? 1 : 0)
} else if (jsonOutput) {
  // JSON output mode
  const jsonResult = {
    passed,
    failed,
    clusters: results
      .filter(r => !r.skipped)
      .map(r => ({
        id: r.id,
        status: r.pass ? (r.drift ? 'drift' : 'pass') : (r.mutationMismatch ? 'mutation_mismatch' : (r.error ? 'error' : 'fail')),
        ...(r.expected ? { expected: r.expected } : {}),
        ...(r.actual ? { actual: r.actual } : {}),
        ...(r.error ? { error: r.error } : {}),
        ...(r.drift ? { drift: true } : {}),
        ...(r.updated ? { updated: true } : {}),
        ...(r.mutationMismatch ? { mutationMismatch: true, mutationDetected: r.mutationDetected } : {}),
        ...(!noDiff && !r.pass && r.goldenOutput != null && r.liveOutput != null ? (() => { try { return { diff: jsonDiff(typeof r.goldenOutput === 'string' ? JSON.parse(r.goldenOutput) : r.goldenOutput, typeof r.liveOutput === 'string' ? JSON.parse(r.liveOutput) : r.liveOutput) } } catch { return {} } })() : {}),
      }))
  }
  console.log(JSON.stringify(jsonResult, null, 0))
  process.exit(failed > 0 ? 1 : 0)
} else if (quiet) {
  // ─── Quiet summary: only one line ─────────────────────────────────────────
  const failedIds = results.filter(r => !r.pass).map(r => r.id)
  if (updateMode) {
    console.log(`✅ Update complete. ${results.filter(r => r.updated).length} updated.`)
    process.exit(0)
  }
  if (driftMode && drifted > 0) {
    console.log(`❌ ${drifted}/${results.length} drifted: [${failedIds.join(', ')}]`)
    process.exit(1)
  }
  if (failed === 0) {
    console.log(`✅ ${passed}/${results.length} passed`)
    process.exit(0)
  }
  console.log(`❌ ${failed}/${results.length} failed: [${failedIds.join(', ')}]`)
  process.exit(1)
} else {
  console.log(`\n${'─'.repeat(60)}`)

  if (updateMode) {
    console.log(`✅ Update complete. ${results.filter(r => r.updated).length} updated.\n   Audit: regrets/audit.log`)
    process.exit(0)
  }
  if (driftMode && drifted > 0) {
    console.log(`❌ Drift in ${drifted} cluster(s). Add normalize rules and re-capture.`)
    process.exit(1)
  }
  if (failed === 0) {
    console.log(`✅ All ${passed} tests passed${driftMode ? ` (${runs} runs — stable)` : ''}. Refactor is safe.\n`)
    process.exit(0)
  }
  console.log(`❌ ${failed}/${results.length} FAILED.\n`)
  results.filter(r => !r.pass).forEach(r => {
    console.log(`  • ${r.id}`)
    if (r.error) console.log(`    ${r.error}`)
    else if (r.mutationMismatch) console.log(`    Mutation fingerprint mismatch — function's input mutation behavior changed`)
    else console.log(`    Expected: ${r.expected || r.golden}  Got: ${r.actual || r.live}`)
    if (!noDiff && r.goldenOutput != null && r.liveOutput != null) {
      const diff = formatDiffOutput(r.goldenOutput, r.liveOutput)
      if (diff) console.log(diff)
    }
  })
  console.log(`\nFix the CODE — do not edit .regret files.\nRe-run: node scripts/validate.js`)
  process.exit(1)
}

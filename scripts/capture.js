#!/usr/bin/env node
// capture.js — ghost-proxy runner
// Reads regrets/manifest.json, instruments watched functions,
// runs entry points, and writes .regret files.
//
// Usage:
//   node scripts/capture.js
//   node scripts/capture.js --cluster transform-user-data
//   node scripts/capture.js --manifest ./regrets/manifest.json
//   node scripts/capture.js --only-new
//   node scripts/capture.js --stale [hours]          (default: 24)
//   node scripts/capture.js --only-new --stale 48
//   node scripts/capture.js --quiet           Only print summary line
//   node scripts/capture.js --verbose         Print extra detail (call trace, ghost intercepts, normalize)

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs'
import { resolve, dirname, join } from 'path'
import { fileURLToPath, pathToFileURL } from 'url'
import { fingerprint, fingerprintSequence, extractSchema, getEnvSnapshot, stableStringify } from './fingerprint.js'
import { createGhost, deepClone, consumeIterator } from './ghost.js'
import { mergeCjsModule } from './cjs-merge.js'
import { applyOutputTransformAsync } from './outputTransform.js'

const __dirname = dirname(fileURLToPath(import.meta.url))

// ─── CLI args ─────────────────────────────────────────────────────────────────

const args = process.argv.slice(2)
const clusterFilter = args.includes('--cluster') ? args[args.indexOf('--cluster') + 1] : null
const manifestPath  = args.includes('--manifest') ? args[args.indexOf('--manifest') + 1] : undefined
  ?? resolve(process.cwd(), 'regrets/manifest.json')

// Incremental capture flags
const onlyNew    = args.includes('--only-new')
let   staleHours = null
if (args.includes('--stale')) {
  const staleIdx = args.indexOf('--stale')
  const nextArg  = args[staleIdx + 1]
  staleHours = (nextArg && !nextArg.startsWith('-') && !isNaN(Number(nextArg)))
    ? Number(nextArg)
    : 24  // default: 24 hours
}

// ─── --quiet / --verbose flags ─────────────────────────────────────────────────

let quiet   = args.includes('--quiet')
let verbose = args.includes('--verbose')

if (quiet && verbose) {
  console.warn('⚠️  --quiet and --verbose are mutually exclusive; using --quiet')
  verbose = false
}

// --quiet: only print summary line
// --verbose: print everything + extra detail (call trace, ghost proxy intercepts, normalize applied)
// default (neither): current behavior unchanged

// ─── Load manifest ────────────────────────────────────────────────────────────

let manifest
try {
  manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
} catch (e) {
  console.error(`❌ Could not read manifest: ${manifestPath}`)
  console.error(`   Create regrets/manifest.json first. See SKILL.md for format.`)
  process.exit(1)
}

let clusters = clusterFilter
  ? manifest.clusters.filter(c => c.id === clusterFilter)
  : manifest.clusters

// ─── Incremental filtering (--only-new / --stale) ──────────────────────────────
// When --cluster is set, it overrides --only-new and --stale entirely.
// When neither --only-new nor --stale is set, behavior is unchanged (capture all).

if (!clusterFilter && (onlyNew || staleHours !== null)) {
  const outDirForFilter = resolve(process.cwd(), 'regrets')
  const filteredClusters = []
  let skippedExisting = 0  // skipped by --only-new (have .regret, no --stale to override)
  let skippedFresh    = 0  // skipped by --stale (have .regret, fresh enough)
  let staleCount      = 0  // re-captured because stale
  let newCount        = 0  // captured because no .regret exists

  for (const cluster of clusters) {
    const regretPath = join(outDirForFilter, `${cluster.id}.regret`)
    const hasRegret  = existsSync(regretPath)

    if (!hasRegret) {
      // No .regret file → always capture (it's new)
      newCount++
      filteredClusters.push(cluster)
      continue
    }

    // Has a .regret file — decide whether to skip or re-capture
    if (staleHours !== null) {
      // --stale is set: check timestamp
      try {
        const content      = readFileSync(regretPath, 'utf8')
        const capturedMatch = content.match(/^captured:\s*(.+)$/m)
        if (capturedMatch) {
          const capturedDate = new Date(capturedMatch[1])
          const now          = new Date()
          const ageHours     = (now - capturedDate) / (1000 * 60 * 60)
          if (ageHours <= staleHours) {
            // Fresh enough → skip
            skippedFresh++
            continue
          }
          // Too old → re-capture
          staleCount++
        }
      } catch {
        // Can't read/parse the file — treat as stale so it gets re-captured
        staleCount++
      }
      filteredClusters.push(cluster)
    } else if (onlyNew) {
      // --only-new without --stale: skip all clusters with existing .regret
      skippedExisting++
    } else {
      filteredClusters.push(cluster)
    }
  }

  // Print summary messages matching the spec
  if (onlyNew && !staleHours) {
    if (skippedExisting > 0) {
      console.log(`Skipping ${skippedExisting} existing clusters. Capturing ${newCount} new clusters.`)
    } else {
      console.log(`No existing clusters to skip. Capturing all ${filteredClusters.length} clusters.`)
    }
  }
  if (staleHours !== null) {
    if (staleCount > 0) {
      console.log(`Re-capturing ${staleCount} stale clusters (>${staleHours}h). Skipping ${skippedFresh} fresh clusters.`)
    } else {
      console.log(`No stale clusters found (all captured within ${staleHours}h). Skipping ${skippedFresh} fresh clusters.`)
    }
    if (newCount > 0 && onlyNew) {
      console.log(`Capturing ${newCount} new clusters (no .regret file).`)
    }
  }

  clusters = filteredClusters
}

if (!clusters.length) {
  if (clusterFilter) {
    console.error(`❌ No clusters found matching "${clusterFilter}"`)
    process.exit(1)
  }
  console.log(`✅ Nothing to capture — all clusters are up-to-date.`)
  process.exit(0)
}

// Ghost Proxy and deepClone imported from ghost.js
// Output transform logic imported from outputTransform.js

// ─── Run clusters ─────────────────────────────────────────────────────────────

const outDir = resolve(process.cwd(), 'regrets')
mkdirSync(outDir, { recursive: true })

let passed = 0
let failed = 0

for (const cluster of clusters) {
  const { id, entry, watches, file, stack, normalize = [], ignoreFields = [],
          ignorePaths = [],
          fingerprintLevel = 'entry', fingerprintMode = 'value', valuePaths = [], inputs,
          classMethod, constructor: constructorName, constructorArgs, setup,
          instanceMethods = {}, kwargs = false, outputTransform = null,
          materializeOutput = false, outputEncoding, resetState, deepCloneInput = true,
          seed, singletonMethod, singletonName, storeDispatch, initialState,
          adapter } = cluster

  if (!quiet) {
    console.log(`\n📡 Capturing: ${id}`)
    console.log(`   File:    ${file}`)
    if (storeDispatch) {
      console.log(`   Store:   ${storeDispatch.store} → dispatch("${storeDispatch.action}")`)
    } else if (classMethod) {
      console.log(`   Class:   ${constructorName ?? entry} → ${classMethod}()`)
    } else if (singletonMethod) {
      console.log(`   Singleton: ${singletonName ?? entry} → ${singletonMethod}()`)
    } else {
      console.log(`   Entry:   ${entry}`)
    }
    console.log(`   Watches: ${watches.join(', ')}`)
  }

  // ─── Verbose: print extra cluster config ──────────────────────────────────
  if (verbose) {
    console.log(`   ┌─ ${id} config ──────────────────────────────`)
    console.log(`   │ fingerprintLevel: ${fingerprintLevel}`)
    console.log(`   │ fingerprintMode:  ${fingerprintMode}`)
    if (normalize.length) console.log(`   │ normalize:        [${normalize.join(', ')}]`)
    if (ignoreFields.length) console.log(`   │ ignoreFields:     [${ignoreFields.join(', ')}]`)
    if (ignorePaths.length) console.log(`   │ ignorePaths:      [${ignorePaths.join(', ')}]`)
    if (outputTransform) console.log(`   │ outputTransform:  ${outputTransform}`)
    if (seed != null) console.log(`   │ seed:             ${seed}`)
    if (resetState) console.log(`   │ resetState:       ${resetState}`)
    console.log(`   └────────────────────────────────────────────`)
  }

  if (stack && stack !== 'js' && stack !== 'ts') {
    const stackScripts = {
      python: 'python3 scripts/capture.py',
      react: 'node scripts/capture_react.mjs',
      rust: 'bash scripts/capture_rust.sh capture',
      go: 'bash scripts/capture_go.sh capture',
    }
    if (!quiet) {
      if (stackScripts[stack]) {
        console.log(`   ⏭️  Stack "${stack}" — use: ${stackScripts[stack]}`)
      } else {
        console.log(`   ⚠️  Stack "${stack}" is not supported — see references/ for available stacks`)
      }
    }
    continue
  }

  // ─── Seed random number generator for deterministic output ────────────
  // When `seed` is set in the manifest, Math.random is replaced with a
  // seeded PRNG (simple mulberry32) so that functions using Math.random
  // produce identical output across runs.
  //
  // Override crypto API for deterministic capture when seed is set:
  //   - crypto.randomUUID() → deterministic UUID based on seed + counter
  //   - crypto.getRandomValues() → fill array with deterministic bytes
  const origRandom = Math.random
  let origRandomUUID = null
  let origGetRandomValues = null
  let cryptoAvailable = false

  try {
    // Dynamic import of target module
    const absPath = resolve(process.cwd(), file)
    const moduleUrl = pathToFileURL(absPath).href
    let rawModule = await import(moduleUrl)

    // Handle CJS modules — merge default exports for consistent access
    rawModule = mergeCjsModule(rawModule)

    const recorder = []
    const ghostModule = createGhost(rawModule, watches, recorder, instanceMethods)

    if (Object.keys(instanceMethods).length > 0 && !quiet) {
      console.log(`   Instance methods: ${Object.entries(instanceMethods).map(([k,v]) => `${k}.${v.join('/')}`).join(', ')}`)
    }

    // ─── classMethod mode ─────────────────────────────────────────────────
    // For class-based APIs: construct an instance, optionally call setup
    // methods, then call the target method and fingerprint its output.
    //
    // Manifest fields:
    //   classMethod: "methodName"          — the instance method to fingerprint
    //   constructor: "ClassName"           — class to instantiate (default: entry)
    //   constructorArgs: [...]             — args for the constructor
    //   setup: [{ method, args }, ...]     — setup calls before the target method
    //
    // If classMethod is set, the flow is:
    //   1. new ClassName(...constructorArgs) → instance
    //   2. For each setup: instance[setup.method](...setup.args)
    //   3. instance.classMethod(input) → output (fingerprint this)
    //   4. Watches are applied to instance methods via ghost proxy

    if (seed != null) {
      // mulberry32 — fast 32-bit seeded PRNG
      let s = seed | 0
      const mulberry32 = () => {
        s |= 0; s = s + 0x6D2B79F5 | 0
        let t = Math.imul(s ^ s >>> 15, 1 | s)
        t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t
        return ((t ^ t >>> 14) >>> 0) / 4294967296
      }
      Math.random = mulberry32

      // Override crypto API for deterministic capture when seed is set
      cryptoAvailable = typeof globalThis.crypto === 'object' && globalThis.crypto !== null

      if (cryptoAvailable) {
        // Save originals for restore
        origRandomUUID = globalThis.crypto.randomUUID
        origGetRandomValues = globalThis.crypto.getRandomValues

        // Deterministic UUID generator: produces valid UUID v4 format
        // (xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx) but derived from the seeded PRNG.
        // Uses a counter so successive calls return different but reproducible UUIDs.
        let uuidCounter = 0
        globalThis.crypto.randomUUID = function seededRandomUUID() {
          uuidCounter++
          // Mix seed + counter to create a unique but deterministic state for this UUID
          const hex = () => {
            const val = (mulberry32() * 0x10000) | 0
            return val.toString(16).padStart(4, '0')
          }
          // UUID v4 format: 8-4-4-4-12 hex chars
          // Version nibble (position 13): always '4'
          // Variant nibble (position 17): '8', '9', 'a', or 'b'
          const p1 = hex() + hex()          // 8 chars
          const p2 = hex()                    // 4 chars
          const p3 = '4' + hex().slice(1)     // 4 chars, version = 4
          const p4y = ((mulberry32() * 0x4) | 0x8).toString(16) // variant: 8-b
          const p4 = p4y + hex().slice(1)     // 4 chars
          const p5 = hex() + hex() + hex()    // 12 chars
          return `${p1}-${p2}-${p3}-${p4}-${p5}`
        }

        // Deterministic getRandomValues: fills the provided TypedArray with
        // bytes derived from the seeded PRNG.
        globalThis.crypto.getRandomValues = function seededGetRandomValues(arr) {
          if (!ArrayBuffer.isView(arr)) {
            throw new TypeError('Parameter must be a TypedArray')
          }
          for (let i = 0; i < arr.length; i++) {
            arr[i] = (mulberry32() * 0x100) | 0
          }
          return arr
        }
      }

      if (!quiet) console.log(`   🎲 Seeded RNG with seed=${seed}${cryptoAvailable ? ' (+ crypto API)' : ''}`)
    }

    const testInputs = (inputs && inputs.length > 0) ? inputs : [undefined]
    const results = []

    // ─── Helper: compute fingerprint with full config ──────────────────────
    const fpConfig = { normalize, ignoreFields, ignorePaths }

    function computeFp(fpInput, output, recorder, fingerprintLevel, fingerprintMode, valuePaths, output_schema) {
      if (fingerprintMode === 'schema') {
        const schema = output_schema || extractSchema(output)
        return fingerprint(fpInput, schema, fpConfig)
      } else if (fingerprintMode === 'mixed') {
        const schema = extractSchema(output)
        const selectedValues = {}
        for (const path of valuePaths) {
          const key = path.replace(/^\$\./, '')
          const parts = key.split('.')
          let val = output
          for (const p of parts) { val = val?.[p] }
          if (val !== undefined) selectedValues[path] = val
        }
        return fingerprint(fpInput, { schema, values: selectedValues }, fpConfig)
      } else {
        return fingerprintLevel === 'entry'
          ? fingerprint(fpInput, output, fpConfig)
          : fingerprintSequence(recorder, fpConfig)
      }
    }

    // ─── outputTransform: delegated to shared applyOutputTransformAsync ─────
    // All transform logic (str, json, keys, toString, toJSON, pojo, repr, len,
    // type, isoformat, array_summary, dict, dataclass_dict, custom module.fn)
    // lives in scripts/outputTransform.js

    // ─── Helper: consumeIterator is now imported from ghost.js ───────────

    if (storeDispatch) {
      // ── storeDispatch mode ────────────────────────────────────────────────
      // For state management stores (Redux, Vuex, DispatchingStore, Zustand):
      // Import the store, optionally reset to initialState, dispatch the action,
      // and fingerprint the resulting state.
      //
      // Manifest fields:
      //   storeDispatch: { store: "storeName", action: "actionName" }
      //   initialState: { ... }  — optional state to reset before each dispatch
      //
      // The flow is:
      //   1. Import the module and find the store export
      //   2. For each input: reset to initialState (if provided), dispatch(action, input)
      //   3. Fingerprint the store's new state as the output
      //   4. Watches track any functions called during dispatch (if applicable)
      const storeExport = rawModule[storeDispatch.store] ?? rawModule.default?.[storeDispatch.store]
      if (!storeExport) {
        throw new Error(`Store "${storeDispatch.store}" not found in ${file}`)
      }

      // Detect store type and extract dispatch/value methods
      let dispatchFn, getStateFn, storeType
      if (typeof storeExport.dispatch === 'function' && typeof storeExport.value !== 'undefined') {
        // DispatchingStore pattern (Hoppscotch): store.dispatch(action, payload), store.value
        dispatchFn = storeExport.dispatch.bind(storeExport)
        getStateFn = () => storeExport.value
        storeType = 'dispatching'
      } else if (typeof storeExport.dispatch === 'function' && typeof storeExport.getState === 'function') {
        // Redux-like pattern: store.dispatch({type, payload}), store.getState()
        dispatchFn = storeExport.dispatch.bind(storeExport)
        getStateFn = storeExport.getState
        storeType = 'redux'
      } else if (typeof storeExport.setState === 'function') {
        // Zustand pattern: store.setState(partial), store.getState()
        dispatchFn = storeExport.setState.bind(storeExport)
        getStateFn = () => storeExport.getState()
        storeType = 'zustand'
      } else {
        throw new Error(`Store "${storeDispatch.store}" does not match any known store pattern (DispatchingStore, Redux, Zustand). Ensure the store has dispatch/getState or setState/getState methods.`)
      }

      if (!quiet) console.log(`   Store type: ${storeType}`)

      for (const input of testInputs) {
        recorder.length = 0

        // Reset to initialState if provided
        if (initialState) {
          if (storeType === 'dispatching') {
            // DispatchingStore: replace the current subject value
            if (typeof storeExport.subject?.next === 'function') {
              storeExport.subject.next(deepClone(initialState))
            } else {
              if (!quiet) console.warn(`   ⚠️  Cannot reset DispatchingStore — no accessible subject. State may be dirty.`)
            }
          } else if (storeType === 'redux') {
            // Redux: no standard reset, warn
            if (!quiet) console.warn(`   ⚠️  initialState reset not supported for Redux stores. State may be dirty.`)
          } else if (storeType === 'zustand') {
            storeExport.setState(deepClone(initialState), true /* replace */)
          }
        }

        const inputForRecord = deepClone(input)
        const inputForArgs = deepClone(input)

        // Dispatch the action
        if (storeType === 'redux') {
          // Redux: dispatch expects { type, payload }
          dispatchFn({ type: storeDispatch.action, payload: inputForArgs })
        } else if (storeType === 'dispatching') {
          // DispatchingStore: dispatch(actionName, payload)
          dispatchFn(storeDispatch.action, inputForArgs)
        } else if (storeType === 'zustand') {
          // Zustand: setState with partial
          dispatchFn(inputForArgs)
        }

        const rawOutput = getStateFn()
        const { result: consumedOutput } = await consumeIterator(rawOutput)
        let transformedOutput = await applyOutputTransformAsync(consumedOutput, outputTransform, process.cwd())
        const output = deepClone(transformedOutput)

        const fpInput = inputForRecord

        let fp
        if (fingerprintMode === 'schema') {
          const schema = extractSchema(output)
          fp = fingerprint(fpInput, schema, fpConfig)
        } else if (fingerprintMode === 'mixed') {
          const schema = extractSchema(output)
          const selectedValues = {}
          for (const path of valuePaths) {
            const key = path.replace(/^\$\./, '')
            const parts = key.split('.')
            let val = output
            for (const p of parts) { val = val?.[p] }
            if (val !== undefined) selectedValues[path] = val
          }
          fp = fingerprint(fpInput, { schema, values: selectedValues }, fpConfig)
        } else {
          fp = fingerprintLevel === 'entry'
            ? fingerprint(fpInput, output, fpConfig)
            : fingerprintSequence(recorder, fpConfig)
        }

        results.push({ input: inputForRecord, output, fp, calls: [...recorder] })
      }
    } else if (classMethod) {
      // ── Class-based entry ────────────────────────────────────────────────
      const Cls = rawModule[constructorName ?? entry] ?? rawModule.default?.[constructorName ?? entry]
      if (typeof Cls !== 'function') {
        throw new Error(`Constructor "${constructorName ?? entry}" not found or not a class in ${file}`)
      }
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

        // Run setup methods
        if (setup && setup.length > 0) {
          for (const step of setup) {
            if (typeof instance[step.method] !== 'function') {
              throw new Error(`Setup method "${step.method}" not found on instance`)
            }
            instance[step.method](...(step.args ? deepClone(step.args) : []))
          }
        }

        // Call the target method
        if (typeof instance[classMethod] !== 'function') {
          throw new Error(`Method "${classMethod}" not found on instance`)
        }
        const inputForRecord = deepClone(input)
        const inputForArgs = deepClone(input)
        const args_ = cluster.multiArgs && Array.isArray(inputForArgs) ? [...inputForArgs] : [inputForArgs]
        const rawOutput = await instance[classMethod](...args_)

        // Consume generators/iterators into arrays for fingerprinting.
        const { result: consumedOutput } = await consumeIterator(rawOutput)

        // Apply outputTransform if specified in manifest
        let transformedOutput = await applyOutputTransformAsync(consumedOutput, outputTransform, process.cwd())

        // trackMutation: snapshot input state before/after call to detect mutations
        let inputAfterCall = null
        if (cluster.trackMutation) {
          inputAfterCall = deepClone(inputForArgs)
        }

        const output = deepClone(transformedOutput)

        const fpInput = cluster.multiArgs && Array.isArray(inputForRecord) ? inputForRecord : inputForRecord

        let fp
        if (fingerprintMode === 'schema') {
          const schema = extractSchema(output)
          fp = fingerprint(fpInput, schema, { normalize, ignoreFields })
        } else if (fingerprintMode === 'mixed') {
          const schema = extractSchema(output)
          const selectedValues = {}
          for (const path of valuePaths) {
            const key = path.replace(/^\$\./, '')
            const parts = key.split('.')
            let val = output
            for (const p of parts) { val = val?.[p] }
            if (val !== undefined) selectedValues[path] = val
          }
          fp = fingerprint(fpInput, { schema, values: selectedValues }, { normalize, ignoreFields })
        } else {
          fp = fingerprintLevel === 'entry'
            ? fingerprint(fpInput, output, { normalize, ignoreFields })
            : fingerprintSequence(recorder, { normalize, ignoreFields })
        }

        const resultEntry = { input: inputForRecord, output, fp, calls: [...recorder] }

        // Detect input mutation if trackMutation is enabled
        if (cluster.trackMutation && inputAfterCall !== null) {
          const inputBefore = inputForRecord
          const beforeStr = stableStringify(inputBefore)
          const afterStr = stableStringify(inputAfterCall)
          resultEntry.inputMutated = beforeStr !== afterStr
          if (resultEntry.inputMutated) {
            if (!quiet) console.warn(`   ⚠️  Input MUTATION detected in cluster ${id}! Function modified its input.`)
          }
        }

        results.push(resultEntry)
      }
    } else if (singletonMethod) {
      // ── Singleton method entry ──────────────────────────────────────────────
      // For CJS modules that export a singleton object with methods.
      // Example: module.exports = new Stemmer() → PorterStemmer.stem("running")
      //
      // Manifest fields:
      //   singletonMethod: "methodName"      — the method to call on the singleton
      //   singletonName: "ExportedName"      — the exported name (default: entry)
      //   entry: "PorterStemmer"             — used to locate the singleton in the module
      //
      // The flow is:
      //   1. Get the singleton object from the module
      //   2. Call singleton.singletonMethod(input) → output
      //   3. Fingerprint the output
      const singletonExportName = singletonName ?? entry
      let singleton = rawModule[singletonExportName] ?? rawModule.default?.[singletonExportName]
      // CJS fallback: when module.exports = new Constructor(), the singleton IS the default export
      // e.g., PorterStemmer: module.exports = new Stemmer() → default = {stem, tokenizeAndStem, ...}
      // In this case, singletonName/entry won't match a named export — use default directly
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
        const args_ = cluster.multiArgs && Array.isArray(inputForArgs) ? [...inputForArgs] : [inputForArgs]
        const rawOutput = await singleton[singletonMethod](...args_)

        // Consume generators/iterators into arrays for fingerprinting
        const { result: consumedOutput } = await consumeIterator(rawOutput)

        // Apply outputTransform if specified
        const transformedOutput = await applyOutputTransformAsync(consumedOutput, outputTransform, process.cwd())

        const output = deepClone(transformedOutput)
        const fpInput = cluster.multiArgs && Array.isArray(inputForRecord) ? inputForRecord : inputForRecord

        let fp
        if (fingerprintMode === 'schema') {
          const schema = extractSchema(output)
          fp = fingerprint(fpInput, schema, fpConfig)
        } else if (fingerprintMode === 'mixed') {
          const schema = extractSchema(output)
          const selectedValues = {}
          for (const path of valuePaths) {
            const key = path.replace(/^\$\./, '')
            const parts = key.split('.')
            let val = output
            for (const p of parts) { val = val?.[p] }
            if (val !== undefined) selectedValues[path] = val
          }
          fp = fingerprint(fpInput, { schema, values: selectedValues }, fpConfig)
        } else {
          fp = fingerprintLevel === 'entry'
            ? fingerprint(fpInput, output, fpConfig)
            : fingerprintSequence(recorder, fpConfig)
        }

        results.push({ input: inputForRecord, output, fp, calls: [...recorder] })
      }
    } else {
      // ── Function-based entry (original behavior) ───────────────────────
      // Resolve entry function with CJS module.exports = function support:
      // 1. Named export: mod.encode (ESM or CJS exports.encode)
      // 2. Default object export: mod.default.encode (CJS default object)
      // 3. Single function export: mod.default (CJS module.exports = function)
      //    Accessible via entry="default" or entry="module.exports"
      //
      // 4. Adapter mode: If `adapter` is specified in the manifest, import the
      //    adapter module and call its exported function to get the entry function.
      //    This is for functions that need complex setup (e.g., constructing a
      //    validator instance and passing it as the first argument).
      //    Example: adapter: "regrets/adapter-isMultiSelect.js"
      //    The adapter module must export a function that returns { entryFn, defaultInputs? }
      let entryFn
      if (adapter) {
        // Adapter mode: import the adapter module
        const adapterPath = resolve(process.cwd(), adapter)
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
        // If adapter provides defaultInputs and cluster has none, use them
        if (adapterResult.defaultInputs && (!inputs || inputs.length === 0)) {
          testInputs.splice(0, testInputs.length, ...adapterResult.defaultInputs)
        }
        if (!quiet) console.log(`   Adapter: ${adapter}`)
      } else {
        entryFn = ghostModule[entry]
          ?? rawModule[entry]
          ?? rawModule.default?.[entry]
          ?? ((entry === 'default' || entry === 'module.exports') && typeof rawModule.default === 'function' ? rawModule.default : null)
      }
      if (typeof entryFn !== 'function') {
        throw new Error(`Entry "${entry}" not found or not a function in ${file}`)
      }

      for (const input of testInputs) {
        recorder.length = 0  // clear between runs

        // ─── resetState: reset module-level mutable state before each run ─────
        // When a module uses global mutable variables (e.g., let counter = 0),
        // calling the same function twice may produce different results because
        // the counter has already been incremented. resetState allows specifying
        // a function name exported by the same module that resets these variables.
        if (resetState) {
          const resetFn = rawModule[resetState] ?? rawModule.default?.[resetState]
          if (typeof resetFn === 'function') {
            resetFn()
          } else {
            if (!quiet) console.warn(`   ⚠️  resetState function "${resetState}" not found in ${file}`)
          }
        }

        // ─── deepCloneInput: clone inputs to prevent mutation ──────────────────
        // When true (default), inputs are deep-cloned before each call so that
        // functions that mutate their input objects don't corrupt the test data
        // for subsequent runs or validations.
        const inputForRecord = deepCloneInput ? deepClone(input) : input
        const inputForArgs = deepCloneInput ? deepClone(input) : input
        // kwargs is a no-op for JS: JS has no **kwargs syntax, so dict inputs are
        // always passed as a single object argument regardless of the kwargs flag.
        const args_ = cluster.multiArgs && Array.isArray(inputForArgs) ? [...inputForArgs] : [inputForArgs]
        const rawOutput = await entryFn(...args_)

        // Materialize generator/iterator output if configured
        const { consumed: wasConsumed, result: consumedOutput } = await consumeIterator(rawOutput, null, { materialize: materializeOutput })
        if (wasConsumed && materializeOutput) {
          if (!quiet) console.log(`   🔄 Output materialized: ${rawOutput.constructor?.name || 'iterable'} → Array (${consumedOutput.length} items)`)
        }

        // Apply outputTransform if specified in manifest
        const transformedOutput = await applyOutputTransformAsync(consumedOutput, outputTransform, process.cwd())

        // trackMutation: snapshot input state after call to detect mutations
        let inputAfterCall = null
        if (cluster.trackMutation) {
          inputAfterCall = deepClone(inputForArgs)
        }

        const output = deepClone(transformedOutput)

        const fpInput = cluster.multiArgs && Array.isArray(inputForRecord) ? inputForRecord : inputForRecord

        let fp
        if (fingerprintMode === 'schema') {
          const schema = extractSchema(output)
          fp = fingerprint(fpInput, schema, fpConfig)
        } else if (fingerprintMode === 'mixed') {
          const schema = extractSchema(output)
          const selectedValues = {}
          for (const path of valuePaths) {
            const key = path.replace(/^\$\./, '')
            const parts = key.split('.')
            let val = output
            for (const p of parts) { val = val?.[p] }
            if (val !== undefined) selectedValues[path] = val
          }
          fp = fingerprint(fpInput, { schema, values: selectedValues }, fpConfig)
        } else {
          fp = fingerprintLevel === 'entry'
            ? fingerprint(fpInput, output, fpConfig)
            : fingerprintSequence(recorder, fpConfig)
        }

        results.push({ input: inputForRecord, output, fp, calls: [...recorder] })

        // Detect input mutation if trackMutation is enabled
        if (cluster.trackMutation && inputAfterCall !== null) {
          const lastResult = results[results.length - 1]
          const inputBefore = inputForRecord
          const beforeStr = stableStringify(inputBefore)
          const afterStr = stableStringify(inputAfterCall)
          lastResult.inputMutated = beforeStr !== afterStr
          if (lastResult.inputMutated) {
            if (!quiet) console.warn(`   ⚠️  Input MUTATION detected in cluster ${id}! Function modified its input.`)
          }
        }
      }
    }

    // Warn about watched functions that were never called during capture
    const calledFns = new Set()
    for (const r of results) {
      for (const call of r.calls) {
        calledFns.add(call.fn)
      }
    }
    const uncalledWatches = watches.filter(fn => !calledFns.has(fn))
    if (uncalledWatches.length > 0) {
      if (fingerprintLevel === 'entry') {
        // When fingerprinting at entry level, uncalled watches are EXPECTED.
        // The Ghost Proxy only intercepts module-level exports, not internal calls.
        // The entry function calls watched functions internally, but the proxy
        // doesn't see those calls — it only sees calls through the proxied module.
        if (!quiet) {
          console.log(`   ℹ️  Watched function(s) not called through proxy: ${uncalledWatches.join(', ')}`)
          console.log(`      This is expected with fingerprintLevel: "entry" — internal calls aren't proxied.`)
          console.log(`      The fingerprint is still valid (based on entry function output).`)
        }
      } else {
        if (!quiet) {
          console.warn(`   ⚠️  Watched function(s) never called during capture: ${uncalledWatches.join(', ')}`)
          console.warn(`      The fingerprint may be based on incomplete data.`)
          console.warn(`      Consider splitting into separate clusters or adjusting the entry function.`)
        }
      }
    }

    // Warn when fingerprintLevel is 'watched' or 'full' but no calls were recorded.
    // This commonly happens with class-based APIs where constructors are called
    // with `new` but the Ghost Proxy lacks a `construct` trap, or where
    // instance methods are not proxied.
    if (fingerprintLevel === 'watched' || fingerprintLevel === 'full') {
      const totalCalls = results.reduce((sum, r) => sum + r.calls.length, 0)
      if (totalCalls === 0) {
        if (!quiet) {
          console.error(`   ❌ fingerprintLevel is "${fingerprintLevel}" but NO watched functions were called!`)
          console.error(`      This means the fingerprint is based on an empty call sequence — it tests NOTHING.`)
          console.error(`      For class-based APIs, use 'classMethod' in manifest or add 'instanceMethods' config.`)
          console.error(`      Example: { "instanceMethods": { "Track": ["addEvent", "buildData"] } }`)
        }
      }
    }

    // Use first run as the golden (representative) for the .regret file
    const { input, output, fp } = results[0]

    // Write .regret file
    const regretPath = join(outDir, `${id}.regret`)
    const timestamp  = new Date().toISOString()

    // Output is already deepClone'd (serializable), no further conversion needed
    // When outputEncoding is 'base64', encode Uint8Array output as base64 for readability
    let outputForFile = output
    if (outputEncoding === 'base64' && Array.isArray(output) && output.every(v => typeof v === 'number' && v >= 0 && v <= 255)) {
      // This looks like a byte array from a Uint8Array — encode as base64
      try {
        outputForFile = Buffer.from(output).toString('base64')
      } catch { /* keep as array */ }
    }

    const content = [
      `cluster: ${id}`,
      `version: 1`,
      `fingerprint: ${fp}`,
      `captured: ${timestamp}`,
      `watches: [${watches.join(', ')}]`,
      storeDispatch ? `store: ${storeDispatch.store}` : (classMethod ? `constructor: ${constructorName ?? entry}` : `entry: ${entry}`),
      storeDispatch ? `dispatch: ${storeDispatch.action}` : null,
      classMethod && !storeDispatch ? `classMethod: ${classMethod}` : null,
      singletonMethod ? `singletonName: ${singletonName ?? entry}` : null,
      singletonMethod ? `singletonMethod: ${singletonMethod}` : null,
      `stack: ${stack ?? 'js'}`,
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
      cluster.trackMutation ? `trackMutation: true` : null,
      results.some(r => r.inputMutated) ? `inputMutated: true` : null,
      outputEncoding ? `outputEncoding: ${outputEncoding}` : null,
      resetState ? `resetState: ${resetState}` : null,
      !deepCloneInput ? `deepCloneInput: false` : null,
      seed != null ? `seed: ${seed}` : null,
      `env: ${JSON.stringify(getEnvSnapshot())}`,
      `---`,
      `INPUT  ${JSON.stringify(input ?? null)}`,
      `OUTPUT ${JSON.stringify(outputForFile ?? null)}`,
      `HASH   ${fp}`,
    ].filter(Boolean).join('\n')

    writeFileSync(regretPath, content, 'utf8')

    if (!quiet) {
      console.log(`   ✅ Fingerprint: ${fp}`)
      console.log(`   📄 Saved: regrets/${id}.regret`)
    }

    // ─── Verbose: print ghost proxy intercepts & call trace ──────────────────
    if (verbose) {
      for (let ri = 0; ri < results.length; ri++) {
        const r = results[ri]
        console.log(`   ┌─ ${id} input[${ri}] call trace ──────────────────`)
        console.log(`   │ Input:  ${JSON.stringify(r.input)?.slice(0, 120)}${JSON.stringify(r.input)?.length > 120 ? '…' : ''}`)
        console.log(`   │ Output: ${JSON.stringify(r.output)?.slice(0, 120)}${JSON.stringify(r.output)?.length > 120 ? '…' : ''}`)
        console.log(`   │ Hash:   ${r.fp}`)
        if (r.calls?.length) {
          console.log(`   │ Ghost proxy intercepts (${r.calls.length}):`)
          for (const call of r.calls) {
            const argsStr = JSON.stringify(call.args)?.slice(0, 80)
            const resStr = JSON.stringify(call.result)?.slice(0, 80)
            console.log(`   │   → ${call.fn}(${argsStr}${argsStr?.length >= 80 ? '…' : ''}) => ${resStr}${resStr?.length >= 80 ? '…' : ''}`)
          }
        } else {
          console.log(`   │ Ghost proxy intercepts: (none)`)
        }
        if (normalize.length) {
          console.log(`   │ Normalize applied: [${normalize.join(', ')}]`)
        }
        if (r.inputMutated) {
          console.log(`   │ ⚠️  Input was mutated by function!`)
        }
        console.log(`   └────────────────────────────────────────────`)
      }
    }

    passed++

  } catch (err) {
    if (!quiet) console.error(`   ❌ Capture failed: ${err.message}`)
    if (verbose) console.error(`   Stack: ${err.stack}`)
    failed++
  } finally {
    // Restore original Math.random if we seeded it
    if (seed != null) Math.random = origRandom
    // Restore original crypto API if we overrode it
    if (seed != null && cryptoAvailable) {
      if (origRandomUUID != null) globalThis.crypto.randomUUID = origRandomUUID
      if (origGetRandomValues != null) globalThis.crypto.getRandomValues = origGetRandomValues
    }
  }
}

// ─── Summary ──────────────────────────────────────────────────────────────────

if (quiet) {
  // ─── Quiet summary: only one line ─────────────────────────────────────────
  if (failed > 0) {
    console.log(`❌ ${failed} cluster(s) failed`)
    process.exit(1)
  }
  console.log(`✅ Captured ${passed} cluster(s)`)
  process.exit(0)
} else {
  console.log(`\n${'─'.repeat(50)}`)
  console.log(`Capture complete: ${passed} captured, ${failed} failed`)

  if (failed > 0) {
    console.log(`\n⚠️  Fix failed captures before proceeding to PHASE 2.`)
    console.log(`   Hint: Check that 'entry' and 'watches' names match exports in your file.`)
    process.exit(1)
  }

  console.log(`\nNext: node scripts/validate.js`)
  console.log(`If all green → you are clear to refactor.`)
}

#!/usr/bin/env node
// capture.js — ghost-proxy runner
// Reads regrets/manifest.json, instruments watched functions,
// runs entry points, and writes .regret files.
//
// Usage:
//   node scripts/capture.js
//   node scripts/capture.js --cluster transform-user-data
//   node scripts/capture.js --manifest ./regrets/manifest.json

import { readFileSync, writeFileSync, mkdirSync } from 'fs'
import { resolve, dirname, join } from 'path'
import { fileURLToPath, pathToFileURL } from 'url'
import { fingerprint, fingerprintSequence, extractSchema, getEnvSnapshot, stableStringify } from './fingerprint.js'
import { createGhost, deepClone, consumeIterator } from './ghost.js'
import { mergeCjsModule } from './cjs-merge.js'
import { applyOutputTransform } from './outputTransform.js'

const __dirname = dirname(fileURLToPath(import.meta.url))

// ─── CLI args ─────────────────────────────────────────────────────────────────

const args = process.argv.slice(2)
const clusterFilter = args.includes('--cluster') ? args[args.indexOf('--cluster') + 1] : null
const manifestPath  = args.includes('--manifest') ? args[args.indexOf('--manifest') + 1] : undefined
  ?? resolve(process.cwd(), 'regrets/manifest.json')

// ─── Load manifest ────────────────────────────────────────────────────────────

let manifest
try {
  manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
} catch (e) {
  console.error(`❌ Could not read manifest: ${manifestPath}`)
  console.error(`   Create regrets/manifest.json first. See SKILL.md for format.`)
  process.exit(1)
}

const clusters = clusterFilter
  ? manifest.clusters.filter(c => c.id === clusterFilter)
  : manifest.clusters

if (!clusters.length) {
  console.error(`❌ No clusters found${clusterFilter ? ` matching "${clusterFilter}"` : ''}`)
  process.exit(1)
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

  if (stack && stack !== 'js' && stack !== 'ts') {
    const stackScripts = {
      python: 'python3 scripts/capture.py',
      react: 'node scripts/capture_react.mjs',
      rust: 'bash scripts/capture_rust.sh capture',
      go: 'bash scripts/capture_go.sh capture',
    }
    if (stackScripts[stack]) {
      console.log(`   ⏭️  Stack "${stack}" — use: ${stackScripts[stack]}`)
    } else {
      console.log(`   ⚠️  Stack "${stack}" is not supported — see references/ for available stacks`)
    }
    continue
  }

  try {
    // Dynamic import of target module
    const absPath = resolve(process.cwd(), file)
    const moduleUrl = pathToFileURL(absPath).href
    let rawModule = await import(moduleUrl)

    // Handle CJS modules — merge default exports for consistent access
    rawModule = mergeCjsModule(rawModule)

    const recorder = []
    const ghostModule = createGhost(rawModule, watches, recorder, instanceMethods)

    if (Object.keys(instanceMethods).length > 0) {
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

    // ─── Seed random number generator for deterministic output ────────────
    // When `seed` is set in the manifest, Math.random is replaced with a
    // seeded PRNG (simple mulberry32) so that functions using Math.random
    // produce identical output across runs.
    const origRandom = Math.random
    if (seed != null) {
      // mulberry32 — fast 32-bit seeded PRNG
      let s = seed | 0
      Math.random = () => {
        s |= 0; s = s + 0x6D2B79F5 | 0
        let t = Math.imul(s ^ s >>> 15, 1 | s)
        t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t
        return ((t ^ t >>> 14) >>> 0) / 4294967296
      }
      console.log(`   🎲 Seeded RNG with seed=${seed}`)
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

    // ─── Helper: apply outputTransform ─────────────────────────────────────
    async function applyOutputTransform(consumedOutput, outputTransform) {
      if (!outputTransform) return consumedOutput
      if (outputTransform === 'str') {
        if (Array.isArray(consumedOutput)) {
          return consumedOutput.map(item => String(item))
        }
        return String(consumedOutput)
      } else if (outputTransform === 'json') {
        if (Array.isArray(consumedOutput)) {
          return consumedOutput.map(item => JSON.parse(JSON.stringify(item)))
        }
        return JSON.parse(JSON.stringify(consumedOutput))
      } else if (outputTransform === 'keys') {
        if (consumedOutput && typeof consumedOutput === 'object') {
          return Object.keys(consumedOutput)
        }
      } else if (outputTransform.includes('.')) {
        const lastDot = outputTransform.lastIndexOf('.')
        const modPath = outputTransform.slice(0, lastDot)
        const fnName = outputTransform.slice(lastDot + 1)
        try {
          const customMod = await import(resolve(process.cwd(), modPath))
          return customMod[fnName](consumedOutput)
        } catch (e) {
          throw new Error(`Cannot resolve outputTransform '${outputTransform}': ${e.message}`)
        }
      }
      return consumedOutput
    }

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

      console.log(`   Store type: ${storeType}`)

      for (const input of testInputs) {
        recorder.length = 0

        // Reset to initialState if provided
        if (initialState) {
          if (storeType === 'dispatching') {
            // DispatchingStore: replace the current subject value
            if (typeof storeExport.subject?.next === 'function') {
              storeExport.subject.next(deepClone(initialState))
            } else {
              console.warn(`   ⚠️  Cannot reset DispatchingStore — no accessible subject. State may be dirty.`)
            }
          } else if (storeType === 'redux') {
            // Redux: no standard reset, warn
            console.warn(`   ⚠️  initialState reset not supported for Redux stores. State may be dirty.`)
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
        let transformedOutput = await applyOutputTransform(consumedOutput, outputTransform)
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
        let transformedOutput = applyOutputTransform(consumedOutput, outputTransform)

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
            console.warn(`   ⚠️  Input MUTATION detected in cluster ${id}! Function modified its input.`)
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
        let transformedOutput = consumedOutput
        if (outputTransform) {
          if (outputTransform === 'str') {
            transformedOutput = Array.isArray(consumedOutput)
              ? consumedOutput.map(item => String(item))
              : String(consumedOutput)
          } else if (outputTransform === 'json') {
            transformedOutput = Array.isArray(consumedOutput)
              ? consumedOutput.map(item => JSON.parse(JSON.stringify(item)))
              : JSON.parse(JSON.stringify(consumedOutput))
          } else if (outputTransform === 'keys') {
            if (consumedOutput && typeof consumedOutput === 'object') {
              transformedOutput = Object.keys(consumedOutput)
            }
          }
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
        console.log(`   Adapter: ${adapter}`)
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
            console.warn(`   ⚠️  resetState function "${resetState}" not found in ${file}`)
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
          console.log(`   🔄 Output materialized: ${rawOutput.constructor?.name || 'iterable'} → Array (${consumedOutput.length} items)`)
        }

        // Apply outputTransform if specified in manifest
        let transformedOutput = applyOutputTransform(consumedOutput, outputTransform)

        // Handle async custom outputTransform (module.function pattern)
        if (outputTransform && outputTransform.includes('.')) {
          const lastDot = outputTransform.lastIndexOf('.')
          const modPath = outputTransform.slice(0, lastDot)
          const fnName = outputTransform.slice(lastDot + 1)
          try {
            const customMod = await import(resolve(process.cwd(), modPath))
            transformedOutput = customMod[fnName](consumedOutput)
          } catch (e) {
            throw new Error(`Cannot resolve outputTransform '${outputTransform}': ${e.message}`)
          }
        }

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
            console.warn(`   ⚠️  Input MUTATION detected in cluster ${id}! Function modified its input.`)
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
        console.log(`   ℹ️  Watched function(s) not called through proxy: ${uncalledWatches.join(', ')}`)
        console.log(`      This is expected with fingerprintLevel: "entry" — internal calls aren't proxied.`)
        console.log(`      The fingerprint is still valid (based on entry function output).`)
      } else {
        console.warn(`   ⚠️  Watched function(s) never called during capture: ${uncalledWatches.join(', ')}`)
        console.warn(`      The fingerprint may be based on incomplete data.`)
        console.warn(`      Consider splitting into separate clusters or adjusting the entry function.`)
      }
    }

    // Warn when fingerprintLevel is 'watched' or 'full' but no calls were recorded.
    // This commonly happens with class-based APIs where constructors are called
    // with `new` but the Ghost Proxy lacks a `construct` trap, or where
    // instance methods are not proxied.
    if (fingerprintLevel === 'watched' || fingerprintLevel === 'full') {
      const totalCalls = results.reduce((sum, r) => sum + r.calls.length, 0)
      if (totalCalls === 0) {
        console.error(`   ❌ fingerprintLevel is "${fingerprintLevel}" but NO watched functions were called!`)
        console.error(`      This means the fingerprint is based on an empty call sequence — it tests NOTHING.`)
        console.error(`      For class-based APIs, use 'classMethod' in manifest or add 'instanceMethods' config.`)
        console.error(`      Example: { "instanceMethods": { "Track": ["addEvent", "buildData"] } }`)
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

    console.log(`   ✅ Fingerprint: ${fp}`)
    console.log(`   📄 Saved: regrets/${id}.regret`)
    passed++

  } catch (err) {
    console.error(`   ❌ Capture failed: ${err.message}`)
    failed++
  } finally {
    // Restore original Math.random if we seeded it
    if (seed != null) Math.random = origRandom
  }
}

// ─── Summary ──────────────────────────────────────────────────────────────────

console.log(`\n${'─'.repeat(50)}`)
console.log(`Capture complete: ${passed} captured, ${failed} failed`)

if (failed > 0) {
  console.log(`\n⚠️  Fix failed captures before proceeding to PHASE 2.`)
  console.log(`   Hint: Check that 'entry' and 'watches' names match exports in your file.`)
  process.exit(1)
}

console.log(`\nNext: node scripts/validate.js`)
console.log(`If all green → you are clear to refactor.`)

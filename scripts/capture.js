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
import { createGhost, deepClone } from './ghost.js'
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

// ─── Output Transform Helper ──────────────────────────────────────────────────
// Centralized transform logic shared between classMethod and function-based paths.
// Supports: 'str', 'json', 'keys', 'toString', 'toJSON', 'pojo', 'repr', 'len', 'type',
//           and custom "module.function" syntax.

function applyOutputTransform(output, transform) {
  if (!transform) return output

  if (transform === 'str') {
    if (Array.isArray(output)) return output.map(item => String(item))
    return String(output)
  }

  if (transform === 'json') {
    if (Array.isArray(output)) return output.map(item => JSON.parse(JSON.stringify(item)))
    return JSON.parse(JSON.stringify(output))
  }

  if (transform === 'keys') {
    if (output && typeof output === 'object') return Object.keys(output)
    return output
  }

  // toString: call .toString() on objects (e.g., mathjs Complex, Unit, Matrix)
  // Useful for libraries where the string representation is the canonical output.
  if (transform === 'toString') {
    if (Array.isArray(output)) return output.map(item => (item && typeof item.toString === 'function') ? item.toString() : String(item))
    if (output && typeof output.toString === 'function' && typeof output !== 'string') return output.toString()
    return String(output)
  }

  // toJSON: call .toJSON() on objects that implement it (e.g., mathjs Complex.toJSON())
  // Returns a plain object suitable for fingerprinting.
  if (transform === 'toJSON') {
    if (Array.isArray(output)) return output.map(item => (item && typeof item.toJSON === 'function') ? item.toJSON() : deepClone(item))
    if (output && typeof output.toJSON === 'function') return output.toJSON()
    return deepClone(output)
  }

  // pojo: recursively convert class instances to plain old JavaScript objects.
  // Calls .toJSON() if available, .toString() if the value is a primitive wrapper,
  // or recursively walks the object to strip class identity.
  // This is essential for libraries like mathjs that return custom class instances
  // (Complex, Unit, Matrix, BigNumber, Fraction) that need deep serialization.
  if (transform === 'pojo') {
    return toPojo(output)
  }

  // repr: use JSON.stringify for a string representation of the full value
  if (transform === 'repr') {
    return JSON.stringify(output)
  }

  // len: return the length/size of the output (arrays, strings, objects)
  if (transform === 'len') {
    if (Array.isArray(output)) return output.length
    if (typeof output === 'string') return output.length
    if (output && typeof output === 'object') return Object.keys(output).length
    return 0
  }

  // type: return the type of the output (useful for schema-level fingerprinting)
  if (transform === 'type') {
    if (output === null) return 'null'
    if (output === undefined) return 'undefined'
    if (Array.isArray(output)) return 'array'
    if (output && output.constructor && output.constructor.name !== 'Object') return output.constructor.name
    return typeof output
  }

  // Custom: "module.function" — dynamic import
  if (transform.includes('.')) {
    // Will be handled async in the caller — this is a sync helper,
    // so we return output unchanged; async custom transforms
    // are handled directly in the capture loop.
    return output
  }

  return output
}

/**
 * Recursively convert class instances to plain objects for fingerprinting.
 * Handles nested class instances, arrays, Maps, Sets, and primitives.
 * Calls .toJSON() if available, otherwise strips class identity.
 */
function toPojo(val) {
  if (val === null || val === undefined) return val
  if (typeof val !== 'object') return val
  if (typeof val === 'bigint') return val.toString() + 'n'

  // Arrays: recurse
  if (Array.isArray(val)) return val.map(toPojo)

  // Map → sorted entries
  if (val instanceof Map) {
    const entries = [...val.entries()].sort((a, b) => String(a[0]).localeCompare(String(b[0])))
    return Object.fromEntries(entries.map(([k, v]) => [k, toPojo(v)]))
  }

  // Set → array
  if (val instanceof Set) return [...val].map(toPojo)

  // Date → ISO string
  if (val instanceof Date) return val.toISOString()

  // RegExp → string
  if (val instanceof RegExp) return val.toString()

  // TypedArray → regular array
  if (ArrayBuffer.isView(val) && !(val instanceof DataView)) {
    return Array.from(val).map(toPojo)
  }

  // If object has .toJSON(), use it (covers BigNumber, Fraction, Complex, etc.)
  if (typeof val.toJSON === 'function') {
    return toPojo(val.toJSON())
  }

  // Plain object or class instance: recurse into own enumerable properties
  const result = {}
  for (const key of Object.keys(val)) {
    try {
      const v = val[key]
      if (typeof v !== 'function') {
        result[key] = toPojo(v)
      }
    } catch { /* skip non-accessible properties */ }
  }
  return result
}

// ─── Run clusters ─────────────────────────────────────────────────────────────

const outDir = resolve(process.cwd(), 'regrets')
mkdirSync(outDir, { recursive: true })

let passed = 0
let failed = 0

for (const cluster of clusters) {
  const { id, entry, watches, file, stack, normalize = [], ignoreFields = [],
          fingerprintLevel = 'entry', fingerprintMode = 'value', valuePaths = [], inputs,
          classMethod, constructor: constructorName, constructorArgs, setup,
          instanceMethods = {}, kwargs = false, outputTransform = null,
          materializeOutput = false, outputEncoding, resetState, deepCloneInput = true,
          seed } = cluster

  console.log(`\n📡 Capturing: ${id}`)
  console.log(`   File:    ${file}`)
  if (classMethod) {
    console.log(`   Class:   ${constructorName ?? entry} → ${classMethod}()`)
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

    if (classMethod) {
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
        let consumedOutput = rawOutput
        if (rawOutput && typeof rawOutput[Symbol.iterator] === 'function' &&
            typeof rawOutput.next === 'function' && !Array.isArray(rawOutput) &&
            !(rawOutput instanceof Map) && !(rawOutput instanceof Set)) {
          consumedOutput = [...rawOutput]
        }

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
    } else {
      // ── Function-based entry (original behavior) ───────────────────────
      // Resolve entry function with CJS module.exports = function support:
      // 1. Named export: mod.encode (ESM or CJS exports.encode)
      // 2. Default object export: mod.default.encode (CJS default object)
      // 3. Single function export: mod.default (CJS module.exports = function)
      //    Accessible via entry="default" or entry="module.exports"
      const entryFn = ghostModule[entry]
        ?? rawModule[entry]
        ?? rawModule.default?.[entry]
        ?? ((entry === 'default' || entry === 'module.exports') && typeof rawModule.default === 'function' ? rawModule.default : null)
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
        let consumedOutput
        if (materializeOutput && rawOutput && typeof rawOutput === 'object') {
          const isIterable = typeof rawOutput[Symbol.asyncIterator] === 'function' ||
                             typeof rawOutput[Symbol.iterator] === 'function'
          if (isIterable && !Array.isArray(rawOutput)) {
            consumedOutput = []
            if (typeof rawOutput[Symbol.asyncIterator] === 'function') {
              for await (const item of rawOutput) consumedOutput.push(deepClone(item))
            } else {
              for (const item of rawOutput) consumedOutput.push(deepClone(item))
            }
            console.log(`   🔄 Output materialized: ${rawOutput.constructor?.name || 'iterable'} → Array (${consumedOutput.length} items)`)
          } else {
            // Consume generators/iterators into arrays for fingerprinting.
            consumedOutput = rawOutput
            if (rawOutput && typeof rawOutput[Symbol.iterator] === 'function' &&
                typeof rawOutput.next === 'function' && !Array.isArray(rawOutput) &&
                !(rawOutput instanceof Map) && !(rawOutput instanceof Set)) {
              consumedOutput = [...rawOutput]
            }
          }
        } else {
          // Consume generators/iterators into arrays for fingerprinting (always-on fallback).
          consumedOutput = rawOutput
          if (rawOutput && typeof rawOutput[Symbol.iterator] === 'function' &&
              typeof rawOutput.next === 'function' && !Array.isArray(rawOutput) &&
              !(rawOutput instanceof Map) && !(rawOutput instanceof Set)) {
            consumedOutput = [...rawOutput]
          }
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
      classMethod ? `constructor: ${constructorName ?? entry}` : `entry: ${entry}`,
      classMethod ? `classMethod: ${classMethod}` : null,
      `stack: ${stack ?? 'js'}`,
      `fingerprintLevel: ${fingerprintLevel}`,
      fingerprintMode !== 'value' ? `fingerprintMode: ${fingerprintMode}` : null,
      valuePaths.length ? `valuePaths: [${valuePaths.join(', ')}]` : null,
      normalize.length ? `normalize: [${normalize.join(', ')}]` : null,
      ignoreFields.length ? `ignoreFields: [${ignoreFields.join(', ')}]` : null,
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

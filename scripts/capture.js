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
import { fingerprint, fingerprintSequence, extractSchema, normalizeBinaryOutput } from './fingerprint.js'
import { createGhost, deepClone } from './ghost.js'

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

// ─── Resolve module exports (handles CJS default export) ──────────────────────

function resolveModuleExports(rawModule) {
  // When a CJS module is loaded via dynamic import(), exports are nested
  // under `mod.default` instead of being at the top level.
  // This function normalizes both ESM and CJS module shapes.
  if (rawModule.default && typeof rawModule.default === 'object' && !Array.isArray(rawModule.default)) {
    // Check if the default export looks like a CJS namespace (has multiple keys and also has 'module.exports')
    const defKeys = Object.keys(rawModule.default)
    if (defKeys.length > 0 && !rawModule.default.__esModule) {
      // Likely a CJS module — merge default with top-level for maximum compatibility
      return { ...rawModule.default, ...rawModule }
    }
  }
  return rawModule
}

// ─── Resolve entry function from module (supports nested paths) ────────────────

function resolveEntryFn(mod, entry, entryType = 'function') {
  // Support dot-notation paths like "Utils.getTickDuration"
  // This allows targeting methods on nested objects
  const parts = entry.split('.')
  let target = mod

  for (let i = 0; i < parts.length - 1; i++) {
    if (target && typeof target === 'object' && parts[i] in target) {
      target = target[parts[i]]
    } else {
      return null
    }
  }

  const finalKey = parts[parts.length - 1]
  const fn = target?.[finalKey]

  if (typeof fn !== 'function') return null

  // If entryType is 'constructor', wrap it so it can be called with `new`
  if (entryType === 'constructor') {
    return { fn, isConstructor: true }
  }

  return { fn, isConstructor: false }
}

// ─── Resolve watches (supports nested paths) ──────────────────────────────────

function resolveWatches(mod, watches) {
  // Resolve each watch target, supporting dot-notation for methods on sub-objects
  const resolved = []
  for (const watch of watches) {
    const parts = watch.split('.')
    let target = mod
    let found = true

    for (let i = 0; i < parts.length - 1; i++) {
      if (target && typeof target === 'object' && parts[i] in target) {
        target = target[parts[i]]
      } else {
        found = false
        break
      }
    }

    if (found) {
      const finalKey = parts[parts.length - 1]
      const parentObj = target
      const fn = target?.[finalKey]
      if (typeof fn === 'function') {
        resolved.push({ name: watch, parentObj, key: finalKey, fn })
      }
    }
  }
  return resolved
}

// ─── Execute setupSteps for builder/workflow patterns ──────────────────────────

async function executeSetupSteps(mod, setupSteps) {
  // setupSteps allows defining multi-step workflows for stateful builder patterns.
  // Each step is: { action: "call"|"new"|"eval", target: "ClassName", method?: "methodName", args?: [] }
  const context = {} // holds named objects created during setup

  // Resolve $ref placeholders in args: {"$ref": "name"} → context["name"]
  function resolveRefs(args) {
    if (!Array.isArray(args)) return args
    return args.map(arg => {
      if (arg && typeof arg === 'object' && !Array.isArray(arg) && arg.$ref) {
        const ref = context[arg.$ref]
        if (!ref) throw new Error(`$ref "${arg.$ref}" not found in setup context. Available: ${Object.keys(context).join(', ')}`)
        return ref
      }
      return arg
    })
  }

  for (const step of setupSteps) {
    const { action, target, method, args: stepArgs = [], as } = step
    const resolvedArgs = resolveRefs(stepArgs)

    if (action === 'new') {
      // Create a new instance: { action: "new", target: "Track", as: "track1" }
      const parts = target.split('.')
      let Ctor = mod
      for (const p of parts) Ctor = Ctor?.[p]
      if (typeof Ctor !== 'function') throw new Error(`Constructor "${target}" not found`)
      const instance = new Ctor(...resolvedArgs)
      if (as) context[as] = instance
    } else if (action === 'call') {
      // Call a method on a context object: { action: "call", on: "track1", method: "addEvent", args: [...] }
      const obj = context[step.on] ?? mod
      const fn = obj[method ?? target]
      if (typeof fn !== 'function') throw new Error(`Method "${method ?? target}" not found on ${step.on ?? 'module'}`)
      const result = await fn.call(obj, ...resolvedArgs)
      if (as) context[as] = result
    } else if (action === 'eval') {
      // Execute a setup expression: { action: "eval", expr: "new module.NoteEvent({pitch:'C4',duration:'4'})", as: "note1" }
      // The expression has `module` and `context` available as variables
      const fn = new Function('module', 'context', `return (${step.expr})`)
      const result = fn(mod, context)
      if (as) context[as] = result
    }
  }

  return context
}

// ─── Apply output transformation ──────────────────────────────────────────────

function transformOutput(output, cluster) {
  const { outputMethod, outputTransform } = cluster

  // outputMethod: call a method on the output object before fingerprinting
  // e.g., "base64" → output.base64()
  if (outputMethod && output != null) {
    const method = output[outputMethod]
    if (typeof method === 'function') {
      return method.call(output)
    }
  }

  // outputTransform: a named transformation to apply
  if (outputTransform) {
    switch (outputTransform) {
      case 'base64':
        // Convert binary output to base64 string
        if (output instanceof Uint8Array || Buffer.isBuffer(output)) {
          return Buffer.from(output).toString('base64')
        }
        if (typeof output === 'string') return output
        break
      case 'hex':
        // Convert binary output to hex string
        if (output instanceof Uint8Array || Buffer.isBuffer(output)) {
          return Array.from(output).map(b => b.toString(16).padStart(2, '0')).join('')
        }
        break
      case 'array':
        // Convert typed array to regular array for proper JSON serialization
        if (ArrayBuffer.isView(output)) {
          return Array.from(output)
        }
        break
      case 'json':
        // JSON serialize the output
        return JSON.stringify(output)
      break
      case 'string':
        // Convert to string
        return String(output)
    }
  }

  // Auto-normalize binary outputs that can't be properly JSON-stringified
  if (output instanceof Uint8Array || Buffer.isBuffer(output)) {
    // Default: convert to base64 for a compact, stable representation
    return Buffer.from(output).toString('base64')
  }

  return output
}

// ─── Run clusters ─────────────────────────────────────────────────────────────

const outDir = resolve(process.cwd(), 'regrets')
mkdirSync(outDir, { recursive: true })

let passed = 0
let failed = 0

for (const cluster of clusters) {
  const { id, entry, watches, file, stack, normalize = [], ignoreFields = [],
          fingerprintLevel = 'entry', fingerprintMode = 'value', valuePaths = [], inputs,
          entryType = 'function', setupSteps, outputMethod, outputTransform } = cluster

  console.log(`\n📡 Capturing: ${id}`)
  console.log(`   File:    ${file}`)
  console.log(`   Entry:   ${entry}`)
  console.log(`   Watches: ${watches.join(', ')}`)
  if (entryType !== 'function') console.log(`   EntryType: ${entryType}`)
  if (setupSteps?.length) console.log(`   SetupSteps: ${setupSteps.length} steps`)
  if (outputMethod) console.log(`   OutputMethod: ${outputMethod}`)
  if (outputTransform) console.log(`   OutputTransform: ${outputTransform}`)

  if (stack && stack !== 'js' && stack !== 'ts') {
    console.log(`   ⚠️  Stack "${stack}" — see references/ for non-JS capture`)
    continue
  }

  try {
    // Dynamic import of target module
    const absPath = resolve(process.cwd(), file)
    const moduleUrl = pathToFileURL(absPath).href
    const rawModule = await import(moduleUrl)

    // Resolve CJS/ESM module shape
    const mod = resolveModuleExports(rawModule)

    // ─── Handle setupSteps (builder/workflow patterns) ───────────────────────

    let setupContext = {}
    if (setupSteps?.length) {
      setupContext = await executeSetupSteps(mod, setupSteps)
    }

    // ─── Resolve entry function ──────────────────────────────────────────────

    let entryFn, isConstructor = false

    if (setupSteps?.length && cluster.entryTarget) {
      // Entry is a method on an object created during setup
      const obj = setupContext[cluster.entryTarget]
      if (!obj) throw new Error(`Setup context "${cluster.entryTarget}" not found. Check setupSteps.`)
      const fn = obj[entry]
      if (typeof fn !== 'function') throw new Error(`Method "${entry}" not found on setup context "${cluster.entryTarget}"`)
      entryFn = fn.bind(obj)
    } else {
      const resolved = resolveEntryFn(mod, entry, entryType)
      if (!resolved) throw new Error(`Entry "${entry}" not found or not a function in ${file}`)
      entryFn = resolved.fn
      isConstructor = resolved.isConstructor
    }

    // ─── Resolve and ghost-wrap watches ──────────────────────────────────────

    const recorder = []

    // Build a flat module-like object for ghost wrapping that includes nested methods
    const ghostModule = { ...mod }

    // If watches include dot-notation paths, resolve and flatten them
    for (const watch of watches) {
      if (watch.includes('.')) {
        const parts = watch.split('.')
        let target = mod
        for (let i = 0; i < parts.length - 1; i++) {
          target = target?.[parts[i]]
        }
        const fn = target?.[parts[parts.length - 1]]
        if (typeof fn === 'function') {
          ghostModule[watch] = fn.bind(target)
        }
      }
    }

    // Also add objects from setup context to ghost module
    for (const [key, val] of Object.entries(setupContext)) {
      if (typeof val === 'object' && val !== null) {
        // Add methods from setup objects so they can be watched
        for (const [methodKey, methodVal] of Object.entries(Object.getPrototypeOf(val) || {})) {
          if (typeof methodVal === 'function' && !methodKey.startsWith('_')) {
            ghostModule[`${key}.${methodKey}`] = methodVal.bind(val)
          }
        }
      }
    }

    const ghosted = createGhost(ghostModule, watches, recorder)

    // Use ghosted entry if available, otherwise the resolved entry
    const effectiveEntryFn = ghosted[entry] ?? entryFn

    // ─── Run with provided inputs ────────────────────────────────────────────

    const testInputs = inputs ?? [undefined]
    const results = []

    for (const input of testInputs) {
      recorder.length = 0  // clear between runs

      let output
      const args_ = cluster.multiArgs && Array.isArray(input) ? input : [input]

      if (isConstructor) {
        // Entry is a constructor — call with `new`
        output = new entryFn(...args_)
      } else if (setupSteps?.length && cluster.entryTarget) {
        // Entry is a method on a setup object
        output = await effectiveEntryFn(...args_)
      } else {
        output = await effectiveEntryFn(...args_)
      }

      // Apply output transformation (outputMethod, outputTransform, or auto-normalize binary)
      const transformedOutput = transformOutput(output, cluster)

      const fpInput = cluster.multiArgs && Array.isArray(input) ? input : input

      // Determine fingerprint based on fingerprintMode
      let fp
      if (fingerprintMode === 'schema') {
        const schema = extractSchema(transformedOutput)
        fp = fingerprint(fpInput, schema, { normalize, ignoreFields })
      } else if (fingerprintMode === 'mixed') {
        const schema = extractSchema(transformedOutput)
        const selectedValues = {}
        for (const path of valuePaths) {
          const key = path.replace(/^\$\./, '')
          const parts = key.split('.')
          let val = transformedOutput
          for (const p of parts) {
            val = val?.[p]
          }
          if (val !== undefined) selectedValues[path] = val
        }
        const combined = { schema, values: selectedValues }
        fp = fingerprint(fpInput, combined, { normalize, ignoreFields })
      } else {
        // Default: value mode
        fp = fingerprintLevel === 'entry'
          ? fingerprint(fpInput, transformedOutput, { normalize, ignoreFields })
          : fingerprintSequence(recorder, { normalize, ignoreFields })
      }

      results.push({ input, output: transformedOutput, fp, calls: [...recorder] })
    }

    // Use first run as the golden (representative) for the .regret file
    const { input, output, fp } = results[0]

    // Write .regret file
    const regretPath = join(outDir, `${id}.regret`)
    const timestamp  = new Date().toISOString()

    const content = [
      `cluster: ${id}`,
      `version: 1`,
      `fingerprint: ${fp}`,
      `captured: ${timestamp}`,
      `watches: [${watches.join(', ')}]`,
      `entry: ${entry}`,
      `stack: ${stack ?? 'js'}`,
      `fingerprintLevel: ${fingerprintLevel}`,
      fingerprintMode !== 'value' ? `fingerprintMode: ${fingerprintMode}` : null,
      entryType !== 'function' ? `entryType: ${entryType}` : null,
      valuePaths.length ? `valuePaths: [${valuePaths.join(', ')}]` : null,
      normalize.length ? `normalize: [${normalize.join(', ')}]` : null,
      ignoreFields.length ? `ignoreFields: [${ignoreFields.join(', ')}]` : null,
      outputMethod ? `outputMethod: ${outputMethod}` : null,
      outputTransform ? `outputTransform: ${outputTransform}` : null,
      `---`,
      `INPUT  ${input === undefined ? 'undefined' : JSON.stringify(input)}`,
      `OUTPUT ${JSON.stringify(output)}`,
      `HASH   ${fp}`,
    ].filter(Boolean).join('\n')

    writeFileSync(regretPath, content, 'utf8')

    console.log(`   ✅ Fingerprint: ${fp}`)
    console.log(`   📄 Saved: regrets/${id}.regret`)
    passed++

  } catch (err) {
    console.error(`   ❌ Capture failed: ${err.message}`)
    failed++
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

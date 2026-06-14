#!/usr/bin/env node
// discover.js — runtime call graph tracing for draft manifest generation
//
// Runs an entry function with a Ghost-style proxy that wraps ALL exported
// functions from the target module. Records the call graph and generates
// a draft manifest.json cluster.
//
// Key insight: JS module internals call siblings directly (not through the
// module object), so we can't intercept those calls via Proxy alone. Our
// approach is two-fold:
//   1. Wrap ALL function exports with tracing proxies (like createGhost)
//      and bind `this` to the traced module, so `this.fn()` calls are caught
//   2. List all function exports as potential watches — the user can trim
//      the list after review
//
// Usage:
//   node scripts/discover.js --entry parseConfig --file src/utils.js
//   node scripts/discover.js --entry parseConfig --file src/utils.js --inputs '[null, {"key":"val"}]'
//   node scripts/discover.js --entry parseConfig --file src/utils.js --out regrets/manifest.json

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs'
import { resolve, dirname } from 'path'
import { fileURLToPath, pathToFileURL } from 'url'
import { deepClone } from './ghost.js'
import { mergeCjsModule } from './cjs-merge.js'

const __dirname = dirname(fileURLToPath(import.meta.url))

// ─── CLI args ─────────────────────────────────────────────────────────────────

function getArg(args, flag) {
  const i = args.indexOf(flag)
  return i !== -1 ? args[i + 1] ?? null : null
}

const args        = process.argv.slice(2)
const entryName   = getArg(args, '--entry')
const filePath    = getArg(args, '--file')
const inputsStr   = getArg(args, '--inputs')
const outPath     = getArg(args, '--out')

// ─── Validate required args ────────────────────────────────────────────────────

if (!entryName || !filePath) {
  console.error('❌ Usage: regret discover --entry <fnName> --file <path/to/file.js>')
  console.error('        regret discover --entry <fnName> --file <path> --inputs \'[null, {}]\'')
  console.error('        regret discover --entry <fnName> --file <path> --out regrets/manifest.json')
  process.exit(1)
}

const absFilePath = resolve(process.cwd(), filePath)

if (!existsSync(absFilePath)) {
  console.error(`❌ File not found: ${absFilePath}`)
  process.exit(1)
}

// ─── Parse inputs ──────────────────────────────────────────────────────────────

let testInputs
if (inputsStr) {
  try {
    testInputs = JSON.parse(inputsStr)
    if (!Array.isArray(testInputs)) {
      console.error('❌ --inputs must be a JSON array, e.g. \'[null, {"key":"val"}]\'')
      process.exit(1)
    }
  } catch (e) {
    console.error(`❌ Invalid --inputs JSON: ${e.message}`)
    process.exit(1)
  }
} else {
  testInputs = [null, {}, undefined]
}

// ─── Call graph recorder ───────────────────────────────────────────────────────

const callGraph = []    // { fn, args, result, calledBy, depth }
const fnCallCounts = {} // fn → count
let currentCaller = null
let currentDepth = 0

const MAX_DEPTH = 3

// Node built-in module prefixes to exclude from watches
const NODE_BUILTIN_PREFIXES = [
  'node:', 'fs', 'path', 'url', 'util', 'crypto', 'os', 'stream',
  'http', 'https', 'net', 'tls', 'child_process', 'events', 'buffer',
  'assert', 'querystring', 'string_decoder', 'zlib', 'readline', 'vm',
  'worker_threads', 'perf_hooks', 'async_hooks', 'dns', 'dgram',
  'cluster', 'process', 'console',
]

function isNodeBuiltin(fnName) {
  const prefix = fnName.split('.')[0]
  return NODE_BUILTIN_PREFIXES.includes(prefix)
}

function recordCall(fn, args, result, calledBy, depth) {
  callGraph.push({ fn, args, result, calledBy, depth })
  fnCallCounts[fn] = (fnCallCounts[fn] || 0) + 1
}

// ─── Tracing ghost module ──────────────────────────────────────────────────────
//
// Creates a module where ALL function exports are replaced with tracing proxies.
// This is similar to ghost.js's createGhost, but instead of watching a specific
// list, we wrap EVERY function export.
//
// When the entry function calls `this.siblingFn()`, the proxy intercepts it.
// Direct calls (e.g., `siblingFn()`) bypass the proxy — this is a JS limitation.
// To maximize coverage, we bind the entry function's `this` to the traced module.

function createTracingModule(rawModule) {
  // Find all function exports
  const functionNames = Object.keys(rawModule).filter(key => {
    const val = rawModule[key]
    return typeof val === 'function' && !isNodeBuiltin(key)
  })

  const tracedModule = { ...rawModule }
  const recorder = []

  for (const fnName of functionNames) {
    const original = rawModule[fnName]

    tracedModule[fnName] = new Proxy(original, {
      apply(target, thisArg, callArgs) {
        // Bind `this` to the traced module so sibling calls via `this.fn()` are intercepted
        const effectiveThis = (thisArg && typeof thisArg === 'object' && fnName in thisArg)
          ? thisArg
          : tracedModule

        const caller = currentCaller
        const callDepth = currentDepth

        // Record call start
        if (callDepth <= MAX_DEPTH && !isNodeBuiltin(fnName)) {
          let clonedArgs
          try { clonedArgs = deepClone(callArgs) } catch { clonedArgs = callArgs.map(a => String(a)) }
          recordCall(fnName, clonedArgs, undefined, caller, callDepth)
        }

        // Set context for nested calls
        const prevCaller = currentCaller
        const prevDepth = currentDepth
        currentCaller = fnName
        currentDepth = callDepth + 1

        let result
        try {
          result = target.apply(effectiveThis, callArgs)
        } catch (err) {
          currentCaller = prevCaller
          currentDepth = prevDepth
          // Update call record with error
          if (callDepth <= MAX_DEPTH) {
            const lastRecord = callGraph[callGraph.length - 1]
            if (lastRecord && lastRecord.fn === fnName) {
              lastRecord.result = { __error__: err.constructor?.name || 'Error', message: String(err.message || err) }
            }
          }
          throw err
        }

        // Handle async results
        if (result && typeof result.then === 'function') {
          return result.then(resolved => {
            currentCaller = prevCaller
            currentDepth = prevDepth
            if (callDepth <= MAX_DEPTH) {
              const lastRecord = callGraph[callGraph.length - 1]
              if (lastRecord && lastRecord.fn === fnName) {
                try { lastRecord.result = deepClone(resolved) } catch { lastRecord.result = String(resolved) }
              }
            }
            return resolved
          }).catch(err => {
            currentCaller = prevCaller
            currentDepth = prevDepth
            if (callDepth <= MAX_DEPTH) {
              const lastRecord = callGraph[callGraph.length - 1]
              if (lastRecord && lastRecord.fn === fnName) {
                lastRecord.result = { __error__: err.constructor?.name || 'Error', message: String(err.message || err) }
              }
            }
            throw err
          })
        }

        currentCaller = prevCaller
        currentDepth = prevDepth

        // Update call record with result
        if (callDepth <= MAX_DEPTH) {
          const lastRecord = callGraph[callGraph.length - 1]
          if (lastRecord && lastRecord.fn === fnName) {
            try { lastRecord.result = deepClone(result) } catch { lastRecord.result = String(result) }
          }
        }

        return result
      },

      construct(target, constructArgs, newTarget) {
        const caller = currentCaller
        const callDepth = currentDepth

        if (callDepth <= MAX_DEPTH && !isNodeBuiltin(fnName)) {
          let clonedArgs
          try { clonedArgs = deepClone(constructArgs) } catch { clonedArgs = constructArgs.map(a => String(a)) }
          recordCall(fnName, clonedArgs, undefined, caller, callDepth)
        }

        const prevCaller = currentCaller
        const prevDepth = currentDepth
        currentCaller = fnName
        currentDepth = callDepth + 1

        let instance
        try {
          instance = Reflect.construct(target, constructArgs, newTarget)
        } catch (err) {
          currentCaller = prevCaller
          currentDepth = prevDepth
          throw err
        }

        currentCaller = prevCaller
        currentDepth = prevDepth

        // Record construction
        if (callDepth <= MAX_DEPTH) {
          const lastRecord = callGraph[callGraph.length - 1]
          if (lastRecord && lastRecord.fn === fnName) {
            lastRecord.result = { __constructed__: true, className: fnName }
            lastRecord.construct = true
          }
        }

        return instance
      }
    })
  }

  return { tracedModule, functionNames }
}

// ─── Main discovery logic ──────────────────────────────────────────────────────

async function discover() {
  console.log(`\n🔍 Discovering call graph for: ${entryName}`)
  console.log(`   File: ${absFilePath}`)
  console.log(`   Inputs: ${testInputs.length} (${testInputs.map(i => i === null ? 'null' : i === undefined ? 'undefined' : JSON.stringify(i)).join(', ')})\n`)

  // Dynamic import of the target module
  let rawModule
  try {
    const moduleUrl = pathToFileURL(absFilePath).href
    rawModule = await import(moduleUrl)
    rawModule = mergeCjsModule(rawModule)
  } catch (e) {
    console.error(`❌ Cannot import module: ${absFilePath}`)
    console.error(`   ${e.message}`)
    process.exit(1)
  }

  // Resolve entry function
  const entryFn = rawModule[entryName]
    ?? rawModule.default?.[entryName]
    ?? ((entryName === 'default' || entryName === 'module.exports') && typeof rawModule.default === 'function' ? rawModule.default : null)

  if (typeof entryFn !== 'function') {
    console.error(`❌ Entry "${entryName}" not found or not a function in ${filePath}`)
    const available = Object.keys(rawModule).filter(k => typeof rawModule[k] === 'function')
    if (available.length > 0) {
      console.error(`   Available functions: ${available.join(', ')}`)
    }
    process.exit(1)
  }

  // Create tracing module — wrap ALL function exports
  const { tracedModule, functionNames } = createTracingModule(rawModule)

  // Run the entry function with each input through the traced module
  for (const input of testInputs) {
    currentCaller = entryName
    currentDepth = 0

    try {
      const args_ = Array.isArray(input) ? [...input] : [input]
      // Call through the traced module so `this.fn()` calls are intercepted
      const tracedEntryFn = tracedModule[entryName]
      await tracedEntryFn(...args_)
    } catch (e) {
      // Errors are OK — we still recorded the call graph up to the error
      console.warn(`   ⚠️  Entry threw for input ${JSON.stringify(input)}: ${e.message}`)
    }

    currentCaller = null
    currentDepth = 0
  }

  // ─── Process call graph into watches ────────────────────────────────────────

  // Functions actually called during tracing (excluding entry itself and builtins)
  const calledFns = Object.keys(fnCallCounts)
    .filter(fn => fn !== entryName && !isNodeBuiltin(fn))

  // All exported functions (excluding entry and builtins) — these are potential watches
  const allExportedFns = functionNames
    .filter(fn => fn !== entryName && !isNodeBuiltin(fn))

  // Merge: called functions first (sorted by count), then uncalled exports
  const calledSet = new Set(calledFns)
  const uncalledExports = allExportedFns.filter(fn => !calledSet.has(fn))

  const watches = [
    ...calledFns.sort((a, b) => (fnCallCounts[b] || 0) - (fnCallCounts[a] || 0)),
    ...uncalledExports
  ]

  // Build caller map for human-readable output
  const callerMap = {}
  for (const record of callGraph) {
    if (record.fn === entryName) continue
    if (isNodeBuiltin(record.fn)) continue
    const caller = record.calledBy || entryName
    if (!callerMap[record.fn]) {
      callerMap[record.fn] = { callers: new Set(), count: 0 }
    }
    callerMap[record.fn].callers.add(caller)
    callerMap[record.fn].count++
  }

  // ─── Generate draft manifest cluster ────────────────────────────────────────

  const clusterId = entryName
    .replace(/([a-z])([A-Z])/g, '$1-$2')
    .replace(/[_\s]+/g, '-')
    .toLowerCase()

  const draftCluster = {
    id: clusterId,
    entry: entryName,
    watches,
    file: filePath,
    stack: 'js',
    fingerprintLevel: 'entry',
    inputs: testInputs,
  }

  const draftManifest = {
    clusters: [draftCluster]
  }

  // ─── Human-readable output ──────────────────────────────────────────────────

  console.log(`  Entry: ${entryName} (${filePath})`)
  console.log(`  Inputs tested: ${testInputs.length} (${testInputs.map(i => i === null ? 'null' : i === undefined ? 'undefined' : JSON.stringify(i)).join(', ')})`)
  console.log()

  if (watches.length === 0) {
    console.log('  No function exports discovered.')
    console.log('  The entry function may be a leaf with no exported helpers.')
  } else {
    console.log('  Functions discovered:')
    console.log(`    ${entryName.padEnd(24)} → entry`)

    for (const fn of watches) {
      const info = callerMap[fn]
      if (info) {
        // This function was called during tracing
        const callers = [...info.callers]
        const callerStr = callers.length > 0
          ? `called by ${callers.join(', ')}`
          : 'direct call'
        const countStr = info.count > 1 ? ` (${info.count}x)` : ''
        console.log(`    ${fn.padEnd(24)} → ${callerStr}${countStr}`)
      } else {
        // This function was exported but not called
        console.log(`    ${fn.padEnd(24)} → exported (not called during trace)`)
      }
    }
  }

  // ─── Output manifest ────────────────────────────────────────────────────────

  const manifestJson = JSON.stringify(draftManifest, null, 2)

  if (outPath) {
    const absOutPath = resolve(process.cwd(), outPath)
    if (existsSync(absOutPath)) {
      console.warn(`\n  ⚠️  ${outPath} already exists — printing draft to stdout instead.`)
      console.warn('     Append the cluster manually or use a different --out path.\n')
      console.log(manifestJson)
    } else {
      const outDir = dirname(absOutPath)
      mkdirSync(outDir, { recursive: true })
      writeFileSync(absOutPath, manifestJson, 'utf8')
      console.log(`\n  Draft manifest written to: ${outPath}`)
    }
  } else {
    console.log(`\n${manifestJson}`)
  }

  // ─── Next steps ─────────────────────────────────────────────────────────────

  console.log(`
  Next steps:
    1. Review the draft manifest — add more inputs for better coverage
    2. regret capture
    3. regret validate
`)
}

discover().catch(err => {
  console.error(`❌ Discovery failed: ${err.message}`)
  process.exit(1)
})

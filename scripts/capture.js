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

import { readFileSync, writeFileSync, mkdirSync, existsSync, openSync, closeSync, unlinkSync } from 'fs'
import { resolve, dirname, join, extname } from 'path'
import { fileURLToPath, pathToFileURL } from 'url'
import { fingerprint, fingerprintSequence, extractSchema, getEnvSnapshot, stableStringify, normalize as fpNormalize, stripFields } from './fingerprint.js'
import { createGhost, wrapCallees, deepClone, consumeIterator } from './ghost.js'
import { mergeCjsModule } from './cjs-merge.js'
import { applyOutputTransformAsync } from './outputTransform.js'
import { isEsmSource, transformEsmForCallees, HOLDER_NAME } from './esm-callee-transform.js'

const __dirname = dirname(fileURLToPath(import.meta.url))

// ─── Lightweight file locking (lockfile pattern) ────────────────────────────────
// Uses O_EXCL atomic create for lock acquisition.  Retries with exponential
// backoff up to 10 s.  Auto-releases in finally block so orphan locks are rare.

import { constants as _fsConstants, statSync as _statSync } from 'fs'
import { execSync as _execSync } from 'child_process'

const _O_EXCL = _fsConstants.O_CREAT | _fsConstants.O_EXCL
const _LOCK_TIMEOUT_MS = 10_000
const _LOCK_BASE_DELAY_MS = 50
const _LOCK_MAX_DELAY_MS = 500

function _lockfilePath(filePath) {
  // Place lockfile next to the target: /path/to/file.ext → /path/to/file.ext.lock
  return filePath + '.lock'
}

function _sleepMs(ms) {
  // Synchronous sleep using child_process — works in Node main thread
  _execSync(`sleep ${Math.max(0, ms / 1000).toFixed(3)}`, { stdio: 'ignore', timeout: ms + 2000 })
}

function acquireLock(filePath) {
  const lockPath = _lockfilePath(filePath)
  const deadline = Date.now() + _LOCK_TIMEOUT_MS
  let delay = _LOCK_BASE_DELAY_MS

  while (Date.now() < deadline) {
    // If stale lock exists (older than timeout), remove it and retry immediately
    try {
      const stat = _statSync(lockPath)
      if (Date.now() - stat.mtimeMs > _LOCK_TIMEOUT_MS) {
        try { unlinkSync(lockPath) } catch (_) { /* race: another process removed it */ }
        continue  // retry immediately
      }
    } catch (_) { /* lock doesn't exist yet — proceed to create */ }

    try {
      const fd = openSync(lockPath, _O_EXCL, 0o600)
      closeSync(fd)
      return lockPath          // success — return lockPath for releaseLock()
    } catch (e) {
      if (e.code !== 'EEXIST') throw e  // unexpected error
    }

    // Exponential backoff
    const sleepMs = Math.min(delay, deadline - Date.now(), _LOCK_MAX_DELAY_MS)
    if (sleepMs <= 0) break
    _sleepMs(sleepMs)
    delay = Math.min(delay * 2, _LOCK_MAX_DELAY_MS)
  }

  throw new Error(`filelock: could not acquire lock on ${filePath} within ${_LOCK_TIMEOUT_MS / 1000}s`)
}

function releaseLock(lockPath) {
  try { unlinkSync(lockPath) } catch (_) { /* already removed — fine */ }
}

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
          adapter, sideEffectWatches = [], detectMode = false,
          freezeTime = null, inputTransform = null, isolateGlobals = false,
          callees = [] } = cluster

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
    if (freezeTime) console.log(`   ⏰ Time frozen: ${freezeTime}`)
    if (inputTransform) console.log(`   Input transform: ${inputTransform}`)
    if (isolateGlobals) console.log(`   Isolate globals: true`)
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
    if (freezeTime) console.log(`   │ freezeTime:       ${freezeTime}`)
    if (inputTransform) console.log(`   │ inputTransform:   ${inputTransform}`)
    if (isolateGlobals) console.log(`   │ isolateGlobals:   true`)
    if (resetState) console.log(`   │ resetState:       ${resetState}`)
    console.log(`   └────────────────────────────────────────────`)
  }

  if (stack && stack !== 'js' && stack !== 'ts' && stack !== 'css') {
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

  // ─── freezeTime: freeze Date during cluster run ─────────────────────
  // When `freezeTime` is set in the manifest (e.g., "2024-01-15T10:00:00Z"),
  // Date.now() and new Date() return the frozen time instead of real time.
  // This is critical for functions that use Date.now() or new Date() as defaults,
  // preventing non-deterministic fingerprints.
  // The original Date is always restored via try/finally after the cluster.
  const OriginalDate = globalThis.Date
  let dateFrozen = false
  if (freezeTime) {
    const frozenMs = new OriginalDate(freezeTime).getTime()
    const frozenTime = new OriginalDate(frozenMs)
    globalThis.Date = class extends OriginalDate {
      constructor(...args) {
        if (args.length > 0) return new OriginalDate(...args)
        return new OriginalDate(frozenMs)
      }
      static now() { return frozenMs }
      static parse(...a) { return OriginalDate.parse(...a) }
      static UTC(...a) { return OriginalDate.UTC(...a) }
    }
    dateFrozen = true
  }

  // ─── inputTransform: transform inputs before calling entry ──────────────
  // Supported transforms:
  //   "str"              — convert each input to String
  //   "hex_to_bytes"     — convert hex string to Buffer
  //   "list_to_bytes"    — convert array of ints to Buffer
  //   "module.fn"        — import module and apply fn to each input
  function applyInputTransform(inputVal, transform) {
    if (!transform) return inputVal
    if (transform === 'str') {
      if (Array.isArray(inputVal)) return inputVal.map(v => String(v))
      return String(inputVal)
    }
    if (transform === 'hex_to_bytes') {
      if (typeof inputVal === 'string') return Buffer.from(inputVal, 'hex')
      if (Array.isArray(inputVal)) return inputVal.map(v => typeof v === 'string' ? Buffer.from(v, 'hex') : v)
      return inputVal
    }
    if (transform === 'list_to_bytes') {
      if (Array.isArray(inputVal) && inputVal.every(v => typeof v === 'number')) return Buffer.from(inputVal)
      if (Array.isArray(inputVal)) return inputVal.map(v => Array.isArray(v) && v.every(x => typeof x === 'number') ? Buffer.from(v) : v)
      return inputVal
    }
    // Custom "module.fn" — will be resolved lazily on first use
    if (transform.includes('.')) {
      return { __inputTransformModule: transform, __value: inputVal }
    }
    return inputVal
  }

  // Lazy resolver for custom inputTransform modules
  let _customInputTransformFn = null
  let _customInputTransformLoaded = false
  async function resolveCustomInputTransform(transform) {
    if (_customInputTransformLoaded) return _customInputTransformFn
    _customInputTransformLoaded = true
    const lastDot = transform.lastIndexOf('.')
    const modPath = transform.slice(0, lastDot)
    const fnName = transform.slice(lastDot + 1)
    try {
      const mod = await import(resolve(process.cwd(), modPath))
      _customInputTransformFn = mod[fnName] ?? mod.default?.[fnName]
      if (typeof _customInputTransformFn !== 'function') {
        throw new Error(`inputTransform '${transform}': '${fnName}' is not a function`)
      }
    } catch (e) {
      throw new Error(`Cannot resolve inputTransform '${transform}': ${e.message}`)
    }
    return _customInputTransformFn
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
  const sideEffectRestores = []  // original methods to restore after capture (declared outside try for finally access)
  // Phase 2: callee-wrapping state — declared outside `try` so the `finally`
  // block can call cleanupCallees() even if the try body threw before the
  // wrapCallees() call ran. Default is a no-op.
  let cleanupCallees = () => {}

  // ESM bare-name transformation: when a cluster declares `callees` AND the
  // target file is ESM, we transform the source in-memory so internal calls
  // route through a mutable `__regretsHolder` object that wrapCallees can
  // reassign. The transformed source is loaded via a temp file in the SAME
  // directory as the original (so relative imports resolve unchanged). The
  // temp file is deleted in the finally block below — the original file is
  // never modified.
  //
  // `esmTransformTempPath` is declared outside `try` so the finally block
  // can clean it up even if the body throws partway through. Null means
  // no temp file was created (CJS module, or transformation aborted).
  let esmTransformTempPath = null

  try {
    // Dynamic import of target module
    // When isolateGlobals is true, we use cache-busting (timestamp query param)
    // to get a fresh module instance per import, preventing shared mutable state
    // from leaking between input runs.
    const absPath = resolve(process.cwd(), file)
    const fileExt = extname(absPath).toLowerCase()

    // ─── ESM bare-name callee transformation (Approach A) ─────────────────
    //
    // Only attempt transformation when ALL of the following hold:
    //   1. The cluster declares callees (otherwise there's nothing to wrap).
    //   2. The file extension is one we support (.mjs, .js, .ts, .tsx).
    //   3. The source is ESM (not CJS — CJS wrapping already works).
    //   4. transformEsmForCallees returns a non-null result. The transformer
    //      aborts on shadowing, parse errors, missing function declarations,
    //      or any other safety concern — in which case we fall back to the
    //      original import and let wrapCallees emit the actionable warning
    //      (Approach B).
    //
    // The transformation rewrites internal call sites to go through
    // `__regretsHolder`, populates the holder with the original function
    // references, and exports the holder. wrapCallees detects the holder on
    // the imported module and reassigns on it instead of the frozen namespace.
    let moduleUrl = pathToFileURL(absPath).href
    if (Array.isArray(callees) && callees.length > 0 &&
        ['.mjs', '.js', '.ts', '.tsx'].includes(fileExt)) {
      try {
        const source = readFileSync(absPath, 'utf8')
        if (isEsmSource(source, fileExt)) {
          const transformResult = await transformEsmForCallees(source, callees, fileExt)
          if (transformResult) {
            // Write transformed source to a temp file in the SAME directory
            // as the original so relative imports resolve unchanged. The temp
            // file is deleted in the finally block below.
            const dir = dirname(absPath)
            const tempName = `.regrets-transform-${id}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.mjs`
            esmTransformTempPath = join(dir, tempName)
            writeFileSync(esmTransformTempPath, transformResult.transformedSource, 'utf8')
            moduleUrl = pathToFileURL(esmTransformTempPath).href
            if (!quiet) {
              console.log(`   🔄 ESM bare-name transform applied (callees: ${callees.join(', ')})`)
              if (verbose) {
                console.log(`   │ Temp file: ${esmTransformTempPath}`)
              }
            }
          } else if (verbose && !quiet) {
            console.log(`   ℹ️  ESM transform aborted (safety check) — falling back to original import`)
          }
        }
      } catch (transformErr) {
        // Any error during transformation is non-fatal — fall back to
        // importing the original file. wrapCallees will emit the warning.
        if (!quiet) {
          console.warn(`   ⚠️  ESM transform failed: ${transformErr.message} — falling back to original import`)
        }
      }
    }

    if (isolateGlobals) {
      // Add cache-busting query param to force a fresh module parse
      moduleUrl += `?_t=${Date.now()}`
    }
    let rawModule
    try {
      rawModule = await import(moduleUrl)
    } catch (err) {
      if (err.code === 'ERR_MODULE_NOT_FOUND' || err.code === 'ENOENT') {
        throw new Error(`Cluster file not found at ${file} (resolved: ${absPath}). Compile the project or fix the 'file' field in manifest.json.`)
      }
      throw new Error(`Failed to import ${file}: ${err.message}`)
    }

    // Handle CJS modules — merge default exports for consistent access
    rawModule = mergeCjsModule(rawModule)

    // ─── detectMode: auto-infer execution mode from module structure ────────
    // When detectMode: true is set in manifest, inspect rawModule to infer
    // the execution mode. This helps agents who are unsure which mode to use.
    // If classMethod/singletonMethod/storeDispatch are already set, skip inference.
    if (detectMode && !classMethod && !singletonMethod && !storeDispatch) {
      const entryExport = rawModule[entry] ?? rawModule.default?.[entry]
      const defaultExport = rawModule.default

      if (entryExport && typeof entryExport === 'function') {
        // Check if it's a class (has prototype with methods)
        const proto = entryExport.prototype
        const hasMethods = proto && Object.getOwnPropertyNames(proto).some(
          name => name !== 'constructor' && typeof proto[name] === 'function'
        )
        if (hasMethods) {
          // It's a class — suggest classMethod mode
          const methodNames = Object.getOwnPropertyNames(proto)
            .filter(name => name !== 'constructor' && typeof proto[name] === 'function')
          console.log(`   ℹ️  Auto-detected mode: class-based (entry "${entry}" is a class)`)
          console.log(`      Suggested: add "classMethod": "${methodNames[0]}" to manifest`)
          console.log(`      Available methods: ${methodNames.join(', ')}`)
        } else {
          // It's a plain function
          console.log(`   ℹ️  Auto-detected mode: function-based (entry "${entry}" is a function)`)
        }
      } else if (!entryExport && defaultExport && typeof defaultExport === 'object') {
        // Entry not found at top level but default export has methods — likely a singleton
        const defaultMethods = Object.entries(defaultExport)
          .filter(([, v]) => typeof v === 'function')
          .map(([k]) => k)
        if (defaultMethods.length > 0) {
          console.log(`   ℹ️  Auto-detected mode: singleton (default export has methods)`)
          console.log(`      Suggested: add "singletonMethod": "${defaultMethods[0]}" to manifest`)
          console.log(`      Available methods: ${defaultMethods.join(', ')}`)
        } else if (defaultExport[entry] && typeof defaultExport[entry] === 'function') {
          console.log(`   ℹ️  Auto-detected mode: function-based (default.${entry} is a function)`)
        } else {
          console.log(`   ℹ️  Auto-detected mode: unable to infer — entry "${entry}" not found in module or default export`)
        }
      } else if (entryExport && typeof entryExport === 'object' && entryExport !== null) {
        // Entry is an object — likely a singleton or store
        const objMethods = Object.entries(entryExport)
          .filter(([, v]) => typeof v === 'function')
          .map(([k]) => k)
        if (entryExport.dispatch && (entryExport.getState || entryExport.value !== undefined || entryExport.setState)) {
          console.log(`   ℹ️  Auto-detected mode: store dispatch (entry "${entry}" looks like a store)`)
          console.log(`      Suggested: add "storeDispatch": { "store": "${entry}", "action": "ACTION_TYPE" } to manifest`)
        } else if (objMethods.length > 0) {
          console.log(`   ℹ️  Auto-detected mode: singleton (entry "${entry}" is an object with methods)`)
          console.log(`      Suggested: add "singletonMethod": "${objMethods[0]}" to manifest`)
          console.log(`      Available methods: ${objMethods.join(', ')}`)
        } else {
          console.log(`   ℹ️  Auto-detected mode: unable to infer — entry "${entry}" is an object but has no callable methods`)
        }
      } else {
        console.log(`   ℹ️  Auto-detected mode: unable to infer — entry "${entry}" not found in module`)
      }
    }

    const recorder = []
    const ghostModule = createGhost(rawModule, watches, recorder, instanceMethods)

    // ─── Phase 2: callee wrapping (opt-in via "callees": [...] in manifest) ────
    // When a cluster declares `callees`, we wrap each named function on the
    // raw module so that every call made from inside the entry function
    // records its args + result (or thrown error) into `calleeRecorder`.
    // After all inputs run, each callee that was actually called gets its
    // own `.regret` file at `<parentClusterId>.calls.<calleeName>.regret`,
    // forming a separate behavioral contract for that callee.
    //
    // Backward compatibility: when `callees` is absent or empty, the
    // wrapCallees call is a no-op (it accepts `[]` defensively) and no
    // callee `.regret` files are written. Behavior is identical to the
    // pre-Phase-2 Ghost Proxy.
    const calleeRecorder = []
    if (Array.isArray(callees) && callees.length > 0) {
      cleanupCallees = wrapCallees(rawModule, callees, calleeRecorder, {
        parentClusterId: id,
        quiet,
      })
      if (!quiet) {
        console.log(`   Callees: ${callees.join(', ')}`)
      }
    }

    // ─── sideEffectWatches: wrap side-effect methods with Proxy recorder ──────
    // Records calls to methods on objects resolved from rawModule by dot-notation
    // path (e.g., "db.insert" → rawModule.db.insert). The recording is used to
    // compute a side-effect fingerprint that is merged into the main fingerprint,
    // ensuring that behavioral changes (e.g., dropped email sends) are detected
    // even when the return value is identical.
    const sideEffectRecorder = []

    for (const sePath of sideEffectWatches) {
      const parts = sePath.split('.')
      if (parts.length > 2) {
        console.warn(`  ⚠️  sideEffectWatch "${sePath}" has >2 levels — only 2-level paths supported in v1, skipping`)
        continue
      }
      const [objName, methodName] = parts
      const parentObj = rawModule[objName]
      if (!parentObj || typeof parentObj !== 'object') {
        console.warn(`  ⚠️  sideEffectWatch "${sePath}": object "${objName}" not found in module — skipping`)
        continue
      }
      if (methodName) {
        // "db.insert" — wrap method on object
        const original = parentObj[methodName]
        if (typeof original !== 'function') {
          console.warn(`  ⚠️  sideEffectWatch "${sePath}": "${methodName}" is not a function on "${objName}" — skipping`)
          continue
        }
        sideEffectRestores.push({ obj: parentObj, key: methodName, original })
        parentObj[methodName] = new Proxy(original, {
          apply(target, thisArg, args) {
            let result
            try {
              result = target.apply(thisArg, args)
            } catch (err) {
              sideEffectRecorder.push({ fn: sePath, args: deepClone(args), error: String(err) })
              throw err
            }
            if (result && typeof result.then === 'function') {
              return result.then(resolved => {
                sideEffectRecorder.push({ fn: sePath, args: deepClone(args), result: deepClone(resolved) })
                return resolved
              }).catch(err => {
                sideEffectRecorder.push({ fn: sePath, args: deepClone(args), error: String(err) })
                throw err
              })
            }
            sideEffectRecorder.push({ fn: sePath, args: deepClone(args), result: deepClone(result) })
            return result
          }
        })
      } else {
        // Single name — wrap a top-level function export
        const original = rawModule[objName]
        if (typeof original !== 'function') {
          console.warn(`  ⚠️  sideEffectWatch "${sePath}": "${objName}" is not a function — skipping`)
          continue
        }
        sideEffectRestores.push({ obj: rawModule, key: objName, original })
        rawModule[objName] = new Proxy(original, {
          apply(target, thisArg, args) {
            let result
            try {
              result = target.apply(thisArg, args)
            } catch (err) {
              sideEffectRecorder.push({ fn: sePath, args: deepClone(args), error: String(err) })
              throw err
            }
            if (result && typeof result.then === 'function') {
              return result.then(resolved => {
                sideEffectRecorder.push({ fn: sePath, args: deepClone(args), result: deepClone(resolved) })
                return resolved
              }).catch(err => {
                sideEffectRecorder.push({ fn: sePath, args: deepClone(args), error: String(err) })
                throw err
              })
            }
            sideEffectRecorder.push({ fn: sePath, args: deepClone(args), result: deepClone(result) })
            return result
          }
        })
      }
    }

    if (sideEffectWatches.length > 0 && !quiet) {
      console.log(`   Side effects: ${sideEffectWatches.join(', ')}`)
    }

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

    // ─── expectThrow helper ─────────────────────────────────────────────────
    // Input with { __expectThrow: true, value: ... } means the function MUST throw.
    // The `value` field is the actual argument sent to the function.
    // On throw, we fingerprint { type: error.constructor.name, message } instead
    // of normal output, and store it as ERROR_CONTRACT in the .regret file.
    function isExpectThrow(inp) {
      return inp && typeof inp === 'object' && inp.__expectThrow === true
    }
    function extractInputValue(inp) {
      return isExpectThrow(inp) ? inp.value : inp
    }
    function normalizeErrorMessage(msg, normalizeRules) {
      if (typeof msg !== 'string') return String(msg)
      let m = msg
      // Strip stack trace (everything after first newline)
      m = m.split('\n')[0]
      // Apply existing normalize rules for non-deterministic values
      if (normalizeRules.includes('timestamps'))  m = m.replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z?/g, '<timestamp>')
      if (normalizeRules.includes('uuids'))        m = m.replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '<uuid>')
      if (normalizeRules.includes('epochs'))        m = m.replace(/\b\d{10,13}\b/g, '<epoch>')
      // Strip file paths and line numbers (common in Node error messages)
      m = m.replace(/\s*\(.+:\d+:\d+\)/g, '')
      m = m.replace(/\s+at .+$/s, '')
      return m.trim()
    }
    function buildErrorContract(err) {
      return {
        type: err.constructor?.name || 'Error',
        message: normalizeErrorMessage(err.message, normalize),
      }
    }

    // ─── Helper: reduce call sequence to { fn, count } pairs (sorted by fn) ──
    // Used by fingerprintLevel: "calls" — tracks WHO was called and HOW MANY
    // times, without recording args or results per call.
    function reduceToCallCounts(recorder) {
      const counts = {}
      for (const call of recorder) {
        counts[call.fn] = (counts[call.fn] || 0) + 1
      }
      return Object.entries(counts)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([fn, count]) => ({ fn, count }))
    }

    // ─── Fallback: "calls" with empty watches → "entry" ─────────────────────
    // When there are no watched functions, call counts would always be empty,
    // making the fingerprint meaningless. Fall back to entry-level fingerprinting.
    let effectiveFingerprintLevel = fingerprintLevel
    if (fingerprintLevel === 'calls' && (!watches || watches.length === 0)) {
      if (!quiet) {
        console.warn(`   ⚠️  fingerprintLevel: "calls" but watches is empty — falling back to "entry"`)
        console.warn(`      Call counts require watched functions. Add watches or use fingerprintLevel: "entry".`)
      }
      effectiveFingerprintLevel = 'entry'
    }

    // ─── Helper: compute fingerprint with full config ──────────────────────
    const fpConfig = { normalize, ignoreFields, ignorePaths }

    /**
     * Compute a side-effect signature from the sideEffectRecorder.
     * Returns a stable-stringifiable object: { sideEffects: [...sortedCalls] }
     * Each call is { fn, args (normalized), callIndex }.
     * If sideEffectRecorder is empty, returns null (no side effects to fingerprint).
     */
    function computeSideEffectSignature(seRecorder) {
      if (!seRecorder || seRecorder.length === 0) return null
      const normalized = seRecorder.map((call, idx) => ({
        fn: call.fn,
        args: stripFields(fpNormalize(deepClone(call.args), normalize), ignoreFields, ignorePaths),
        callIndex: idx,
      }))
      // Sort by fn then callIndex for deterministic ordering
      normalized.sort((a, b) => a.fn.localeCompare(b.fn) || a.callIndex - b.callIndex)
      return { sideEffects: normalized }
    }

    /**
     * Merge side-effect signature into the output for fingerprint computation.
     * If sideEffectSignature is null, returns output unchanged (backward compatible).
     * If present, returns { output, sideEffectSignature } — the fingerprint function
     * will see both the return value and the side-effect behavioral contract.
     */
    function mergeSideEffectsIntoOutput(outputVal, seSignature) {
      if (!seSignature) return outputVal
      return { output: outputVal, sideEffects: seSignature.sideEffects }
    }

    /**
     * Merge side-effect signature into output for fingerprint computation.
     * When sideEffectWatches is configured and side effects were recorded,
     * the output is wrapped: { output, sideEffects: [...] } so that the
     * fingerprint captures both the return value AND the behavioral contract.
     * If no side effects are recorded, output is returned unchanged (backward compatible).
     */
    function maybeMergeSideEffects(outputVal) {
      const seSig = computeSideEffectSignature(sideEffectRecorder)
      return seSig ? mergeSideEffectsIntoOutput(outputVal, seSig) : outputVal
    }

    function computeFp(fpInput, output, recorder, fingerprintLevel, fingerprintMode, valuePaths, output_schema) {
      // Merge side-effect signature into output if sideEffectWatches is configured
      const seSig = computeSideEffectSignature(sideEffectRecorder)
      const effectiveOutput = seSig ? mergeSideEffectsIntoOutput(output, seSig) : output

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
      } else if (fingerprintLevel === 'calls') {
        const callCounts = reduceToCallCounts(recorder)
        return fingerprint(fpInput, callCounts, fpConfig)
      } else {
        return fingerprintLevel === 'entry'
          ? fingerprint(fpInput, effectiveOutput, fpConfig)
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
        sideEffectRecorder.length = 0
        calleeRecorder.length = 0  // Phase 2: clear callee recordings between runs

        // Reset to initialState if provided
        if (initialState) {
          if (storeType === 'dispatching') {
            if (typeof storeExport.subject?.next === 'function') {
              storeExport.subject.next(deepClone(initialState))
            } else {
              if (!quiet) console.warn(`   ⚠️  Cannot reset DispatchingStore — no accessible subject. State may be dirty.`)
            }
          } else if (storeType === 'redux') {
            if (!quiet) console.warn(`   ⚠️  initialState reset not supported for Redux stores. State may be dirty.`)
          } else if (storeType === 'zustand') {
            storeExport.setState(deepClone(initialState), true /* replace */)
          }
        }

        const inputForRecord = deepClone(input)
        const actualInput = extractInputValue(input)
        const inputForArgs = deepClone(actualInput)
        const expectThrow = isExpectThrow(input)

        // ─── expectThrow: catch error from dispatch ──────────────────────
        if (expectThrow) {
          let caughtError = null
          try {
            if (storeType === 'redux') {
              dispatchFn({ type: storeDispatch.action, payload: inputForArgs })
            } else if (storeType === 'dispatching') {
              dispatchFn(storeDispatch.action, inputForArgs)
            } else if (storeType === 'zustand') {
              dispatchFn(inputForArgs)
            }
          } catch (err) {
            caughtError = err
          }
          if (!caughtError) {
            throw new Error(`expectThrow: dispatch did not throw for input ${JSON.stringify(actualInput)}`)
          }
          const errorContract = buildErrorContract(caughtError)
          const fp = fingerprint(inputForRecord, errorContract, fpConfig)
          if (!quiet) console.log(`   ⚡ expectThrow: caught ${errorContract.type}: ${errorContract.message}`)
          results.push({ input: inputForRecord, output: null, threw: true, error: errorContract, fp, calls: [...recorder], sideEffects: [...sideEffectRecorder] })
          continue
        }

        // Dispatch the action (normal path)
        if (storeType === 'redux') {
          dispatchFn({ type: storeDispatch.action, payload: inputForArgs })
        } else if (storeType === 'dispatching') {
          dispatchFn(storeDispatch.action, inputForArgs)
        } else if (storeType === 'zustand') {
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
        } else if (effectiveFingerprintLevel === 'calls') {
          const callCounts = reduceToCallCounts(recorder)
          fp = fingerprint(fpInput, callCounts, fpConfig)
        } else {
          fp = fingerprintLevel === 'entry'
            ? fingerprint(fpInput, maybeMergeSideEffects(output), fpConfig)
            : fingerprintSequence(recorder, fpConfig)
        }

        results.push({ input: inputForRecord, output, fp, calls: [...recorder], sideEffects: [...sideEffectRecorder] })
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
        sideEffectRecorder.length = 0
        calleeRecorder.length = 0  // Phase 2: clear callee recordings between runs
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
        const actualInput = extractInputValue(input)
        const inputForArgs = deepClone(actualInput)
        const expectThrow = isExpectThrow(input)
        const args_ = cluster.multiArgs && Array.isArray(inputForArgs) ? [...inputForArgs] : [inputForArgs]

        // ─── expectThrow: catch error from method call ──────────────────────
        if (expectThrow) {
          let caughtError = null
          try {
            await instance[classMethod](...args_)
          } catch (err) {
            caughtError = err
          }
          if (!caughtError) {
            throw new Error(`expectThrow: method did not throw for input ${JSON.stringify(actualInput)}`)
          }
          const errorContract = buildErrorContract(caughtError)
          const fp = fingerprint(inputForRecord, errorContract, fpConfig)
          if (!quiet) console.log(`   ⚡ expectThrow: caught ${errorContract.type}: ${errorContract.message}`)
          results.push({ input: inputForRecord, output: null, threw: true, error: errorContract, fp, calls: [...recorder], sideEffects: [...sideEffectRecorder] })
          continue
        }

        // Normal path: call the target method
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
        } else if (effectiveFingerprintLevel === 'calls') {
          const callCounts = reduceToCallCounts(recorder)
          fp = fingerprint(fpInput, callCounts, { normalize, ignoreFields })
        } else {
          fp = fingerprintLevel === 'entry'
            ? fingerprint(fpInput, maybeMergeSideEffects(output), { normalize, ignoreFields })
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
          // Compute mutation fingerprint for validate.js to compare against
          resultEntry.mutationFingerprint = fingerprint(inputBefore, inputAfterCall, { normalize, ignoreFields })
          resultEntry.mutationBefore = inputBefore
          resultEntry.mutationAfter = inputAfterCall
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
        sideEffectRecorder.length = 0
        calleeRecorder.length = 0  // Phase 2: clear callee recordings between runs
        const inputForRecord = deepClone(input)
        const actualInput = extractInputValue(input)
        const inputForArgs = deepClone(actualInput)
        const expectThrow = isExpectThrow(input)
        const args_ = cluster.multiArgs && Array.isArray(inputForArgs) ? [...inputForArgs] : [inputForArgs]

        // ─── expectThrow: catch error from singleton method ────────────────
        if (expectThrow) {
          let caughtError = null
          try {
            await singleton[singletonMethod](...args_)
          } catch (err) {
            caughtError = err
          }
          if (!caughtError) {
            throw new Error(`expectThrow: singleton method did not throw for input ${JSON.stringify(actualInput)}`)
          }
          const errorContract = buildErrorContract(caughtError)
          const fp = fingerprint(inputForRecord, errorContract, fpConfig)
          if (!quiet) console.log(`   ⚡ expectThrow: caught ${errorContract.type}: ${errorContract.message}`)
          results.push({ input: inputForRecord, output: null, threw: true, error: errorContract, fp, calls: [...recorder], sideEffects: [...sideEffectRecorder] })
          continue
        }

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
        } else if (effectiveFingerprintLevel === 'calls') {
          const callCounts = reduceToCallCounts(recorder)
          fp = fingerprint(fpInput, callCounts, fpConfig)
        } else {
          fp = fingerprintLevel === 'entry'
            ? fingerprint(fpInput, maybeMergeSideEffects(output), fpConfig)
            : fingerprintSequence(recorder, fpConfig)
        }

        results.push({ input: inputForRecord, output, fp, calls: [...recorder], sideEffects: [...sideEffectRecorder] })
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
        recorder.length = 0
        sideEffectRecorder.length = 0  // clear between runs
        calleeRecorder.length = 0  // Phase 2: clear callee recordings between runs

        // ─── isolateGlobals: re-import module with cache-busting for fresh state ──
        // When isolateGlobals is true, re-import the module before each input run
        // to get a fresh instance without any accumulated mutable global state.
        //
        // ESM-transform note: if we transformed the source (esmTransformTempPath
        // is set), re-import the temp file too. The temp file is still on disk
        // at this point (it's only deleted in the finally block). The fresh
        // module will have its own `__regretsHolder` — but wrapCallees (called
        // once before the loop) only wraps the FIRST rawModule. For isolateGlobals
        // + ESM-transform, callee wrapping currently only intercepts the first
        // run; subsequent runs use the fresh module without callee proxies.
        // This is an accepted limitation — isolateGlobals + callees is a rare
        // combination. The capture still works (parent contract is captured),
        // just callee recordings may be empty on runs > 1.
        if (isolateGlobals) {
          const reimportBase = esmTransformTempPath
            ? pathToFileURL(esmTransformTempPath).href
            : pathToFileURL(absPath).href
          const reimportUrl = reimportBase + `?_t=${Date.now()}`
          const freshModule = await import(reimportUrl)
          const freshMerged = mergeCjsModule(freshModule)
          // Re-create ghost proxy with fresh module
          const freshGhost = createGhost(freshMerged, watches, recorder, instanceMethods)
          // Re-resolve entry function from fresh module
          if (!adapter) {
            const freshEntryFn = freshGhost[entry]
              ?? freshMerged[entry]
              ?? freshMerged.default?.[entry]
              ?? ((entry === 'default' || entry === 'module.exports') && typeof freshMerged.default === 'function' ? freshMerged.default : null)
            if (typeof freshEntryFn === 'function') {
              entryFn = freshEntryFn
            }
          }
          // Re-assign sideEffectWatches proxies on fresh module
          for (const sePath of sideEffectWatches) {
            const parts = sePath.split('.')
            if (parts.length === 2) {
              const [objName, methodName] = parts
              const parentObj = freshMerged[objName]
              if (parentObj && typeof parentObj === 'object' && typeof parentObj[methodName] === 'function') {
                parentObj[methodName] = new Proxy(parentObj[methodName], {
                  apply(target, thisArg, args) {
                    let result
                    try { result = target.apply(thisArg, args) } catch (err) {
                      sideEffectRecorder.push({ fn: sePath, args: deepClone(args), error: String(err) })
                      throw err
                    }
                    if (result && typeof result.then === 'function') {
                      return result.then(resolved => {
                        sideEffectRecorder.push({ fn: sePath, args: deepClone(args), result: deepClone(resolved) })
                        return resolved
                      }).catch(err => {
                        sideEffectRecorder.push({ fn: sePath, args: deepClone(args), error: String(err) })
                        throw err
                      })
                    }
                    sideEffectRecorder.push({ fn: sePath, args: deepClone(args), result: deepClone(result) })
                    return result
                  }
                })
              }
            }
          }
        }

        // ─── resetState: reset module-level mutable state before each run ─────
        if (resetState) {
          const resetFn = rawModule[resetState] ?? rawModule.default?.[resetState]
          if (typeof resetFn === 'function') {
            resetFn()
          } else {
            if (!quiet) console.warn(`   ⚠️  resetState function "${resetState}" not found in ${file}`)
          }
        }

        // ─── expectThrow: extract actual input value from { __expectThrow, value } ──
        const inputForRecord = deepCloneInput ? deepClone(input) : input
        const actualInput = extractInputValue(input)
        const inputForArgs = deepCloneInput ? deepClone(actualInput) : actualInput
        const expectThrow = isExpectThrow(input)

        // ─── inputTransform: apply transform before calling entry ────────────
        let transformedInputForArgs = inputForArgs
        if (inputTransform) {
          // Check for lazy custom module transform
          const lazyResult = applyInputTransform(inputForArgs, inputTransform)
          if (lazyResult && typeof lazyResult === 'object' && lazyResult.__inputTransformModule) {
            // Custom "module.fn" transform — resolve and apply
            const fn = await resolveCustomInputTransform(lazyResult.__inputTransformModule)
            transformedInputForArgs = fn(lazyResult.__value)
          } else {
            transformedInputForArgs = lazyResult
          }
        }

        const args_ = cluster.multiArgs && Array.isArray(transformedInputForArgs) ? [...transformedInputForArgs] : [transformedInputForArgs]

        // ─── expectThrow: catch error and build error contract ──────────────
        if (expectThrow) {
          let caughtError = null
          try {
            await entryFn(...args_)
          } catch (err) {
            caughtError = err
          }
          if (!caughtError) {
            throw new Error(`expectThrow: function did not throw for input ${JSON.stringify(actualInput)}`)
          }
          const errorContract = buildErrorContract(caughtError)
          const fpInput = inputForRecord
          const fp = fingerprint(fpInput, errorContract, fpConfig)
          if (!quiet) {
            console.log(`   ⚡ expectThrow: caught ${errorContract.type}: ${errorContract.message}`)
          }
          results.push({ input: inputForRecord, output: null, threw: true, error: errorContract, fp, calls: [...recorder], sideEffects: [...sideEffectRecorder] })
          continue
        }

        // ─── Normal (non-expectThrow) path ──────────────────────────────────
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
        } else if (effectiveFingerprintLevel === 'calls') {
          const callCounts = reduceToCallCounts(recorder)
          fp = fingerprint(fpInput, callCounts, fpConfig)
        } else {
          fp = fingerprintLevel === 'entry'
            ? fingerprint(fpInput, maybeMergeSideEffects(output), fpConfig)
            : fingerprintSequence(recorder, fpConfig)
        }

        results.push({ input: inputForRecord, output, fp, calls: [...recorder], sideEffects: [...sideEffectRecorder] })

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
          // Compute mutation fingerprint for validate.js to compare against
          lastResult.mutationFingerprint = fingerprint(inputBefore, inputAfterCall, { normalize, ignoreFields })
          lastResult.mutationBefore = inputBefore
          lastResult.mutationAfter = inputAfterCall
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
      if (fingerprintLevel === 'entry' || effectiveFingerprintLevel === 'entry') {
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

    // Warn when fingerprintLevel is 'watched', 'full', or 'calls' but no calls were recorded.
    // This commonly happens with class-based APIs where constructors are called
    // with `new` but the Ghost Proxy lacks a `construct` trap, or where
    // instance methods are not proxied.
    if (fingerprintLevel === 'watched' || fingerprintLevel === 'full' || fingerprintLevel === 'calls') {
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
    const golden = results[0]
    const { input, output, fp } = golden
    const threw = golden.threw ?? false
    const errorContract = golden.error ?? null
    // Extract mutation data for .regret file (trackMutation support)
    const mutationFingerprint = golden.mutationFingerprint ?? null
    const mutationBefore = golden.mutationBefore
    const mutationAfter = golden.mutationAfter

    // Extract side effect data for .regret file
    const goldenSideEffects = golden.sideEffects ?? []
    const sideEffectSignature = goldenSideEffects.length > 0
      ? computeSideEffectSignature(goldenSideEffects)
      : null

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
      mutationFingerprint ? `mutationFingerprint: ${mutationFingerprint}` : null,
      outputEncoding ? `outputEncoding: ${outputEncoding}` : null,
      resetState ? `resetState: ${resetState}` : null,
      !deepCloneInput ? `deepCloneInput: false` : null,
      seed != null ? `seed: ${seed}` : null,
      freezeTime ? `freezeTime: ${freezeTime}` : null,
      inputTransform ? `inputTransform: ${inputTransform}` : null,
      isolateGlobals ? `isolateGlobals: true` : null,
      callees.length ? `callees: [${callees.map(c => `"${c}"`).join(', ')}]` : null,
      threw ? `expectThrow: true` : null,
      sideEffectWatches.length ? `sideEffectWatches: [${sideEffectWatches.map(s => `"${s}"`).join(', ')}]` : null,
      `env: ${JSON.stringify(getEnvSnapshot())}`,
      `---`,
      `INPUT  ${JSON.stringify(input ?? null)}`,
      threw
        ? `ERROR_CONTRACT ${JSON.stringify(errorContract)}`
        : `OUTPUT ${JSON.stringify(outputForFile ?? null)}`,
      `HASH   ${fp}`,
      goldenSideEffects.length > 0 ? `SIDE_EFFECTS ${JSON.stringify(sideEffectSignature)}` : null,
      mutationBefore !== undefined ? `MUTATION_BEFORE ${JSON.stringify(mutationBefore)}` : null,
      mutationAfter !== undefined ? `MUTATION_AFTER ${JSON.stringify(mutationAfter)}` : null,
    ].filter(Boolean).join('\n')

    const _lock = acquireLock(regretPath)
    try {
      writeFileSync(regretPath, content, 'utf8')
    } finally {
      releaseLock(_lock)
    }

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
        if (r.sideEffects?.length) {
          console.log(`   │ Side effect calls (${r.sideEffects.length}):`)
          for (const se of r.sideEffects) {
            const argsStr = JSON.stringify(se.args)?.slice(0, 80)
            console.log(`   │   → ${se.fn}(${argsStr}${argsStr?.length >= 80 ? '…' : ''})`)
          }
        }
        console.log(`   └────────────────────────────────────────────`)
      }
    }

    // ─── Phase 2: write callee `.regret` files for each wrapped callee ──────
    // For each callee that was actually called during any input run, we
    // emit a separate `.regret` file at
    //   regrets/<parentClusterId>.calls.<calleeName>.regret
    //
    // The "golden" entry for each callee is the FIRST recorded call of
    // that callee (matching the parent cluster's `golden = results[0]`
    // convention). The file format mirrors the parent `.regret` so that
    // existing tooling (validate.js diff, list, etc.) can parse it.
    //
    // If a declared callee was never called (e.g., the entry function's
    // branch didn't reach it for any input), we emit a warning instead of
    // an empty `.regret` file.
    if (Array.isArray(callees) && callees.length > 0) {
      // Group all callee recordings by function name. Each declared callee
      // may have been called multiple times across multiple inputs — we
      // only need the first call for the golden contract.
      const callsByCallee = new Map()
      for (const rec of calleeRecorder) {
        if (!callsByCallee.has(rec.fn)) callsByCallee.set(rec.fn, rec)
      }

      for (const calleeName of callees) {
        if (typeof calleeName !== 'string' || calleeName.length === 0) continue
        const goldenCall = callsByCallee.get(calleeName)
        if (!goldenCall) {
          if (!quiet) {
            console.warn(`   ⚠️  Callee "${calleeName}" was declared but never called during capture — no contract written (cluster: ${id})`)
          }
          continue
        }

        const calleeClusterId = `${id}.calls.${calleeName}`
        const calleeRegretPath = join(outDir, `${calleeClusterId}.regret`)
        const calleeTimestamp = new Date().toISOString()

        // Callee fingerprint: hash of (args, result) or (args, error).
        // We use the same fingerprint() function as the parent cluster so
        // hash semantics are consistent across parent and callee contracts.
        const calleeFpInput = goldenCall.args
        const calleeFpOutput = goldenCall.error != null
          ? { __error: goldenCall.error }
          : (goldenCall.result ?? null)
        const calleeFp = fingerprint(calleeFpInput, calleeFpOutput, fpConfig)

        const calleeContent = [
          `cluster: ${calleeClusterId}`,
          `version: 1`,
          `fingerprint: ${calleeFp}`,
          `captured: ${calleeTimestamp}`,
          `parent: ${id}`,
          `callee: ${calleeName}`,
          `entry: ${calleeName}`,
          `stack: ${stack ?? 'js'}`,
          `fingerprintLevel: entry`,
          goldenCall.construct ? `construct: true` : null,
          goldenCall.error != null ? `threw: true` : null,
          `env: ${JSON.stringify(getEnvSnapshot())}`,
          `---`,
          `INPUT  ${JSON.stringify(goldenCall.args ?? null)}`,
          goldenCall.error != null
            ? `ERROR_CONTRACT ${JSON.stringify({ type: 'Error', message: goldenCall.error })}`
            : `OUTPUT ${JSON.stringify(goldenCall.result ?? null)}`,
          `HASH   ${calleeFp}`,
        ].filter(Boolean).join('\n')

        const _calleeLock = acquireLock(calleeRegretPath)
        try {
          writeFileSync(calleeRegretPath, calleeContent, 'utf8')
        } finally {
          releaseLock(_calleeLock)
        }

        if (!quiet) {
          console.log(`   📄 Saved: regrets/${calleeClusterId}.regret (callee fingerprint: ${calleeFp})`)
        }
      }
    }

    passed++

  } catch (err) {
    if (!quiet) console.error(`   ❌ Capture failed: ${err.message}`)
    if (verbose) console.error(`   Stack: ${err.stack}`)
    failed++
  } finally {
    // Restore original Date if we froze it
    if (dateFrozen) {
      globalThis.Date = OriginalDate
    }
    // Restore original Math.random if we seeded it
    if (seed != null) Math.random = origRandom
    // Restore original crypto API if we overrode it
    if (seed != null && cryptoAvailable) {
      if (origRandomUUID != null) globalThis.crypto.randomUUID = origRandomUUID
      if (origGetRandomValues != null) globalThis.crypto.getRandomValues = origGetRandomValues
    }
    // Restore original side-effect-watched methods
    for (const { obj, key, original } of sideEffectRestores) {
      obj[key] = original
    }
    // Phase 2: restore original callee functions (idempotent — safe even
    // if wrapCallees was never invoked, because cleanupCallees defaults to a no-op).
    cleanupCallees()
    // ESM bare-name transform: delete the temp file (if any) that held the
    // transformed source. Best-effort — if deletion fails (rare race with
    // another process), log and continue. The temp file is hidden (starts
    // with `.`) and its name includes a timestamp + random suffix, so even
    // if it leaks it's easy to identify and clean up.
    if (esmTransformTempPath) {
      try {
        unlinkSync(esmTransformTempPath)
      } catch (e) {
        if (e.code !== 'ENOENT' && !quiet) {
          // Don't fail the capture if temp file cleanup fails — just warn.
          console.warn(`   ⚠️  Could not delete ESM transform temp file ${esmTransformTempPath}: ${e.message}`)
        }
      }
      esmTransformTempPath = null
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

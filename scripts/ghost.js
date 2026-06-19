// ghost.js — shared Ghost Proxy utilities
// Used by capture.js, validate.js, and capture_react.mjs.
// Do NOT duplicate these functions. Import them: import { createGhost, wrapCallees, deepClone, normalizeHtml, consumeIterator } from './ghost.js'

/**
 * Deep clone a value via JSON round-trip.
 * Handles most JSON-compatible values. Non-JSON values are converted to
 * serializable representations before cloning:
 *   - BigInt → string with "n" suffix (e.g., 18n → "18n")
 *   - TypedArrays → regular arrays
 *   - Map → plain object (entries become key-value pairs)
 *   - Set → array of values
 *   - RegExp → string pattern (e.g. "/^abc$/i")
 *   - Date → ISO string
 *   - Circular references → "__circular__" placeholder (prevents stack overflow)
 *   - Functions → returned as-is (cannot be meaningfully cloned)
 * Unknown types that can't be serialized fall through to JSON round-trip,
 * which silently drops non-serializable values (backward-compatible behavior).
 */
export function deepClone(val, _seen = null) {
  // Handle BigInt → string with "n" suffix for round-trip fidelity
  // BigInt cannot be JSON.stringify'd, so we convert to a tagged string
  if (typeof val === 'bigint') {
    return val.toString() + 'n'
  }
  // Handle functions — return as-is (cannot be meaningfully cloned)
  if (typeof val === 'function') {
    return val
  }
  // Handle TypedArrays — convert to regular array before cloning
  // Without this, JSON.stringify(Uint8Array) produces {"0":1,"1":2,...} instead of [1,2,...]
  if (ArrayBuffer.isView(val) && !(val instanceof DataView)) {
    return Array.from(val).map(v => deepClone(v, _seen))
  }
  // Handle arrays — recurse to catch nested BigInt/TypedArray values
  if (Array.isArray(val)) {
    if (!_seen) _seen = new Set()
    if (_seen.has(val)) return '__circular__'
    _seen.add(val)
    const result = val.map(v => deepClone(v, _seen))
    _seen.delete(val)
    return result
  }
  // Handle Map → plain object with entries as key-value pairs
  if (val instanceof Map) {
    const obj = {}
    for (const [k, v] of val) {
      obj[k] = deepClone(v, _seen)
    }
    return obj
  }
  // Handle Set → array of values
  if (val instanceof Set) {
    return Array.from(val).map(v => deepClone(v, _seen))
  }
  // Handle RegExp → string representation (e.g. "/^abc$/i")
  if (val instanceof RegExp) {
    return val.toString()
  }
  // Handle Date → ISO string
  if (val instanceof Date) {
    return val.toISOString()
  }
  // Handle plain objects — recurse to catch nested BigInt values
  // JSON round-trip silently drops BigInt, so we must walk manually
  if (val !== null && typeof val === 'object') {
    if (!_seen) _seen = new Set()
    if (_seen.has(val)) return '__circular__'
    _seen.add(val)
    try {
      // Fast path: if JSON.stringify succeeds AND preserves all keys,
      // no BigInt/function/undefined values inside
      const serialized = JSON.stringify(val)
      const parsed = JSON.parse(serialized)
      // Verify no keys were silently dropped (functions, undefined, symbols)
      const originalKeys = Object.keys(val)
      if (originalKeys.length === Object.keys(parsed).length) {
        _seen.delete(val)
        return parsed
      }
      // Keys were dropped (e.g., function values) — fall through to slow path
    } catch {
      // Slow path: BigInt or other non-serializable values detected
    }
    // Slow path: walk each key recursively
    const obj = {}
    for (const k of Object.keys(val)) {
      obj[k] = deepClone(val[k], _seen)
    }
    _seen.delete(val)
    return obj
  }
  // Primitives: return as-is
  return val
}

/**
 * Snapshot the data properties of a class instance for recording.
 * Only captures own enumerable properties that are not functions.
 * This avoids serializing methods while preserving instance state.
 *
 * @param {object} instance - The class instance to snapshot
 * @returns {object} Serializable snapshot of data properties
 */
function snapshotInstance(instance) {
  const snapshot = {}
  for (const key of Object.keys(instance)) {
    try {
      const val = instance[key]
      if (typeof val !== 'function') {
        snapshot[key] = deepClone(val)
      }
    } catch { /* skip non-serializable properties */ }
  }
  return snapshot
}

/**
 * Create a Ghost Proxy wrapper for watched functions.
 * Records all calls (fn name, args, result) into the recorder array.
 * Handles promises transparently — waits for resolution before recording.
 * Handles class constructors (called with `new`) via the `construct` trap.
 * Optionally proxies instance methods when `instanceMethods` is provided.
 *
 * @param {object} targetModule - The module containing the functions to wrap
 * @param {string[]} watchList - Function names to monitor
 * @param {Array} recorder - Array to push call records into
 * @param {object} [instanceMethods] - Map of class name → array of instance method names to watch
 *   e.g., { Track: ['addEvent', 'buildData', 'setTempo'], Writer: ['buildFile'] }
 * @returns {object} Module with watched functions replaced by proxies
 */
export function createGhost(targetModule, watchList, recorder, instanceMethods = {}) {
  const proxied = {}

  // Build the ghost module object first (before creating proxies) so that
  // proxied functions can bind `this` to it. This is needed for CJS modules
  // where functions use `this.siblingMethod()` — when called without a
  // receiver (e.g., entryFn(...args)), `this` would be undefined.
  const ghostModule = { ...targetModule }

  for (const fnName of watchList) {
    if (typeof targetModule[fnName] !== 'function') {
      console.warn(`  ⚠️  Watch target "${fnName}" is not a function — skipping`)
      continue
    }

    const original = targetModule[fnName]
    const methodsToWatch = instanceMethods[fnName] || []
    proxied[fnName] = new Proxy(original, {
      apply(target, thisArg, args) {
        // If `this` is undefined or not the module object (e.g., called as
        // entryFn(...args) instead of module.method(...args)), bind to the
        // ghost module so that `this.siblingMethod()` still works.
        const effectiveThis = (thisArg && typeof thisArg === 'object' && fnName in thisArg)
          ? thisArg
          : ghostModule
        // Issue #277: snapshot args BEFORE invoking the target. If the
        // target mutates its arguments (e.g. `obj.flag = true`), a clone
        // taken AFTER the call would capture the post-mutation state and
        // the recorded contract would no longer represent the invocation-
        // time input. Re-validation against such a contract would silently
        // accept refactors that change mutation behavior.
        //
        // deepClone is cheap for primitives (returned as-is) so this only
        // adds real cost for object/array args, which is exactly when it
        // matters.
        const argsSnapshot = deepClone(args)
        let result
        try {
          result = target.apply(effectiveThis, args)
        } catch (err) {
          recorder.push({ fn: fnName, args: argsSnapshot, error: String(err) })
          throw err
        }
        // Handle promises transparently
        if (result && typeof result.then === 'function') {
          return result.then(resolved => {
            recorder.push({ fn: fnName, args: argsSnapshot, result: deepClone(resolved) })
            return resolved
          }).catch(err => {
            recorder.push({ fn: fnName, args: argsSnapshot, error: String(err) })
            throw err
          })
        }
        recorder.push({ fn: fnName, args: argsSnapshot, result: deepClone(result) })
        return result
      },

      /**
       * Intercept `new ClassName()` calls.
       * Without this trap, class constructors called with `new` are invisible
       * to the Ghost Proxy — the recorder stays empty even though the
       * constructor was invoked. This is the #1 issue for class-based APIs
       * where the primary usage is `new Track()`, `new NoteEvent({...})`, etc.
       *
       * When instance methods are specified in the instanceMethods config,
       * the constructed instance is wrapped in a proxy that intercepts
       * those method calls and records them with instance state snapshots.
       */
      construct(target, args, newTarget) {
        // Issue #277: snapshot constructor args BEFORE invoking the
        // constructor. Constructors routinely mutate their argument
        // objects (e.g. populate defaults, normalize shapes), and a
        // post-construct clone would record the mutated state.
        const argsSnapshot = deepClone(args)
        const instance = Reflect.construct(target, args, newTarget)

        // Record the construction with a snapshot of initial state
        const snapshot = snapshotInstance(instance)
        recorder.push({ fn: fnName, args: argsSnapshot, result: snapshot, construct: true })

        // If instance methods are specified, wrap the instance in a proxy
        if (methodsToWatch.length > 0) {
          return new Proxy(instance, {
            get(obj, prop) {
              const value = obj[prop]
              // Intercept specified instance methods
              if (methodsToWatch.includes(prop) && typeof value === 'function') {
                return new Proxy(value.bind(obj), {
                  apply(method, thisArg, callArgs) {
                    // Issue #277: snapshot call args BEFORE invoking the
                    // method. Same rationale as the outer apply trap.
                    const callArgsSnapshot = deepClone(callArgs)
                    let methodResult
                    try {
                      methodResult = method(...callArgs)
                    } catch (err) {
                      recorder.push({ fn: `${fnName}.${prop}`, args: callArgsSnapshot, error: String(err) })
                      throw err
                    }
                    // Handle async methods
                    if (methodResult && typeof methodResult.then === 'function') {
                      return methodResult.then(resolved => {
                        const postSnapshot = snapshotInstance(obj)
                        recorder.push({ fn: `${fnName}.${prop}`, args: callArgsSnapshot, result: deepClone(resolved), instanceSnapshot: postSnapshot })
                        return resolved
                      }).catch(err => {
                        recorder.push({ fn: `${fnName}.${prop}`, args: callArgsSnapshot, error: String(err) })
                        throw err
                      })
                    }
                    const postSnapshot = snapshotInstance(obj)
                    recorder.push({ fn: `${fnName}.${prop}`, args: callArgsSnapshot, result: deepClone(methodResult), instanceSnapshot: postSnapshot })
                    return methodResult
                  }
                })
              }
              return value
            }
          })
        }

        return instance
      }
    })
  }

  // Return spread: non-watched fns pass through, watched are proxied
  return { ...targetModule, ...proxied }
}

/**
 * Wrap specified callee functions on a module so that each invocation
 * records its arguments and return value (or thrown error) into the
 * calleeRecorder. This is the Phase 2 callee-wrapping feature: it lets
 * the Ghost Proxy capture each direct callee of an entry function as
 * its own behavioral contract, identified by
 * `<parentClusterId>.calls.<calleeName>`.
 *
 * Design constraints (see Phase 2 spec):
 *   - Opt-in: only invoked when a manifest cluster declares `callees: [...]`.
 *   - Depth 1: only the named callees are wrapped. They are NOT recursively
 *     re-wrapped if they themselves call other wrapped functions.
 *   - Accessible callees only: we resolve `targetModule[calleeName]`. If the
 *     name is missing or not a function (typical for closure-private or
 *     arrow-function-assigned-to-const-not-exported cases), we log a warning
 *     and skip — we never throw.
 *   - Restorable: the returned cleanup function puts the originals back, so
 *     the module is left untouched after capture/validate.
 *
 * The recorder entries are shaped:
 *   { fn: '<calleeName>', args: [...deepClone], result: <deepClone>,
 *     error: '<string>'|undefined, parentClusterId: '<id>' }
 *
 * Async callees are handled transparently: the proxy awaits the promise and
 * records the resolved value (or the rejection error).
 *
 * @param {object} targetModule - The module whose functions to wrap
 * @param {string[]} calleeNames - Callee function names to wrap
 * @param {Array} calleeRecorder - Array to push callee call records into
 * @param {object} [options]
 * @param {string} [options.parentClusterId='<unknown>'] - For warning context
 * @param {boolean} [options.quiet=false] - Suppress per-callee warnings
 * @returns {Function} cleanup function that restores the original functions.
 *                     Safe to call multiple times; subsequent calls are no-ops.
 */
export function wrapCallees(targetModule, calleeNames, calleeRecorder, options = {}) {
  const {
    parentClusterId = '<unknown>',
    quiet = false,
    holderName = '__regretsHolder',
  } = options

  const restores = []

  // Defensive: accept undefined/null calleeNames as "no-op"
  const names = Array.isArray(calleeNames) ? calleeNames : []

  // CJS modules imported via dynamic import() expose the original
  // `module.exports` object as `targetModule.default`. After mergeCjsModule(),
  // top-level keys (e.g. `targetModule.add`) are shallow-copied references
  // that point to the SAME function as `targetModule.default.add`.
  //
  // When the entry function calls the callee via `module.exports.foo(...)`,
  // the lookup resolves to `targetModule.default.foo`, NOT to the merged
  // `targetModule.foo`. To make callee wrapping actually intercept such
  // calls, we must reassign the proxy on every "live holder" that may be
  // consulted at call time.
  //
  // For frozen ESM namespace objects, reassignment throws — we catch and
  // continue (the caller already warned about closure-private callees).
  //
  // ESM bare-name workaround: when capture.js detects an ESM module with
  // callees declared, it transforms the source to introduce a mutable
  // `__regretsHolder` object (name configurable via `holderName` option)
  // and rewrites internal call sites to go through it. The holder is
  // exported from the transformed module as a plain (non-frozen) object,
  // so reassigning `holder.foo = proxy` works and internal calls see the
  // proxy. We add the holder as a live holder so wrapCallees can intercept
  // via it transparently.
  const liveHolders = [targetModule]
  if (targetModule && typeof targetModule === 'object' &&
      targetModule.default && typeof targetModule.default === 'object' &&
      !Array.isArray(targetModule.default) &&
      targetModule.default !== targetModule) {
    liveHolders.push(targetModule.default)
  }
  // ESM-transformed holder: a plain mutable object exported under
  // `holderName`. If present, it's the primary interception point for
  // internal calls — the namespace and default holders remain in the list
  // for backward compatibility (they're no-ops on frozen namespaces).
  if (targetModule && typeof targetModule === 'object' &&
      targetModule[holderName] && typeof targetModule[holderName] === 'object' &&
      !Array.isArray(targetModule[holderName]) &&
      !Object.isFrozen(targetModule[holderName])) {
    liveHolders.push(targetModule[holderName])
  }

  for (const calleeName of names) {
    if (typeof calleeName !== 'string' || calleeName.length === 0) {
      if (!quiet) {
        console.warn(`  ⚠️  Callee name must be a non-empty string — skipping (cluster: ${parentClusterId})`)
      }
      continue
    }

    // Find the original function on any live holder. We consider the
    // callee "found" if at least one holder exposes it as a function.
    let original = null
    const holdersWithFn = []
    for (const holder of liveHolders) {
      if (holder && typeof holder[calleeName] === 'function') {
        if (!original) original = holder[calleeName]
        holdersWithFn.push(holder)
      }
    }
    if (!original) {
      if (!quiet) {
        console.warn(`  ⚠️  Callee "${calleeName}" not found or not a function on module exports — skipping (cluster: ${parentClusterId})`)
        console.warn(`      This typically means the function is a closure-private or not exported. The parent cluster will still be captured.`)
      }
      continue
    }

    const proxy = new Proxy(original, {
      apply(target, thisArg, args) {
        // Issue #277: snapshot args BEFORE invoking the callee. Same
        // rationale as createGhost — if the callee mutates its args,
        // a post-call clone would record the mutated state, corrupting
        // the .regret contract and breaking re-validation.
        const argsSnapshot = deepClone(args)
        let result
        try {
          result = target.apply(thisArg, args)
        } catch (err) {
          calleeRecorder.push({
            fn: calleeName,
            args: argsSnapshot,
            error: String(err),
            parentClusterId,
          })
          throw err
        }
        // Handle promises transparently (same pattern as createGhost)
        if (result && typeof result.then === 'function') {
          return result.then(resolved => {
            calleeRecorder.push({
              fn: calleeName,
              args: argsSnapshot,
              result: deepClone(resolved),
              parentClusterId,
            })
            return resolved
          }).catch(err => {
            calleeRecorder.push({
              fn: calleeName,
              args: argsSnapshot,
              error: String(err),
              parentClusterId,
            })
            throw err
          })
        }
        calleeRecorder.push({
          fn: calleeName,
          args: argsSnapshot,
          result: deepClone(result),
          parentClusterId,
        })
        return result
      },

      // Pass through `new` calls so wrapped constructors keep working.
      // Callee recordings under `new` capture the constructed instance
      // snapshot (data properties only, mirroring createGhost's construct).
      construct(target, args, newTarget) {
        // Issue #277: snapshot constructor args BEFORE invoking the
        // constructor.
        const argsSnapshot = deepClone(args)
        const instance = Reflect.construct(target, args, newTarget)
        const snapshot = snapshotInstance(instance)
        calleeRecorder.push({
          fn: calleeName,
          args: argsSnapshot,
          result: snapshot,
          construct: true,
          parentClusterId,
        })
        return instance
      },
    })

    // Reassign the proxy on every holder that currently exposes the
    // original function. This is what makes the wrap actually intercept
    // calls made via `module.exports.foo(...)` (CJS) or `mod.foo(...)`
    // (mutable namespace patterns).
    let reassignedAnywhere = false
    for (const holder of holdersWithFn) {
      try {
        holder[calleeName] = proxy
        reassignedAnywhere = true
        restores.push({ obj: holder, key: calleeName, original })
      } catch {
        // ESM namespace objects are frozen — silently skip.
        // The warning below fires if NO holder accepted the reassignment.
      }
    }
    if (!reassignedAnywhere && !quiet) {
      // Emit a specific, actionable warning. Two cases:
      //   1. The module exposes our `__regretsHolder` but the callee isn't
      //      on it — this happens when the transformer couldn't rewrite
      //      this particular callee (e.g. it's a class method, a destructured
      //      export, or a closure-private function). The fix is to refactor
      //      to a top-level function declaration or `export const foo = ...`.
      //   2. The module is a plain frozen ESM namespace with no holder —
      //      the user never opted into transformation (or it was aborted
      //      due to shadowing/parse errors). The fix is to remove the
      //      shadowing or convert to a supported pattern.
      const hasHolder = !!(targetModule && typeof targetModule === 'object' &&
                          targetModule[holderName])
      if (hasHolder) {
        console.warn(`  ⚠️  Callee "${calleeName}" could not be installed on the holder "${holderName}" (cluster: ${parentClusterId})`)
        console.warn(`      This typically means "${calleeName}" is not a transformable top-level function.`)
        console.warn(`      Supported ESM patterns:  function ${calleeName}() {} / export function ${calleeName}() {} /`)
        console.warn(`                               export const ${calleeName} = () => {} / export const ${calleeName} = function() {}`)
        console.warn(`      Supported CJS patterns:  function ${calleeName}() {} / const ${calleeName} = () => {} /`)
        console.warn(`                               const ${calleeName} = function() {}`)
        console.warn(`      Class methods, nested functions, and destructured exports are not yet supported.`)
        console.warn(`      The callee is skipped; the parent cluster is still captured.`)
      } else {
        console.warn(`  ⚠️  Callee "${calleeName}" found but module is frozen (no mutable holder available) — could not install proxy (cluster: ${parentClusterId})`)
        console.warn(`      This means the source transform was aborted (shadowing, parse error, unsupported`)
        console.warn(`      pattern) AND the module's namespace is frozen (ESM) or its internal calls`)
        console.warn(`      resolve to local bindings rather than a holder wrapCallees can intercept.`)
        console.warn(`      Options to enable callee wrapping:`)
        console.warn(`        1. Refactor to a supported pattern (see list above) and ensure the callee`)
        console.warn(`           name is not shadowed anywhere in the file.`)
        console.warn(`        2. For CJS: call the callee via \`module.exports.${calleeName}(...)\` instead`)
        console.warn(`           of the bare name — this works without source transformation.`)
        console.warn(`      The callee is skipped; the parent cluster is still captured.`)
      }
    }
  }

  // Cleanup function: idempotent — first call restores everything,
  // subsequent calls are no-ops. This makes it safe to call from a
  // finally block even if wrapCallees itself partially failed.
  let cleaned = false
  return function cleanup() {
    if (cleaned) return
    cleaned = true
    for (const { obj, key, original } of restores) {
      try {
        obj[key] = original
      } catch {
        // Module namespace objects may be frozen (ESM). Best-effort restore.
      }
    }
  }
}

/**
 * Normalize an HTML string for consistent fingerprinting.
 * Collapses whitespace, strips specified attributes.
 *
 * @param {string} html - The HTML string to normalize
 * @param {string[]} stripAttrs - Attribute names to remove (e.g., ['data-testid', 'aria-label'])
 * @returns {string} Normalized HTML string
 */
export function normalizeHtml(html, stripAttrs = []) {
  let result = html
    .replace(/\s+/g, ' ')
    .replace(/>\s+</g, '><')
    .trim()

  for (const attr of stripAttrs) {
    const regex = new RegExp(`\\s*${attr}="[^"]*"`, 'g')
    result = result.replace(regex, '')
  }

  return result
}

/**
 * Normalize visual HTML/SVG output for consistent visual fingerprinting.
 * Strips comments, collapses whitespace, normalizes dynamic colors and measurements.
 * Used with fingerprintMode: "render" for SVG/HTML-heavy output.
 *
 * @param {string} html - The HTML/SVG string to normalize
 * @returns {string} Normalized visual string
 */
export function normalizeVisualOutput(html) {
  return html
    // Strip comments
    .replace(/<!--[\s\S]*?-->/g, '')
    // Collapse whitespace
    .replace(/\s+/g, ' ')
    .replace(/>\s+</g, '><')
    // Normalize hex colors → <COLOR>
    .replace(/#[0-9a-fA-F]{6}\b/g, '<COLOR>')
    .replace(/#[0-9a-fA-F]{3}\b/g, '<COLOR>')
    // Normalize rgb/rgba colors → <COLOR>
    .replace(/rgba?\([^)]+\)/g, '<COLOR>')
    // Normalize computed measurements → <SIZE>
    .replace(/\d+(\.\d+)?px/g, '<SIZE>')
    .replace(/\d+(\.\d+)?%/g, '<PERCENT>')
    .replace(/\d+(\.\d+)?em/g, '<SIZE>')
    .replace(/\d+(\.\d+)?rem/g, '<SIZE>')
    .replace(/\d+(\.\d+)?vh/g, '<SIZE>')
    .replace(/\d+(\.\d+)?vw/g, '<SIZE>')
    // Normalize inline styles with dynamic values
    .replace(/style="[^"]*"/g, 'style="<STYLE>"')
    .trim()
}

/**
 * Consume sync and async iterators/generators into arrays.
 *
 * Detects and consumes:
 *   - Async iterators (Symbol.asyncIterator) — consumed with for-await loop
 *   - Sync iterators/generators (Symbol.iterator + .next, not Array/Map/Set) — consumed with spread or loop
 *   - Generic iterables (Symbol.iterator without .next, not Array) — only when materialize=true
 *
 * Fixes the bug where fallback blocks only checked Symbol.iterator but missed
 * Symbol.asyncIterator — now both are always checked regardless of materialize mode.
 *
 * When maxYields is set, limits the number of yielded items and appends
 * a {"__truncated__": true, "maxYields": N} sentinel if the limit is hit.
 *
 * @param {*} output - The value to check and potentially consume
 * @param {number|null} [maxYields=null] - Max items to yield; null = unlimited
 * @param {object} [options={}] - Additional options
 * @param {boolean} [options.materialize=false] - Full materialization mode:
 *   checks all iterables (including async and generic), deep-clones each item
 * @returns {Promise<{consumed: boolean, result: *}>} - consumed=true if an iterator was detected and consumed
 */
export async function consumeIterator(output, maxYields = null, options = {}) {
  const { materialize = false } = options

  if (!output || typeof output !== 'object') {
    return { consumed: false, result: output }
  }

  // 1. Check for async iterator — always, regardless of materialize flag
  if (typeof output[Symbol.asyncIterator] === 'function') {
    const items = []
    let count = 0
    for await (const item of output) {
      if (maxYields !== null && count >= maxYields) {
        items.push({ __truncated__: true, maxYields })
        break
      }
      items.push(materialize ? deepClone(item) : item)
      count++
    }
    return { consumed: true, result: items }
  }

  // 2. Check for sync iterator/generator (Symbol.iterator + .next, not Array/Map/Set)
  if (typeof output[Symbol.iterator] === 'function' &&
      typeof output.next === 'function' &&
      !Array.isArray(output) &&
      !(output instanceof Map) &&
      !(output instanceof Set)) {
    if (maxYields !== null || materialize) {
      const items = []
      let count = 0
      for (const item of output) {
        if (maxYields !== null && count >= maxYields) {
          items.push({ __truncated__: true, maxYields })
          break
        }
        items.push(materialize ? deepClone(item) : item)
        count++
      }
      return { consumed: true, result: items }
    }
    // No maxYields, no materialize — use spread for backward compatibility
    return { consumed: true, result: [...output] }
  }

  // 3. Check for generic iterable (Symbol.iterator without .next) when materialize=true
  if (materialize && typeof output[Symbol.iterator] === 'function' && !Array.isArray(output)) {
    const items = []
    let count = 0
    for (const item of output) {
      if (maxYields !== null && count >= maxYields) {
        items.push({ __truncated__: true, maxYields })
        break
      }
      items.push(deepClone(item))
      count++
    }
    return { consumed: true, result: items }
  }

  return { consumed: false, result: output }
}

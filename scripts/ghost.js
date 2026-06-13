// ghost.js — shared Ghost Proxy utilities
// Used by capture.js, validate.js, and capture_react.mjs.
// Do NOT duplicate these functions. Import them: import { createGhost, deepClone, normalizeHtml } from './ghost.js'

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
 * Unknown types that can't be serialized fall through to JSON round-trip,
 * which silently drops non-serializable values (backward-compatible behavior).
 */
export function deepClone(val) {
  // Handle BigInt → string with "n" suffix for round-trip fidelity
  // BigInt cannot be JSON.stringify'd, so we convert to a tagged string
  if (typeof val === 'bigint') {
    return val.toString() + 'n'
  }
  // Handle TypedArrays — convert to regular array before cloning
  // Without this, JSON.stringify(Uint8Array) produces {"0":1,"1":2,...} instead of [1,2,...]
  if (ArrayBuffer.isView(val) && !(val instanceof DataView)) {
    return Array.from(val).map(v => deepClone(v))
  }
  // Handle arrays — recurse to catch nested BigInt/TypedArray values
  if (Array.isArray(val)) {
    return val.map(v => deepClone(v))
  }
  // Handle Map → plain object with entries as key-value pairs
  if (val instanceof Map) {
    const obj = {}
    for (const [k, v] of val) {
      obj[k] = deepClone(v)
    }
    return obj
  }
  // Handle Set → array of values
  if (val instanceof Set) {
    return Array.from(val).map(v => deepClone(v))
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
    try {
      // Fast path: if JSON.stringify succeeds, no BigInt inside
      const serialized = JSON.stringify(val)
      return JSON.parse(serialized)
    } catch {
      // Slow path: BigInt or other non-serializable values detected
      const obj = {}
      for (const k of Object.keys(val)) {
        obj[k] = deepClone(val[k])
      }
      return obj
    }
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
        let result
        try {
          result = target.apply(effectiveThis, args)
        } catch (err) {
          recorder.push({ fn: fnName, args: deepClone(args), error: String(err) })
          throw err
        }
        // Handle promises transparently
        if (result && typeof result.then === 'function') {
          return result.then(resolved => {
            recorder.push({ fn: fnName, args: deepClone(args), result: deepClone(resolved) })
            return resolved
          }).catch(err => {
            recorder.push({ fn: fnName, args: deepClone(args), error: String(err) })
            throw err
          })
        }
        recorder.push({ fn: fnName, args: deepClone(args), result: deepClone(result) })
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
        const instance = Reflect.construct(target, args, newTarget)

        // Record the construction with a snapshot of initial state
        const snapshot = snapshotInstance(instance)
        recorder.push({ fn: fnName, args: deepClone(args), result: snapshot, construct: true })

        // If instance methods are specified, wrap the instance in a proxy
        if (methodsToWatch.length > 0) {
          return new Proxy(instance, {
            get(obj, prop) {
              const value = obj[prop]
              // Intercept specified instance methods
              if (methodsToWatch.includes(prop) && typeof value === 'function') {
                return new Proxy(value.bind(obj), {
                  apply(method, thisArg, callArgs) {
                    let methodResult
                    try {
                      methodResult = method(...callArgs)
                    } catch (err) {
                      recorder.push({ fn: `${fnName}.${prop}`, args: deepClone(callArgs), error: String(err) })
                      throw err
                    }
                    // Handle async methods
                    if (methodResult && typeof methodResult.then === 'function') {
                      return methodResult.then(resolved => {
                        const postSnapshot = snapshotInstance(obj)
                        recorder.push({ fn: `${fnName}.${prop}`, args: deepClone(callArgs), result: deepClone(resolved), instanceSnapshot: postSnapshot })
                        return resolved
                      }).catch(err => {
                        recorder.push({ fn: `${fnName}.${prop}`, args: deepClone(callArgs), error: String(err) })
                        throw err
                      })
                    }
                    const postSnapshot = snapshotInstance(obj)
                    recorder.push({ fn: `${fnName}.${prop}`, args: deepClone(callArgs), result: deepClone(methodResult), instanceSnapshot: postSnapshot })
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

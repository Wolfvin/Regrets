// ghost.js — shared Ghost Proxy utilities
// Used by capture.js, validate.js, and capture_react.mjs.
// Do NOT duplicate these functions. Import them: import { createGhost, deepClone, normalizeHtml } from './ghost.js'

/**
 * Deep clone a value, handling non-JSON-serializable types that JSON round-trip
 * would silently corrupt (ArrayBuffer → {}, Uint8Array → indexed object, etc.).
 *
 * Supported non-JSON types:
 * - ArrayBuffer → cloned via Uint8Array copy
 * - Uint8Array, Int8Array, Uint16Array, Int16Array, Uint32Array, Int32Array,
 *   Float32Array, Float64Array → cloned with same constructor and data
 * - DataView → cloned with underlying ArrayBuffer copy
 * - Map → cloned recursively (keys and values)
 * - Set → cloned recursively (values)
 * - NaN, Infinity, -Infinity → preserved (JSON would turn them to null)
 * - undefined → preserved in arrays (JSON would drop it), dropped in objects (JS semantics)
 * - RegExp → cloned via constructor
 * - Date → cloned via constructor
 * - Circular references → detected and replaced with [Circular] marker
 */
export function deepClone(val, seen = new WeakMap()) {
  // Primitives: return as-is (handles null, undefined, boolean, number, string, bigint)
  if (val === null || val === undefined) return val
  if (typeof val !== 'object' && typeof val !== 'function') return val

  // Handle NaN, Infinity, -Infinity — these are typeof 'number' but not === to primitives above
  if (typeof val === 'number') return val  // already handled, but explicit for clarity

  // Circular reference detection
  if (seen.has(val)) return '[Circular]'

  // --- Typed Arrays & ArrayBuffer ---
  if (val instanceof ArrayBuffer) {
    const copy = new ArrayBuffer(val.byteLength)
    new Uint8Array(copy).set(new Uint8Array(val))
    return copy
  }
  if (val instanceof DataView) {
    const bufCopy = deepClone(val.buffer, seen)
    return new DataView(bufCopy, val.byteOffset, val.byteLength)
  }
  // All TypedArray subtypes
  if (ArrayBuffer.isView(val) && !(val instanceof DataView)) {
    const TypedCtor = val.constructor
    const bufCopy = deepClone(val.buffer, seen)
    return new TypedCtor(bufCopy, val.byteOffset, val.length)
  }

  // --- Map ---
  if (val instanceof Map) {
    seen.set(val, true)
    const copy = new Map()
    for (const [k, v] of val) {
      copy.set(deepClone(k, seen), deepClone(v, seen))
    }
    return copy
  }

  // --- Set ---
  if (val instanceof Set) {
    seen.set(val, true)
    const copy = new Set()
    for (const v of val) {
      copy.add(deepClone(v, seen))
    }
    return copy
  }

  // --- Date ---
  if (val instanceof Date) {
    return new Date(val.getTime())
  }

  // --- RegExp ---
  if (val instanceof RegExp) {
    return new RegExp(val.source, val.flags)
  }

  // --- Array ---
  if (Array.isArray(val)) {
    seen.set(val, true)
    return val.map(item => deepClone(item, seen))
  }

  // --- Plain object ---
  if (typeof val === 'object') {
    seen.set(val, true)
    const copy = {}
    for (const key of Object.keys(val)) {
      // Skip undefined values in objects (matches JSON.stringify behavior)
      const v = val[key]
      if (v !== undefined) {
        copy[key] = deepClone(v, seen)
      }
    }
    return copy
  }

  // Fallback: functions, symbols, and other non-cloneable values
  return val
}

/**
 * Create a Ghost Proxy wrapper for watched functions.
 * Records all calls (fn name, args, result) into the recorder array.
 * Handles promises transparently — waits for resolution before recording.
 *
 * @param {object} targetModule - The module containing the functions to wrap
 * @param {string[]} watchList - Function names to monitor
 * @param {Array} recorder - Array to push call records into
 * @returns {object} Module with watched functions replaced by proxies
 */
export function createGhost(targetModule, watchList, recorder) {
  const proxied = {}

  for (const fnName of watchList) {
    if (typeof targetModule[fnName] !== 'function') {
      console.warn(`  ⚠️  Watch target "${fnName}" is not a function — skipping`)
      continue
    }

    const original = targetModule[fnName]
    proxied[fnName] = new Proxy(original, {
      apply(target, thisArg, args) {
        let result
        try {
          result = target.apply(thisArg, args)
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

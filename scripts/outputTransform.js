// outputTransform.js — Shared output transformation logic
//
// Used by both capture.js and validate.js to ensure identical transform behavior.
// Eliminates code duplication that caused false positives when validate.js
// didn't have the same transforms as capture.js (discovered during mathjs refactoring).

import { resolve } from 'path'
import { deepClone } from './ghost.js'

/**
 * Apply an output transform to prepare output for fingerprinting.
 *
 * Supported transforms:
 *   'str'            — Convert to string via String()
 *   'json'           — Force JSON round-trip (strips non-serializable values)
 *   'keys'           — Return Object.keys() for objects
 *   'toString'       — Call .toString() on objects (e.g., mathjs Node trees)
 *   'toJSON'         — Call .toJSON() on objects (e.g., mathjs Complex, BigNumber)
 *   'pojo'           — Recursively convert class instances to plain objects
 *   'repr'           — JSON.stringify the full value
 *   'len'            — Return length/size
 *   'type'           — Return type name string
 *   'isoformat'      — Convert Date/datetime objects to ISO 8601 strings
 *   'array_summary'  — Summarize array-like data (length + shape + dtype info)
 *   'dict'           — Convert to plain object (for Map-like or dict-like objects)
 *   'dataclass_dict' — Recursively convert class instances to dicts (alias for pojo)
 *   'a.b'            — Custom module.function (returns output unchanged; use applyOutputTransformAsync for auto-import)
 *
 * @param {*} output - The raw output value
 * @param {string|null} transform - Transform name from manifest
 * @returns {*} Transformed output
 */
export function applyOutputTransform(output, transform) {
  if (!transform) return output

  if (transform === 'str') {
    if (Array.isArray(output)) return output.map(item => String(item))
    return String(output)
  }

  if (transform === 'isoformat') {
    // Convert Date/datetime objects to ISO 8601 strings.
    // Recommended for libraries returning datetime objects (python-dateutil, arrow, etc.)
    if (Array.isArray(output)) {
      return output.map(item =>
        (item && typeof item.toISOString === 'function') ? item.toISOString() : String(item)
      )
    }
    if (output && typeof output.toISOString === 'function') return output.toISOString()
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

  if (transform === 'toString') {
    if (Array.isArray(output)) return output.map(item => (item && typeof item.toString === 'function') ? item.toString() : String(item))
    if (output && typeof output.toString === 'function' && typeof output !== 'string') return output.toString()
    return String(output)
  }

  if (transform === 'toJSON') {
    if (Array.isArray(output)) return output.map(item => (item && typeof item.toJSON === 'function') ? item.toJSON() : deepClone(item))
    if (output && typeof output.toJSON === 'function') return output.toJSON()
    return deepClone(output)
  }

  if (transform === 'pojo') return toPojo(output)

  if (transform === 'repr') return JSON.stringify(output)

  if (transform === 'len') {
    if (Array.isArray(output)) return output.length
    if (typeof output === 'string') return output.length
    if (output && typeof output === 'object') return Object.keys(output).length
    return 0
  }

  if (transform === 'type') {
    if (output === null) return 'null'
    if (output === undefined) return 'undefined'
    if (Array.isArray(output)) return 'array'
    if (output && output.constructor && output.constructor.name !== 'Object') return output.constructor.name
    return typeof output
  }

  if (transform === 'array_summary') {
    // Summarize array-like output: length, shape hints, dtype-like info.
    // Essential for numpy-style arrays or large typed arrays where full
    // fingerprinting is impractical.
    if (Array.isArray(output)) {
      const summary = { length: output.length }
      if (output.length > 0) {
        summary.first = output[0]
        summary.last = output[output.length - 1]
      }
      return summary
    }
    if (ArrayBuffer.isView(output) && !(output instanceof DataView)) {
      return { length: output.length, byteLength: output.byteLength }
    }
    if (output && typeof output === 'object') {
      const keys = Object.keys(output)
      return { length: keys.length, keys }
    }
    return { length: 0 }
  }

  if (transform === 'dict') {
    // Convert Map-like or dict-like objects to plain JS objects.
    // For Map instances, converts entries to an object.
    // For class instances, recursively strips class identity.
    if (output instanceof Map) {
      const result = {}
      for (const [k, v] of output) {
        result[k] = toPojo(v)
      }
      return result
    }
    if (output && typeof output === 'object' && !Array.isArray(output)) {
      return toPojo(output)
    }
    return output
  }

  if (transform === 'dataclass_dict') {
    // Recursively convert dataclass-like instances to plain dicts.
    // In JS this is functionally equivalent to pojo.
    return toPojo(output)
  }

  // Custom "module.function" — caller handles async import
  if (transform.includes('.')) return output

  return output
}

/**
 * Async version of applyOutputTransform that also handles the custom
 * "module.function" transform pattern by dynamically importing the module.
 *
 * Use this when the transform might be a custom "module.fn" pattern that
 * requires async import(). For all other transforms, behavior is identical
 * to applyOutputTransform().
 *
 * @param {*} output - The raw output value
 * @param {string|null} transform - Transform name from manifest
 * @param {string} [cwd] - Current working directory for resolving module paths
 * @returns {Promise<*>} Transformed output
 */
export async function applyOutputTransformAsync(output, transform, cwd) {
  if (!transform) return output

  // Custom "module.function" — async import
  if (transform.includes('.')) {
    const lastDot = transform.lastIndexOf('.')
    const modPath = transform.slice(0, lastDot)
    const fnName = transform.slice(lastDot + 1)
    try {
      const customMod = await import(resolve(cwd || process.cwd(), modPath))
      return customMod[fnName](output)
    } catch (e) {
      throw new Error(`Cannot resolve outputTransform '${transform}': ${e.message}`)
    }
  }

  // All other transforms delegate to the sync version
  return applyOutputTransform(output, transform)
}

/**
 * Recursively convert class instances to plain objects for fingerprinting.
 * Handles nested class instances, arrays, Maps, Sets, and primitives.
 * Calls .toJSON() if available, otherwise strips class identity.
 *
 * This is essential for libraries like mathjs that return custom class instances
 * (Complex, Unit, Matrix, BigNumber, Fraction) that need deep serialization
 * before fingerprinting.
 */
export function toPojo(val) {
  if (val === null || val === undefined) return val
  if (typeof val !== 'object') return val
  if (typeof val === 'bigint') return val.toString() + 'n'

  if (Array.isArray(val)) return val.map(toPojo)

  if (val instanceof Map) {
    const entries = [...val.entries()].sort((a, b) => String(a[0]).localeCompare(String(b[0])))
    return Object.fromEntries(entries.map(([k, v]) => [k, toPojo(v)]))
  }

  if (val instanceof Set) return [...val].map(toPojo)

  if (val instanceof Date) return val.toISOString()

  if (val instanceof RegExp) return val.toString()

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

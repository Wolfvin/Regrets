// outputTransform.js — Shared output transformation logic
//
// Used by both capture.js and validate.js to ensure identical transform behavior.
// Eliminates code duplication that caused false positives when validate.js
// didn't have the same transforms as capture.js (discovered during mathjs refactoring).

import { deepClone } from './ghost.js'

/**
 * Apply an output transform to prepare output for fingerprinting.
 *
 * Supported transforms:
 *   'str'      — Convert to string via String()
 *   'json'     — Force JSON round-trip (strips non-serializable values)
 *   'keys'     — Return Object.keys() for objects
 *   'toString' — Call .toString() on objects (e.g., mathjs Node trees)
 *   'toJSON'   — Call .toJSON() on objects (e.g., mathjs Complex, BigNumber)
 *   'pojo'     — Recursively convert class instances to plain objects
 *   'repr'     — JSON.stringify the full value
 *   'len'      — Return length/size
 *   'type'     — Return type name string
 *   'a.b'      — Custom module.function (returns output unchanged; caller handles async)
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

  // Custom "module.function" — caller handles async import
  if (transform.includes('.')) return output

  return output
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

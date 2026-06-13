// fingerprint.js — deterministic hash for regression contracts
// No dependencies. Works in Node.js 16+.

import { createHash } from 'crypto'

/**
 * Convert a binary value (ArrayBuffer, TypedArray, DataView) to a hex string
 * for deterministic serialization. Used by stableStringify to handle
 * non-JSON-serializable binary types that would otherwise become {}.
 */
export function binaryToHex(val) {
  let bytes
  if (val instanceof ArrayBuffer) {
    bytes = new Uint8Array(val)
  } else if (val instanceof DataView) {
    bytes = new Uint8Array(val.buffer, val.byteOffset, val.byteLength)
  } else if (ArrayBuffer.isView(val)) {
    // TypedArray (Uint8Array, Int32Array, etc.)
    bytes = new Uint8Array(val.buffer, val.byteOffset, val.byteLength)
  } else {
    return null // not a binary type
  }
  return Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('')
}

/**
 * Stable JSON stringify — keys sorted recursively.
 * { b:2, a:1 } and { a:1, b:2 } produce identical output.
 *
 * Extended to handle non-JSON-serializable types:
 * - ArrayBuffer, TypedArray, DataView → hex string representation
 * - Map → sorted entries as [key, value] pairs
 * - Set → sorted values as array
 * - NaN → "<NaN>" (distinct from null)
 * - Infinity → "<Infinity>" (distinct from null)
 * - -Infinity → "<-Infinity>" (distinct from null)
 * - undefined in arrays → "<undefined>" (distinct from null)
 * - Circular references → "[Circular]" marker
 * - BigInt → string representation with type tag
 */
export function stableStringify(obj, seen = new WeakSet()) {
  // Primitives
  if (obj === null) return 'null'
  if (obj === undefined) return '<undefined>'

  // Special numeric values — must distinguish from null
  if (typeof obj === 'number') {
    if (Number.isNaN(obj)) return '<NaN>'
    if (obj === Infinity) return '<Infinity>'
    if (obj === -Infinity) return '<-Infinity>'
    return JSON.stringify(obj)
  }

  if (typeof obj === 'bigint') return `<BigInt:${obj.toString()}>`
  if (typeof obj === 'boolean') return JSON.stringify(obj)
  if (typeof obj === 'string') return JSON.stringify(obj)

  // --- Binary types ---
  const hex = binaryToHex(obj)
  if (hex !== null) {
    const tag = obj instanceof ArrayBuffer ? 'ArrayBuffer'
      : obj instanceof DataView ? 'DataView'
      : obj.constructor?.name || 'TypedArray'
    return `<${tag}:${hex}>`
  }

  // --- Map ---
  if (obj instanceof Map) {
    const entries = []
    for (const [k, v] of obj) {
      entries.push(stableStringify(k, seen) + ':' + stableStringify(v, seen))
    }
    entries.sort() // deterministic key order
    return '<Map:{' + entries.join(',') + '}>'
  }

  // --- Set ---
  if (obj instanceof Set) {
    const values = []
    for (const v of obj) {
      values.push(stableStringify(v, seen))
    }
    values.sort() // deterministic order
    return '<Set:[' + values.join(',') + ']>'
  }

  // --- Date ---
  if (obj instanceof Date) {
    return `<Date:${obj.toISOString()}>`
  }

  // --- RegExp ---
  if (obj instanceof RegExp) {
    return `<RegExp:${obj.source}/${obj.flags}>`
  }

  // --- Circular reference detection ---
  if (typeof obj === 'object' && seen.has(obj)) return '<Circular>'

  // --- Array ---
  if (Array.isArray(obj)) {
    seen.add(obj)
    return '[' + obj.map(item => stableStringify(item, seen)).join(',') + ']'
  }

  // --- Plain object ---
  if (typeof obj === 'object') {
    seen.add(obj)
    const keys = Object.keys(obj).sort()
    return '{' + keys.map(k => JSON.stringify(k) + ':' + stableStringify(obj[k], seen)).join(',') + '}'
  }

  // Fallback for functions, symbols, etc.
  return JSON.stringify(obj)
}

/**
 * Normalize non-deterministic values before hashing.
 * Pass normalize array from cluster manifest.
 *
 * Extended to handle non-JSON types:
 * - ArrayBuffer, TypedArray, DataView → hex representation (deterministic)
 * - Map → normalized entries
 * - Set → normalized values
 * - NaN, Infinity, -Infinity → preserved as-is (stableStringify handles them)
 */
export function normalize(obj, rules = []) {
  if (typeof obj === 'string') {
    if (rules.includes('timestamps') && /^\d{4}-\d{2}-\d{2}T[\d:.Z+-]+$/.test(obj)) {
      return '<TIMESTAMP>'
    }
    if (rules.includes('uuids') && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(obj)) {
      return '<UUID>'
    }
    if (rules.includes('absPaths') && /^\//.test(obj)) {
      return obj.replace(/^\/[^/]+\/[^/]+\//, '<ROOT>/')
    }
    if (rules.includes('dynamicDates')) {
      return obj
        .replace(/(0[1-9]|1[0-2])\d{4}/g, '<MMYYYY>')
        .replace(/(?<![0-9])(20\d{2}|19\d{2})(?![0-9])/g, '<YYYY>')
    }
  }
  if (typeof obj === 'number') {
    // Preserve NaN, Infinity, -Infinity as-is (don't lose them to epochs check)
    if (Number.isNaN(obj)) return obj
    if (!Number.isFinite(obj)) return obj
    if (rules.includes('epochs') && obj > 1_000_000_000 && obj < 9_999_999_999_999) {
      return '<EPOCH>'
    }
  }

  // --- Binary types: pass through for stableStringify to handle ---
  if (obj instanceof ArrayBuffer || obj instanceof DataView || (ArrayBuffer.isView(obj) && !(obj instanceof DataView))) {
    return obj // stableStringify will convert to hex
  }

  // --- Map ---
  if (obj instanceof Map) {
    const entries = []
    for (const [k, v] of obj) {
      entries.push([normalize(k, rules), normalize(v, rules)])
    }
    return new Map(entries)
  }

  // --- Set ---
  if (obj instanceof Set) {
    const values = []
    for (const v of obj) {
      values.push(normalize(v, rules))
    }
    return new Set(values)
  }

  if (Array.isArray(obj)) return obj.map(v => normalize(v, rules))
  if (obj && typeof obj === 'object') {
    return Object.fromEntries(Object.entries(obj).map(([k, v]) => [k, normalize(v, rules)]))
  }
  return obj
}

/**
 * Strip ignored fields from output before hashing.
 *
 * Extended to handle Map (strips by key) and binary types (pass through).
 */
export function stripFields(obj, ignoreFields = []) {
  if (!ignoreFields.length) return obj

  // Binary types: pass through (no fields to strip)
  if (obj instanceof ArrayBuffer || obj instanceof DataView || (ArrayBuffer.isView(obj) && !(obj instanceof DataView))) {
    return obj
  }

  // Map: strip entries with ignored keys
  if (obj instanceof Map) {
    const copy = new Map()
    for (const [k, v] of obj) {
      if (!ignoreFields.includes(k)) {
        copy.set(k, stripFields(v, ignoreFields))
      }
    }
    return copy
  }

  if (Array.isArray(obj)) return obj.map(v => stripFields(v, ignoreFields))
  if (obj && typeof obj === 'object') {
    return Object.fromEntries(
      Object.entries(obj)
        .filter(([k]) => !ignoreFields.includes(k))
        .map(([k, v]) => [k, stripFields(v, ignoreFields)])
    )
  }
  return obj
}

/**
 * Core fingerprint function.
 * Produces a 7-char base36 hash from input + output.
 */
export function fingerprint(input, output, clusterConfig = {}) {
  const { normalize: normalizeRules = [], ignoreFields = [] } = clusterConfig

  const cleanInput  = stripFields(normalize(input, normalizeRules), ignoreFields)
  const cleanOutput = stripFields(normalize(output, normalizeRules), ignoreFields)

  const combined = stableStringify(cleanInput) + '|' + stableStringify(cleanOutput)
  const hash = createHash('sha256').update(combined, 'utf8').digest('hex')

  // Convert hex to base36, take first 7 chars
  const num = BigInt('0x' + hash)
  return num.toString(36).slice(0, 7)
}

/**
 * Fingerprint an entire call sequence (for fingerprintLevel: "full" or "watched")
 */
export function fingerprintSequence(calls, clusterConfig = {}) {
  const { normalize: normalizeRules = [], ignoreFields = [] } = clusterConfig

  const normalized = calls.map(({ fn, args, result }) => ({
    fn,
    args: stripFields(normalize(args, normalizeRules), ignoreFields),
    result: stripFields(normalize(result, normalizeRules), ignoreFields)
  }))

  const combined = stableStringify(normalized)
  const hash = createHash('sha256').update(combined, 'utf8').digest('hex')
  return BigInt('0x' + hash).toString(36).slice(0, 7)
}

/**
 * Extract structural schema from a value.
 * All values replaced with their type name for structural fingerprinting.
 * Used by fingerprintMode: "schema" and "mixed".
 *
 * Extended to handle non-JSON types:
 * - ArrayBuffer, TypedArray, DataView → "binary" (content-agnostic)
 * - Map → { "<Map>": { keySchema: valueSchema } }
 * - Set → { "<Set>": [valueSchema] }
 * - NaN, Infinity, -Infinity → "number" (they ARE numbers)
 * - undefined → "undefined"
 * - BigInt → "bigint"
 */
export function extractSchema(obj) {
  if (obj === null) return 'null'
  if (obj === undefined) return 'undefined'
  if (typeof obj === 'bigint') return 'bigint'

  // Binary types
  if (obj instanceof ArrayBuffer) return 'binary'
  if (obj instanceof DataView) return 'binary'
  if (ArrayBuffer.isView(obj) && !(obj instanceof DataView)) return 'binary'

  // Map
  if (obj instanceof Map) {
    if (obj.size === 0) return { '<Map>': 'empty' }
    const keySchemas = new Set()
    const valSchemas = new Set()
    for (const [k, v] of obj) {
      keySchemas.add(JSON.stringify(extractSchema(k)))
      valSchemas.add(JSON.stringify(extractSchema(v)))
    }
    return { '<Map>': { keys: [...keySchemas].map(s => JSON.parse(s)), values: [...valSchemas].map(s => JSON.parse(s)) } }
  }

  // Set
  if (obj instanceof Set) {
    if (obj.size === 0) return { '<Set>': 'empty' }
    const schemas = new Set()
    for (const v of obj) {
      schemas.add(JSON.stringify(extractSchema(v)))
    }
    return { '<Set>': [...schemas].map(s => JSON.parse(s)) }
  }

  if (Array.isArray(obj)) {
    if (obj.length === 0) return 'array'
    // Sample up to 5 elements to detect mixed-type arrays
    const sampleSize = Math.min(obj.length, 5)
    const schemas = []
    const seen = new Set()
    for (let i = 0; i < sampleSize; i++) {
      const s = extractSchema(obj[i])
      const key = JSON.stringify(s)
      if (!seen.has(key)) {
        seen.add(key)
        schemas.push(s)
      }
    }
    // If all elements share the same schema, return single-element array like before
    if (schemas.length === 1) return [schemas[0]]
    // Mixed types — return array of unique schemas
    return schemas
  }
  if (typeof obj === 'object') {
    const keys = Object.keys(obj).sort()
    const schema = {}
    for (const k of keys) {
      schema[k] = extractSchema(obj[k])
    }
    return schema
  }
  return typeof obj  // "string", "number", "boolean"
}

// fingerprint.js — deterministic hash for regression contracts
// No dependencies. Works in Node.js 16+.

import { createHash } from 'crypto'

/**
 * Stable JSON stringify — keys sorted recursively.
 * { b:2, a:1 } and { a:1, b:2 } produce identical output.
 *
 * Handles Map objects by converting them to sorted entry arrays,
 * since JSON.stringify(new Map()) produces "{}" which loses all data.
 */
export function stableStringify(obj) {
  if (obj === null || obj === undefined) return String(obj)
  // Handle BigInt — serialize as tagged string for deterministic representation
  // e.g., 18n → "__bigint__:18" — collision-resistant tag prevents confusion with
  // real strings that happen to start with "BigInt:"
  if (typeof obj === 'bigint') {
    return '__bigint__:' + obj.toString()
  }
  // Handle Map — convert to sorted array of entries for deterministic serialization
  if (obj instanceof Map) {
    const entries = [...obj.entries()].sort((a, b) => String(a[0]).localeCompare(String(b[0])))
    return 'Map:' + stableStringify(entries)
  }
  // Handle TypedArrays (Uint8Array, Int32Array, etc.) — convert to regular arrays
  // so that Uint8Array [1,2,3] serializes as [1,2,3], not {"0":1,"1":2,"2":3}
  if (ArrayBuffer.isView(obj) && !(obj instanceof DataView)) {
    return '[' + Array.from(obj).map(stableStringify).join(',') + ']'
  }
  if (Array.isArray(obj)) return '[' + obj.map(stableStringify).join(',') + ']'
  if (obj instanceof DataView) {
    return '<DataView:' + Array.from(new Uint8Array(obj.buffer, obj.byteOffset, obj.byteLength)).map(b => b.toString(16).padStart(2, '0')).join('') + '>'
  }
  if (typeof obj === 'object') {
    const keys = Object.keys(obj).sort()
    return '{' + keys.map(k => JSON.stringify(k) + ':' + stableStringify(obj[k])).join(',') + '}'
  }
  return JSON.stringify(obj)
}

/**
 * Normalize non-deterministic values before hashing.
 * Pass normalize array from cluster manifest.
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
    // dynamicDates: replace embedded MMYYYY or YYYY date patterns in strings
    // e.g. "FPK-052026" → "FPK-<MMYYYY>", "DOC-2026" → "DOC-<YYYY>"
    // Narrowed: MMYYYY requires valid month (01-12), YYYY only matches standalone years
    if (rules.includes('dynamicDates')) {
      return obj
        .replace(/(0[1-9]|1[0-2])\d{4}/g, '<MMYYYY>')   // MMYYYY with valid month (01-12)
        .replace(/(?<![0-9])(20\d{2}|19\d{2})(?![0-9])/g, '<YYYY>')  // 4-digit year
    }
  }
  if (typeof obj === 'number') {
    if (rules.includes('epochs') && obj > 1_000_000_000 && obj < 9_999_999_999_999) {
      return '<EPOCH>'
    }
  }
  if (Array.isArray(obj)) return obj.map(v => normalize(v, rules))
  // Handle TypedArrays — convert to regular arrays before recursing
  if (ArrayBuffer.isView(obj) && !(obj instanceof DataView)) {
    return Array.from(obj).map(v => normalize(v, rules))
  }
  if (obj && typeof obj === 'object') {
    return Object.fromEntries(Object.entries(obj).map(([k, v]) => [k, normalize(v, rules)]))
  }
  return obj
}

/**
 * Strip ignored fields from output before hashing.
 */
export function stripFields(obj, ignoreFields = []) {
  if (!ignoreFields.length) return obj
  if (Array.isArray(obj)) return obj.map(v => stripFields(v, ignoreFields))
  // Handle TypedArrays — convert to regular arrays before stripping
  if (ArrayBuffer.isView(obj) && !(obj instanceof DataView)) {
    return Array.from(obj).map(v => stripFields(v, ignoreFields))
  }
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
 * Extract structural schema from a JSON value.
 * All values replaced with their type name for structural fingerprinting.
 * Used by fingerprintMode: "schema" and "mixed".
 *
 * For arrays with mixed types, each unique schema is captured
 * (up to 5 elements to avoid infinite schemas).
 */
export function extractSchema(obj) {
  if (obj === null) return 'null'
  if (obj === undefined) return 'undefined'
  // Handle TypedArrays — treat as arrays for schema extraction
  if (ArrayBuffer.isView(obj) && !(obj instanceof DataView)) {
    return extractSchema(Array.from(obj))
  }
  if (obj instanceof DataView) return 'binary'
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

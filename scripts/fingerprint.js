// fingerprint.js — deterministic hash for regression contracts
// No dependencies. Works in Node.js 16+.

import { createHash } from 'crypto'
import { deepClone } from './ghost.js'

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
    // normalizeNow: replace current-date-derived strings in output with placeholders.
    // For functions that call new Date() internally and produce date-based output
    // (e.g., filenameFallback generating "FPK-062026" from current month).
    // Replaces MMYYYY patterns AND standalone YYYY patterns — same as dynamicDates
    // but also handles the common case where the ENTIRE output is a date-derived string.
    // This is semantically different from dynamicDates (which is for embedded dates in
    // larger strings): normalizeNow signals "this function's output IS a current-time value".
    if (rules.includes('normalizeNow')) {
      return obj
        .replace(/(0[1-9]|1[0-2])\d{4}/g, '<NOW_MMYYYY>')   // MMYYYY
        .replace(/(?<![0-9])(20\d{2}|19\d{2})(?![0-9])/g, '<NOW_YYYY>')  // YYYY
    }
    // floatPrecision: normalize float-like strings that differ only in trailing zeros
    // Common in OCR output where "1500000.0" and "1500000" should be equivalent.
    // Strips trailing ".0" from number-like strings (including negative).
    if (rules.includes('floatPrecision')) {
      return obj.replace(/^-?(\d+)\.0+$/, '$1')
    }
    // incrementingIds: normalize auto-incrementing or unique IDs that change across runs.
    // Handles patterns from lodash/uniqueId ("rjsf-array-item-1", "rjsf-array-item-2"),
    // nanoid, crypto.randomUUID, React.useId, and similar generators.
    // Replaces strings matching <prefix><digits> or pure hex/alnum IDs with <ID>.
    // This is essential for React component libraries that use uniqueId for keys,
    // where the internal counter never resets between runs.
    if (rules.includes('incrementingIds')) {
      // Pattern 1: prefix + incrementing number (lodash/uniqueId style)
      // e.g., "rjsf-array-item-42", "field-0", ":r0:", ":r1:"
      if (/^(.+[-_:])(\d+)$/.test(obj)) {
        return obj.replace(/^(.+[-_:])\d+$/, '$1<ID>')
      }
      // Pattern 2: pure numeric ID (e.g., "42")
      if (/^\d+$/.test(obj) && obj.length <= 10) {
        return '<ID>'
      }
      // Pattern 3: React useId format ":r0:", ":r1:", ":rs0:", ":rs1:"
      if (/^:r[s]?\d+:$/.test(obj)) {
        return '<ID>'
      }
      // Pattern 4: UUID-like hex strings without dashes (nanoid short, etc.)
      // e.g., "V1StGXR8_Z5jdHi6B-myT" or "abc123def456"
      if (/^[A-Za-z0-9_-]{8,30}$/.test(obj) && !/^(true|false|null|undefined|NaN|Infinity)$/.test(obj)) {
        // Heuristic: if it looks like a random ID (has both letters and digits), normalize it
        if (/[A-Za-z]/.test(obj) && /\d/.test(obj)) {
          return '<ID>'
        }
      }
    }
  }
  if (typeof obj === 'number') {
    if (rules.includes('epochs') && obj > 1_000_000_000 && obj < 9_999_999_999_999) {
      return '<EPOCH>'
    }
    // floatTolerance: round floating-point numbers to N decimal places before hashing.
    // Prevents false negatives from tiny floating-point representation differences
    // (e.g., 123456.0 vs 123456.00000001 in financial/scientific computing).
    // Usage: "floatTolerance" (default 2 decimal places) or "floatTolerance:N" for N places.
    if (rules.some(r => r.startsWith('floatTolerance'))) {
      const rule = rules.find(r => r.startsWith('floatTolerance'))
      const decimals = rule.includes(':') ? parseInt(rule.split(':')[1], 10) : 2
      const factor = Math.pow(10, decimals)
      return Math.round(obj * factor) / factor
    }
    // floatPrecision: normalize numbers that are whole but stored as float
    // e.g., 1500000.0 → 1500000 (common in OCR/parsing pipelines)
    if (rules.includes('floatPrecision') && Number.isInteger(obj)) {
      return obj  // already an integer, no change needed
    }
    if (rules.includes('floatPrecision') && !Number.isInteger(obj) && Number.isFinite(obj)) {
      // Round to 2 decimal places to normalize precision differences
      return Math.round(obj * 100) / 100
    }
  }
  if (Array.isArray(obj)) {
    // incrementingIds: also normalize numeric array indices that act as keys
    // When used in React lists, array indices map to incrementing IDs.
    // We don't normalize the array elements themselves, only string values within them.
    return obj.map(v => normalize(v, rules))
  }
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

/**
 * Transform output before fingerprinting, enabling class-heavy libraries.
 * JS-side equivalent of Python's snapshot_output().
 *
 * Supported transforms:
 * - null/undefined: pass through (use deepClone as before)
 * - 'to_dict': call val.toDict() if available
 * - 'to_json': call val.toJSON() if available
 * - 'repr': use JSON.stringify(val) as the fingerprinted value
 * - 'hex': convert Buffer/Uint8Array to hex string
 * - function: call transform(val) and use the result
 */
export function snapshotOutput(val, transform) {
  if (transform == null) return deepClone(val)

  // If transform is a function, call it directly
  if (typeof transform === 'function') {
    return deepClone(transform(val))
  }

  // Handle arrays — transform each element
  if (Array.isArray(val)) {
    return val.map(v => snapshotOutput(v, transform))
  }

  // Named transforms
  if (transform === 'to_dict' && val && typeof val.toDict === 'function') {
    return deepClone(val.toDict())
  }
  if (transform === 'to_json' && val && typeof val.toJSON === 'function') {
    return deepClone(val.toJSON())
  }
  if (transform === 'repr') {
    return JSON.stringify(val)
  }
  if (transform === 'hex') {
    if (Buffer.isBuffer(val) || (ArrayBuffer.isView(val) && !(val instanceof DataView))) {
      return Buffer.from(val).toString('hex')
    }
    return deepClone(val)
  }

  // Unknown transform — fall back to deepClone
  return deepClone(val)
}

/**
 * Capture a snapshot of the current Node.js environment for reproducibility.
 * Records key environment facts that could affect fingerprint stability.
 */
export function getEnvSnapshot() {
  const snapshot = {
    node_version: process.version,
    platform: process.platform,
    arch: process.arch,
  }

  // Check for optional packages that affect behavior
  const optionalPackages = ['numpy', 'gmpy2']
  for (const pkg of optionalPackages) {
    try {
      const mod = require(pkg)
      snapshot[pkg] = mod.version || 'installed'
    } catch {
      snapshot[pkg] = 'not_installed'
    }
  }

  return snapshot
}

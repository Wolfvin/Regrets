// diff-utils.js — pure diff functions extracted for testability
// Used by diff.js and tests/diff.test.js

/**
 * Deep-compare two values and return an array of differences.
 * Each difference has: { path, expected, actual, type }
 * Types: value_mismatch, length_mismatch, type_mismatch, added_key, removed_key, float_tolerance
 */
export function deepDiff(expected, actual, path = '') {
  const diffs = []

  if (expected === actual) return diffs

  // Type mismatch
  if (typeof expected !== typeof actual || expected === null || actual === null) {
    if (expected !== actual) {
      diffs.push({ path: path || '(root)', expected, actual, type: 'value_mismatch' })
    }
    return diffs
  }

  // Array comparison
  if (Array.isArray(expected) && Array.isArray(actual)) {
    if (expected.length !== actual.length) {
      diffs.push({ path: path || '(root)', expected: `array[${expected.length}]`, actual: `array[${actual.length}]`, type: 'length_mismatch' })
    }
    const maxLen = Math.max(expected.length, actual.length)
    for (let i = 0; i < maxLen; i++) {
      const eVal = i < expected.length ? expected[i] : undefined
      const aVal = i < actual.length ? actual[i] : undefined
      const subPath = `${path}[${i}]`
      diffs.push(...deepDiff(eVal, aVal, subPath))
    }
    return diffs
  }

  // Object comparison
  if (typeof expected === 'object' && typeof actual === 'object') {
    if (Array.isArray(expected) !== Array.isArray(actual)) {
      diffs.push({ path: path || '(root)', expected, actual, type: 'type_mismatch' })
      return diffs
    }
    const allKeys = new Set([...Object.keys(expected), ...Object.keys(actual)])
    for (const key of allKeys) {
      const subPath = path ? `${path}.${key}` : key
      if (!(key in expected)) {
        diffs.push({ path: subPath, expected: undefined, actual: actual[key], type: 'added_key' })
      } else if (!(key in actual)) {
        diffs.push({ path: subPath, expected: expected[key], actual: undefined, type: 'removed_key' })
      } else {
        diffs.push(...deepDiff(expected[key], actual[key], subPath))
      }
    }
    return diffs
  }

  // Primitive comparison
  if (expected !== actual) {
    // Check if it's a float tolerance issue
    if (typeof expected === 'number' && typeof actual === 'number') {
      const diff = Math.abs(expected - actual)
      const relDiff = expected !== 0 ? diff / Math.abs(expected) : diff
      if (diff < 0.01 || relDiff < 1e-10) {
        diffs.push({ path: path || '(root)', expected, actual, type: 'float_tolerance', diff })
        return diffs
      }
    }
    diffs.push({ path: path || '(root)', expected, actual, type: 'value_mismatch' })
  }

  return diffs
}

/**
 * Format a value for display, truncating long strings.
 */
export function formatValue(val, maxLen = 80) {
  if (val === undefined) return 'undefined'
  if (val === null) return 'null'
  const str = typeof val === 'object' ? JSON.stringify(val) : String(val)
  return str.length > maxLen ? str.slice(0, maxLen) + '...' : str
}

/**
 * Format an array of diffs into a human-readable string.
 */
export function formatDiffs(diffs) {
  if (!diffs.length) return '  (no differences)'

  const lines = []
  for (const d of diffs) {
    const icon = d.type === 'float_tolerance' ? '≈' : d.type === 'added_key' ? '+' : d.type === 'removed_key' ? '-' : '≠'
    lines.push(`  ${icon} ${d.path}`)
    lines.push(`      golden:  ${formatValue(d.expected)}`)
    lines.push(`      live:    ${formatValue(d.actual)}`)
    if (d.type === 'float_tolerance') {
      lines.push(`      diff:    ${d.diff} (within float tolerance)`)
    }
    if (d.type === 'length_mismatch') {
      lines.push(`      ⚠️  Array length changed — this likely means added/removed items`)
    }
  }
  return lines.join('\n')
}

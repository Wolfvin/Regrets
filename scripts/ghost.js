// ghost.js — shared Ghost Proxy utilities
// Used by capture.js, validate.js, and capture_react.mjs.
// Do NOT duplicate these functions. Import them: import { createGhost, deepClone, normalizeHtml } from './ghost.js'

/**
 * Deep clone a value via JSON round-trip.
 * Handles most JSON-compatible values. Non-JSON values pass through unchanged.
 * TypedArrays are converted to regular arrays so they serialize deterministically.
 */
export function deepClone(val) {
  // Handle TypedArrays — convert to regular array before cloning
  // Without this, JSON.stringify(Uint8Array) produces {"0":1,"1":2,...} instead of [1,2,...]
  if (ArrayBuffer.isView(val) && !(val instanceof DataView)) {
    return Array.from(val)
  }
  try { return JSON.parse(JSON.stringify(val)) } catch { return val }
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

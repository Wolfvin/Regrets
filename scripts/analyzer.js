// analyzer.js — Static analyzer interface (stub)
//
// Drop-in interface for the upcoming WASM-based static analyzer that will
// replace the regex scanner in scan.js. This file currently ships a stub
// implementation so the call site in scan.js can be wired up today without
// waiting for the WASM integration. Behavior is intentionally a no-op:
// analyzeScope returns empty results, detectLanguage returns the same
// extension-based guess scan.js already does internally.
//
// When the WASM analyzer (tree-sitter subset from codebase-memory-mcp) is
// ready, replace the bodies of these two functions — the call site in
// scan.js does not need to change.

import { extname } from 'path'

/**
 * Analyze a file or folder for function definitions and call edges.
 *
 * @param {string} scopePath - absolute path to a file or folder
 * @returns {Promise<{functions: Array<{name: string, file: string, line: number}>, edges: Array<{from: string, to: string}>}>}
 */
export async function analyzeScope(scopePath) {
  // TODO: replace with WASM call to codebase-memory-mcp subset
  return { functions: [], edges: [] }
}

/**
 * Detect source language from a file path.
 *
 * @param {string} filePath
 * @returns {Promise<'javascript' | 'typescript' | 'python' | 'unknown'>}
 */
export async function detectLanguage(filePath) {
  // TODO: replace with WASM call
  const ext = extname(filePath).toLowerCase()
  const map = {
    '.js': 'javascript',
    '.mjs': 'javascript',
    '.cjs': 'javascript',
    '.ts': 'typescript',
    '.tsx': 'typescript',
    '.py': 'python',
  }
  return map[ext] || 'unknown'
}

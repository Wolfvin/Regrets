#!/usr/bin/env node
// cjs-merge.js — Shared CJS module merge utility
// When a CommonJS module is imported via ESM dynamic import, named exports
// may not be available — they're on `mod.default`. This utility merges them
// so that both `entry` and `classMethod` lookups work correctly.
//
// Usage: import { mergeCjsModule } from './cjs-merge.js'
//        const rawModule = mergeCjsModule(await import(moduleUrl))

/**
 * Merge CJS module exports for consistent access patterns.
 *
 * Case 1: mod.default is an object (multi-export CJS like levenshtein_distance)
 *         → merge its keys into the module namespace
 * Case 2: mod.default is a function (single-class CJS like TfIdf, Trie)
 *         → expose it under its .name property for classMethod/entry lookup
 *
 * @param {object} rawModule - The module object from dynamic import()
 * @returns {object} Merged module with named exports accessible at top level
 */
export function mergeCjsModule (rawModule) {
  if (rawModule.default && typeof rawModule.default === 'object' && !Array.isArray(rawModule.default)) {
    const merged = { ...rawModule }
    for (const key of Object.keys(rawModule.default)) {
      if (!(key in merged)) {
        merged[key] = rawModule.default[key]
      }
    }
    return merged
  }

  if (rawModule.default && typeof rawModule.default === 'function') {
    const merged = { ...rawModule }
    const fnName = rawModule.default.name
    if (fnName && !(fnName in merged)) {
      merged[fnName] = rawModule.default
    }
    return merged
  }

  return rawModule
}

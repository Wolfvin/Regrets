#!/usr/bin/env node
// diagnose.js — Diagnose a module's export pattern and recommend Regrets mode
//
// When setting up Regrets on a CJS project, figuring out whether to use
// entry, classMethod, or singletonMethod is a painful manual process.
// This script imports a file, inspects its exports, and tells you:
// 1. What the module exports (functions, classes, objects, singletons)
// 2. Which Regrets entry mode to use for each export
// 3. Suggested manifest cluster definitions
//
// Usage:
//   node scripts/diagnose.js lib/natural/stemmers/porter_stemmer.js
//   node scripts/diagnose.js lib/natural/distance/jaro-winkler_distance.js

import { resolve, dirname } from 'path'
import { fileURLToPath, pathToFileURL } from 'url'
import { mergeCjsModule } from './cjs-merge.js'

const __dirname = dirname(fileURLToPath(import.meta.url))

const args = process.argv.slice(2)
const filePath = args[0]

if (!filePath) {
  console.error('❌ Usage: node scripts/diagnose.js <file-path>')
  console.error('   Example: node scripts/diagnose.js lib/natural/stemmers/porter_stemmer.js')
  process.exit(1)
}

const absPath = resolve(process.cwd(), filePath)
console.log(`\n🔍 Diagnosing: ${filePath}\n`)

try {
  let rawModule = await import(pathToFileURL(absPath).href)
  const originalKeys = Object.keys(rawModule)

  // Apply CJS merge
  rawModule = mergeCjsModule(rawModule)

  const exports = []
  const suggestions = []

  for (const [name, value] of Object.entries(rawModule)) {
    if (name === 'default' || name === 'module.exports') continue

    const type = typeof value
    const isClass = type === 'function' && /^\s*class\s/.test(value.toString().slice(0, 20))
    const isConstructor = type === 'function' && !isClass && value.prototype && Object.keys(value.prototype).length > 0
    const isPlainFunction = type === 'function' && !isClass && !isConstructor

    if (isClass) {
      // ES6 class — use classMethod
      const methods = Object.getOwnPropertyNames(value.prototype)
        .filter(m => m !== 'constructor' && typeof value.prototype[m] === 'function')

      exports.push({ name, type: 'class', methods })
      for (const method of methods) {
        suggestions.push({
          mode: 'classMethod',
          entry: name,
          classMethod: method,
          constructor: name,
          reason: `${name} is an ES6 class with method .${method}()`
        })
      }
    } else if (isConstructor) {
      // Old-style constructor with prototype methods
      const methods = Object.getOwnPropertyNames(value.prototype)
        .filter(m => m !== 'constructor' && typeof value.prototype[m] === 'function')

      exports.push({ name, type: 'constructor (prototype-based)', methods })
      for (const method of methods) {
        suggestions.push({
          mode: 'classMethod',
          entry: name,
          classMethod: method,
          constructor: name,
          reason: `${name} is a constructor function with prototype method .${method}()`
        })
      }
    } else if (isPlainFunction) {
      // Plain function — use entry mode
      exports.push({ name, type: 'function' })
      suggestions.push({
        mode: 'entry (function)',
        entry: name,
        reason: `${name} is a plain function`
      })
    } else if (type === 'object' && value !== null) {
      // Object — could be a singleton with methods
      const methods = Object.keys(value).filter(k => typeof value[k] === 'function')

      if (methods.length > 0) {
        exports.push({ name, type: 'singleton object', methods })
        for (const method of methods) {
          // Skip internal-looking methods (starting with _ or step)
          if (method.startsWith('_') || method.startsWith('step')) continue
          suggestions.push({
            mode: 'singletonMethod',
            entry: name,
            singletonMethod: method,
            singletonName: name,
            reason: `${name} is a singleton object with method .${method}() — use singletonMethod mode`
          })
        }
      } else {
        exports.push({ name, type: 'object (data only, no methods)' })
      }
    }
  }

  // Also check if the default export is a function (CJS module.exports = function)
  if (rawModule.default && typeof rawModule.default === 'function' && !rawModule.default.prototype) {
    const fnName = rawModule.default.name || '(anonymous)'
    exports.push({ name: 'default (function)', type: 'default function export', fnName })
    suggestions.push({
      mode: 'entry (default function)',
      entry: 'default',
      reason: `Module exports a single function: ${fnName}. Use entry: "default"`
    })
  }

  // Also check if the default export is a singleton with methods
  if (rawModule.default && typeof rawModule.default === 'object' && !Array.isArray(rawModule.default)) {
    const defaultMethods = Object.keys(rawModule.default).filter(k => typeof rawModule.default[k] === 'function')
    if (defaultMethods.length > 0 && exports.length === 0) {
      // The default IS the singleton (e.g., module.exports = new Stemmer())
      exports.push({ name: 'default (singleton)', type: 'default singleton object', methods: defaultMethods })
      for (const method of defaultMethods) {
        if (method.startsWith('_') || method.startsWith('step')) continue
        suggestions.push({
          mode: 'singletonMethod',
          entry: '(any name)',
          singletonMethod: method,
          singletonName: '(any name)',
          reason: `Default export is a singleton object with .${method}() — use singletonMethod mode. The entry/singletonName can be any label you choose.`
        })
      }
    }
  }

  // ─── Report ────────────────────────────────────────────────────────────────

  if (exports.length === 0) {
    console.log('⚠️  No exports detected. This file may be a data file or use an unsupported pattern.')
  } else {
    console.log('EXPORTS FOUND:')
    console.log('─'.repeat(60))
    for (const exp of exports) {
      if (exp.methods) {
        console.log(`  📦 ${exp.name} (${exp.type})`)
        console.log(`     Methods: ${exp.methods.join(', ')}`)
      } else if (exp.fnName) {
        console.log(`  📦 ${exp.name} (${exp.type})`)
        console.log(`     Function name: ${exp.fnName}`)
      } else {
        console.log(`  📦 ${exp.name} (${exp.type})`)
      }
    }
  }

  if (suggestions.length > 0) {
    console.log(`\nSUGGESTED CLUSTER MODES:`)
    console.log('─'.repeat(60))
    for (const s of suggestions) {
      const modeIcon = s.mode === 'classMethod' ? '🏗️ ' : s.mode === 'singletonMethod' ? '🎯' : '⚡'
      console.log(`  ${modeIcon} ${s.mode}`)
      if (s.entry) console.log(`     entry: "${s.entry}"`)
      if (s.classMethod) console.log(`     classMethod: "${s.classMethod}"`)
      if (s.constructor) console.log(`     constructor: "${s.constructor}"`)
      if (s.singletonMethod) console.log(`     singletonMethod: "${s.singletonMethod}"`)
      if (s.singletonName) console.log(`     singletonName: "${s.singletonName}"`)
      console.log(`     → ${s.reason}`)
    }
  }

  console.log()

} catch (err) {
  console.error(`❌ Failed to import: ${err.message}`)
  process.exit(1)
}

#!/usr/bin/env node
// generate-adapter.js — generates an adapter module for class-instance libraries
//
// Many TypeScript libraries export class instances rather than plain functions.
// Regrets' Ghost Proxy cannot wrap instance methods directly. This script
// generates an adapter module that bridges the gap.
//
// Usage:
//   node scripts/generate-adapter.js --module ./lib/index.js --methods compute,validate,generate
//   node scripts/generate-adapter.js --module ./lib/index.js --methods compute,validate --output regret-adapters.mjs

import { pathToFileURL } from 'url'
import { resolve } from 'path'
import { writeFileSync } from 'fs'

// ─── CLI args ─────────────────────────────────────────────────────────────────

function getArg(args, flag) {
  const i = args.indexOf(flag)
  return i !== -1 ? args[i + 1] ?? null : null
}

const args = process.argv.slice(2)
const modulePath = getArg(args, '--module')
const methodsStr = getArg(args, '--methods')
const outputPath = getArg(args, '--output') ?? 'regret-adapters.mjs'

if (!modulePath || !methodsStr) {
  console.error(`
generate-adapter.js — Generate adapter module for class-instance libraries

Usage:
  node scripts/generate-adapter.js --module <path> --methods <method1,method2,...>
  node scripts/generate-adapter.js --module ./lib/index.js --methods compute,validate

Options:
  --module   Path to the compiled module (relative to CWD)
  --methods  Comma-separated list of method names to adapt
  --output   Output file name (default: regret-adapters.mjs)
`)
  process.exit(1)
}

const methods = methodsStr.split(',').map(m => m.trim()).filter(Boolean)

// ─── Detect exports ────────────────────────────────────────────────────────────

async function detectExports(modPath) {
  const absPath = resolve(process.cwd(), modPath)
  const moduleUrl = pathToFileURL(absPath).href
  const mod = await import(moduleUrl)

  const exports = []
  for (const [name, value] of Object.entries(mod)) {
    if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
      // Check if this looks like a class instance with the target methods
      const availableMethods = methods.filter(m => typeof value[m] === 'function')
      if (availableMethods.length > 0) {
        exports.push({ name, methods: availableMethods })
      }
    }
  }
  return exports
}

// ─── Generate adapter code ─────────────────────────────────────────────────────

function generateAdapter(modulePath, exports) {
  const lines = [
    '// Auto-generated adapter module for Regrets regression testing',
    '// This module bridges class-instance exports to standalone functions',
    '// that can be wrapped by the Ghost Proxy.',
    '',
    `import { ${exports.map(e => e.name).join(', ')} } from '${modulePath}';`,
    '',
  ]

  for (const exp of exports) {
    for (const method of exp.methods) {
      const fnName = `${exp.name}${method.charAt(0).toUpperCase()}${method.slice(1)}`
      lines.push(`export function ${fnName}(...args) { return ${exp.name}.${method}(...args); }`)
    }
    lines.push('')
  }

  return lines.join('\n')
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log('📡 Detecting class-instance exports...\n')

  const exports = await detectExports(modulePath)

  if (exports.length === 0) {
    console.error('❌ No class-instance exports with the specified methods found.')
    console.error('   Make sure the module path is correct and the exports are objects with the specified methods.')
    process.exit(1)
  }

  console.log(`Found ${exports.length} class-instance export(s):\n`)
  for (const exp of exports) {
    console.log(`  ${exp.name}: ${exp.methods.join(', ')}`)
  }

  const code = generateAdapter(modulePath, exports)
  const outPath = resolve(process.cwd(), outputPath)
  writeFileSync(outPath, code, 'utf8')

  console.log(`\n✅ Adapter module generated: ${outputPath}`)
  console.log(`   Import path: ${modulePath}`)
  console.log(`   Methods adapted: ${methods.join(', ')}`)
  console.log(`\nNext steps:`)
  console.log(`  1. Edit regrets/manifest.json — reference adapter functions in "entry" and "watches"`)
  console.log(`  2. Set "file" to "${outputPath}" in each cluster`)
  console.log(`  3. Run: node scripts/capture.js`)
}

main().catch(err => {
  console.error('Fatal:', err.message)
  process.exit(1)
})

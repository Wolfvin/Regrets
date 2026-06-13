#!/usr/bin/env node
// init.js — scaffolding command that creates the regrets/ directory structure
// in the target project for regret-based regression testing.
//
// Usage:
//   node scripts/init.js           # creates regrets/ with manifest.json template
//   node scripts/init.js --force   # overwrite existing

import { existsSync, mkdirSync, writeFileSync } from 'fs'
import { resolve, join } from 'path'

// ─── CLI args ─────────────────────────────────────────────────────────────────

const args = process.argv.slice(2)
const force = args.includes('--force')

// ─── Target paths ─────────────────────────────────────────────────────────────

const regretsDir  = resolve(process.cwd(), 'regrets')
const manifestPath = join(regretsDir, 'manifest.json')
const gitkeepPath  = join(regretsDir, '.gitkeep')

// ─── Manifest template ────────────────────────────────────────────────────────

const manifestTemplate = {
  clusters: [
    {
      id: 'example-cluster',
      entry: 'myFunction',
      watches: ['myFunction', 'myHelper'],
      file: 'src/my-module.js',
      stack: 'js',
      fingerprintLevel: 'entry',
      description: 'Example cluster — replace with your actual cluster definitions',
      inputs: [
        { sample: 'input-1' },
        null
      ]
    }
  ]
}

// ─── Pre-flight check ─────────────────────────────────────────────────────────

if (existsSync(regretsDir) && !force) {
  console.error(`❌ regrets/ directory already exists at: ${regretsDir}`)
  console.error(`   Use --force to overwrite, or edit the existing manifest directly.`)
  process.exit(1)
}

if (existsSync(regretsDir) && force) {
  console.log(`⚠️  --force flag provided — overwriting existing regrets/ structure.`)
}

// ─── Create directory structure ────────────────────────────────────────────────

try {
  mkdirSync(regretsDir, { recursive: true })
  console.log(`📁 Created: ${regretsDir}`)
} catch (err) {
  console.error(`❌ Failed to create regrets/ directory: ${err.message}`)
  process.exit(1)
}

// ─── Write manifest.json ──────────────────────────────────────────────────────

try {
  writeFileSync(manifestPath, JSON.stringify(manifestTemplate, null, 2) + '\n', 'utf8')
  console.log(`📄 Created: ${manifestPath}`)
} catch (err) {
  console.error(`❌ Failed to write manifest.json: ${err.message}`)
  process.exit(1)
}

// ─── Write .gitkeep (placeholder for audit.log directory tracking) ────────────

try {
  writeFileSync(gitkeepPath, '', 'utf8')
  console.log(`📌 Created: ${gitkeepPath}`)
} catch (err) {
  console.error(`❌ Failed to write .gitkeep: ${err.message}`)
  process.exit(1)
}

// ─── Success ──────────────────────────────────────────────────────────────────

console.log()
console.log(`✅ regrets/ directory scaffolded successfully!`)
console.log()
console.log(`Next steps:`)
console.log(`  1. Edit regrets/manifest.json — replace the example cluster with your actual cluster definitions`)
console.log(`  2. Set cluster fields: id, entry, watches, file, stack, inputs`)
console.log(`  3. Run: npm run regret:build     (compile TypeScript if needed)`)
console.log(`  4. Run: npm run regret:capture   (capture behavioral fingerprints)`)
console.log(`  5. Run: npm run regret:drift      (5 runs — ensure all STABLE)`)
console.log(`  6. Run: npm run regret:health     (check cluster health scores)`)
console.log()
console.log(`See SKILL.md and references/ for full documentation.`)

#!/usr/bin/env node
// init.js — scaffolding command that creates the regrets/ directory structure
// in the target project for regret-based regression testing.
//
// Usage:
//   node scripts/init.js                     # creates regrets/ with manifest.json template (stack: js)
//   node scripts/init.js --stack python       # creates regrets/ with Python manifest template
//   node scripts/init.js --stack php          # creates regrets/ with PHP manifest template
//   node scripts/init.js --stack go           # creates regrets/ with Go manifest template
//   node scripts/init.js --force              # overwrite existing

import { existsSync, mkdirSync, writeFileSync } from 'fs'
import { resolve, join } from 'path'

// ─── CLI args ─────────────────────────────────────────────────────────────────

const args = process.argv.slice(2)
const force = args.includes('--force')
const validStacks = ['js', 'python', 'php', 'go', 'ts', 'css', 'jq']
let stack = args.find(a => a.startsWith('--stack='))?.split('=')[1]
  ?? args[args.indexOf('--stack') + 1]
  ?? 'js'

if (!validStacks.includes(stack)) {
  console.error(`❌ Unknown stack: "${stack}". Valid stacks: ${validStacks.join(', ')}`)
  process.exit(1)
}

// ─── Target paths ─────────────────────────────────────────────────────────────

const regretsDir  = resolve(process.cwd(), 'regrets')
const manifestPath = join(regretsDir, 'manifest.json')
const gitkeepPath  = join(regretsDir, '.gitkeep')

// ─── Manifest templates by stack ──────────────────────────────────────────────

const templates = {
  js: {
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
  },
  python: {
    clusters: [
      {
        id: 'example-cluster',
        entry: 'my_function',
        watches: ['my_function'],
        module: 'my_package.my_module',
        stack: 'python',
        pythonPath: '.',
        description: 'Example Python cluster — replace with your actual cluster definitions',
        inputs: [
          'sample_input_1',
          null
        ]
      }
    ]
  },
  php: {
    clusters: [
      {
        id: 'example-cluster',
        entry: 'myFunction',
        watches: ['myFunction'],
        file: 'src/MyClass.php',
        stack: 'php',
        description: 'Example PHP cluster — replace with your actual cluster definitions',
        inputs: [
          'sample_input_1',
          null
        ]
      }
    ]
  },
  go: {
    clusters: [
      {
        id: 'example-cluster',
        entry: 'MyFunction',
        watches: ['MyFunction'],
        file: 'mypackage/myfunction.go',
        stack: 'go',
        description: 'Example Go cluster — replace with your actual cluster definitions',
        inputs: [
          'sample_input_1',
          null
        ]
      }
    ]
  },
  ts: {
    clusters: [
      {
        id: 'example-cluster',
        entry: 'myFunction',
        watches: ['myFunction', 'myHelper'],
        file: 'src/my-module.ts',
        stack: 'ts',
        fingerprintLevel: 'entry',
        description: 'Example TypeScript cluster — replace with your actual cluster definitions',
        inputs: [
          { sample: 'input-1' },
          null
        ]
      }
    ]
  },
  css: {
    clusters: [
      {
        id: 'postcss-transform',
        entry: 'transform',
        watches: ['transform'],
        file: 'plugins/my-postcss-plugin.js',
        stack: 'css',
        fingerprintLevel: 'entry',
        description: 'PostCSS plugin that transforms CSS — replace with your actual cluster definitions',
        inputs: [
          { css: '.a { color: red; }', opts: {} },
          { css: '@media (min-width: 768px) { .b { color: blue; } }', opts: {} }
        ]
      },
      {
        id: 'sass-function',
        entry: 'compileSass',
        watches: ['compileSass'],
        file: 'src/sass-compiler.js',
        stack: 'css',
        fingerprintLevel: 'entry',
        description: 'Sass/SCSS compilation function — replace with your actual cluster definitions',
        inputs: [
          { source: '$primary: #333; .btn { color: $primary; }' },
          { source: '@mixin flex { display: flex; } .container { @include flex; }' }
        ]
      }
    ]
  }
}

const manifestTemplate = templates[stack] || templates.js

// ─── Pre-flight check ─────────────────────────────────────────────────────────

if (existsSync(regretsDir) && !force) {
  console.warn(`⚠️  regrets/ directory already exists at: ${regretsDir}`)
  console.warn(`   Skipping init to avoid overwriting existing data.`)
  console.warn(`   Use --force to overwrite, or edit the existing manifest directly.`)
  process.exit(0)
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
console.log(`✅ regrets/ directory scaffolded successfully! (stack: ${stack})`)
console.log()
console.log(`Next: edit regrets/manifest.json, then run: node scripts/regret.js capture`)
if (stack === 'python') {
  console.log()
  console.log(`📦 Note for Python stack: make sure to install project dependencies first:`)
  console.log(`   pip install -r requirements.txt   (or your project's dependency file)`)
}
if (stack === 'php') {
  console.log()
  console.log(`📦 Note for PHP stack: make sure composer dependencies are installed:`)
  console.log(`   composer install`)
}
if (stack === 'go') {
  console.log()
  console.log(`📦 Note for Go stack: make sure dependencies are available:`)
  console.log(`   go mod tidy`)
}
if (stack === 'jq') {
  console.log()
  console.log(`📦 Note for jq stack: requires jq 1.6+ (jq --version).`)
  console.log(`   Also requires sha256sum, python3, and jq on PATH.`)
  console.log(`   Your .jq file must use jq 'def' functions callable via 'include "file"; funcname'.`)
  console.log(`   See proof/jq_slugify/ for a working end-to-end example.`)
}
if (stack === 'css') {
  console.log()
  console.log(`📦 Note for CSS stack: CSS uses the JS runner (capture.js / validate.js).`)
  console.log(`   Your module should export a function that takes CSS input and returns the transformed output.`)
  console.log(`   See references/css-stack-guide.md for PostCSS, Sass, and CSS-in-JS examples.`)
}
console.log()
console.log(`See SKILL.md and references/ for full documentation.`)

#!/usr/bin/env node
// ci-init.js — generate .github/workflows/regrets.yml for CI integration
// Usage:
//   node scripts/ci-init.js
//   node scripts/ci-init.js --force    (overwrite existing workflow file)
//
// Auto-detects stack from regrets/manifest.json and generates appropriate steps.

import { readFileSync, existsSync, mkdirSync, writeFileSync } from 'fs'
import { resolve, join } from 'path'

// ─── CLI args ─────────────────────────────────────────────────────────────────

const args = process.argv.slice(2)
const force = args.includes('--force')

// ─── Detect stacks from manifest ──────────────────────────────────────────────

const manifestPath = resolve(process.cwd(), 'regrets/manifest.json')
let stacks = ['js']
try {
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  const stackSet = new Set()
  for (const cluster of manifest.clusters) {
    stackSet.add(cluster.stack || 'js')
  }
  stacks = [...stackSet]
} catch {
  // No manifest yet — default to js
}

// ─── Target path ──────────────────────────────────────────────────────────────

const workflowDir = resolve(process.cwd(), '.github/workflows')
const workflowPath = join(workflowDir, 'regrets.yml')

// ─── Pre-flight: check if file already exists ────────────────────────────────

if (existsSync(workflowPath) && !force) {
  console.warn(`⚠️  Workflow file already exists: ${workflowPath}`)
  console.warn(`   Use --force to overwrite, or edit the file directly.`)
  process.exit(0)
}

if (existsSync(workflowPath) && force) {
  console.log(`⚠️  --force flag provided — overwriting existing workflow file.`)
}

// ─── Build workflow steps based on detected stacks ───────────────────────────

const hasJs = stacks.some(s => s === 'js' || s === 'ts' || s === 'react')
const hasTs = stacks.includes('ts')
const hasPython = stacks.includes('python')
const hasPhp = stacks.includes('php')
const hasGo = stacks.includes('go')
const hasRust = stacks.includes('rust')

const setupSteps = []
const installSteps = []

if (hasJs || hasReact) {
  setupSteps.push('      - uses: actions/setup-node@v4')
  setupSteps.push('        with:')
  setupSteps.push('          node-version: 20')
  installSteps.push('      - run: npm ci')
}

if (hasTs) {
  // TypeScript needs node + build step
  if (!hasJs && !hasReact) {
    setupSteps.push('      - uses: actions/setup-node@v4')
    setupSteps.push('        with:')
    setupSteps.push('          node-version: 20')
    installSteps.push('      - run: npm ci')
  }
  installSteps.push('      - run: npm run build')
}

if (hasPython) {
  setupSteps.push('      - uses: actions/setup-python@v5')
  setupSteps.push('        with:')
  setupSteps.push('          python-version: "3.12"')
  installSteps.push('      - run: pip install -r requirements.txt')
}

if (hasPhp) {
  setupSteps.push('      - uses: shivammathur/setup-php@v2')
  setupSteps.push('        with:')
  setupSteps.push('          php-version: "8.3"')
  installSteps.push('      - run: composer install --no-interaction')
}

if (hasGo) {
  setupSteps.push('      - uses: actions/setup-go@v5')
  setupSteps.push('        with:')
  setupSteps.push('          go-version: "1.22"')
  installSteps.push('      - run: go mod tidy')
}

if (hasRust) {
  // No special setup needed — cargo is included in rust-toolchain
  installSteps.push('      - run: cargo build')
}

// ─── Generate workflow YAML ──────────────────────────────────────────────────

const workflowYaml = `name: Regrets — Regression Guard

on:
  pull_request:
    branches: [main]
  push:
    branches: [main]

jobs:
  regrets:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
${setupSteps.join('\n')}
${installSteps.join('\n')}

      - name: Capture fingerprints (if missing)
        run: |
          if [ ! -d regrets ] || [ -z "\$(find regrets -name '*.regret')" ]; then
            echo "No .regret files found — running capture..."
            node scripts/regret.js capture
          else
            echo "Existing .regret files found — skipping capture."
          fi

      - name: Validate fingerprints
        run: node scripts/regret.js validate --reporter junit

      - name: Upload JUnit results
        if: always()
        uses: actions/upload-artifact@v4
        with:
          name: regrets-junit
          path: regrets/results.xml

      - name: Test Report
        if: always()
        uses: dorny/test-reporter@v1
        with:
          name: Regrets Results
          path: regrets/results.xml
          reporter: java-junit
`

// ─── Write file ───────────────────────────────────────────────────────────────

try {
  mkdirSync(workflowDir, { recursive: true })
} catch (err) {
  console.error(`❌ Failed to create .github/workflows/ directory: ${err.message}`)
  process.exit(1)
}

try {
  writeFileSync(workflowPath, workflowYaml, 'utf8')
} catch (err) {
  console.error(`❌ Failed to write workflow file: ${err.message}`)
  process.exit(1)
}

// ─── Success ──────────────────────────────────────────────────────────────────

console.log()
console.log(`✅ GitHub Actions workflow generated: ${workflowPath}`)
console.log()
console.log(`   Detected stacks: ${stacks.join(', ')}`)
console.log()
console.log(`   The workflow will:`)
console.log(`     1. Checkout code and install dependencies`)
console.log(`     2. Run 'regret capture' if no .regret files exist`)
console.log(`     3. Run 'regret validate --reporter junit' to check fingerprints`)
console.log(`     4. Upload JUnit XML as artifact`)
console.log(`     5. Publish test report (dorny/test-reporter)`)
console.log()
console.log(`   Commit this file and push to enable CI integration.`)
console.log()

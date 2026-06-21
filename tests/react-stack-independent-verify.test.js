// tests/react-stack-independent-verify.test.js
//
// Independent verification of the React stack (PRs #348 + #410 + #449).
//
// This test file uses a DIFFERENT fixture than tests/validate-react-multi-input.test.js
// to avoid confirmation bias (CONTEXT.md "Lesson Learned"). The existing
// test file uses the InvoiceCard fixture from proof/react_demo/. This file
// uses the ProductBadge/StatusPill fixture from proofs/react_independent/,
// which exercises different React patterns:
//   - Function component (not class)
//   - Boolean prop with default
//   - Array prop with default
//   - Array.map() with key prop
//   - Inline style object
//   - Template literal in className
//   - Conditional rendering with .filter(Boolean)
//   - Object lookup table
//
// If validate_react.mjs only works on InvoiceCard's patterns, this test
// would expose the gap.
//
// Run: node --test tests/react-stack-independent-verify.test.js

import { describe, it, before, beforeEach, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, writeFileSync, rmSync, existsSync, readFileSync, readdirSync } from 'node:fs'
import { resolve, join } from 'node:path'

const REPO_ROOT = resolve(import.meta.dirname, '..')
const CAPTURE_JS  = join(REPO_ROOT, 'scripts', 'capture_react.mjs')
const VALIDATE_JS = join(REPO_ROOT, 'scripts', 'validate_react.mjs')
const FINGERPRINT_JS = join(REPO_ROOT, 'scripts', 'fingerprint.js')

const TMP = resolve(REPO_ROOT, 'tests', `__react_indep_${process.pid}__`)

const PRODUCT_BADGE_SOURCE = `
import React from 'react'

export function ProductBadge({ product, showStock = true, tags = [] }) {
  const stockLabel = product.inStock ? 'In Stock' : 'Out of Stock'
  const stockClass = product.inStock ? 'badge-stock-yes' : 'badge-stock-no'
  return React.createElement('div', { className: \`product-badge \${stockClass}\`, style: { padding: '8px' } }, [
    React.createElement('h3', { key: 'name' }, product.name),
    React.createElement('span', { key: 'price', className: 'price' }, \`$\${product.price.toFixed(2)}\`),
    showStock && React.createElement('span', { key: 'stock', className: 'stock' }, stockLabel),
    tags.length > 0 && React.createElement('ul', { key: 'tags', className: 'tags' },
      tags.map((t, i) => React.createElement('li', { key: \`tag-\${i}\` }, t))
    ),
  ].filter(Boolean))
}

export function StatusPill({ status }) {
  const labels = { active: 'Active', paused: 'Paused', done: 'Completed' }
  const label = labels[status] || 'Unknown'
  return React.createElement('span', { className: \`status-pill status-\${status}\` }, label)
}

export default ProductBadge
`

const PRODUCT_BADGE_BREAKING = `
import React from 'react'

export function ProductBadge({ product, showStock = true, tags = [] }) {
  const stockLabel = product.inStock ? 'In Stock' : 'Out of Stock'
  const stockClass = product.inStock ? 'badge-stock-yes' : 'badge-stock-no'
  return React.createElement('div', { className: \`product-badge \${stockClass}\`, style: { padding: '8px' } }, [
    React.createElement('h3', { key: 'name' }, product.name),
    React.createElement('span', { key: 'price', className: 'price' }, \`$\${product.price.toFixed(2)}\`),
    showStock && React.createElement('span', { key: 'stock', className: 'stock' }, stockLabel),
    tags.length > 0 && React.createElement('ul', { key: 'tags', className: 'tags' },
      tags.map((t, i) => React.createElement('li', { key: \`tag-\${i}\` }, t))
    ),
  ].filter(Boolean))
}

export function StatusPill({ status }) {
  // BREAKING: 'Active' → 'ACTIVE' (case change)
  const labels = { active: 'ACTIVE', paused: 'Paused', done: 'Completed' }
  const label = labels[status] || 'Unknown'
  return React.createElement('span', { className: \`status-pill status-\${status}\` }, label)
}

export default ProductBadge
`

function setupProject() {
  mkdirSync(join(TMP, 'src'), { recursive: true })
  mkdirSync(join(TMP, 'regrets'), { recursive: true })
  writeFileSync(join(TMP, 'src', 'ProductBadge.js'), PRODUCT_BADGE_SOURCE)
  writeFileSync(join(TMP, 'package.json'), JSON.stringify({
    name: 'react-indep-test',
    version: '1.0.0',
    type: 'module',
    dependencies: { react: '^18.3.1', 'react-dom': '^18.3.1' },
  }))
  writeFileSync(join(TMP, 'regrets', 'manifest.json'), JSON.stringify({
    clusters: [
      {
        id: 'product-badge-full',
        entry: 'ProductBadge',
        file: './src/ProductBadge.js',
        stack: 'react',
        fingerprintLevel: 'entry',
        watches: [],
        inputs: [{
          product: { name: 'Widget Pro', price: 29.99, inStock: true },
          showStock: true,
          tags: ['new', 'sale'],
        }],
      },
      {
        id: 'product-badge-no-stock',
        entry: 'ProductBadge',
        file: './src/ProductBadge.js',
        stack: 'react',
        fingerprintLevel: 'entry',
        watches: [],
        inputs: [{
          product: { name: 'Gadget Mini', price: 9.5, inStock: false },
          showStock: false,
          tags: [],
        }],
      },
      {
        id: 'status-pill-active',
        entry: 'StatusPill',
        file: './src/ProductBadge.js',
        stack: 'react',
        fingerprintLevel: 'entry',
        watches: [],
        inputs: [{ status: 'active' }],
      },
      {
        id: 'status-pill-unknown',
        entry: 'StatusPill',
        file: './src/ProductBadge.js',
        stack: 'react',
        fingerprintLevel: 'entry',
        watches: [],
        inputs: [{ status: 'archived' }],
      },
    ],
  }))
}

function runCapture() {
  const r = spawnSync('node', [CAPTURE_JS], { cwd: TMP, encoding: 'utf8', timeout: 30_000 })
  return { exitCode: r.status ?? 1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' }
}

function runValidate() {
  const r = spawnSync('node', [VALIDATE_JS], { cwd: TMP, encoding: 'utf8', timeout: 30_000 })
  return { exitCode: r.status ?? 1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' }
}

before(() => {
  rmSync(TMP, { recursive: true, force: true })
  setupProject()
})
beforeEach(() => {
  // Reset source + clear regrets between tests
  writeFileSync(join(TMP, 'src', 'ProductBadge.js'), PRODUCT_BADGE_SOURCE)
  rmSync(join(TMP, 'regrets'), { recursive: true, force: true })
  mkdirSync(join(TMP, 'regrets'), { recursive: true })
  // Re-write manifest (it was inside regrets/)
  writeFileSync(join(TMP, 'regrets', 'manifest.json'), JSON.stringify({
    clusters: [
      {
        id: 'product-badge-full', entry: 'ProductBadge', file: './src/ProductBadge.js',
        stack: 'react', fingerprintLevel: 'entry', watches: [],
        inputs: [{ product: { name: 'Widget Pro', price: 29.99, inStock: true }, showStock: true, tags: ['new', 'sale'] }],
      },
      {
        id: 'product-badge-no-stock', entry: 'ProductBadge', file: './src/ProductBadge.js',
        stack: 'react', fingerprintLevel: 'entry', watches: [],
        inputs: [{ product: { name: 'Gadget Mini', price: 9.5, inStock: false }, showStock: false, tags: [] }],
      },
      {
        id: 'status-pill-active', entry: 'StatusPill', file: './src/ProductBadge.js',
        stack: 'react', fingerprintLevel: 'entry', watches: [],
        inputs: [{ status: 'active' }],
      },
      {
        id: 'status-pill-unknown', entry: 'StatusPill', file: './src/ProductBadge.js',
        stack: 'react', fingerprintLevel: 'entry', watches: [],
        inputs: [{ status: 'archived' }],
      },
    ],
  }))
})
after(() => { rmSync(TMP, { recursive: true, force: true }) })

describe('React stack — independent verification (function components, array.map, conditional render)', () => {
  it('capture writes 4 .regret files with all required fields', () => {
    const r = runCapture()
    assert.equal(r.exitCode, 0, `capture failed: ${r.stderr}`)
    assert.match(r.stdout, /React capture complete: 4 captured, 0 failed/)

    for (const id of ['product-badge-full', 'product-badge-no-stock', 'status-pill-active', 'status-pill-unknown']) {
      const regretPath = join(TMP, 'regrets', `${id}.regret`)
      assert.ok(existsSync(regretPath), `.regret file for ${id} should exist`)
      const content = readFileSync(regretPath, 'utf8')
      // Required fields per the contract
      assert.match(content, /^cluster: /m, `${id}: missing cluster field`)
      assert.match(content, /^version: 1/m, `${id}: missing version field`)
      assert.match(content, /^fingerprint: [a-z0-9]{7}/m, `${id}: missing/invalid fingerprint`)
      assert.match(content, /^captured: \d{4}-\d{2}-\d{2}T/m, `${id}: missing captured timestamp`)
      assert.match(content, /^entry: /m, `${id}: missing entry field`)
      assert.match(content, /^stack: react/m, `${id}: missing/invalid stack field`)
      assert.match(content, /^renderMode: static/m, `${id}: missing/invalid renderMode`)
      assert.match(content, /^---$/m, `${id}: missing --- separator`)
      assert.match(content, /^INPUT\s+/m, `${id}: missing INPUT line`)
      assert.match(content, /^OUTPUT\s+/m, `${id}: missing OUTPUT line`)
      assert.match(content, /^HASH\s+[a-z0-9]{7}/m, `${id}: missing/invalid HASH line`)
    }
  })

  it('validate PASSes for all 4 clusters when code is unchanged', () => {
    runCapture()  // generate .regret files
    const r = runValidate()
    assert.equal(r.exitCode, 0, `validate should PASS, got exit ${r.exitCode}\nstdout: ${r.stdout}`)
    assert.match(r.stdout, /All 4 React tests passed/)
    for (const id of ['product-badge-full', 'product-badge-no-stock', 'status-pill-active', 'status-pill-unknown']) {
      assert.match(r.stdout, new RegExp(`✅\\s+${id}\\s+\\S+\\s+PASS`), `${id} should PASS`)
    }
  })

  it('validate FAILs after breaking refactor of StatusPill labels (case change)', () => {
    runCapture()
    writeFileSync(join(TMP, 'src', 'ProductBadge.js'), PRODUCT_BADGE_BREAKING)

    const r = runValidate()
    assert.notEqual(r.exitCode, 0, 'validate should FAIL after breaking refactor')
    assert.match(r.stdout, /❌\s+status-pill-active.*FAIL/,
      'status-pill-active should FAIL (label changed Active → ACTIVE)')
    assert.match(r.stdout, /1\/4 FAILED/,
      'exactly 1 of 4 clusters should fail')
    // Other clusters should still PASS
    assert.match(r.stdout, /✅\s+product-badge-full.*PASS/)
    assert.match(r.stdout, /✅\s+product-badge-no-stock.*PASS/)
    assert.match(r.stdout, /✅\s+status-pill-unknown.*PASS/)
  })

  it('validate PASSes again after code is restored', () => {
    runCapture()
    writeFileSync(join(TMP, 'src', 'ProductBadge.js'), PRODUCT_BADGE_BREAKING)
    runValidate()  // should fail
    // Restore original
    writeFileSync(join(TMP, 'src', 'ProductBadge.js'), PRODUCT_BADGE_SOURCE)

    const r = runValidate()
    assert.equal(r.exitCode, 0, 'validate should PASS after restore')
    assert.match(r.stdout, /All 4 React tests passed/)
  })

  it('cross-stack fingerprint parity — React HASH === JS fingerprint(input, output)', async () => {
    runCapture()
    const { fingerprint } = await import(FINGERPRINT_JS)

    for (const id of ['product-badge-full', 'product-badge-no-stock', 'status-pill-active', 'status-pill-unknown']) {
      const regretPath = join(TMP, 'regrets', `${id}.regret`)
      const content = readFileSync(regretPath, 'utf8')
      const inputMatch = content.match(/^INPUT\s+(.+)$/m)
      const outputMatch = content.match(/^OUTPUT\s+(.+)$/m)
      const hashMatch = content.match(/^HASH\s+(\S+)/m)
      const input = JSON.parse(inputMatch[1])
      const output = JSON.parse(outputMatch[1])
      const golden = hashMatch[1]
      const jsHash = fingerprint(input, output)
      assert.equal(jsHash, golden,
        `${id}: React hash (${golden}) must match JS reference (${jsHash}) — cross-stack parity`)
    }
  })
})

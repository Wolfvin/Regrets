// tests/validate-react-multi-input.test.js — React multi-input contract tests
//
// Mirrors tests/validate-all-inputs.test.js (JS Issue #315) but for the React
// stack. Verifies that:
//   1. capture_react.mjs writes the INPUTS line for multi-input manifests
//   2. capture_react.mjs OMITS the INPUTS line for single-input (no overhead)
//   3. validate_react.mjs PASSES when no behavior changed (all inputs match)
//   4. validate_react.mjs FAILs when ONLY a later input (input[1+]) changes
//      — this is the core #315 scenario (false GREEN without INPUTS)
//   5. validate_react.mjs JSON output includes multiInputFailures array
//   6. update mode refreshes the INPUTS line (next validate PASSES)
//   7. backward compat: old .regret without INPUTS line still validates
//
// Run: node --test tests/validate-react-multi-input.test.js

import { describe, it, before, after, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import {
  mkdirSync, writeFileSync, rmSync, existsSync, readFileSync,
} from 'node:fs'
import { resolve, join } from 'node:path'

const SCRIPTS_DIR = resolve(import.meta.dirname, '..', 'scripts')
const CAPTURE_REACT  = join(SCRIPTS_DIR, 'capture_react.mjs')
const VALIDATE_REACT = join(SCRIPTS_DIR, 'validate_react.mjs')

// Use a tmp dir INSIDE the Regrets working tree so .git is reachable
// (validate_react.mjs looks up git config for the audit.log entry on update).
const TMP = resolve(join(process.cwd(), 'tests', `__react_multi_input_${process.pid}__`))

function sh(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { cwd: TMP, stdio: 'pipe', ...opts })
  return {
    exitCode: r.status ?? 1,
    stdout: r.stdout ? r.stdout.toString() : '',
    stderr: r.stderr ? r.stderr.toString() : '',
  }
}

// A simple React component with status-dependent rendering.
// Used as the fingerprint target — the rendered HTML changes when the
// statusLabel switch changes, so a breaking change to one status (e.g.,
// 'void' → 'Cancelled') produces a different hash ONLY for that input.
function setupProject(componentCode, inputs, clusterId = 'StatusCard', opts = {}) {
  mkdirSync(join(TMP, 'regrets'), { recursive: true })
  mkdirSync(join(TMP, 'src'), { recursive: true })
  writeFileSync(join(TMP, 'src', 'StatusCard.js'), componentCode)
  writeFileSync(join(TMP, 'package.json'), JSON.stringify({
    name: 'react-multi-input-test', version: '0.0.0', type: 'module',
  }))
  writeFileSync(join(TMP, 'regrets', 'manifest.json'), JSON.stringify({
    clusters: [{
      id: clusterId,
      entry: 'StatusCard',
      file: 'src/StatusCard.js',
      stack: 'react',
      renderMode: 'static',
      fingerprintLevel: 'entry',
      stripAttrs: opts.stripAttrs || [],
      inputs,
    }],
  }, null, 2))
}

function cleanup() {
  if (existsSync(TMP)) rmSync(TMP, { recursive: true, force: true })
}

function readRegret(id = 'StatusCard') {
  return readFileSync(join(TMP, 'regrets', `${id}.regret`), 'utf8')
}

// Component: renders a status badge + message. The switch statement is the
// regression-sensitive surface — changing one label changes one input's hash.
const COMPONENT_BASE = `import React from 'react'

export function StatusCard({ status, message }) {
  let label
  switch (status) {
    case 'paid':    return React.createElement('div', { className: 'card paid' }, 'Paid: ' + (message || ''))
    case 'unpaid':  return React.createElement('div', { className: 'card unpaid' }, 'Unpaid: ' + (message || ''))
    case 'overdue': return React.createElement('div', { className: 'card overdue' }, 'Overdue: ' + (message || ''))
    case 'void':    return React.createElement('div', { className: 'card void' }, 'Void: ' + (message || ''))
    default:        return React.createElement('div', { className: 'card unknown' }, 'Unknown: ' + (message || ''))
  }
}

export default StatusCard
`

// Breaking variant: only the 'void' label changes ('Void' → 'Cancelled').
// Inputs with status: 'paid'/'unpaid'/'overdue' produce IDENTICAL HTML to
// the base component — only the 'void' input's hash differs. This is the
// exact #315 scenario for React.
const COMPONENT_VOID_BROKEN = `import React from 'react'

export function StatusCard({ status, message }) {
  switch (status) {
    case 'paid':    return React.createElement('div', { className: 'card paid' }, 'Paid: ' + (message || ''))
    case 'unpaid':  return React.createElement('div', { className: 'card unpaid' }, 'Unpaid: ' + (message || ''))
    case 'overdue': return React.createElement('div', { className: 'card overdue' }, 'Overdue: ' + (message || ''))
    case 'void':    return React.createElement('div', { className: 'card void' }, 'Cancelled: ' + (message || ''))
    default:        return React.createElement('div', { className: 'card unknown' }, 'Unknown: ' + (message || ''))
  }
}

export default StatusCard
`

const FOUR_INPUTS = [
  { status: 'paid',    message: 'invoice 0001' },
  { status: 'unpaid',  message: 'invoice 0002' },
  { status: 'overdue', message: 'invoice 0003' },
  { status: 'void',    message: 'invoice 0004' },
]

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('React #315 — capture_react.mjs writes INPUTS line for multi-input manifests', () => {
  beforeEach(() => {
    cleanup()
    setupProject(COMPONENT_BASE, FOUR_INPUTS)
  })
  after(() => cleanup())

  it('capture succeeds and writes .regret file', () => {
    const r = sh('node', [CAPTURE_REACT])
    assert.equal(r.exitCode, 0, `capture failed: ${r.stderr}`)
    assert.ok(existsSync(join(TMP, 'regrets', 'StatusCard.regret')),
      'StatusCard.regret should exist after capture')
  })

  it('.regret file contains an INPUTS line with 3 entries (inputs 1+)', () => {
    sh('node', [CAPTURE_REACT])
    const content = readRegret()
    assert.ok(content.includes('INPUTS '),
      '.regret should have an INPUTS line for multi-input manifests')
    const inputsLine = content.split('\n').find(l => l.startsWith('INPUTS '))
    assert.ok(inputsLine, 'INPUTS line should be findable')
    const parsed = JSON.parse(inputsLine.replace(/^INPUTS\s+/, ''))
    assert.ok(Array.isArray(parsed), 'INPUTS payload should be an array')
    assert.equal(parsed.length, 3,
      `INPUTS should have 3 entries (inputs 1+; input 0 is the top-level trio), got ${parsed.length}`)
    // Each entry should have input/output/hash
    for (const entry of parsed) {
      assert.ok('input' in entry, 'each INPUTS entry should have an input field')
      assert.ok('output' in entry, 'each INPUTS entry should have an output field')
      assert.ok('hash' in entry, 'each INPUTS entry should have a hash field')
      assert.ok(typeof entry.hash === 'string' && entry.hash.length >= 5,
        'each INPUTS entry hash should be a non-empty string')
    }
  })

  it('INPUTS line is omitted for single-input manifests (no overhead)', () => {
    cleanup()
    setupProject(COMPONENT_BASE, [{ status: 'paid', message: 'one' }])
    const r = sh('node', [CAPTURE_REACT])
    assert.equal(r.exitCode, 0, `capture failed: ${r.stderr}`)
    const content = readRegret()
    assert.ok(!content.includes('INPUTS '),
      'single-input .regret should NOT have an INPUTS line (no overhead)')
  })
})

describe('React #315 — validate_react.mjs checks ALL inputs (core fix)', () => {
  beforeEach(() => {
    cleanup()
    setupProject(COMPONENT_BASE, FOUR_INPUTS)
  })
  after(() => cleanup())

  it('validate PASSES when no behavior changed', () => {
    sh('node', [CAPTURE_REACT])
    const r = sh('node', [VALIDATE_REACT])
    assert.equal(r.exitCode, 0,
      `validate should PASS when no behavior changed. stderr: ${r.stderr}\nstdout: ${r.stdout}`)
    assert.match(r.stdout, /✅ StatusCard.*PASS/,
      'validate output should show StatusCard PASS')
  })

  it('validate FAILs when ONLY input[3] (status: void) changes behavior', () => {
    sh('node', [CAPTURE_REACT])
    // Change behavior: 'Void' → 'Cancelled' (only affects the void input)
    setupProject(COMPONENT_VOID_BROKEN, FOUR_INPUTS)
    const r = sh('node', [VALIDATE_REACT])
    assert.notEqual(r.exitCode, 0,
      'validate MUST exit non-zero when input[3] changed (the #315 bug was a false GREEN here)')
    assert.match(r.stdout, /❌ StatusCard.*FAIL/,
      'validate output should show StatusCard FAIL')
  })

  it('validate output identifies the multi-input failure breakdown', () => {
    sh('node', [CAPTURE_REACT])
    setupProject(COMPONENT_VOID_BROKEN, FOUR_INPUTS)
    const r = sh('node', [VALIDATE_REACT])
    // The summary should mention "Multi-input failure(s)" with the void input
    assert.match(r.stdout, /Multi-input failure/,
      'validate output should have a multi-input failure breakdown section')
    // Should mention the void invoice input (input[3])
    assert.match(r.stdout, /void/,
      'validate output should mention the void input that changed')
  })

  it('JSON output includes multiInputFailures array', () => {
    sh('node', [CAPTURE_REACT])
    setupProject(COMPONENT_VOID_BROKEN, FOUR_INPUTS)
    const r = sh('node', [VALIDATE_REACT, '--json'])
    assert.notEqual(r.exitCode, 0, 'validate --json should exit non-zero on failure')
    const parsed = JSON.parse(r.stdout)
    assert.ok(Array.isArray(parsed.results), 'JSON output should have a results array')
    const scResult = parsed.results.find(x => x.id === 'StatusCard')
    assert.ok(scResult, 'should have a result for StatusCard')
    assert.equal(scResult.pass, false, 'StatusCard result should be FAIL')
    assert.ok(Array.isArray(scResult.multiInputFailures),
      'StatusCard result should have a multiInputFailures array')
    assert.ok(scResult.multiInputFailures.length > 0,
      'multiInputFailures should have at least one entry')
    // The failing input should be the void one
    const fail = scResult.multiInputFailures[0]
    assert.equal(fail.input.status, 'void',
      `first multi-input failure should be the void input, got ${JSON.stringify(fail.input)}`)
    assert.ok(fail.goldenHash !== fail.liveHash,
      'golden and live hashes should differ for the failing input')
  })

  it('verbose output shows per-input hash comparison', () => {
    sh('node', [CAPTURE_REACT])
    const r = sh('node', [VALIDATE_REACT, '--verbose'])
    assert.equal(r.exitCode, 0, `verbose validate should PASS: ${r.stderr}`)
    // Verbose output should include "Multi-input (4 inputs):" with 4 lines
    assert.match(r.stdout, /Multi-input \(4 inputs\)/,
      'verbose output should show 4 inputs in multi-input section')
    // Each input line should show ✓ or ✗ marker
    const inputLines = r.stdout.split('\n').filter(l => /\[\d\]/.test(l))
    assert.ok(inputLines.length >= 4,
      `verbose output should show 4 per-input lines, got ${inputLines.length}`)
  })
})

describe('React #315 — update mode refreshes the INPUTS line', () => {
  beforeEach(() => {
    cleanup()
    setupProject(COMPONENT_BASE, FOUR_INPUTS)
  })
  after(() => cleanup())

  it('update mode writes new hashes to BOTH top-level and INPUTS line', () => {
    sh('node', [CAPTURE_REACT])
    // Apply the breaking change
    setupProject(COMPONENT_VOID_BROKEN, FOUR_INPUTS)

    // Read pre-update INPUTS line — capture the void input's original hash
    const beforeContent = readRegret()
    const beforeInputs = JSON.parse(
      beforeContent.split('\n').find(l => l.startsWith('INPUTS ')).replace(/^INPUTS\s+/, '')
    )
    const beforeVoidEntry = beforeInputs.find(e => e.input.status === 'void')
    assert.ok(beforeVoidEntry, 'void entry should be in INPUTS before update')

    // Run update with a valid 4+ word reason
    const r = sh('node', [
      VALIDATE_REACT,
      '--update', 'StatusCard',
      '--reason', 'status label changed from Void to Cancelled per new branding guideline',
    ])
    assert.equal(r.exitCode, 0, `update should succeed: ${r.stderr}\n${r.stdout}`)

    // Read post-update INPUTS line — void input's hash should have changed
    const afterContent = readRegret()
    const afterInputs = JSON.parse(
      afterContent.split('\n').find(l => l.startsWith('INPUTS ')).replace(/^INPUTS\s+/, '')
    )
    const afterVoidEntry = afterInputs.find(e => e.input.status === 'void')
    assert.ok(afterVoidEntry, 'void entry should still be in INPUTS after update')
    assert.notEqual(beforeVoidEntry.hash, afterVoidEntry.hash,
      'void input hash should change after update (was ' + beforeVoidEntry.hash +
      ', now ' + afterVoidEntry.hash + ')')
    // The output for the void input should now contain "Cancelled"
    assert.match(afterVoidEntry.output, /Cancelled/,
      'void output should contain the new "Cancelled" label after update')
  })

  it('after update, validate PASSES (no stale hashes)', () => {
    sh('node', [CAPTURE_REACT])
    setupProject(COMPONENT_VOID_BROKEN, FOUR_INPUTS)
    sh('node', [
      VALIDATE_REACT,
      '--update', 'StatusCard',
      '--reason', 'status label changed from Void to Cancelled per new branding guideline',
    ])
    // Validate should now PASS — both top-level and INPUTS hashes are refreshed
    const r = sh('node', [VALIDATE_REACT])
    assert.equal(r.exitCode, 0,
      `validate should PASS after update. stderr: ${r.stderr}\nstdout: ${r.stdout}`)
    assert.match(r.stdout, /✅ StatusCard.*PASS/,
      'validate output should show StatusCard PASS after update')
  })
})

describe('React #315 — backward compatibility with old .regret files (no INPUTS line)', () => {
  before(() => {
    cleanup()
    // Set up project with single input (will produce .regret without INPUTS line)
    setupProject(COMPONENT_BASE, [{ status: 'paid', message: 'one' }])
  })
  after(() => cleanup())

  it('old .regret (no INPUTS line) validates without crashing', () => {
    sh('node', [CAPTURE_REACT])
    const content = readRegret()
    assert.ok(!content.includes('INPUTS '),
      'single-input .regret should NOT have INPUTS line')
    const r = sh('node', [VALIDATE_REACT])
    assert.equal(r.exitCode, 0,
      `validate should PASS on single-input .regret: ${r.stderr}\n${r.stdout}`)
  })

  it('old .regret update mode works without crashing (no INPUTS line to refresh)', () => {
    sh('node', [CAPTURE_REACT])
    // Apply a breaking change to the single input
    setupProject(COMPONENT_VOID_BROKEN, [{ status: 'void', message: 'one' }])
    const r = sh('node', [
      VALIDATE_REACT,
      '--update', 'StatusCard',
      '--reason', 'status label changed from Void to Cancelled per new branding guideline',
    ])
    assert.equal(r.exitCode, 0,
      `update on single-input .regret should succeed: ${r.stderr}\n${r.stdout}`)
    // Validate after update should PASS (golden refreshed, no INPUTS to worry about)
    const r2 = sh('node', [VALIDATE_REACT])
    assert.equal(r2.exitCode, 0,
      `validate after single-input update should PASS: ${r2.stderr}`)
  })
})

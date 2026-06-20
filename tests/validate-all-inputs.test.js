// tests/validate-all-inputs.test.js — Issue #315 regression tests
//
// Validates that `regret validate` checks ALL inputs' hashes, not just
// the first one. Before #315, a breaking change that only affected
// inputs[1+] was invisible — validate reported GREEN even when a real
// regression existed.
//
// Coverage:
//   1. capture writes the INPUTS line when manifest has multiple inputs
//   2. validate PASSES when ALL inputs match (no behavior change)
//   3. validate FAILs when ONLY input[2] changes (the core #315 scenario)
//   4. validate FAILs when ONLY the last input changes
//   5. validate shows WHICH input(s) failed in the output
//   6. JSON output includes multiInputFailures array
//   7. update mode refreshes the INPUTS line (next validate PASSES)
//   8. backward compat: old .regret without INPUTS line still validates
//   9. backward compat: old .regret without INPUTS line doesn't crash on update
//  10. single-input manifest: no INPUTS line written (no overhead)
//
// Run: node --test tests/validate-all-inputs.test.js

import { describe, it, before, after, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import {
  mkdirSync, writeFileSync, rmSync, existsSync, readFileSync,
} from 'node:fs'
import { resolve, join } from 'node:path'

const SCRIPTS_DIR = resolve(import.meta.dirname, '..', 'scripts')
const CAPTURE_JS  = join(SCRIPTS_DIR, 'capture.js')
const VALIDATE_JS = join(SCRIPTS_DIR, 'validate.js')

// Use a tmp dir INSIDE the Regrets working tree so .git is reachable
// (some validate.js code paths look up git config).
const TMP = resolve(join(process.cwd(), 'tests', `__validate_all_inputs_${process.pid}__`))

function sh(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { cwd: TMP, stdio: 'pipe', ...opts })
  return {
    exitCode: r.status ?? 1,
    stdout: r.stdout ? r.stdout.toString() : '',
    stderr: r.stderr ? r.stderr.toString() : '',
  }
}

function setupProject(sourceCode, inputs) {
  mkdirSync(join(TMP, 'regrets'), { recursive: true })
  writeFileSync(join(TMP, 'api.mjs'), sourceCode)
  writeFileSync(join(TMP, 'package.json'), JSON.stringify({
    name: 'validate-all-inputs-test', version: '0.0.0', type: 'module',
  }))
  writeFileSync(join(TMP, 'regrets', 'manifest.json'), JSON.stringify({
    clusters: [{
      id: 'toFloat',
      entry: 'toFloat',
      file: 'api.mjs',
      stack: 'js',
      fingerprintLevel: 'entry',
      inputs,
      watches: [],
    }],
  }, null, 2))
}

function cleanup() {
  if (existsSync(TMP)) rmSync(TMP, { recursive: true, force: true })
}

function readRegret() {
  return readFileSync(join(TMP, 'regrets', 'toFloat.regret'), 'utf8')
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('#315 — capture writes INPUTS line for multi-input manifests', () => {
  beforeEach(() => {
    cleanup()
    setupProject(
      `export function toFloat(x) { return parseFloat(x) }`,
      ['3.14', '42', 'not-a-number', ''],
    )
  })
  after(() => cleanup())

  it('capture succeeds and writes .regret file', () => {
    const r = sh('node', [CAPTURE_JS])
    assert.equal(r.exitCode, 0, `capture failed: ${r.stderr}`)
    assert.ok(existsSync(join(TMP, 'regrets', 'toFloat.regret')),
      'toFloat.regret should exist after capture')
  })

  it('.regret file contains an INPUTS line with 3 entries (inputs 1+)', () => {
    sh('node', [CAPTURE_JS])
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
    mkdirSync(join(TMP, 'regrets'), { recursive: true })
    writeFileSync(join(TMP, 'api.mjs'), `export function double(x) { return x * 2 }`)
    writeFileSync(join(TMP, 'package.json'), JSON.stringify({
      name: 'validate-single-input', version: '0.0.0', type: 'module',
    }))
    writeFileSync(join(TMP, 'regrets', 'manifest.json'), JSON.stringify({
      clusters: [{
        id: 'double', entry: 'double', file: 'api.mjs', stack: 'js',
        fingerprintLevel: 'entry', inputs: [21], watches: [],
      }],
    }, null, 2))
    const r = sh('node', [CAPTURE_JS])
    assert.equal(r.exitCode, 0, `capture failed: ${r.stderr}`)
    const content = readFileSync(join(TMP, 'regrets', 'double.regret'), 'utf8')
    assert.ok(!content.includes('INPUTS '),
      'single-input .regret should NOT have an INPUTS line (no overhead)')
  })
})

describe('#315 — validate checks ALL inputs (core fix)', () => {
  beforeEach(() => {
    cleanup()
    // toFloat: parseFloat-based. NaN for invalid inputs.
    setupProject(
      `export function toFloat(x) { return parseFloat(x) }`,
      ['3.14', '42', 'not-a-number', ''],
    )
  })
  after(() => cleanup())

  it('validate PASSES when no behavior changed', () => {
    sh('node', [CAPTURE_JS])
    const r = sh('node', [VALIDATE_JS])
    assert.equal(r.exitCode, 0,
      `validate should PASS when no behavior changed. stderr: ${r.stderr}\nstdout: ${r.stdout}`)
    assert.match(r.stdout, /✅ toFloat.*PASS/,
      'validate output should show toFloat PASS')
  })

  it('validate FAILs when ONLY input[2] ("not-a-number") changes behavior', () => {
    sh('node', [CAPTURE_JS])
    // Change behavior: return 0 instead of NaN for invalid inputs.
    // This affects input[2]="not-a-number" and input[3]="" — but NOT
    // input[0]="3.14" or input[1]="42".
    setupProject(
      `export function toFloat(x) { const n = parseFloat(x); return isNaN(n) ? 0 : n }`,
      ['3.14', '42', 'not-a-number', ''],
    )
    const r = sh('node', [VALIDATE_JS])
    assert.notEqual(r.exitCode, 0,
      'validate MUST exit non-zero when input[2] changed (the #315 bug was a false GREEN here)')
    assert.match(r.stdout, /❌ toFloat.*FAIL/,
      'validate output should show toFloat FAIL')
  })

  it('validate output identifies WHICH input(s) failed', () => {
    sh('node', [CAPTURE_JS])
    setupProject(
      `export function toFloat(x) { const n = parseFloat(x); return isNaN(n) ? 0 : n }`,
      ['3.14', '42', 'not-a-number', ''],
    )
    const r = sh('node', [VALIDATE_JS])
    // The per-input failure breakdown should mention "not-a-number" and ""
    // (the two inputs whose behavior changed), but NOT "3.14" or "42".
    assert.match(r.stdout, /not-a-number/,
      'validate output should mention the "not-a-number" input that changed')
    assert.match(r.stdout, /additional input\(s\) changed behavior/,
      'validate output should have a per-input failure breakdown section')
  })

  it('JSON output includes multiInputFailures array', () => {
    sh('node', [CAPTURE_JS])
    setupProject(
      `export function toFloat(x) { const n = parseFloat(x); return isNaN(n) ? 0 : n }`,
      ['3.14', '42', 'not-a-number', ''],
    )
    const r = sh('node', [VALIDATE_JS, '--json'])
    assert.notEqual(r.exitCode, 0, 'validate --json should exit non-zero on failure')
    const parsed = JSON.parse(r.stdout)
    assert.ok(Array.isArray(parsed.clusters), 'JSON output should have a clusters array')
    const toFloatResult = parsed.clusters.find(x => x.id === 'toFloat')
    assert.ok(toFloatResult, 'should have a result for toFloat')
    assert.equal(toFloatResult.pass, false, 'toFloat result should be FAIL')
    assert.ok(Array.isArray(toFloatResult.multiInputFailures),
      'toFloat result should have a multiInputFailures array')
    assert.ok(toFloatResult.multiInputFailures.length >= 1,
      'multiInputFailures should have at least 1 entry (input[2] changed)')
    // Each failure should have input/goldenHash/liveHash
    for (const f of toFloatResult.multiInputFailures) {
      assert.ok('input' in f, 'each failure should have an input field')
      assert.ok('goldenHash' in f, 'each failure should have a goldenHash field')
      assert.ok('liveHash' in f, 'each failure should have a liveHash field')
      assert.notEqual(f.goldenHash, f.liveHash,
        'each failure should have a hash mismatch (golden !== live)')
    }
  })

  it('validate FAILs when ONLY the LAST input changes (not just input[2])', () => {
    sh('node', [CAPTURE_JS])
    // Change behavior ONLY for empty-string input: return -1 instead of NaN.
    // parseFloat("") === NaN, so we need a special case.
    setupProject(
      `export function toFloat(x) {
         if (x === '') return -1
         const n = parseFloat(x)
         return isNaN(n) ? NaN : n
       }`,
      ['3.14', '42', 'not-a-number', ''],
    )
    const r = sh('node', [VALIDATE_JS])
    assert.notEqual(r.exitCode, 0,
      'validate MUST FAIL when the LAST input changes (not just input[2])')
    assert.match(r.stdout, /❌ toFloat.*FAIL/,
      'validate output should show toFloat FAIL')
  })

  it('validate PASSES when behavior changes but ALL inputs still produce same output', () => {
    sh('node', [CAPTURE_JS])
    // Refactor: use `+x` (unary plus) instead of parseFloat(). For these
    // specific inputs, the outputs are identical:
    //   parseFloat("3.14") === 3.14,  +"3.14" === 3.14
    //   parseFloat("42")   === 42,    +"42"   === 42
    //   parseFloat("not-a-number") === NaN,  +"not-a-number" === NaN
    //   parseFloat("") === NaN,  +"" === 0   ← DIFFERENT! so we can't use +x
    //
    // Instead, refactor to an arrow function — same behavior, different
    // implementation. This is the safe-refactor case Regrets is designed
    // to protect: validate should PASS because no input's output changed.
    setupProject(
      `const _parseFloat = parseFloat
       export const toFloat = (x) => _parseFloat(x)`,
      ['3.14', '42', 'not-a-number', ''],
    )
    const r = sh('node', [VALIDATE_JS])
    assert.equal(r.exitCode, 0,
      `validate should PASS when the refactor preserves all input outputs. stderr: ${r.stderr}\nstdout: ${r.stdout}`)
    assert.match(r.stdout, /✅ toFloat.*PASS/,
      'validate output should show toFloat PASS')
  })
})

describe('#315 — update mode refreshes the INPUTS line', () => {
  beforeEach(() => {
    cleanup()
    setupProject(
      `export function toFloat(x) { return parseFloat(x) }`,
      ['3.14', '42', 'not-a-number', ''],
    )
  })
  after(() => cleanup())

  it('update mode writes new hashes to BOTH top-level and INPUTS line', () => {
    sh('node', [CAPTURE_JS])
    // Capture the original INPUTS line for comparison
    const originalContent = readRegret()
    const originalInputsLine = originalContent.split('\n').find(l => l.startsWith('INPUTS '))
    assert.ok(originalInputsLine, 'precondition: capture wrote an INPUTS line')

    // Change behavior
    setupProject(
      `export function toFloat(x) { const n = parseFloat(x); return isNaN(n) ? 0 : n }`,
      ['3.14', '42', 'not-a-number', ''],
    )

    // Run update
    const r = sh('node', [VALIDATE_JS, '--update', '--cluster', 'toFloat',
      '--reason', 'change toFloat to return 0 for invalid inputs instead of NaN test case'])
    assert.equal(r.exitCode, 0, `update failed: ${r.stderr}\nstdout: ${r.stdout}`)
    assert.match(r.stdout, /UPDATED/, 'update should report UPDATED')

    // The INPUTS line should have changed (new hashes for the changed inputs)
    const updatedContent = readRegret()
    const updatedInputsLine = updatedContent.split('\n').find(l => l.startsWith('INPUTS '))
    assert.ok(updatedInputsLine, 'INPUTS line should still exist after update')
    assert.notEqual(updatedInputsLine, originalInputsLine,
      'INPUTS line should be different after update (hashes refreshed)')

    // The updated INPUTS should have output:0 for "not-a-number" and ""
    const updatedInputs = JSON.parse(updatedInputsLine.replace(/^INPUTS\s+/, ''))
    const notANumberEntry = updatedInputs.find(e => e.input === 'not-a-number')
    assert.ok(notANumberEntry, 'updated INPUTS should have an entry for "not-a-number"')
    assert.equal(notANumberEntry.output, 0,
      'updated "not-a-number" entry should have output:0 (new behavior)')
  })

  it('after update, validate PASSES (no stale hashes)', () => {
    sh('node', [CAPTURE_JS])
    setupProject(
      `export function toFloat(x) { const n = parseFloat(x); return isNaN(n) ? 0 : n }`,
      ['3.14', '42', 'not-a-number', ''],
    )
    sh('node', [VALIDATE_JS, '--update', '--cluster', 'toFloat',
      '--reason', 'change toFloat to return 0 for invalid inputs instead of NaN test case'])

    // validate should now PASS — the INPUTS line was refreshed
    const r = sh('node', [VALIDATE_JS])
    assert.equal(r.exitCode, 0,
      `validate should PASS after update refreshed the INPUTS line. stderr: ${r.stderr}\nstdout: ${r.stdout}`)
    assert.match(r.stdout, /✅ toFloat.*PASS/,
      'validate should show toFloat PASS after update')
  })
})

describe('#315 — backward compatibility with old .regret files (no INPUTS line)', () => {
  beforeEach(() => {
    cleanup()
    mkdirSync(join(TMP, 'regrets'), { recursive: true })
    writeFileSync(join(TMP, 'api.mjs'), `export function toFloat(x) { return parseFloat(x) }`)
    writeFileSync(join(TMP, 'package.json'), JSON.stringify({
      name: 'validate-backward-compat', version: '0.0.0', type: 'module',
    }))
    writeFileSync(join(TMP, 'regrets', 'manifest.json'), JSON.stringify({
      clusters: [{
        id: 'toFloat', entry: 'toFloat', file: 'api.mjs', stack: 'js',
        fingerprintLevel: 'entry', inputs: ['3.14', '42', 'not-a-number', ''],
        watches: [],
      }],
    }, null, 2))
    // Hand-craft an OLD .regret file (pre-#315, no INPUTS line).
    // The golden hash matches toFloat("3.14") = 3.14.
    writeFileSync(join(TMP, 'regrets', 'toFloat.regret'), [
      'cluster: toFloat',
      'version: 1',
      'fingerprint: 5ko34vw',
      `captured: ${new Date().toISOString()}`,
      'watches: []',
      'entry: toFloat',
      'stack: js',
      'fingerprintLevel: entry',
      'env: {"node_version":"' + process.version + '","platform":"linux","arch":"x64","numpy":"not_installed","gmpy2":"not_installed"}',
      '---',
      'INPUT  "3.14"',
      'OUTPUT 3.14',
      'HASH   5ko34vw',
    ].join('\n'))
  })
  after(() => cleanup())

  it('old .regret (no INPUTS line) validates without crashing', () => {
    const r = sh('node', [VALIDATE_JS])
    assert.equal(r.exitCode, 0,
      `old .regret should validate without crash. stderr: ${r.stderr}\nstdout: ${r.stdout}`)
    assert.match(r.stdout, /✅ toFloat.*PASS/,
      'old .regret should PASS when behavior unchanged')
  })

  it('old .regret does NOT detect input[2] change (known limitation, documented)', () => {
    // Change behavior — old .regret won't catch it because it has no INPUTS line.
    writeFileSync(join(TMP, 'api.mjs'),
      `export function toFloat(x) { const n = parseFloat(x); return isNaN(n) ? 0 : n }`)
    const r = sh('node', [VALIDATE_JS])
    // This is the KNOWN limitation — old captures must re-capture to opt in.
    // We assert it doesn't crash and doesn't false-FAIL; the user just
    // doesn't get multi-input protection until they re-capture.
    assert.equal(r.exitCode, 0,
      `old .regret should not crash on behavior change (known limitation). stderr: ${r.stderr}`)
    assert.match(r.stdout, /✅ toFloat.*PASS/,
      'old .regret should still PASS (known limitation — re-capture to opt in)')
  })

  it('old .regret update mode works without crashing (no INPUTS line to refresh)', () => {
    writeFileSync(join(TMP, 'api.mjs'),
      `export function toFloat(x) { const n = parseFloat(x); return isNaN(n) ? 0 : n }`)
    const r = sh('node', [VALIDATE_JS, '--update', '--cluster', 'toFloat',
      '--reason', 'update old regret file without inputs line for backward compat test'])
    assert.equal(r.exitCode, 0,
      `update should not crash on old .regret without INPUTS line. stderr: ${r.stderr}\nstdout: ${r.stdout}`)
  })
})

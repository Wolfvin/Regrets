// validate-py-multi-input.test.js — test that validate.py checks ALL inputs (issue #330)
// Port of the JS #315 fix to Python: the Python validator should detect
// regressions in ANY input, not just the first one.

import { writeFileSync, mkdirSync, rmSync } from 'fs'
import { resolve, join } from 'path'
import { spawnSync } from 'child_process'
import { test, describe, before, after, it } from 'node:test'
import assert from 'node:assert/strict'
import { fingerprint } from '../scripts/fingerprint.js'

const REPO_ROOT = resolve(import.meta.dirname, '..')
const SCRIPTS_DIR = join(REPO_ROOT, 'scripts')
const VALIDATE_PY = join(SCRIPTS_DIR, 'validate.py')
const TMPDIR = join(REPO_ROOT, 'tests/__validate_py_multi_input__')

function runValidatePy(cwd) {
  const result = spawnSync('python3', [VALIDATE_PY], {
    cwd,
    encoding: 'utf8',
    timeout: 30_000,
  })
  return {
    exitCode: result.status ?? 1,
    stdout: result.stdout || '',
    stderr: result.stderr || '',
  }
}

describe('#330 — validate.py checks ALL inputs (multi-input contract)', () => {
  before(() => {
    mkdirSync(TMPDIR, { recursive: true })
    mkdirSync(join(TMPDIR, 'regrets'), { recursive: true })

    // Python module with a pure function
    writeFileSync(join(TMPDIR, 'mymod.py'), `
def greet(name):
    return f"Hello, {name}!"
`)

    // Manifest with 3 inputs for greet
    writeFileSync(join(TMPDIR, 'regrets', 'manifest.json'), JSON.stringify({
      clusters: [{
        id: 'greet',
        entry: 'greet',
        module: 'mymod',
        stack: 'python',
        pythonPath: '.',
        fingerprintLevel: 'entry',
        inputs: ['Alice', 'Bob', 'Charlie']
      }]
    }))

    // .regret file with INPUTS line (3 inputs)
    const hash0 = fingerprint('Alice', 'Hello, Alice!')
    const hash1 = fingerprint('Bob', 'Hello, Bob!')
    const hash2 = fingerprint('Charlie', 'Hello, Charlie!')

    writeFileSync(join(TMPDIR, 'regrets', 'greet.regret'), [
      'cluster: greet',
      'version: 1',
      `fingerprint: ${hash0}`,
      'captured: 2026-06-21T00:00:00Z',
      'entry: greet',
      'stack: python',
      'fingerprintLevel: entry',
      '---',
      `INPUT  "Alice"`,
      `OUTPUT "Hello, Alice!"`,
      `HASH   ${hash0}`,
      `INPUTS [{"input":"Bob","output":"Hello, Bob!","hash":"${hash1}"},{"input":"Charlie","output":"Hello, Charlie!","hash":"${hash2}"}]`,
    ].join('\n'))
  })

  after(() => {
    rmSync(TMPDIR, { recursive: true, force: true })
  })

  it('validate.py PASSES when no behavior changed', () => {
    const result = runValidatePy(TMPDIR)
    assert.equal(result.exitCode, 0, `Expected exit 0, got ${result.exitCode}\nstdout: ${result.stdout}\nstderr: ${result.stderr}`)
    assert.ok(result.stdout.includes('PASS'), `Expected PASS in output\nstdout: ${result.stdout}`)
  })

  it('validate.py FAILs when ONLY input[2] changes behavior', () => {
    // Change greet to return uppercase only for 'Charlie'
    writeFileSync(join(TMPDIR, 'mymod.py'), `
def greet(name):
    if name == "Charlie":
        return "HELLO, CHARLIE!"
    return f"Hello, {name}!"
`)

    const result = runValidatePy(TMPDIR)
    assert.notEqual(result.exitCode, 0, `Expected non-zero exit code, got ${result.exitCode}\nstdout: ${result.stdout}`)
    assert.ok(result.stdout.includes('FAIL'), `Expected FAIL in output\nstdout: ${result.stdout}`)
  })

  it('validate.py identifies WHICH input(s) failed', () => {
    const result = runValidatePy(TMPDIR)
    assert.ok(
      result.stdout.includes('additional input') || result.stdout.includes('multiInputFailures'),
      `Expected multi-input failure details\nstdout: ${result.stdout}`
    )
  })

  it('validate.py PASSES after restoring original behavior', () => {
    writeFileSync(join(TMPDIR, 'mymod.py'), `
def greet(name):
    return f"Hello, {name}!"
`)

    const result = runValidatePy(TMPDIR)
    assert.equal(result.exitCode, 0, `Expected exit 0 after restore, got ${result.exitCode}\nstdout: ${result.stdout}`)
  })
})

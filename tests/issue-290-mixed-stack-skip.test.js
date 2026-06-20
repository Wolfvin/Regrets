// tests/issue-290-mixed-stack-skip.test.js
// Closes #290: validate.py (and validate.js) must NOT count clusters skipped
// due to stack mismatch (e.g. a Python cluster seen by the JS validator, or
// a JS cluster seen by the Python validator) as failures. Exit code must
// reflect actual pass/fail, not skip count.
//
// We exercise both validators end-to-end against a mixed-stack manifest:
//   - validate.js against a manifest with one JS cluster + one Python cluster
//     → JS cluster runs, Python cluster is skipped → exit 0 (not exit 1).
//   - validate.py against a manifest with one JS cluster + one Python cluster
//     → Python cluster runs, JS cluster is skipped → exit 0 (not exit 1).

import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs'
import { resolve, join } from 'node:path'

const SCRIPTS_DIR = resolve(import.meta.dirname, '..', 'scripts')
const VALIDATE_JS = join(SCRIPTS_DIR, 'validate.js')
const VALIDATE_PY = join(SCRIPTS_DIR, 'validate.py')
const CAPTURE_JS  = join(SCRIPTS_DIR, 'capture.js')

const TMP = resolve(join(process.cwd(), 'tests', `__issue290_${process.pid}__`))

function setupMixedStackProject() {
  mkdirSync(join(TMP, 'regrets'), { recursive: true })
  // JS source file
  writeFileSync(join(TMP, 'math.mjs'), `
export function add(a, b) { return a + b }
`)
  // Python source file
  writeFileSync(join(TMP, 'mathpy.py'), `
def sub(a, b):
    return a - b
`)
  // Manifest with one JS cluster and one Python cluster
  writeFileSync(join(TMP, 'regrets', 'manifest.json'), JSON.stringify({
    clusters: [
      {
        id: 'js-add',
        entry: 'add',
        file: './math.mjs',
        stack: 'js',
        fingerprintLevel: 'entry',
        inputs: [[1, 2]],
        watches: [],
      },
      {
        id: 'py-sub',
        entry: 'sub',
        module: 'mathpy',
        file: './mathpy.py',
        stack: 'python',
        pythonPath: '.',
        multiArgs: true,
        fingerprintLevel: 'entry',
        inputs: [[5, 2]],
        watches: [],
      },
    ],
  }, null, 2))
}

function runCliJs(cwd) {
  const result = spawnSync('node', [VALIDATE_JS], { cwd, encoding: 'utf8', timeout: 30_000 })
  return { exitCode: result.status ?? 1, stdout: result.stdout ?? '', stderr: result.stderr ?? '' }
}

function runCaptureJs(cwd) {
  const result = spawnSync('node', [CAPTURE_JS], { cwd, encoding: 'utf8', timeout: 30_000 })
  return { exitCode: result.status ?? 1, stdout: result.stdout ?? '', stderr: result.stderr ?? '' }
}

function runCaptureJsAllowingSkip(cwd) {
  // capture.js exits with code 3 when some clusters were skipped due to
  // unsupported stack (e.g. a Python cluster in a capture.js run). That's
  // a partial success — captures that did happen succeeded. Treat both
  // 0 and 3 as "capture OK" for our mixed-stack test.
  const result = runCaptureJs(cwd)
  if (result.exitCode === 3) return { ...result, exitCode: 0 }
  return result
}

function runCliPy(cwd) {
  const result = spawnSync('python3', [VALIDATE_PY], { cwd, encoding: 'utf8', timeout: 30_000 })
  return { exitCode: result.status ?? 1, stdout: result.stdout ?? '', stderr: result.stderr ?? '' }
}

describe('Issue #290 — mixed-stack skips must not count as failures', () => {
  before(() => setupMixedStackProject())
  after(() => { if (existsSync(TMP)) rmSync(TMP, { recursive: true, force: true }) })

  it('validate.js: JS cluster PASS + Python cluster skipped → exit 0 (not 1)', () => {
    // Capture the JS cluster first so validate.js has a .regret to compare.
    // We only run capture for the JS cluster (Python capture requires capture.py).
    // Use the helper that accepts exit code 3 ("some skipped due to unsupported
    // stack") since the Python cluster in our manifest will be skipped here.
    const cap = runCaptureJsAllowingSkip(TMP)
    assert.equal(cap.exitCode, 0, `capture should exit 0 (or 3 accepted as 0)\nstdout: ${cap.stdout}\nstderr: ${cap.stderr}`)

    // Synthesize a minimal Python .regret so validate.js sees a python-stack
    // cluster in its iteration. validate.js should skip it (stack=python →
    // use validate.py) WITHOUT marking it as a failure.
    const pythonRegretContent = [
      'cluster: py-sub',
      'version: 1',
      'fingerprint: placeholder',
      'captured: 2024-01-01T00:00:00.000Z',
      'entry: sub',
      'stack: python',
      'fingerprintLevel: entry',
      'env: {"python_version":"3.11.0","python_impl":"CPython"}',
      '---',
      'INPUT  [5, 2]',
      'OUTPUT 3',
      'HASH   placeholder',
    ].join('\n')
    writeFileSync(join(TMP, 'regrets', 'py-sub.regret'), pythonRegretContent)

    const result = runCliJs(TMP)
    // The bug: exit code 1 because validate.js used to count skipped
    // python clusters as failures (pre-fix). After the fix, skipped clusters
    // are pass:true / skipped:true and don't inflate the failure count.
    assert.equal(result.exitCode, 0,
      `expected exit 0 (only skip + 1 JS pass), got ${result.exitCode}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`)

    // Should explicitly mention the python cluster was skipped.
    assert.match(result.stdout, /py-sub.*stack=python|stack=python.*py-sub/,
      'should print a skip line for the python cluster')
  })

  it('validate.py: Python cluster PASS + JS cluster skipped → exit 0 (not 1)', () => {
    // Pre-fix bug: validate.py marked stack-mismatch skips as pass:False,
    // which inflated the failed count and caused exit 1 even when the only
    // Python cluster passed. After the fix, pass:True / skipped:True.
    //
    // We need a Python .regret file for py-sub. Since capture.py is more
    // involved to set up, we hand-write a minimal one that matches what
    // capture.py would produce. validate.py will run the live Python
    // function and compare fingerprints.
    //
    // Compute the expected fingerprint the same way capture.py would:
    //   fingerprint([5, 2], 3, [], [])  — JS / Python parity verified by
    // existing cross-stack fingerprint tests.
    const pythonRegretContent = [
      'cluster: py-sub',
      'version: 1',
      'fingerprint: 1gqq8y3',  // placeholder — we use --update to set it correctly
      'captured: 2024-01-01T00:00:00.000Z',
      'entry: sub',
      'module: mathpy',
      'stack: python',
      'fingerprintLevel: entry',
      // No env line — we don't want a stale env-snapshot warning to muddy
      // this test (we're testing exit code, not env drift). validate.py
      // only warns when regret_env is present.
      '---',
      'INPUT  [5, 2]',
      'OUTPUT 3',
      'HASH   1gqq8y3',
    ].join('\n')
    writeFileSync(join(TMP, 'regrets', 'py-sub.regret'), pythonRegretContent)

    // Also write a JS .regret file so validate.py sees a js-stack cluster
    // in its iteration and skips it.
    const jsRegretContent = [
      'cluster: js-add',
      'version: 1',
      'fingerprint: placeholder',
      'captured: 2024-01-01T00:00:00.000Z',
      'entry: add',
      'stack: js',
      'fingerprintLevel: entry',
      'env: {"node_version":"v18.0.0","platform":"linux","arch":"x64"}',
      '---',
      'INPUT  [1, 2]',
      'OUTPUT 3',
      'HASH   placeholder',
    ].join('\n')
    writeFileSync(join(TMP, 'regrets', 'js-add.regret'), jsRegretContent)

    // We don't know the exact fingerprint that capture.py would produce
    // (Python env differs between machines), so use --update to set the
    // golden from the live run, THEN validate.
    const updateResult = spawnSync('python3', [VALIDATE_PY, '--update', 'py-sub', '--reason', 'initial test setup for issue 290 mixed-stack skip regression'], {
      cwd: TMP, encoding: 'utf8', timeout: 30_000,
    })
    assert.equal(updateResult.status, 0,
      `--update should exit 0\nstdout: ${updateResult.stdout}\nstderr: ${updateResult.stderr}`)

    // Now validate. The bug: exit 1 because js-add was skipped (stack=js,
    // wrong validator) but counted as a failure. After the fix: exit 0.
    const result = runCliPy(TMP)
    assert.equal(result.exitCode, 0,
      `expected exit 0 (only skip + 1 Python pass), got ${result.exitCode}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`)

    // Should explicitly mention the JS cluster was skipped.
    assert.match(result.stdout, /js-add.*use JS validator/i,
      'should print a skip line for the JS cluster')
  })
})

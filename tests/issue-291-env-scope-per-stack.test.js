// tests/issue-291-env-scope-per-stack.test.js
// Closes #291: validate.js must NOT report false "environment changed"
// warnings for Python clusters. The env-snapshot block in a Python
// cluster's .regret file was captured by validate.py (using
// fingerprint.get_env_snapshot() which records `python_version` /
// `python_impl`), but validate.js was running the env comparison BEFORE
// the stack-skip check — so it compared Python env keys against JS env
// values (which don't have those keys) and emitted a false warning for
// every Python cluster.

import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs'
import { resolve, join } from 'node:path'

const SCRIPTS_DIR = resolve(import.meta.dirname, '..', 'scripts')
const VALIDATE_JS = join(SCRIPTS_DIR, 'validate.js')
const CAPTURE_JS  = join(SCRIPTS_DIR, 'capture.js')

const TMP = resolve(join(process.cwd(), 'tests', `__issue291_${process.pid}__`))

function setupProject() {
  mkdirSync(join(TMP, 'regrets'), { recursive: true })
  writeFileSync(join(TMP, 'api.mjs'), `
function add(a, b) { return a + b }
export function main(x) { return add(x, 1) }
`)
  writeFileSync(join(TMP, 'regrets', 'manifest.json'), JSON.stringify({
    clusters: [
      {
        id: 'main',
        entry: 'main',
        file: './api.mjs',
        stack: 'js',
        fingerprintLevel: 'entry',
        inputs: [5],
        watches: [],
        callees: ['add'],
      },
      // A Python cluster that we hand-write a .regret for (we don't run
      // capture.py here — we just need the .regret file to be present so
      // validate.js iterates over it and triggers the env-comparison path).
      {
        id: 'py-cluster',
        entry: 'noop',
        module: 'noop',
        file: './noop.py',
        stack: 'python',
        fingerprintLevel: 'entry',
        inputs: [null],
        watches: [],
      },
    ],
  }, null, 2))
}

function runCaptureJs(cwd) {
  const result = spawnSync('node', [CAPTURE_JS], { cwd, encoding: 'utf8', timeout: 30_000 })
  return { exitCode: result.status ?? 1, stdout: result.stdout ?? '', stderr: result.stderr ?? '' }
}

function runCaptureJsAllowingSkip(cwd) {
  const result = runCaptureJs(cwd)
  // capture.js exits with 3 when some clusters skipped due to unsupported
  // stack — expected here since py-cluster can't be captured by capture.js.
  if (result.exitCode === 3) return { ...result, exitCode: 0 }
  return result
}

function runCliJs(cwd, args = []) {
  const result = spawnSync('node', [VALIDATE_JS, ...args], { cwd, encoding: 'utf8', timeout: 30_000 })
  return { exitCode: result.status ?? 1, stdout: result.stdout ?? '', stderr: result.stderr ?? '' }
}

describe('Issue #291 — env comparison scoped per-stack (no false warning for Python clusters)', () => {
  before(() => setupProject())
  after(() => { if (existsSync(TMP)) rmSync(TMP, { recursive: true, force: true }) })

  it('validate.js does NOT emit "environment changed" warning for a Python cluster', () => {
    // Capture main (JS) — produces main.regret + main.calls.add.regret.
    const cap = runCaptureJsAllowingSkip(TMP)
    assert.equal(cap.exitCode, 0, `capture should succeed\nstdout: ${cap.stdout}\nstderr: ${cap.stderr}`)

    // Hand-write a Python-cluster .regret with a Python-style env block.
    // Pre-fix: validate.js would emit
    //   "⚠️  py-cluster: environment changed: python_version was 3.11.0, now undefined"
    //   "⚠️  py-cluster: environment changed: python_impl was CPython, now undefined"
    // because it compared Python env keys against JS env values.
    // Post-fix (#291): validate.js skips the Python cluster (stack=python)
    // BEFORE running the env check, so no false warning is emitted.
    const pythonRegretContent = [
      'cluster: py-cluster',
      'version: 1',
      'fingerprint: placeholder',
      'captured: 2024-01-01T00:00:00.000Z',
      'entry: noop',
      'stack: python',
      'fingerprintLevel: entry',
      'env: {"python_version":"3.11.0","python_impl":"CPython"}',
      '---',
      'INPUT  null',
      'OUTPUT null',
      'HASH   placeholder',
    ].join('\n')
    writeFileSync(join(TMP, 'regrets', 'py-cluster.regret'), pythonRegretContent)

    const result = runCliJs(TMP)
    assert.equal(result.exitCode, 0,
      `expected exit 0 (main PASS + py-cluster skipped), got ${result.exitCode}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`)

    // The bug: false env-change warning for py-cluster. After the fix,
    // validate.js skips py-cluster before the env check runs.
    // Note: validate.js uses `console.warn` for env warnings, which Node
    // writes to stderr. We check BOTH streams to ensure the warning is
    // truly absent.
    const combinedOutput = `${result.stdout}\n${result.stderr}`
    assert.doesNotMatch(
      combinedOutput,
      /py-cluster.*environment changed|environment changed.*py-cluster/,
      `should NOT emit env-change warning for py-cluster (Python cluster — JS validator has no business comparing its env); got:\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`
    )
    assert.doesNotMatch(
      combinedOutput,
      /python_version was .*, now undefined/,
      `should NOT report python_version as undefined (that is a clear sign of cross-stack env comparison); got:\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`
    )

    // The Python cluster SHOULD be explicitly skipped with the stack-mismatch message.
    assert.match(result.stdout, /py-cluster.*stack=python|stack=python.*py-cluster/,
      'should print the stack-skip line for the Python cluster')
  })

  it('validate.js STILL emits env-change warnings for JS clusters (no regression)', () => {
    // Sanity check: the env-check logic is still active for JS clusters.
    // We hand-write a JS-cluster .regret with a deliberately wrong env
    // value and confirm validate.js DOES warn.
    const mainRegretPath = join(TMP, 'regrets', 'main.regret')
    const mainRegretContent = [
      'cluster: main',
      'version: 1',
      'fingerprint: placeholder',  // will mismatch — that's fine, we only care about env warning
      'captured: 2024-01-01T00:00:00.000Z',
      'entry: main',
      'stack: js',
      'fingerprintLevel: entry',
      'env: {"node_version":"v0.0.0-fake","platform":"linux","arch":"x64"}',
      '---',
      'INPUT  5',
      'OUTPUT 6',
      'HASH   placeholder',
    ].join('\n')
    writeFileSync(mainRegretPath, mainRegretContent)

    const result = runCliJs(TMP)
    // Exit code may be 1 (fingerprint mismatch) — that's fine, we only
    // care that the env warning fires for the JS cluster.
    // Note: validate.js uses `console.warn` for env warnings, which Node
    // writes to stderr (not stdout). Check both streams to be robust.
    const combinedOutput = `${result.stdout}\n${result.stderr}`
    assert.match(
      combinedOutput,
      /main.*environment changed.*node_version was v0\.0\.0-fake/,
      `should STILL emit env-change warning for the JS cluster main; got:\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`
    )
  })
})

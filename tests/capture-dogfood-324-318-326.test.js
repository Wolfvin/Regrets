// tests/capture-dogfood-324-318-326.test.js — Dogfood regression tests
//
// Covers 3 dogfood bugs found in scripts/capture.js:
//
//   #324 — "Cluster file not found" error masks actual ERR_MODULE_NOT_FOUND
//          cause (missing npm dep, extensionless imports). The file IS at
//          the resolved path, but the message blamed the file field.
//
//   #318 — Capture fails entire cluster when ANY input throws — no partial
//          capture. Including null in inputs killed the whole cluster for
//          validation-style functions (validator.js's assertString).
//
//   #326 — Capture inconsistently writes callee contracts. When a declared
//          callee sits behind a conditional that didn't trigger for any
//          input, capture silently skipped the contract and validate
//          failed with a confusing "missing" message. The warning conflated
//          this valid case with the "transform aborted" bug case.
//
// Run: node --test tests/capture-dogfood-324-318-326.test.js

import { describe, it, before, after, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import {
  mkdirSync, writeFileSync, rmSync, existsSync, readFileSync, readdirSync,
} from 'node:fs'
import { resolve, join } from 'node:path'

const SCRIPTS_DIR = resolve(import.meta.dirname, '..', 'scripts')
const CAPTURE_JS  = join(SCRIPTS_DIR, 'capture.js')
const VALIDATE_JS = join(SCRIPTS_DIR, 'validate.js')

const TMP = resolve(join(process.cwd(), 'tests', `__dogfood_${process.pid}__`))

function sh(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { cwd: TMP, stdio: 'pipe', ...opts })
  return {
    exitCode: r.status ?? 1,
    stdout: r.stdout ? r.stdout.toString() : '',
    stderr: r.stderr ? r.stderr.toString() : '',
  }
}

function setupProject(files, manifest) {
  mkdirSync(join(TMP, 'regrets'), { recursive: true })
  for (const [name, content] of Object.entries(files)) {
    writeFileSync(join(TMP, name), content)
  }
  writeFileSync(join(TMP, 'package.json'), JSON.stringify({
    name: 'dogfood-test', version: '0.0.0', type: 'module',
  }))
  writeFileSync(join(TMP, 'regrets', 'manifest.json'), JSON.stringify({
    clusters: [manifest],
  }, null, 2))
}

function cleanup() {
  if (existsSync(TMP)) rmSync(TMP, { recursive: true, force: true })
}

function readRegret(id) {
  return readFileSync(join(TMP, 'regrets', `${id}.regret`), 'utf8')
}

// ─── #324 — differentiated import error messages ───────────────────────────

describe('#324 — import error messages differentiate 3 failure modes', () => {
  beforeEach(() => cleanup())
  after(() => cleanup())

  it('Case 1: file truly missing → "Cluster file not found" with file hint', () => {
    mkdirSync(join(TMP, 'regrets'), { recursive: true })
    writeFileSync(join(TMP, 'package.json'), JSON.stringify({
      name: 'case1', version: '0.0.0', type: 'module',
    }))
    writeFileSync(join(TMP, 'regrets', 'manifest.json'), JSON.stringify({
      clusters: [{
        id: 'x', entry: 'x', file: 'missing.mjs', stack: 'js',
        fingerprintLevel: 'entry', inputs: [1], watches: [],
      }],
    }, null, 2))

    const r = sh('node', [CAPTURE_JS])
    assert.notEqual(r.exitCode, 0, 'capture should fail for missing file')
    const combined = r.stdout + r.stderr
    assert.match(combined, /Cluster file not found at missing\.mjs/,
      'error should mention "Cluster file not found" for case 1')
    assert.match(combined, /Check the 'file' field in manifest\.json — the path doesn't exist on disk/,
      'error should explain the file path doesn\'t exist')
  })

  it('Case 2: missing transitive npm dependency → "transitive npm dependency is missing"', () => {
    mkdirSync(join(TMP, 'regrets'), { recursive: true })
    writeFileSync(join(TMP, 'package.json'), JSON.stringify({
      name: 'case2', version: '0.0.0', type: 'module',
    }))
    // Source file imports a package that isn't installed.
    writeFileSync(join(TMP, 'has-dep.mjs'),
      `import someMissingPackage from 'some-missing-package-324'\n` +
      `export function x(input) { return someMissingPackage(input) }\n`)
    writeFileSync(join(TMP, 'regrets', 'manifest.json'), JSON.stringify({
      clusters: [{
        id: 'x', entry: 'x', file: 'has-dep.mjs', stack: 'js',
        fingerprintLevel: 'entry', inputs: [1], watches: [],
      }],
    }, null, 2))

    const r = sh('node', [CAPTURE_JS])
    assert.notEqual(r.exitCode, 0, 'capture should fail for missing npm dep')
    const combined = r.stdout + r.stderr
    assert.match(combined, /transitive npm dependency is missing/,
      'error should mention "transitive npm dependency is missing" for case 2')
    assert.match(combined, /some-missing-package-324/,
      'error should mention the missing package name')
    assert.match(combined, /npm install some-missing-package-324/,
      'error should suggest the npm install command with the package name')
    // CRITICAL: the error must NOT blame the manifest's file field.
    assert.doesNotMatch(combined, /Cluster file not found at has-dep\.mjs/,
      'error must NOT say "Cluster file not found" — the file EXISTS')
    assert.match(combined, /The cluster file at .* EXISTS/,
      'error should clarify the file exists')
  })

  it('Case 3: extensionless ESM import → "transitive module failed to resolve" with extension hint', () => {
    mkdirSync(join(TMP, 'regrets'), { recursive: true })
    writeFileSync(join(TMP, 'package.json'), JSON.stringify({
      name: 'case3', version: '0.0.0', type: 'module',
    }))
    // Source file does an extensionless import (common in TS-first libs).
    writeFileSync(join(TMP, 'has-extless.mjs'),
      `import { helper } from './helper'\n` +
      `export function x(input) { return helper(input) }\n`)
    writeFileSync(join(TMP, 'helper.mjs'),
      `export function helper(x) { return x * 2 }\n`)
    writeFileSync(join(TMP, 'regrets', 'manifest.json'), JSON.stringify({
      clusters: [{
        id: 'x', entry: 'x', file: 'has-extless.mjs', stack: 'js',
        fingerprintLevel: 'entry', inputs: [1], watches: [],
      }],
    }, null, 2))

    const r = sh('node', [CAPTURE_JS])
    assert.notEqual(r.exitCode, 0, 'capture should fail for extensionless import')
    const combined = r.stdout + r.stderr
    assert.match(combined, /transitive module failed to resolve/,
      'error should mention "transitive module failed to resolve" for case 3')
    assert.match(combined, /extensionless ESM imports/,
      'error should mention extensionless ESM imports as the common cause')
    assert.match(combined, /Node error:.*Cannot find module/,
      'error should surface the real Node error message')
    // CRITICAL: the error must NOT blame the manifest's file field.
    assert.doesNotMatch(combined, /Cluster file not found at has-extless\.mjs/,
      'error must NOT say "Cluster file not found" — the file EXISTS')
    assert.match(combined, /The cluster file at .* EXISTS/,
      'error should clarify the file exists')
  })
})

// ─── #318 — partial capture when input throws ──────────────────────────────

describe('#318 — partial capture when one input throws', () => {
  beforeEach(() => cleanup())
  after(() => cleanup())

  it('cluster captures successfully when one of two inputs throws', () => {
    // Reproduces the validator.js isEmail scenario: the function throws
    // TypeError on null input (assertString). Including null in inputs
    // previously killed the entire cluster.
    setupProject(
      {
        'isEmail.mjs': `
export function isEmail(input) {
  if (typeof input !== 'string') {
    throw new TypeError('Expected a string but received a ' + typeof input)
  }
  return input.includes('@')
}
`,
      },
      {
        id: 'isEmail', entry: 'isEmail', file: 'isEmail.mjs', stack: 'js',
        fingerprintLevel: 'entry', inputs: ['test@example.com', null],
        watches: [],
      }
    )

    const r = sh('node', [CAPTURE_JS])
    assert.equal(r.exitCode, 0,
      `capture should succeed (partial) when one input throws. stderr: ${r.stderr}\nstdout: ${r.stdout}`)
    assert.match(r.stdout, /Capture complete: 1 captured, 0 failed/,
      'capture should report 1 captured, 0 failed')
  })

  it('per-input warning identifies WHICH input threw and why', () => {
    setupProject(
      {
        'isEmail.mjs': `
export function isEmail(input) {
  if (typeof input !== 'string') {
    throw new TypeError('Expected a string but received a ' + typeof input)
  }
  return input.includes('@')
}
`,
      },
      {
        id: 'isEmail', entry: 'isEmail', file: 'isEmail.mjs', stack: 'js',
        fingerprintLevel: 'entry', inputs: ['test@example.com', null],
        watches: [],
      }
    )

    const r = sh('node', [CAPTURE_JS])
    // Warnings go to stderr via console.warn — check both streams.
    const combined = r.stdout + r.stderr
    assert.match(combined, /input null threw: Expected a string but received a object/,
      'warning should identify the throwing input (null) and the error message')
    assert.match(combined, /Skipping this input/,
      'warning should say the input is being skipped')
  })

  it('.regret file captures ONLY the non-throwing input', () => {
    setupProject(
      {
        'isEmail.mjs': `
export function isEmail(input) {
  if (typeof input !== 'string') {
    throw new TypeError('Expected a string but received a ' + typeof input)
  }
  return input.includes('@')
}
`,
      },
      {
        id: 'isEmail', entry: 'isEmail', file: 'isEmail.mjs', stack: 'js',
        fingerprintLevel: 'entry', inputs: ['test@example.com', null],
        watches: [],
      }
    )

    sh('node', [CAPTURE_JS])
    const content = readRegret('isEmail')
    // The .regret file's golden INPUT should be the valid input, not null.
    assert.match(content, /INPUT\s+"test@example.com"/,
      '.regret golden INPUT should be the non-throwing input')
    assert.doesNotMatch(content, /INPUT\s+null/,
      '.regret should NOT contain the throwing input as golden')
    // The INPUTS line (multi-input contract from #315) should also only
    // contain the non-throwing input. Since there's only 1 valid input,
    // there's no INPUTS line at all (it's omitted for single-input).
    // Verify the .regret has exactly 1 INPUT line.
    const inputLineCount = (content.match(/^INPUT\s/gm) || []).length
    assert.equal(inputLineCount, 1,
      `.regret should have exactly 1 INPUT line (the non-throwing input), got ${inputLineCount}`)
  })

  it('cluster summary shows X/Y inputs captured, Z skipped', () => {
    setupProject(
      {
        'isEmail.mjs': `
export function isEmail(input) {
  if (typeof input !== 'string') {
    throw new TypeError('Expected a string but received a ' + typeof input)
  }
  return input.includes('@')
}
`,
      },
      {
        id: 'isEmail', entry: 'isEmail', file: 'isEmail.mjs', stack: 'js',
        fingerprintLevel: 'entry', inputs: ['test@example.com', null],
        watches: [],
      }
    )

    const r = sh('node', [CAPTURE_JS])
    // Summary warning goes to stderr — check both streams.
    const combined = r.stdout + r.stderr
    assert.match(combined, /Cluster captured with 1\/2 input\(s\) — 1 skipped due to throws/,
      'summary should show "1/2 inputs captured, 1 skipped"')
    assert.match(combined, /null: Expected a string but received a object/,
      'summary should list the skipped input and its error')
  })

  it('ALL inputs throw → cluster fails with clear message listing all skipped inputs', () => {
    setupProject(
      {
        'isEmail.mjs': `
export function isEmail(input) {
  if (typeof input !== 'string') {
    throw new TypeError('Expected a string but received a ' + typeof input)
  }
  return input.includes('@')
}
`,
      },
      {
        id: 'isEmail', entry: 'isEmail', file: 'isEmail.mjs', stack: 'js',
        fingerprintLevel: 'entry', inputs: [null, 42, {}],
        watches: [],
      }
    )

    const r = sh('node', [CAPTURE_JS])
    assert.notEqual(r.exitCode, 0,
      'capture should FAIL when ALL inputs throw')
    // The "All N inputs threw" message is written to stderr via console.error
    // in the capture.js outer catch block.
    const combined = r.stdout + r.stderr
    assert.match(combined, /All 3 input\(s\) threw during capture/,
      'error should say all 3 inputs threw')
    assert.match(combined, /Skipped inputs \(3\)/,
      'error should list 3 skipped inputs')
    // Should suggest the 3 remediation options
    assert.match(combined, /Remove the throwing inputs/,
      'error should suggest removing throwing inputs')
    assert.match(combined, /__expectThrow/,
      'error should suggest __expectThrow for expected throws')
  })

  it('expectThrow inputs are still captured as error contracts (not affected by #318)', () => {
    // Sanity: the partial-capture fix must not break the existing expectThrow
    // path. An input marked { __expectThrow: true, value: null } should
    // still be captured as an error contract, not skipped.
    setupProject(
      {
        'isEmail.mjs': `
export function isEmail(input) {
  if (typeof input !== 'string') {
    throw new TypeError('Expected a string but received a ' + typeof input)
  }
  return input.includes('@')
}
`,
      },
      {
        id: 'isEmail', entry: 'isEmail', file: 'isEmail.mjs', stack: 'js',
        fingerprintLevel: 'entry',
        inputs: ['test@example.com', { __expectThrow: true, value: null }],
        watches: [],
      }
    )

    const r = sh('node', [CAPTURE_JS])
    assert.equal(r.exitCode, 0,
      `capture should succeed with expectThrow input. stderr: ${r.stderr}`)
    assert.match(r.stdout, /expectThrow: caught TypeError/,
      'expectThrow input should be captured as an error contract')
    assert.doesNotMatch(r.stdout, /Skipping this input/,
      'expectThrow input should NOT be skipped (it\'s expected to throw)')
    // Both inputs should be in the .regret file
    sh('node', [VALIDATE_JS])
    // validate should PASS (both inputs captured correctly)
    const v = sh('node', [VALIDATE_JS])
    assert.equal(v.exitCode, 0,
      `validate should PASS for the expectThrow cluster. stderr: ${v.stderr}`)
  })
})

// ─── #326 — clear warnings for uncalled callees ────────────────────────────

describe('#326 — callee not called: clear warning distinguishes valid vs bug', () => {
  beforeEach(() => cleanup())
  after(() => cleanup())

  it('callee behind conditional that didn\'t trigger → "was not called" (valid) warning', () => {
    // Reproduces the axios isEmptyObject(null) scenario:
    //   if (!isObject(val) || isBuffer(val)) { return false }
    // For input null, isObject(null) returns false → !false=true → short-circuits
    // → isBuffer is NOT called. isObject IS called.
    setupProject(
      {
        'utils.mjs': `
function isObject(val) {
  return val !== null && typeof val === 'object'
}
function isBuffer(val) {
  return val !== null && typeof val === 'object' && val._isBuffer === true
}
export function isEmptyObject(val) {
  if (!isObject(val) || isBuffer(val)) {
    return false
  }
  return Object.keys(val).length === 0
}
export default { isObject, isBuffer, isEmptyObject }
`,
      },
      {
        id: 'utils-is-empty-object', entry: 'isEmptyObject', file: 'utils.mjs',
        stack: 'js', fingerprintLevel: 'entry', inputs: [null],
        watches: [], callees: ['isObject', 'isBuffer'],
      }
    )

    const r = sh('node', [CAPTURE_JS])
    assert.equal(r.exitCode, 0, `capture should succeed. stderr: ${r.stderr}`)
    // capture.js writes warnings to stderr via console.warn — check both.
    const combined = r.stdout + r.stderr
    // The valid case should use the ℹ️ info icon, not the ⚠️ warning icon.
    assert.match(combined, /ℹ️\s+Callee "isBuffer" was not called during capture — no contract written/,
      'isBuffer should get the "was not called" info message (valid case)')
    assert.match(combined, /execution path/,
      'warning should explain the execution path didn\'t reach the callee')
    assert.match(combined, /didn.t reach it/,
      'warning should say "didn\'t reach it"')
    assert.match(combined, /conditional/,
      'warning should mention conditional logic as the cause')
    // isObject WAS called → should have a contract written (no warning).
    assert.doesNotMatch(combined, /Callee "isObject" was not called/,
      'isObject should NOT get the "not called" warning (it was called)')
  })

  it('valid-case warning suggests adding inputs that exercise the branch', () => {
    setupProject(
      {
        'utils.mjs': `
function isObject(val) { return val !== null && typeof val === 'object' }
function isBuffer(val) { return val !== null && typeof val === 'object' && val._isBuffer === true }
export function isEmptyObject(val) {
  if (!isObject(val) || isBuffer(val)) { return false }
  return Object.keys(val).length === 0
}
export default { isObject, isBuffer, isEmptyObject }
`,
      },
      {
        id: 'utils-is-empty-object', entry: 'isEmptyObject', file: 'utils.mjs',
        stack: 'js', fingerprintLevel: 'entry', inputs: [null],
        watches: [], callees: ['isObject', 'isBuffer'],
      }
    )

    const r = sh('node', [CAPTURE_JS])
    const combined = r.stdout + r.stderr
    assert.match(combined, /Add inputs that exercise the branch containing "isBuffer"/,
      'warning should suggest adding inputs that exercise the branch')
    assert.match(combined, /Remove "isBuffer" from the manifest's "callees" array/,
      'warning should suggest removing the callee from the manifest')
  })

  it('adding input that triggers the callee → contract IS written (no warning)', () => {
    // Same fixture, but with input {} which DOES trigger isBuffer.
    setupProject(
      {
        'utils.mjs': `
function isObject(val) { return val !== null && typeof val === 'object' }
function isBuffer(val) { return val !== null && typeof val === 'object' && val._isBuffer === true }
export function isEmptyObject(val) {
  if (!isObject(val) || isBuffer(val)) { return false }
  return Object.keys(val).length === 0
}
export default { isObject, isBuffer, isEmptyObject }
`,
      },
      {
        id: 'utils-is-empty-object', entry: 'isEmptyObject', file: 'utils.mjs',
        stack: 'js', fingerprintLevel: 'entry', inputs: [null, {}],
        watches: [], callees: ['isObject', 'isBuffer'],
      }
    )

    const r = sh('node', [CAPTURE_JS])
    assert.equal(r.exitCode, 0, `capture should succeed. stderr: ${r.stderr}`)
    const combined = r.stdout + r.stderr
    // BOTH callees should now have contracts written.
    assert.match(combined, /Saved: regrets\/utils-is-empty-object\.calls\.isObject\.regret/,
      'isObject contract should be written')
    assert.match(combined, /Saved: regrets\/utils-is-empty-object\.calls\.isBuffer\.regret/,
      'isBuffer contract should be written (input {} triggers it)')
    // No "was not called" warning for either callee.
    assert.doesNotMatch(combined, /Callee "isBuffer" was not called/,
      'isBuffer should NOT get the "not called" warning (it was called for input {})')
    assert.doesNotMatch(combined, /Callee "isObject" was not called/,
      'isObject should NOT get the "not called" warning')
  })

  it('callee that can\'t be wrapped (ESM imported binding) → "not intercepted" (bug) warning', () => {
    // An ESM imported binding: `import { helper } from './helper.mjs'`.
    // wrapCallees can't install a proxy on `helper` because it's an
    // imported binding, not a property on the module namespace. This is
    // the case-(b) "not wrapped" scenario — distinct from the case-(a)
    // "wrapped but not called" scenario above.
    setupProject(
      {
        'main.mjs': `
import { helper } from './helper.mjs'
export function main(input) { return helper(input) }
`,
        'helper.mjs': `export function helper(x) { return x * 2 }\n`,
      },
      {
        id: 'main', entry: 'main', file: 'main.mjs',
        stack: 'js', fingerprintLevel: 'entry', inputs: [21],
        watches: [], callees: ['helper'],
      }
    )

    const r = sh('node', [CAPTURE_JS])
    const combined = r.stdout + r.stderr
    // The bug-case warning should fire (⚠️ icon, not ℹ️). Either the
    // "imported binding" message (#301) or the "not intercepted" message.
    assert.ok(
      /⚠️\s+Callee "helper" is an imported binding/.test(combined) ||
      /⚠️\s+Callee "helper" was not intercepted during capture/.test(combined),
      'imported-binding callee should get a ⚠️ warning (not the ℹ️ "was not called" message)'
    )
    // The valid-case wording should NOT appear.
    assert.doesNotMatch(combined, /was not called during capture — no contract written/,
      'imported-binding callee should NOT get the valid-case "was not called" message')
  })
})

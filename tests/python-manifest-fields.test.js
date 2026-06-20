// tests/python-manifest-fields.test.js — Issue #279 + #274 regression tests
//
// Two related bugs are covered here:
//
//   #279 — install.js generated `file: "src/foo.py"` for Python clusters,
//          but capture.py expects `module: "foo"` (dotted) + optional
//          `pythonPath: "src"`. The mismatch caused capture.py to call
//          `importlib.import_module("src/foo.py")` → ModuleNotFoundError.
//
//   #274 — capture.py's sys.path setup didn't include the cwd, so even
//          after #279 was fixed, root-level Python modules (e.g.
//          `module: "transforms"` with no pythonPath) could not be
//          imported. The diagnostic for ModuleNotFoundError was also
//          unhelpful — a raw traceback with no hint about pythonPath
//          or sys.path.
//
// Layer 1 (issue #279): install.js manifest field generation
//   - Python cluster must use `module` (dotted), not `file`
//   - pythonPath must be the package root (first dir component)
//   - `__init__.py` must collapse to its package name
//   - root-level files must omit pythonPath entirely
//
// Layer 2 (issue #274): capture.py import path resolution + sys.path
//   - cwd is auto-added to sys.path so root-level modules import cleanly
//   - legacy manifests with `file` (no `module`) are auto-converted
//   - clear diagnostic when neither `module` nor `file` is present
//   - clear diagnostic when the module path can't be resolved
//
// Run: node --test tests/python-manifest-fields.test.js

import { describe, it, before, after, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import {
  mkdirSync, writeFileSync, rmSync, existsSync,
  readFileSync,
} from 'node:fs'
import { resolve, join } from 'node:path'
import { filePathToPythonModule } from '../scripts/install.js'

const SCRIPTS_DIR = resolve(import.meta.dirname, '..', 'scripts')
const INSTALL_JS = join(SCRIPTS_DIR, 'install.js')
const CAPTURE_PY = join(SCRIPTS_DIR, 'capture.py')

const TMP = resolve(join(process.cwd(), 'tests', '__python_manifest_tmp__'))

function setup() {
  mkdirSync(TMP, { recursive: true })
}

function cleanup() {
  if (existsSync(TMP)) {
    rmSync(TMP, { recursive: true, force: true })
  }
}

/**
 * Run install.js with given args, returning { exitCode, stdout, stderr }.
 * cwd is set to TMP so the manifest lands at TMP/regrets/manifest.json.
 */
function runInstall(args) {
  try {
    const stdout = execFileSync('node', [INSTALL_JS, ...args], {
      cwd: TMP,
      stdio: 'pipe',
      timeout: 60_000,
    })
    return { exitCode: 0, stdout: stdout.toString(), stderr: '' }
  } catch (err) {
    return {
      exitCode: err.status ?? 1,
      stdout: err.stdout ? err.stdout.toString() : '',
      stderr: err.stderr ? err.stderr.toString() : '',
    }
  }
}

/**
 * Run capture.py with given args, returning { exitCode, stdout, stderr }.
 */
function runCapturePy(args) {
  try {
    const stdout = execFileSync('python3', [CAPTURE_PY, ...args], {
      cwd: TMP,
      stdio: 'pipe',
      timeout: 60_000,
    })
    return { exitCode: 0, stdout: stdout.toString(), stderr: '' }
  } catch (err) {
    return {
      exitCode: err.status ?? 1,
      stdout: err.stdout ? err.stdout.toString() : '',
      stderr: err.stderr ? err.stderr.toString() : '',
    }
  }
}

function writeManifest(clusters) {
  mkdirSync(join(TMP, 'regrets'), { recursive: true })
  writeFileSync(join(TMP, 'regrets', 'manifest.json'), JSON.stringify({ clusters }, null, 2))
}

// ─── Layer 1: pure unit tests for filePathToPythonModule ─────────────────────

describe('Issue #279 — filePathToPythonModule() pure conversion', () => {
  it('root-level file → module name, no pythonPath', () => {
    assert.deepEqual(filePathToPythonModule('transforms.py'),
      { module: 'transforms', pythonPath: '' })
  })

  it('nested file → dotted module, pythonPath = first dir', () => {
    assert.deepEqual(filePathToPythonModule('src/invoice/processor.py'),
      { module: 'invoice.processor', pythonPath: 'src' })
  })

  it('deeply nested file → multi-segment dotted module', () => {
    assert.deepEqual(filePathToPythonModule('src/utils/math/normalize.py'),
      { module: 'utils.math.normalize', pythonPath: 'src' })
  })

  it('__init__.py collapses to its package name', () => {
    assert.deepEqual(filePathToPythonModule('src/pkg/__init__.py'),
      { module: 'pkg', pythonPath: 'src' })
  })

  it('root __init__.py collapses to empty module', () => {
    assert.deepEqual(filePathToPythonModule('__init__.py'),
      { module: '', pythonPath: '' })
  })

  it('single-segment path with no extension is treated as a module name', () => {
    assert.deepEqual(filePathToPythonModule('transforms'),
      { module: 'transforms', pythonPath: '' })
  })

  it('Windows-style backslashes are normalized to forward slashes', () => {
    assert.deepEqual(filePathToPythonModule('src\\invoice\\processor.py'),
      { module: 'invoice.processor', pythonPath: 'src' })
  })

  it('tests/ directory becomes pythonPath "tests"', () => {
    assert.deepEqual(filePathToPythonModule('tests/conftest.py'),
      { module: 'conftest', pythonPath: 'tests' })
  })
})

// ─── Layer 2: install.js manifest generation for Python clusters ────────────

describe('Issue #279 — install.js emits `module` (not `file`) for Python clusters', () => {
  beforeEach(() => {
    cleanup()
    setup()
    writeFileSync(join(TMP, 'package.json'), JSON.stringify({
      name: 'py-test-279',
      version: '1.0.0',
    }))
  })
  afterEach(cleanup)

  it('root-level Python file → module name, NO pythonPath, NO file field', () => {
    writeFileSync(join(TMP, 'transforms.py'), `def double(x):
    return x * 2

def main(x):
    return double(x)
`)
    const r = runInstall(['--scope', 'transforms.py', '--skip-capture'])
    assert.equal(r.exitCode, 0, `install.js failed: ${r.stderr}`)

    const manifest = JSON.parse(readFileSync(join(TMP, 'regrets', 'manifest.json'), 'utf8'))
    assert.ok(manifest.clusters.length >= 1)
    for (const c of manifest.clusters) {
      assert.equal(c.stack, 'python')
      assert.equal(c.module, 'transforms',
        `cluster ${c.id} should have module: "transforms"`)
      assert.ok(!('file' in c),
        `cluster ${c.id} must NOT have a 'file' field (issue #279)`)
      assert.ok(!('pythonPath' in c),
        `cluster ${c.id} must NOT have pythonPath (cwd is sufficient)`)
    }
  })

  it('nested Python file → dotted module + pythonPath = first dir, NO file field', () => {
    mkdirSync(join(TMP, 'src', 'invoice'), { recursive: true })
    writeFileSync(join(TMP, 'src', 'invoice', 'processor.py'), `def normalize_amount(raw):
    return float(raw)

def apply_tax(amount, rate=0.11):
    return round(amount * (1 + rate), 2)

def process_invoice(raw_amount, tax_rate=0.11):
    amount = normalize_amount(raw_amount)
    return apply_tax(amount, tax_rate)
`)
    const r = runInstall(['--scope', 'src/invoice/processor.py', '--skip-capture'])
    assert.equal(r.exitCode, 0, `install.js failed: ${r.stderr}`)

    const manifest = JSON.parse(readFileSync(join(TMP, 'regrets', 'manifest.json'), 'utf8'))
    assert.ok(manifest.clusters.length >= 3)
    for (const c of manifest.clusters) {
      assert.equal(c.stack, 'python')
      assert.equal(c.module, 'invoice.processor',
        `cluster ${c.id} should have module: "invoice.processor"`)
      assert.equal(c.pythonPath, 'src',
        `cluster ${c.id} should have pythonPath: "src"`)
      assert.ok(!('file' in c),
        `cluster ${c.id} must NOT have a 'file' field (issue #279)`)
    }
  })

  it('__init__.py → module is the package name, not package.__init__', () => {
    mkdirSync(join(TMP, 'src', 'pkg'), { recursive: true })
    writeFileSync(join(TMP, 'src', 'pkg', '__init__.py'), `def helper(x):
    return x + 1
`)
    const r = runInstall(['--scope', 'src/pkg/__init__.py', '--skip-capture'])
    assert.equal(r.exitCode, 0, `install.js failed: ${r.stderr}`)

    const manifest = JSON.parse(readFileSync(join(TMP, 'regrets', 'manifest.json'), 'utf8'))
    assert.ok(manifest.clusters.length >= 1)
    const c = manifest.clusters[0]
    assert.equal(c.module, 'pkg',
      `__init__.py should resolve to module "pkg", got "${c.module}"`)
    assert.equal(c.pythonPath, 'src')
    assert.ok(!('file' in c))
  })
})

// ─── Layer 3: capture.py import resolution + sys.path handling (#274) ───────

describe('Issue #274 — capture.py resolves module path + sys.path correctly', () => {
  beforeEach(() => {
    cleanup()
    setup()
    // capture.py imports sibling modules (fingerprint, ghost) from its own
    // directory, so we don't need to copy them — they're already in scripts/.
    writeFileSync(join(TMP, 'package.json'), JSON.stringify({
      name: 'py-test-274',
      version: '1.0.0',
    }))
  })
  afterEach(cleanup)

  it('cwd is added to sys.path automatically (root-level module imports)', () => {
    // A Python file at the project root — capture.py must add cwd to
    // sys.path so `import transforms` succeeds.
    writeFileSync(join(TMP, 'transforms.py'), `def double(x):
    return x * 2
`)
    writeManifest([{
      id: 'transforms-double',
      entry: 'double',
      watches: [],
      module: 'transforms',
      stack: 'python',
      fingerprintLevel: 'entry',
      inputs: [21],
    }])

    const r = runCapturePy([])
    assert.equal(r.exitCode, 0,
      `capture.py should exit 0 on success. stderr:\n${r.stderr}\nstdout:\n${r.stdout}`)
    assert.match(r.stdout, /Added cwd to sys.path/,
      'capture.py must log that it added cwd to sys.path (issue #274 root cause)')
    assert.match(r.stdout, /✅ Fingerprint:/,
      'capture.py must produce a fingerprint')
    assert.ok(existsSync(join(TMP, 'regrets', 'transforms-double.regret')),
      '.regret file must be written')
  })

  it('pythonPath on cluster is honored (nested module imports)', () => {
    mkdirSync(join(TMP, 'src', 'invoice'), { recursive: true })
    writeFileSync(join(TMP, 'src', 'invoice', 'processor.py'), `def normalize_amount(raw):
    return float(raw)

def apply_tax(amount, rate=0.11):
    return round(amount * (1 + rate), 2)

def process_invoice(raw_amount, tax_rate=0.11):
    amount = normalize_amount(raw_amount)
    return apply_tax(amount, tax_rate)
`)
    writeManifest([{
      id: 'invoice-process',
      entry: 'process_invoice',
      watches: [],
      module: 'invoice.processor',
      pythonPath: 'src',
      stack: 'python',
      fingerprintLevel: 'entry',
      multiArgs: true,
      inputs: [[1000000, 0.11]],
    }])

    const r = runCapturePy([])
    assert.equal(r.exitCode, 0,
      `capture.py should exit 0. stderr:\n${r.stderr}\nstdout:\n${r.stdout}`)
    assert.match(r.stdout, /pythonPath resolved: src/)
    assert.ok(existsSync(join(TMP, 'regrets', 'invoice-process.regret')))
  })

  it('legacy manifest with `file` (no `module`) is auto-converted and imports', () => {
    // Backward-compat: a manifest written before the #279 fix uses `file`
    // instead of `module`. capture.py must auto-convert the file path to a
    // dotted module path AND auto-add the parent dir to sys.path.
    mkdirSync(join(TMP, 'src', 'invoice'), { recursive: true })
    writeFileSync(join(TMP, 'src', 'invoice', 'processor.py'), `def normalize_amount(raw):
    return float(raw)

def process_invoice(raw_amount, tax_rate=0.11):
    return apply_tax(normalize_amount(raw_amount), tax_rate)

def apply_tax(amount, rate=0.11):
    return round(amount * (1 + rate), 2)
`)
    writeManifest([{
      id: 'legacy-process',
      entry: 'process_invoice',
      watches: [],
      file: 'src/invoice/processor.py',   // ← legacy field
      stack: 'python',
      fingerprintLevel: 'entry',
      multiArgs: true,
      inputs: [[1000000, 0.11]],
    }])

    const r = runCapturePy([])
    assert.equal(r.exitCode, 0,
      `capture.py should auto-convert file→module and import. stderr:\n${r.stderr}\nstdout:\n${r.stdout}`)
    // The auto-discovered pythonPath (src) must be added to sys.path.
    assert.match(r.stdout, /pythonPath resolved: src/,
      'capture.py must auto-discover pythonPath from legacy file field')
    assert.match(r.stdout, /Module:\s+invoice\.processor/,
      'capture.py must show the auto-converted dotted module path')
    assert.ok(existsSync(join(TMP, 'regrets', 'legacy-process.regret')))
  })

  it('legacy manifest with root-level `file` imports without pythonPath', () => {
    writeFileSync(join(TMP, 'transforms.py'), `def double(x):
    return x * 2
`)
    writeManifest([{
      id: 'legacy-root',
      entry: 'double',
      watches: [],
      file: 'transforms.py',   // ← legacy, root-level
      stack: 'python',
      fingerprintLevel: 'entry',
      inputs: [21],
    }])

    const r = runCapturePy([])
    assert.equal(r.exitCode, 0,
      `stderr:\n${r.stderr}\nstdout:\n${r.stdout}`)
    assert.match(r.stdout, /Module:\s+transforms/)
    assert.ok(existsSync(join(TMP, 'regrets', 'legacy-root.regret')))
  })

  it('clear diagnostic when neither module nor file is present', () => {
    writeManifest([{
      id: 'no-fields',
      entry: 'whatever',
      watches: [],
      stack: 'python',
      fingerprintLevel: 'entry',
      inputs: [1],
    }])

    const r = runCapturePy([])
    assert.notEqual(r.exitCode, 0,
      'capture.py must exit non-zero when no module/file is declared')
    assert.match(r.stdout, /has neither 'module' nor 'file' field/,
      'capture.py must clearly state the missing-field problem')
    assert.match(r.stdout, /Update regrets\/manifest\.json/)
  })

  it('clear ModuleNotFoundError diagnostic with sys.path + pythonPath context', () => {
    writeManifest([{
      id: 'broken-module',
      entry: 'whatever',
      watches: [],
      module: 'nonexistent.module.path',
      stack: 'python',
      fingerprintLevel: 'entry',
      inputs: [1],
    }])

    const r = runCapturePy([])
    assert.notEqual(r.exitCode, 0,
      'capture.py must exit non-zero when import fails')
    assert.match(r.stdout, /ModuleNotFoundError/i)
    assert.match(r.stdout, /Resolved module path:/,
      'diagnostic must show the resolved module path that failed')
    assert.match(r.stdout, /sys\.path/,
      'diagnostic must include sys.path context for debugging')
    assert.match(r.stdout, /pythonPath/,
      'diagnostic must mention pythonPath as the likely fix')
  })
})

// ─── Layer 4: end-to-end install.js → capture.py roundtrip ──────────────────

describe('Issue #279 + #274 end-to-end — install.js manifest → capture.py import', () => {
  beforeEach(() => {
    cleanup()
    setup()
    writeFileSync(join(TMP, 'package.json'), JSON.stringify({
      name: 'py-test-e2e',
      version: '1.0.0',
    }))
  })
  afterEach(cleanup)

  it('install.js-generated manifest is consumable by capture.py with zero edits', () => {
    // This is the user-facing flow that was completely broken before #279:
    //   1. install.js --scope <py-file> --skip-capture → manifest.json
    //   2. python3 scripts/capture.py → ModuleNotFoundError
    //
    // After the fix, capture.py reads the `module` + `pythonPath` fields
    // install.js produced and imports the module cleanly.
    mkdirSync(join(TMP, 'src', 'invoice'), { recursive: true })
    writeFileSync(join(TMP, 'src', 'invoice', 'processor.py'), `def normalize_amount(raw):
    if isinstance(raw, str):
        return float(raw.replace(',', '').replace('$', ''))
    return float(raw)

def apply_tax(amount, rate=0.11):
    return round(amount * (1 + rate), 2)

def process_invoice(raw_amount, tax_rate=0.11):
    amount = normalize_amount(raw_amount)
    return apply_tax(amount, tax_rate)
`)

    // Step 1: install.js generates manifest with `module` + `pythonPath`.
    const install = runInstall(['--scope', 'src/invoice/processor.py', '--skip-capture'])
    assert.equal(install.exitCode, 0, `install.js failed: ${install.stderr}`)

    const manifestPath = join(TMP, 'regrets', 'manifest.json')
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
    assert.ok(manifest.clusters.length >= 3)

    // Verify install.js emitted the correct fields (defense in depth —
    // the unit tests above already cover this, but the e2e test should
    // fail loudly if a future refactor regresses the manifest format).
    for (const c of manifest.clusters) {
      assert.equal(c.module, 'invoice.processor')
      assert.equal(c.pythonPath, 'src')
      assert.ok(!('file' in c), `cluster ${c.id} must not have 'file' field`)
    }

    // Step 2: enrich inputs so the capture actually exercises the function.
    // install.js emits [null, {}] which would trigger the trivial-output
    // guard or fail with a TypeError. We override with real inputs here
    // because this test is about import resolution, not output validity.
    for (const c of manifest.clusters) {
      if (c.entry === 'normalize_amount') {
        c.inputs = [1000000, '1,000,000']
      } else if (c.entry === 'apply_tax') {
        c.multiArgs = true
        c.inputs = [[100, 0.11]]
      } else if (c.entry === 'process_invoice') {
        c.multiArgs = true
        c.inputs = [[1000000, 0.11]]
      }
    }
    writeFileSync(manifestPath, JSON.stringify(manifest, null, 2))

    // Step 3: capture.py reads the install.js-generated manifest and
    // successfully imports the module. Before the #274/#279 fixes this
    // would have failed with ModuleNotFoundError.
    const capture = runCapturePy([])
    assert.equal(capture.exitCode, 0,
      `capture.py failed on install.js-generated manifest.\nstderr:\n${capture.stderr}\nstdout:\n${capture.stdout}`)

    // Every cluster must have produced a .regret file.
    for (const c of manifest.clusters) {
      const regretPath = join(TMP, 'regrets', `${c.id}.regret`)
      assert.ok(existsSync(regretPath),
        `expected ${c.id}.regret to be written, but it was not`)
    }
  })
})

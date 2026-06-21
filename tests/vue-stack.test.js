// tests/vue-stack.test.js
// End-to-end test for the Vue 3 stack: capture_vue.mjs + validate_vue.mjs.
//
// Verifies the contract:
//   - capture_vue.mjs reads a manifest, renders Vue components via SSR,
//     computes fingerprints via scripts/fingerprint.js, writes .regret files
//     with the standard format (cluster/version/fingerprint/captured/
//     INPUT/OUTPUT/HASH).
//   - validate_vue.mjs re-renders, recomputes fingerprints, and reports
//     PASS for unchanged code.
//   - validate_vue.mjs detects breaking changes (FAIL with diff) and
//     continues to validate other clusters.
//   - Cross-stack parity: the Vue fingerprint matches the JS reference
//     fingerprint for the same input/output pair.
//   - Missing .regret file → validate FAILs (not silent pass).
//   - Unknown stack in manifest → capture_vue.mjs exits 0 with "No Vue
//     clusters found" (graceful no-op).

import { describe, it, before, beforeEach, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, writeFileSync, rmSync, existsSync, readFileSync, copyFileSync } from 'node:fs'
import { resolve, join } from 'node:path'

const REPO_ROOT = resolve(import.meta.dirname, '..')
const CAPTURE_VUE = join(REPO_ROOT, 'scripts', 'capture_vue.mjs')
const VALIDATE_VUE = join(REPO_ROOT, 'scripts', 'validate_vue.mjs')
const FINGERPRINT_JS = join(REPO_ROOT, 'scripts', 'fingerprint.js')

const TMP = resolve(REPO_ROOT, 'tests', `__vue_stack_${process.pid}__`)

// ─── Helpers ──────────────────────────────────────────────────────────────────

function setupProject(components) {
  mkdirSync(join(TMP, 'src'), { recursive: true })
  mkdirSync(join(TMP, 'regrets'), { recursive: true })
  for (const [name, content] of Object.entries(components)) {
    writeFileSync(join(TMP, 'src', name), content)
  }
}

function writeManifest(clusters) {
  writeFileSync(join(TMP, 'regrets', 'manifest.json'), JSON.stringify({
    clusters,
  }, null, 2))
}

function runCapture(args = []) {
  const result = spawnSync('node', [CAPTURE_VUE, ...args], {
    cwd: TMP,
    encoding: 'utf8',
    timeout: 30_000,
  })
  return { exitCode: result.status ?? 1, stdout: result.stdout ?? '', stderr: result.stderr ?? '' }
}

function runValidate(args = []) {
  const result = spawnSync('node', [VALIDATE_VUE, ...args], {
    cwd: TMP,
    encoding: 'utf8',
    timeout: 30_000,
  })
  return { exitCode: result.status ?? 1, stdout: result.stdout ?? '', stderr: result.stderr ?? '' }
}

function readRegret(id) {
  const p = join(TMP, 'regrets', `${id}.regret`)
  if (!existsSync(p)) return null
  return readFileSync(p, 'utf8')
}

// ─── Test components ──────────────────────────────────────────────────────────

const HELLO_COMPONENT = `import { defineComponent, h } from 'vue'
export const Hello = defineComponent({
  name: 'Hello',
  props: { name: { type: String, required: true } },
  setup(props) {
    return () => h('div', { class: 'hello' }, 'Hello, ' + props.name + '!')
  }
})
export default Hello
`

const COUNTER_COMPONENT = `import { defineComponent, h } from 'vue'
export const Counter = defineComponent({
  name: 'Counter',
  props: { count: { type: Number, required: true }, label: { type: String, default: 'Count' } },
  setup(props) {
    return () => h('div', { class: 'counter' }, [
      h('span', { class: 'label' }, props.label),
      h('span', { class: 'value' }, String(props.count))
    ])
  }
})
export default Counter
`

// Breaking version: changes "Hello, X!" to "Hi, X!"
const HELLO_BREAKING = `import { defineComponent, h } from 'vue'
export const Hello = defineComponent({
  name: 'Hello',
  props: { name: { type: String, required: true } },
  setup(props) {
    return () => h('div', { class: 'hello' }, 'Hi, ' + props.name + '!')
  }
})
export default Hello
`

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('Vue stack — capture_vue.mjs', () => {
  before(() => {
    rmSync(TMP, { recursive: true, force: true })
    setupProject({ 'Hello.js': HELLO_COMPONENT, 'Counter.js': COUNTER_COMPONENT })
  })
  beforeEach(() => {
    // Clear regrets/ between tests so each test starts fresh
    rmSync(join(TMP, 'regrets'), { recursive: true, force: true })
    mkdirSync(join(TMP, 'regrets'), { recursive: true })
  })
  after(() => { rmSync(TMP, { recursive: true, force: true }) })

  it('captures a Vue component and writes a .regret file with the standard format', () => {
    writeManifest([{
      id: 'hello-render',
      entry: 'Hello',
      file: './src/Hello.js',
      stack: 'vue',
      fingerprintLevel: 'entry',
      inputs: [{ name: 'World' }],
      watches: [],
    }])

    const r = runCapture()
    assert.equal(r.exitCode, 0, `capture failed: ${r.stderr}`)
    assert.match(r.stdout, /Capturing Vue: hello-render/)
    assert.match(r.stdout, /Fingerprint:/)

    const regret = readRegret('hello-render')
    assert.ok(regret, '.regret file should exist')
    assert.match(regret, /^cluster: hello-render$/m)
    assert.match(regret, /^version: 1$/m)
    assert.match(regret, /^fingerprint: [a-z0-9]{7}$/m)
    assert.match(regret, /^captured: \d{4}-\d{2}-\d{2}T/m)
    assert.match(regret, /^watches: \[Hello\]$/m)
    assert.match(regret, /^entry: Hello$/m)
    assert.match(regret, /^stack: vue$/m)
    assert.match(regret, /^renderMode: ssr$/m)
    assert.match(regret, /^---$/m)
    assert.match(regret, /^INPUT  \{"name":"World"\}$/m)
    // OUTPUT is JSON.stringify(html) — quotes around attribute values get escaped
    assert.match(regret, /^OUTPUT "<div class=\\"hello\\">Hello, World!<\/div>"$/m)
    assert.match(regret, /^HASH   [a-z0-9]{7}$/m)
  })

  it('captures multiple Vue clusters in a single manifest', () => {
    writeManifest([
      {
        id: 'hello-render',
        entry: 'Hello',
        file: './src/Hello.js',
        stack: 'vue',
        fingerprintLevel: 'entry',
        inputs: [{ name: 'World' }],
        watches: [],
      },
      {
        id: 'counter-render',
        entry: 'Counter',
        file: './src/Counter.js',
        stack: 'vue',
        fingerprintLevel: 'entry',
        inputs: [{ count: 42, label: 'Total' }],
        watches: [],
      },
    ])

    const r = runCapture()
    assert.equal(r.exitCode, 0, `capture failed: ${r.stderr}`)
    assert.match(r.stdout, /Capturing Vue: hello-render/)
    assert.match(r.stdout, /Capturing Vue: counter-render/)
    assert.ok(readRegret('hello-render'))
    assert.ok(readRegret('counter-render'))
  })

  it('exits 0 with "No Vue clusters found" when manifest has only non-Vue stacks', () => {
    writeManifest([{
      id: 'js-add',
      entry: 'add',
      file: './src/math.js',
      stack: 'js',
      fingerprintLevel: 'entry',
      inputs: [[1, 2]],
      watches: [],
    }])

    const r = runCapture()
    assert.equal(r.exitCode, 0)
    assert.match(r.stdout, /No Vue clusters found/)
  })

  it('filters by --cluster flag', () => {
    writeManifest([
      {
        id: 'hello-render',
        entry: 'Hello',
        file: './src/Hello.js',
        stack: 'vue',
        fingerprintLevel: 'entry',
        inputs: [{ name: 'World' }],
        watches: [],
      },
      {
        id: 'counter-render',
        entry: 'Counter',
        file: './src/Counter.js',
        stack: 'vue',
        fingerprintLevel: 'entry',
        inputs: [{ count: 42 }],
        watches: [],
      },
    ])

    const r = runCapture(['--cluster', 'hello-render'])
    assert.equal(r.exitCode, 0)
    assert.match(r.stdout, /Capturing Vue: hello-render/)
    assert.doesNotMatch(r.stdout, /Capturing Vue: counter-render/)
  })
})

describe('Vue stack — validate_vue.mjs', () => {
  before(() => {
    rmSync(TMP, { recursive: true, force: true })
    setupProject({ 'Hello.js': HELLO_COMPONENT, 'Counter.js': COUNTER_COMPONENT })
  })
  beforeEach(() => {
    // Reset components to original state and clear regrets/ between tests
    writeFileSync(join(TMP, 'src', 'Hello.js'), HELLO_COMPONENT)
    writeFileSync(join(TMP, 'src', 'Counter.js'), COUNTER_COMPONENT)
    rmSync(join(TMP, 'regrets'), { recursive: true, force: true })
    mkdirSync(join(TMP, 'regrets'), { recursive: true })
  })
  after(() => { rmSync(TMP, { recursive: true, force: true }) })

  it('PASSes when code is unchanged', () => {
    writeManifest([{
      id: 'hello-render',
      entry: 'Hello',
      file: './src/Hello.js',
      stack: 'vue',
      fingerprintLevel: 'entry',
      inputs: [{ name: 'World' }],
      watches: [],
    }])

    runCapture()  // generate .regret
    const v = runValidate()
    assert.equal(v.exitCode, 0, `validate failed: ${v.stderr}`)
    assert.match(v.stdout, /✅ hello-render.*PASS/)
    assert.match(v.stdout, /All 1 Vue tests passed/)
  })

  it('FAILs with diff when component output changes (breaking refactor)', () => {
    writeManifest([{
      id: 'hello-render',
      entry: 'Hello',
      file: './src/Hello.js',
      stack: 'vue',
      fingerprintLevel: 'entry',
      inputs: [{ name: 'World' }],
      watches: [],
    }])

    runCapture()
    // Apply breaking change
    writeFileSync(join(TMP, 'src', 'Hello.js'), HELLO_BREAKING)

    const v = runValidate()
    assert.notEqual(v.exitCode, 0, 'validate should fail')
    assert.match(v.stdout, /❌ hello-render.*FAIL/)
    assert.match(v.stdout, /1\/1 FAILED/)
  })

  it('continues validating other clusters when one FAILs (no --fail-fast)', () => {
    writeManifest([
      {
        id: 'hello-render',
        entry: 'Hello',
        file: './src/Hello.js',
        stack: 'vue',
        fingerprintLevel: 'entry',
        inputs: [{ name: 'World' }],
        watches: [],
      },
      {
        id: 'counter-render',
        entry: 'Counter',
        file: './src/Counter.js',
        stack: 'vue',
        fingerprintLevel: 'entry',
        inputs: [{ count: 42, label: 'Total' }],
        watches: [],
      },
    ])

    runCapture()
    // Break only Hello
    writeFileSync(join(TMP, 'src', 'Hello.js'), HELLO_BREAKING)

    const v = runValidate()
    assert.notEqual(v.exitCode, 0)
    assert.match(v.stdout, /❌ hello-render.*FAIL/)
    assert.match(v.stdout, /✅ counter-render.*PASS/)
    assert.match(v.stdout, /1\/2 FAILED/)
  })

  it('stops on first FAIL with --fail-fast', () => {
    writeManifest([
      {
        id: 'aaa-failing',  // alphabetically first so --fail-fast hits it before counter
        entry: 'Hello',
        file: './src/Hello.js',
        stack: 'vue',
        fingerprintLevel: 'entry',
        inputs: [{ name: 'World' }],
        watches: [],
      },
      {
        id: 'counter-render',
        entry: 'Counter',
        file: './src/Counter.js',
        stack: 'vue',
        fingerprintLevel: 'entry',
        inputs: [{ count: 42, label: 'Total' }],
        watches: [],
      },
    ])

    runCapture()
    writeFileSync(join(TMP, 'src', 'Hello.js'), HELLO_BREAKING)

    const v = runValidate(['--fail-fast'])
    assert.notEqual(v.exitCode, 0)
    assert.match(v.stdout, /❌ aaa-failing.*FAIL/)
    assert.match(v.stdout, /--fail-fast: stopping/)
    // Counter should NOT have been reached
    assert.doesNotMatch(v.stdout, /✅ counter-render/)
  })

  it('FAILs (not silent pass) when .regret file is missing', () => {
    writeManifest([{
      id: 'hello-render',
      entry: 'Hello',
      file: './src/Hello.js',
      stack: 'vue',
      fingerprintLevel: 'entry',
      inputs: [{ name: 'World' }],
      watches: [],
    }])

    // Don't run capture — .regret file doesn't exist.
    // validate_vue.mjs writes the "No Vue .regret files found" message to
    // stderr (not stdout) — combine both for the assertion.
    const v = runValidate()
    assert.notEqual(v.exitCode, 0)
    const combined = v.stdout + v.stderr
    assert.match(combined, /No Vue .regret files found/)
  })

  it('supports --json output for machine consumers', () => {
    writeManifest([{
      id: 'hello-render',
      entry: 'Hello',
      file: './src/Hello.js',
      stack: 'vue',
      fingerprintLevel: 'entry',
      inputs: [{ name: 'World' }],
      watches: [],
    }])

    runCapture()
    const v = runValidate(['--json'])
    assert.equal(v.exitCode, 0)

    const parsed = JSON.parse(v.stdout)
    assert.equal(parsed.stack, 'vue')
    assert.equal(parsed.total, 1)
    assert.equal(parsed.passed, 1)
    assert.equal(parsed.failed, 0)
    assert.equal(parsed.results[0].id, 'hello-render')
    assert.equal(parsed.results[0].pass, true)
  })
})

describe('Vue stack — cross-stack fingerprint parity', () => {
  before(() => {
    rmSync(TMP, { recursive: true, force: true })
    setupProject({ 'Hello.js': HELLO_COMPONENT })
  })
  after(() => { rmSync(TMP, { recursive: true, force: true }) })

  it('produces the same fingerprint as scripts/fingerprint.js for the same I/O', async () => {
    writeManifest([{
      id: 'hello-render',
      entry: 'Hello',
      file: './src/Hello.js',
      stack: 'vue',
      fingerprintLevel: 'entry',
      inputs: [{ name: 'World' }],
      watches: [],
    }])

    const r = runCapture()
    assert.equal(r.exitCode, 0)

    const regret = readRegret('hello-render')
    const hashMatch = regret.match(/^HASH   ([a-z0-9]{7})$/m)
    assert.ok(hashMatch, 'HASH line should be in .regret file')
    const vueHash = hashMatch[1]

    // Manually compute the JS reference fingerprint for the same I/O
    const { fingerprint } = await import(FINGERPRINT_JS)
    const input = { name: 'World' }
    // The OUTPUT line in the .regret file is JSON-quoted (a JSON string),
    // so we JSON.parse it to get the raw HTML string, then re-fingerprint.
    const outputMatch = regret.match(/^OUTPUT (.+)$/m)
    assert.ok(outputMatch)
    const output = JSON.parse(outputMatch[1])
    const jsHash = fingerprint(input, output)

    assert.equal(vueHash, jsHash,
      `Vue fingerprint (${vueHash}) must match JS reference (${jsHash}) for the same I/O — cross-stack parity`)
  })
})

// ─── Additional coverage ─────────────────────────────────────────────────────
// These tests were added during a parallel-worker consolidation review (issue
// #396). They cover cases that the original test file didn't exercise:
//   - Non-breaking refactor still PASSes (False Positive guard)
//   - --runs N stability check
//   - regret.js dispatches Vue clusters to validate_vue.mjs (not validate.js)
//   - validate.js skips Vue clusters (does not run them itself)
//   - init.js --stack vue scaffolds a Vue manifest template

const HELLO_REFACTOR_JS = `import { defineComponent, h } from 'vue'

// Refactor: extracted greeting composition — output HTML must be identical.
function composeGreeting(name) {
  return 'Hello, ' + name + '!'
}

export const Hello = defineComponent({
  name: 'Hello',
  props: { name: { type: String, required: true } },
  setup(props) {
    return () => h('div', { class: 'hello' }, composeGreeting(props.name))
  }
})
export default Hello
`

describe('Vue stack — non-breaking refactor + multi-run + dispatch', () => {
  const REPO_ROOT = resolve(import.meta.dirname, '..')
  const REGRET_JS = join(REPO_ROOT, 'scripts', 'regret.js')
  const VALIDATE_JS = join(REPO_ROOT, 'scripts', 'validate.js')
  const INIT_JS = join(REPO_ROOT, 'scripts', 'init.js')
  const TMP2 = resolve(REPO_ROOT, 'tests', `__vue_stack_extra_${process.pid}__`)

  beforeEach(() => {
    rmSync(TMP2, { recursive: true, force: true })
    mkdirSync(join(TMP2, 'src'), { recursive: true })
    mkdirSync(join(TMP2, 'regrets'), { recursive: true })
    writeFileSync(join(TMP2, 'src', 'Hello.js'), HELLO_COMPONENT)
    writeFileSync(join(TMP2, 'package.json'), JSON.stringify({
      name: 'vue-stack-extra-test', version: '1.0.0', type: 'module'
    }))
  })
  after(() => { rmSync(TMP2, { recursive: true, force: true }) })

  function run(script, args = [], cwd = TMP2) {
    const result = spawnSync('node', [script, ...args], {
      cwd, encoding: 'utf8', timeout: 30_000,
    })
    return { exitCode: result.status ?? 1, stdout: result.stdout ?? '', stderr: result.stderr ?? '' }
  }

  function writeManifest2(clusters) {
    writeFileSync(join(TMP2, 'regrets', 'manifest.json'), JSON.stringify({ clusters }, null, 2))
  }

  it('PASSes for a NON-BREAKING refactor (same output HTML, different impl)', () => {
    writeManifest2([{
      id: 'hello-render',
      entry: 'Hello',
      file: './src/Hello.js',
      stack: 'vue',
      fingerprintLevel: 'entry',
      inputs: [{ name: 'World' }],
      watches: [],
    }])

    // Capture with the original
    const cap = run(CAPTURE_VUE)
    assert.equal(cap.exitCode, 0, `capture failed: ${cap.stderr}`)

    // Apply non-breaking refactor (extract helper fn — same HTML output)
    writeFileSync(join(TMP2, 'src', 'Hello.js'), HELLO_REFACTOR_JS)

    // Validate should still PASS
    const val = run(VALIDATE_VUE)
    assert.equal(val.exitCode, 0,
      `validate should exit 0 for non-breaking refactor. stdout: ${val.stdout}`)
    assert.match(val.stdout, /PASS/)
    assert.doesNotMatch(val.stdout, /FAIL/)
  })

  it('supports --runs N for stability checking (multi-run PASS)', () => {
    writeManifest2([{
      id: 'hello-render',
      entry: 'Hello',
      file: './src/Hello.js',
      stack: 'vue',
      fingerprintLevel: 'entry',
      inputs: [{ name: 'World' }],
      watches: [],
    }])

    const cap = run(CAPTURE_VUE)
    assert.equal(cap.exitCode, 0)

    const val = run(VALIDATE_VUE, ['--runs', '3'])
    assert.equal(val.exitCode, 0,
      `validate --runs 3 should exit 0 for stable output. stdout: ${val.stdout}`)
    // Output should indicate stability (either PASS+STABLE or just PASS)
    assert.match(val.stdout, /PASS/)
  })

  it('regret.js validate dispatches Vue clusters to validate_vue.mjs', () => {
    writeManifest2([{
      id: 'hello-render',
      entry: 'Hello',
      file: './src/Hello.js',
      stack: 'vue',
      fingerprintLevel: 'entry',
      inputs: [{ name: 'World' }],
      watches: [],
    }])

    // Capture first
    const cap = run(CAPTURE_VUE)
    assert.equal(cap.exitCode, 0)

    // Run via regret.js — should dispatch to validate_vue.mjs
    const val = run(REGRET_JS, ['validate'])
    assert.equal(val.exitCode, 0,
      `regret.js validate should exit 0. stdout: ${val.stdout}`)
    assert.match(val.stdout, /validate_vue\.mjs/,
      'regret.js should dispatch Vue clusters to validate_vue.mjs')
    assert.match(val.stdout, /PASS/)
  })

  it('regret.js capture dispatches Vue clusters to capture_vue.mjs', () => {
    writeManifest2([{
      id: 'hello-render',
      entry: 'Hello',
      file: './src/Hello.js',
      stack: 'vue',
      fingerprintLevel: 'entry',
      inputs: [{ name: 'World' }],
      watches: [],
    }])

    const cap = run(REGRET_JS, ['capture'])
    assert.equal(cap.exitCode, 0,
      `regret.js capture should exit 0. stdout: ${cap.stdout}`)
    assert.match(cap.stdout, /capture_vue\.mjs/,
      'regret.js should dispatch Vue clusters to capture_vue.mjs')
    assert.ok(existsSync(join(TMP2, 'regrets', 'hello-render.regret')),
      '.regret file should be written')
  })

  it('validate.js skips Vue clusters (does not run them itself)', () => {
    writeManifest2([{
      id: 'hello-render',
      entry: 'Hello',
      file: './src/Hello.js',
      stack: 'vue',
      fingerprintLevel: 'entry',
      inputs: [{ name: 'World' }],
      watches: [],
    }])

    // Capture first via dedicated Vue capture
    const cap = run(CAPTURE_VUE)
    assert.equal(cap.exitCode, 0)

    // validate.js should SKIP Vue clusters (not run them itself)
    const val = run(VALIDATE_JS)
    assert.equal(val.exitCode, 0,
      `validate.js should exit 0 (skipping Vue clusters). stdout: ${val.stdout}`)
    assert.match(val.stdout, /stack=vue — use validate_vue\.mjs/,
      'validate.js should log a skip message for Vue clusters')
  })

  it('init.js --stack vue scaffolds a regrets/ dir with a Vue manifest template', () => {
    const initTmp = resolve(REPO_ROOT, 'tests', `__vue_init_${process.pid}__`)
    rmSync(initTmp, { recursive: true, force: true })
    mkdirSync(initTmp, { recursive: true })

    const result = spawnSync('node', [INIT_JS, '--stack', 'vue'], {
      cwd: initTmp, encoding: 'utf8', timeout: 30_000,
    })
    assert.equal(result.status, 0,
      `init.js --stack vue should exit 0. stderr: ${result.stderr}`)

    const manifestPath = join(initTmp, 'regrets', 'manifest.json')
    assert.ok(existsSync(manifestPath), 'manifest.json should be created')

    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
    assert.ok(manifest.clusters && manifest.clusters.length >= 1,
      'manifest should have at least one cluster')
    const vueCluster = manifest.clusters.find(c => c.stack === 'vue')
    assert.ok(vueCluster, 'manifest should contain a vue cluster')
    assert.equal(vueCluster.stack, 'vue')
    assert.ok(vueCluster.entry, 'vue cluster should have an entry field')
    assert.ok(vueCluster.file, 'vue cluster should have a file field')
    assert.ok(Array.isArray(vueCluster.inputs), 'vue cluster should have inputs array')

    rmSync(initTmp, { recursive: true, force: true })
  })
})

// ─── Issue #315 parity — multi-input INPUTS line ──────────────────────────────

describe('Vue stack — Issue #315 multi-input INPUTS line parity', () => {
  before(() => {
    rmSync(TMP, { recursive: true, force: true })
    setupProject({ 'Hello.js': HELLO_COMPONENT, 'Counter.js': COUNTER_COMPONENT })
  })
  beforeEach(() => {
    rmSync(join(TMP, 'regrets'), { recursive: true, force: true })
    mkdirSync(join(TMP, 'regrets'), { recursive: true })
  })
  after(() => { rmSync(TMP, { recursive: true, force: true }) })

  it('capture_vue.mjs OMITS INPUTS line when only 1 input (backward compat)', () => {
    writeManifest([{
      id: 'hello-single',
      entry: 'Hello',
      file: './src/Hello.js',
      stack: 'vue',
      inputs: [{ name: 'Alice' }],
    }])
    const cap = runCapture()
    assert.equal(cap.exitCode, 0, `capture should succeed. stderr: ${cap.stderr}`)
    const regret = readRegret('hello-single')
    assert.ok(regret, '.regret file should be written')
    assert.ok(!/^INPUTS /m.test(regret),
      'INPUTS line should NOT be present when only 1 input (backward compat)')
  })

  it('capture_vue.mjs WRITES INPUTS line when inputs.length > 1 (Issue #315 parity)', () => {
    writeManifest([{
      id: 'hello-multi',
      entry: 'Hello',
      file: './src/Hello.js',
      stack: 'vue',
      inputs: [
        { name: 'Alice' },
        { name: 'Bob' },
        { name: 'Carol' },
      ],
    }])
    const cap = runCapture()
    assert.equal(cap.exitCode, 0, `capture should succeed. stderr: ${cap.stderr}`)
    const regret = readRegret('hello-multi')
    assert.ok(regret, '.regret file should be written')

    // INPUTS line should be present and parseable as JSON array
    const inputsMatch = regret.match(/^INPUTS (.+)$/m)
    assert.ok(inputsMatch, 'INPUTS line should be present when inputs.length > 1')
    const inputsArr = JSON.parse(inputsMatch[1])
    assert.ok(Array.isArray(inputsArr), 'INPUTS payload should be a JSON array')
    assert.equal(inputsArr.length, 2,
      'INPUTS array should have inputs.length - 1 entries (first input omitted, represented by top-level INPUT/OUTPUT/HASH)')

    // Each entry should have { input, output, hash }
    for (const entry of inputsArr) {
      assert.ok(typeof entry.input === 'object', 'entry.input should be an object')
      assert.ok(typeof entry.output === 'string', 'entry.output should be a string (HTML)')
      assert.ok(typeof entry.hash === 'string' && entry.hash.length === 7,
        'entry.hash should be a 7-char fingerprint string')
    }

    // Verify the omitted-first-input convention: top-level INPUT should be inputs[0]
    const topLevelInputMatch = regret.match(/^INPUT  (.+)$/m)
    assert.ok(topLevelInputMatch, 'top-level INPUT line should be present')
    assert.equal(
      JSON.parse(topLevelInputMatch[1]).name,
      'Alice',
      'top-level INPUT should be inputs[0] (Alice) — first input is omitted from INPUTS array'
    )

    // Verify INPUTS contains inputs[1+] (Bob, Carol) — NOT inputs[0] (Alice)
    const inputNames = inputsArr.map(e => e.input.name).sort()
    assert.deepEqual(inputNames, ['Bob', 'Carol'],
      'INPUTS array should contain inputs[1+] (Bob, Carol), not inputs[0] (Alice)')
  })

  it('validate_vue.mjs PASSes for multi-input contract when code is unchanged', () => {
    writeManifest([{
      id: 'hello-multi',
      entry: 'Hello',
      file: './src/Hello.js',
      stack: 'vue',
      inputs: [
        { name: 'Alice' },
        { name: 'Bob' },
        { name: 'Carol' },
      ],
    }])
    runCapture()  // produce the golden .regret with INPUTS line
    const val = runValidate()
    assert.equal(val.exitCode, 0,
      `validate should PASS for unchanged multi-input contract. stdout: ${val.stdout}`)
    assert.match(val.stdout, /hello-multi.*PASS/,
      'validate output should show PASS for multi-input cluster')
  })

  it('validate_vue.mjs FAILs when a NON-FIRST input breaks (Issue #315 core guarantee)', () => {
    // This is the WHOLE POINT of the INPUTS line: catch breaking changes
    // that affect inputs[1+] but not inputs[0]. Without INPUTS, validate
    // would silently PASS (false GREEN) because the first input's hash
    // still matches.
    writeManifest([{
      id: 'hello-multi',
      entry: 'Hello',
      file: './src/Hello.js',
      stack: 'vue',
      inputs: [
        { name: 'Alice' },     // first input — golden
        { name: 'Bob' },       // second input — will break
        { name: 'Carol' },     // third input — will break
      ],
    }])
    runCapture()  // capture the golden

    // Now patch the component to break ONLY for inputs[1+] — keep "Alice"
    // rendering the same so the first hash still matches. We do this by
    // changing the greeting only when name !== 'Alice'.
    writeFileSync(join(TMP, 'src', 'Hello.js'), `import { defineComponent, h } from 'vue'
export const Hello = defineComponent({
  name: 'Hello',
  props: { name: { type: String, required: true } },
  setup(props) {
    // BREAKING: non-Alice names get "Hi, " instead of "Hello, "
    // Alice still gets "Hello, Alice!" — so the first input's hash matches.
    const greeting = props.name === 'Alice' ? 'Hello' : 'Hi'
    return () => h('div', { class: 'hello' }, greeting + ', ' + props.name + '!')
  }
})
export default Hello
`)

    const val = runValidate()
    assert.notEqual(val.exitCode, 0,
      `validate should FAIL when a non-first input breaks. stdout: ${val.stdout}`)

    // The FAIL message should specifically mention the multi-input failures
    // (not just a generic hash mismatch on the first input)
    assert.match(val.stdout, /hello-multi.*FAIL/,
      'validate output should show FAIL for multi-input cluster')
    assert.match(val.stdout, /Expected:.*Got:/,
      'validate output should show per-input Expected/Got diffs for the broken inputs')

    // CRITICAL: the first input's hash should still match (Alice is unchanged).
    // If validate_vue.mjs reported a generic first-input FAIL, that would be a
    // false positive. The failure MUST come from inputs[1+].
    assert.ok(
      !/hello-multi\s+<\w+>\s+→\s+<\w+>\s+FAIL\s*$/.test(val.stdout),
      'first input should still PASS — failure must come from inputs[1+] (no generic first-input hash mismatch)'
    )
  })

  it('validate_vue.mjs --update refreshes the INPUTS line on multi-input contract', () => {
    writeManifest([{
      id: 'hello-multi',
      entry: 'Hello',
      file: './src/Hello.js',
      stack: 'vue',
      inputs: [
        { name: 'Alice' },
        { name: 'Bob' },
      ],
    }])
    runCapture()  // golden with INPUTS line
    const regretBefore = readRegret('hello-multi')
    const inputsMatchBefore = regretBefore.match(/^INPUTS (.+)$/m)
    assert.ok(inputsMatchBefore, 'precondition: INPUTS line should exist')

    // Patch the component — change greeting for everyone (including Alice).
    // This breaks BOTH inputs, requiring an --update.
    writeFileSync(join(TMP, 'src', 'Hello.js'), `import { defineComponent, h } from 'vue'
export const Hello = defineComponent({
  name: 'Hello',
  props: { name: { type: String, required: true } },
  setup(props) {
    return () => h('div', { class: 'hello' }, 'Hola, ' + props.name + '!')
  }
})
export default Hello
`)

    const val = runValidate(['--update', 'hello-multi', '--reason',
      'greeting changed from Hello to Hola per localization requirement'])
    assert.equal(val.exitCode, 0,
      `--update should succeed. stdout: ${val.stdout}`)
    assert.match(val.stdout, /UPDATED/, 'validate output should show UPDATED')

    // The .regret file should now have REFRESHED INPUTS line with new hashes
    const regretAfter = readRegret('hello-multi')
    const inputsMatchAfter = regretAfter.match(/^INPUTS (.+)$/m)
    assert.ok(inputsMatchAfter, 'INPUTS line should still exist after --update')
    const inputsAfter = JSON.parse(inputsMatchAfter[1])
    const inputsBefore = JSON.parse(inputsMatchBefore[1])
    assert.equal(inputsAfter.length, inputsBefore.length,
      'INPUTS array length should be unchanged after --update')
    for (let i = 0; i < inputsAfter.length; i++) {
      assert.notEqual(inputsAfter[i].hash, inputsBefore[i].hash,
        `INPUTS[${i}].hash should be refreshed after --update (was ${inputsBefore[i].hash}, now ${inputsAfter[i].hash})`)
    }

    // Re-validate — should now PASS with the new golden
    const reVal = runValidate()
    assert.equal(reVal.exitCode, 0,
      `validate should PASS after --update. stdout: ${reVal.stdout}`)
  })

  it('validate_vue.mjs --json surfaces multiInputFailures in the result', () => {
    writeManifest([{
      id: 'hello-multi',
      entry: 'Hello',
      file: './src/Hello.js',
      stack: 'vue',
      inputs: [
        { name: 'Alice' },
        { name: 'Bob' },
      ],
    }])
    runCapture()

    // Break only Bob
    writeFileSync(join(TMP, 'src', 'Hello.js'), `import { defineComponent, h } from 'vue'
export const Hello = defineComponent({
  name: 'Hello',
  props: { name: { type: String, required: true } },
  setup(props) {
    const greeting = props.name === 'Alice' ? 'Hello' : 'Hi'
    return () => h('div', { class: 'hello' }, greeting + ', ' + props.name + '!')
  }
})
export default Hello
`)

    const val = runValidate(['--json'])
    assert.notEqual(val.exitCode, 0, '--json should exit non-zero on FAIL')
    const parsed = JSON.parse(val.stdout)
    assert.equal(parsed.stack, 'vue')
    assert.equal(parsed.failed, 1)
    const failedCluster = parsed.results.find(r => r.id === 'hello-multi')
    assert.ok(failedCluster, 'hello-multi should be in results')
    assert.equal(failedCluster.pass, false)
    assert.ok(Array.isArray(failedCluster.multiInputFailures),
      'multiInputFailures array should be present in --json output on multi-input FAIL')
    assert.equal(failedCluster.multiInputFailures.length, 1,
      'exactly one input (Bob) should be in multiInputFailures')
    assert.equal(failedCluster.multiInputFailures[0].input.name, 'Bob',
      'the failing input should be Bob (Alice still matches)')
  })
})

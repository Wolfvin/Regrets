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

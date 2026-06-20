// tests/java-stack.test.js — end-to-end tests for the Java stack support
//
// Verifies:
//   1. The Java fixture compiles
//   2. capture_java.sh produces .regret files for all clusters in the manifest
//   3. validate_java.sh PASSes when the source matches the captured contracts
//   4. validate_java.sh FAILs when the source has been mutated (breaking refactor)
//   5. Cross-stack fingerprint parity: Java fingerprints match JS fingerprints
//      for the same input/output pairs (critical contract — the .regret file
//      format must be stack-agnostic)
//
// These tests are skipped automatically if `javac` is not available on PATH
// (or in the standard worker fallback location). This keeps CI green on
// machines without a JDK, while still verifying the full pipeline on
// developer machines and the worker environment.

import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync, execSync, spawnSync } from 'child_process'
import { existsSync, readFileSync, mkdirSync, rmSync, writeFileSync, copyFileSync } from 'fs'
import { resolve, join, dirname } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = resolve(__dirname, '..')
const FIXTURE_DIR = join(REPO_ROOT, 'tests', 'fixtures', 'java')
const SCRIPTS_DIR = join(REPO_ROOT, 'scripts')

// ─── Locate javac ────────────────────────────────────────────────────────────
//
// Mirror the logic in capture_java.sh: PATH first, then known fallback paths.

function findJavac() {
  const candidates = [
    'javac',  // resolves via PATH
    '/home/z/.jdk/jdk-21.0.11+10/bin/javac',
    '/usr/lib/jvm/java-21-openjdk-amd64/bin/javac',
  ]
  for (const c of candidates) {
    try {
      const r = spawnSync(c, ['--version'], { stdio: 'pipe' })
      if (r.status === 0) return c
    } catch { /* not found, try next */ }
  }
  return null
}

const JAVAC = findJavac()
const JAVA = JAVAC ? (JAVAC === 'javac' ? 'java' : resolve(dirname(JAVAC), 'java')) : null

// Skip all tests if no JDK available — keeps CI green on JDK-less machines
const describeOrSkip = JAVAC ? describe : describe.skip

// ─── Helpers ─────────────────────────────────────────────────────────────────

function runBash(script, args, cwd = FIXTURE_DIR, env = { ...process.env, PATH: `${dirname(JAVAC || '')}:${process.env.PATH}` }) {
  const r = spawnSync('bash', [script, ...args], { cwd, env, stdio: 'pipe' })
  return {
    status: r.status,
    stdout: r.stdout?.toString() ?? '',
    stderr: r.stderr?.toString() ?? '',
  }
}

function compileFixture() {
  if (!JAVAC) return
  const buildDir = join(FIXTURE_DIR, 'build', 'classes')
  mkdirSync(buildDir, { recursive: true })
  const sources = [
    join(FIXTURE_DIR, 'src', 'com', 'example', 'MathUtils.java'),
    join(FIXTURE_DIR, 'src', 'com', 'example', 'Formatter.java'),
  ]
  const r = spawnSync(JAVAC, ['-d', buildDir, ...sources], { stdio: 'pipe' })
  if (r.status !== 0) {
    throw new Error('Fixture compilation failed: ' + r.stderr?.toString())
  }
}

function readRegretFile(clusterId) {
  const p = join(FIXTURE_DIR, 'regrets', `${clusterId}.regret`)
  if (!existsSync(p)) return null
  return readFileSync(p, 'utf8')
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describeOrSkip('Java stack — end-to-end', () => {
  // Compile fixture and clean regrets/ before each test run
  before(() => {
    compileFixture()
    // Clean any stale .regret files from previous runs
    const regretsDir = join(FIXTURE_DIR, 'regrets')
    if (existsSync(regretsDir)) {
      // Preserve manifest.json, delete generated files
      const files = ['RegretCaptureTest.java', 'RegretValidateTest.java']
      for (const f of files) {
        try { rmSync(join(regretsDir, f)) } catch { /* ok if missing */ }
      }
      // Don't delete .regret files — capture will overwrite
      try { rmSync(join(regretsDir, '_build'), { recursive: true, force: true }) } catch {}
    }
  })

  it('capture_java.sh writes .regret files for all 9 clusters', () => {
    const r = runBash(join(SCRIPTS_DIR, 'capture_java.sh'), [])
    assert.equal(r.status, 0, `capture failed: ${r.stderr}`)
    assert.match(r.stdout, /9 captured, 0 failed/)

    const expectedClusters = [
      'java-square', 'java-factorial', 'java-reverse-decimal',
      'java-to-upper', 'java-reverse-string',
      'java-join-multiargs', 'java-add-multiargs',
      'java-formatter-format', 'java-formatter-allformats',
    ]
    for (const id of expectedClusters) {
      const content = readRegretFile(id)
      assert.ok(content, `Missing .regret file for ${id}`)
      assert.match(content, /^cluster: /m)
      assert.match(content, /^stack: java$/m)
      assert.match(content, /^fingerprint: [a-z0-9]{7}$/m)
      assert.match(content, /^HASH\s+[a-z0-9]{7}$/m)
      assert.match(content, /^INPUT\s/m)
      assert.match(content, /^OUTPUT\s/m)
    }
  })

  it('validate_java.sh PASSes when source matches contracts', () => {
    const r = runBash(join(SCRIPTS_DIR, 'validate_java.sh'), [])
    assert.equal(r.status, 0, `validate failed: ${r.stderr}`)
    assert.match(r.stdout, /9 passed, 0 failed, 0 drift/)
  })

  it('validate_java.sh FAILs when square() is mutated', () => {
    const srcPath = join(FIXTURE_DIR, 'src', 'com', 'example', 'MathUtils.java')
    const original = readFileSync(srcPath, 'utf8')
    const mutated = original.replace('return n * n;', 'return n * n * n;')
    assert.notEqual(original, mutated, 'mutation did not change source — check regex')
    writeFileSync(srcPath, mutated)

    try {
      // Recompile the mutated source
      const buildDir = join(FIXTURE_DIR, 'build', 'classes')
      spawnSync(JAVAC, ['-d', buildDir, srcPath], { stdio: 'pipe' })

      const r = runBash(join(SCRIPTS_DIR, 'validate_java.sh'), ['--cluster', 'java-square'])
      assert.notEqual(r.status, 0, 'validate should FAIL after breaking mutation')
      assert.match(r.stdout, /FAIL — fingerprint mismatch/)
    } finally {
      // Always restore — even on assertion failure
      writeFileSync(srcPath, original)
      spawnSync(JAVAC, ['-d', join(FIXTURE_DIR, 'build', 'classes'), srcPath], { stdio: 'pipe' })
    }
  })

  it('validate_java.sh --runs N detects drift (deterministic fixture → no drift)', () => {
    const r = runBash(join(SCRIPTS_DIR, 'validate_java.sh'), ['--runs', '3'])
    assert.equal(r.status, 0, `validate failed: ${r.stderr}`)
    assert.match(r.stdout, /9 passed, 0 failed, 0 drift/)
  })

  it('cross-stack fingerprint parity: Java fingerprint == JS fingerprint', async () => {
    // Verify the same input/output pairs produce identical fingerprints
    // in JS and Java. This is the critical contract for stack-agnostic .regret files.
    const { fingerprint } = await import('../scripts/fingerprint.js')
    // Cases that must match the Java fixture's golden fingerprints
    // (captured in the .regret files from the first test)
    const cases = [
      { id: 'java-square', input: 5, output: 25 },
      { id: 'java-to-upper', input: 'hello', output: 'HELLO' },
      { id: 'java-formatter-format', input: '2025_05', output: '052025' },
    ]
    for (const c of cases) {
      const jsFp = fingerprint(c.input, c.output)
      const regret = readRegretFile(c.id)
      assert.ok(regret, `Missing ${c.id}.regret`)
      const match = regret.match(/^HASH\s+(\S+)/m)
      assert.ok(match, `No HASH in ${c.id}.regret`)
      const javaHash = match[1]
      assert.equal(jsFp, javaHash,
        `Cross-stack parity broken for ${c.id}: JS=${jsFp} Java=${javaHash}`)
    }
  })
})

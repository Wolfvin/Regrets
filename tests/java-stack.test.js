// tests/java-stack.test.js
// Verifies the Java stack (capture_java.sh + validate_java.sh + RegretJava.java):
//   - capture writes .regret files with the standard format
//   - validate PASSes when the captured code is unchanged
//   - validate PASSes for a valid refactor (output preserved)
//   - validate FAILs (non-zero exit) for a breaking refactor (output changed)
//   - Java fingerprint matches JS fingerprint() for the same (input, output)
//
// Skips automatically when `java` is not on PATH (so this test is safe in
// environments without a JVM).

import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, writeFileSync, readFileSync, rmSync, copyFileSync, existsSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { fingerprint } from '../scripts/fingerprint.js'

const ROOT = resolve(import.meta.dirname, '..')
const SCRIPTS_DIR = join(ROOT, 'scripts')
const CAPTURE_SH  = join(SCRIPTS_DIR, 'capture_java.sh')
const VALIDATE_SH = join(SCRIPTS_DIR, 'validate_java.sh')
const JAVA_FILE   = join(SCRIPTS_DIR, 'regret_java', 'RegretJava.java')

const TMP = resolve(join(process.cwd(), 'tests', `__java_${process.pid}__`))

const hasJava = (() => {
  const r = spawnSync('java', ['-version'], { stdio: 'ignore' })
  return r.status === 0
})()

const itIfJava = hasJava ? it : it.skip

function setupProject() {
  mkdirSync(join(TMP, 'regrets'), { recursive: true })
  writeFileSync(join(TMP, 'regrets', 'manifest.json'), JSON.stringify({
    clusters: [
      {
        id: 'add',
        entry: 'add', method: 'add',
        class: 'DemoMathUtils',
        stack: 'java', fingerprintLevel: 'entry',
        watches: ['add'],
        multiArgs: true,
        inputs: [[2, 3]],
      },
      {
        id: 'fibonacci',
        entry: 'fibonacci', method: 'fibonacci',
        class: 'DemoMathUtils',
        stack: 'java', fingerprintLevel: 'entry',
        watches: ['fibonacci'],
        inputs: [10],
      },
      {
        id: 'reverse',
        entry: 'reverse', method: 'reverse',
        class: 'DemoMathUtils',
        stack: 'java', fingerprintLevel: 'entry',
        watches: ['reverse'],
        inputs: ['Hello, World!'],
      },
      {
        // Edge-case cluster: returns a Map with NaN / +Infinity / -Infinity
        // nested inside. Used by the cross-stack parity test for the
        // __nan__ / __infinity__ / __neg_infinity__ sentinels.
        id: 'stats',
        entry: 'computeStats', method: 'computeStats',
        class: 'DemoMathUtils',
        stack: 'java', fingerprintLevel: 'entry',
        watches: ['computeStats'],
        inputs: [0],
      },
    ],
  }, null, 2))
}

function run(script, args = [], opts = {}) {
  return spawnSync('bash', [script, ...args], {
    cwd: TMP,
    encoding: 'utf8',
    ...opts,
  })
}

function readRegret(id) {
  const p = join(TMP, 'regrets', `${id}.regret`)
  return readFileSync(p, 'utf8')
}

function extractHash(regretContent) {
  const m = regretContent.match(/^HASH\s+(\S+)/m)
  return m ? m[1] : null
}

function extractOutput(regretContent) {
  const m = regretContent.match(/^OUTPUT\s+(.*)$/m)
  return m ? JSON.parse(m[1]) : null
}

describe('Java stack', () => {
  before(() => {
    if (!hasJava) return
    setupProject()
  })

  after(() => {
    if (existsSync(TMP)) rmSync(TMP, { recursive: true, force: true })
  })

  itIfJava('capture writes .regret files with the standard format', () => {
    const r = run(CAPTURE_SH)
    assert.equal(r.status, 0, `capture failed: ${r.stdout}\n${r.stderr}`)

    const addRegret = readRegret('add')
    for (const field of ['cluster:', 'version:', 'fingerprint:', 'captured:',
                         'watches:', 'entry:', 'stack: java', 'fingerprintLevel:',
                         '---', 'INPUT  ', 'OUTPUT ', 'HASH   ']) {
      assert.ok(addRegret.includes(field), `missing field "${field}" in add.regret:\n${addRegret}`)
    }
  })

  itIfJava('validate PASSes for unchanged code', () => {
    // Capture first to ensure .regret files exist
    run(CAPTURE_SH)
    const r = run(VALIDATE_SH)
    assert.equal(r.status, 0, `validate should PASS for unchanged code:\n${r.stdout}\n${r.stderr}`)
    assert.match(r.stdout, /Passed: 4/)
  })

  itIfJava('Java fingerprint matches JS fingerprint() (cross-stack parity)', () => {
    run(CAPTURE_SH)
    const cases = [
      { id: 'add',       input: [2, 3],            output: 5 },
      { id: 'fibonacci', input: 10,                output: 55 },
      { id: 'reverse',   input: 'Hello, World!',   output: '!dlroW ,olleH' },
    ]
    for (const c of cases) {
      const regret = readRegret(c.id)
      const javaHash = extractHash(regret)
      const jsHash = fingerprint(c.input, c.output)
      assert.equal(javaHash, jsHash, `parity mismatch for ${c.id}: Java=${javaHash} JS=${jsHash}`)
    }
  })

  itIfJava('cross-stack parity holds for non-finite sentinels (NaN/Infinity) and nested objects', () => {
    // Uses the `computeStats` method which returns a Map<String,Object> with
    // insertion order {input, reciprocal, negReciprocal, nanField} containing
    // NaN, +Infinity, -Infinity. After stableStringify the canonical form is
    //   {"input":0,"nanField":"__nan__","negReciprocal":"__neg_infinity__","reciprocal":"__infinity__"}
    // — JS fingerprint() must produce the same hash as the Java capture for
    // the equivalent JS object. This guards the issue #322 sentinel paths
    // and recursive key sorting, which the basic int/string demos never hit.
    run(CAPTURE_SH)
    const regret = readRegret('stats')
    const javaHash = extractHash(regret)
    const jsHash = fingerprint(0, {
      input: 0,
      reciprocal: Infinity,
      negReciprocal: -Infinity,
      nanField: NaN,
    })
    assert.equal(javaHash, jsHash,
      `parity mismatch for stats: Java=${javaHash} JS=${jsHash}\n` +
      `Java OUTPUT line: ${extractOutput(regret)}`)
  })

  itIfJava('validate PASSes for a valid refactor (output preserved)', () => {
    const backup = join(TMP, 'RegretJava.java.bak')
    copyFileSync(JAVA_FILE, backup)
    try {
      // Replace fibonacci body with Binet's formula (output for n=10 still 55)
      let src = readFileSync(JAVA_FILE, 'utf8')
      const old = `    /** Compute the n-th Fibonacci number (0-indexed, iterative). */
    public static long fibonacci(int n) {
        if (n < 0) throw new IllegalArgumentException("n must be >= 0");
        if (n == 0) return 0L;
        if (n == 1) return 1L;
        long a = 0, b = 1;
        for (int i = 2; i <= n; i++) {
            long c = a + b;
            a = b;
            b = c;
        }
        return b;
    }`
      const next = `    /** Compute the n-th Fibonacci number (0-indexed, via Binet's formula — refactor). */
    public static long fibonacci(int n) {
        if (n < 0) throw new IllegalArgumentException("n must be >= 0");
        if (n == 0) return 0L;
        if (n == 1) return 1L;
        double phi = (1.0 + Math.sqrt(5.0)) / 2.0;
        double psi = (1.0 - Math.sqrt(5.0)) / 2.0;
        return Math.round((Math.pow(phi, n) - Math.pow(psi, n)) / Math.sqrt(5.0));
    }`
      assert.ok(src.includes(old), 'original fibonacci body not found')
      writeFileSync(JAVA_FILE, src.replace(old, next))

      const r = run(VALIDATE_SH)
      assert.equal(r.status, 0, `valid refactor should PASS:\n${r.stdout}\n${r.stderr}`)
      assert.match(r.stdout, /Passed: 4/)
    } finally {
      copyFileSync(backup, JAVA_FILE)
      rmSync(backup, { force: true })
    }
  })

  itIfJava('validate FAILs (non-zero exit) for a breaking refactor (output changed)', () => {
    const backup = join(TMP, 'RegretJava.java.bak')
    copyFileSync(JAVA_FILE, backup)
    try {
      // Change fibonacci to 1-indexed (n=10 returns 89 instead of 55)
      let src = readFileSync(JAVA_FILE, 'utf8')
      const old = `    /** Compute the n-th Fibonacci number (0-indexed, iterative). */
    public static long fibonacci(int n) {
        if (n < 0) throw new IllegalArgumentException("n must be >= 0");
        if (n == 0) return 0L;
        if (n == 1) return 1L;
        long a = 0, b = 1;
        for (int i = 2; i <= n; i++) {
            long c = a + b;
            a = b;
            b = c;
        }
        return b;
    }`
      const next = `    /** Compute the n-th Fibonacci number (1-indexed — BREAKING refactor). */
    public static long fibonacci(int n) {
        if (n < 0) throw new IllegalArgumentException("n must be >= 0");
        if (n == 0) return 1L;
        if (n == 1) return 1L;
        long a = 1, b = 1;
        for (int i = 2; i <= n; i++) {
            long c = a + b;
            a = b;
            b = c;
        }
        return b;
    }`
      assert.ok(src.includes(old), 'original fibonacci body not found')
      writeFileSync(JAVA_FILE, src.replace(old, next))

      const r = run(VALIDATE_SH)
      assert.notEqual(r.status, 0, `breaking refactor should FAIL (non-zero exit)`)
      // fibonacci cluster should be the one that FAILs — fibonacci appears on
      // the line above the FAIL line, so use a multiline-aware regex.
      assert.match(r.stdout, /fibonacci[\s\S]*FAIL/, 'FAIL should be on the fibonacci cluster')
      assert.match(r.stdout, /Failed: 1/, 'summary should show 1 failure')
    } finally {
      copyFileSync(backup, JAVA_FILE)
      rmSync(backup, { force: true })
    }
  })
})

describe('Java stack (no java installed)', () => {
  // Always runs; if java IS installed, the previous describe block covers functional tests.
  // This block guards against the capture_java.sh wrapper exiting with the wrong code
  // when java is missing (we want a clean error message + non-zero exit, not a crash).
  it('capture_java.sh prints a clear error when java is missing', { skip: hasJava }, () => {
    setupProject()
    try {
      const r = run(CAPTURE_SH)
      assert.notEqual(r.status, 0, 'should exit non-zero when java is missing')
      assert.match(r.stdout + r.stderr, /java not found|Install JDK/i)
    } finally {
      if (existsSync(TMP)) rmSync(TMP, { recursive: true, force: true })
    }
  })
})

describe('Java stack — verify_java_stack.sh', () => {
  // The one-command end-to-end verifier. Skipped when java is missing.
  const VERIFY_SH = join(SCRIPTS_DIR, 'verify_java_stack.sh')

  itIfJava('verify_java_stack.sh exists and is executable', () => {
    assert.ok(existsSync(VERIFY_SH), `missing ${VERIFY_SH}`)
    const r = spawnSync('bash', ['-n', VERIFY_SH], { encoding: 'utf8' })
    assert.equal(r.status, 0, `verify_java_stack.sh has a syntax error:\n${r.stderr}`)
  })

  itIfJava('verify_java_stack.sh PASSes end-to-end (capture + refactor + parity)', { timeout: 60000 }, () => {
    // Run the verifier from the repo root so its relative paths resolve.
    const r = spawnSync('bash', [VERIFY_SH], {
      cwd: ROOT,
      encoding: 'utf8',
    })
    assert.equal(r.status, 0,
      `verify_java_stack.sh exited ${r.status} (expected 0)\n--- stdout ---\n${r.stdout}\n--- stderr ---\n${r.stderr}`)
    // The summary line should report all checks PASSed.
    assert.match(r.stdout, /All Java stack checks PASSed/, 'summary line missing')
    // All 6 verify sections must have run.
    for (const section of [
      'Check prerequisites',
      'Capture (write .regret files)',
      'Validate baseline',
      'Apply VALID refactor',
      'Apply BREAKING refactor',
      'cross-stack fingerprint parity',
    ]) {
      assert.ok(r.stdout.includes(section),
        `verify_java_stack.sh missing section: ${section}`)
    }
  })
})

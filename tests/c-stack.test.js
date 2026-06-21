// tests/c-stack.test.js
// Verifies the C stack (capture_c.sh + validate_c.sh + regret_harness.c):
//   - capture writes .regret files with the standard format
//   - validate PASSes when the captured code is unchanged
//   - validate PASSes for a valid refactor (output preserved)
//   - validate FAILs (non-zero exit) for a breaking refactor (output changed)
//   - C fingerprint matches JS fingerprint() for the same (input, output)
//
// Skips automatically when `gcc` is not on PATH or when libcrypto/json-c
// headers are missing (so this test is safe in environments without a C
// toolchain).

import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, writeFileSync, readFileSync, rmSync, copyFileSync, existsSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { fingerprint } from '../scripts/fingerprint.js'

const ROOT = resolve(import.meta.dirname, '..')
const SCRIPTS_DIR = join(ROOT, 'scripts')
const CAPTURE_SH  = join(SCRIPTS_DIR, 'capture_c.sh')
const VALIDATE_SH = join(SCRIPTS_DIR, 'validate_c.sh')
const DEMO_SRC    = join(ROOT, 'proof', 'c', 'demo_math.c')
const DEMO_HDR    = join(ROOT, 'proof', 'c', 'demo_math.h')
const ADAPTER_SRC = join(ROOT, 'proof', 'c', 'regret_adapter.c')

const TMP = resolve(join(process.cwd(), 'tests', `__c_${process.pid}__`))

// Detect C toolchain availability
const hasGcc = (() => {
  const r = spawnSync('gcc', ['--version'], { stdio: 'ignore' })
  return r.status === 0
})()
const hasLibs = (() => {
  if (!hasGcc) return false
  // Try compiling a tiny test that uses libcrypto + libjson-c
  const tmpC = join(TMP, '_probe.c')
  try {
    mkdirSync(TMP, { recursive: true })
    writeFileSync(tmpC, `#include <openssl/sha.h>\n#include <json-c/json.h>\nint main(){return 0;}\n`)
    const r = spawnSync('gcc', [tmpC, '-o', join(TMP, '_probe'), '-lcrypto', '-ljson-c'], { stdio: 'ignore' })
    return r.status === 0
  } catch {
    return false
  } finally {
    // cleanup handled by after() hook
  }
})()

const itIfC = (hasGcc && hasLibs) ? it : it.skip

function setupProject() {
  mkdirSync(join(TMP, 'regrets'), { recursive: true })
  writeFileSync(join(TMP, 'regrets', 'manifest.json'), JSON.stringify({
    clusters: [
      {
        id: 'add', entry: 'regret_add', stack: 'c',
        fingerprintLevel: 'entry', watches: ['demo_add'],
        inputs: [[2, 3]],
      },
      {
        id: 'fibonacci', entry: 'regret_fibonacci', stack: 'c',
        fingerprintLevel: 'entry', watches: ['demo_fibonacci'],
        inputs: [10],
      },
      {
        id: 'reverse', entry: 'regret_reverse', stack: 'c',
        fingerprintLevel: 'entry', watches: ['demo_reverse'],
        inputs: ['Hello, World!'],
      },
    ],
  }, null, 2))
  // Copy the demo sources + adapter
  copyFileSync(DEMO_SRC, join(TMP, 'demo_math.c'))
  copyFileSync(DEMO_HDR, join(TMP, 'demo_math.h'))
  copyFileSync(ADAPTER_SRC, join(TMP, 'regret_adapter.c'))
}

function run(script, args = [], opts = {}) {
  return spawnSync('bash', [script, ...args], {
    cwd: TMP,
    encoding: 'utf8',
    env: {
      ...process.env,
      C_SOURCES: `${TMP}/demo_math.c:${TMP}/regret_adapter.c`,
      C_INCLUDE: TMP,
    },
    ...opts,
  })
}

function readRegret(id) {
  return readFileSync(join(TMP, 'regrets', `${id}.regret`), 'utf8')
}

describe('C stack', () => {
  before(() => {
    if (!hasGcc || !hasLibs) return
    setupProject()
  })

  after(() => {
    if (existsSync(TMP)) rmSync(TMP, { recursive: true, force: true })
  })

  itIfC('capture writes .regret files with the standard format', () => {
    const r = run(CAPTURE_SH)
    assert.equal(r.status, 0, `capture failed: ${r.stdout}\n${r.stderr}`)

    const addRegret = readRegret('add')
    for (const field of ['cluster:', 'version:', 'fingerprint:', 'captured:',
                         'watches:', 'entry:', 'stack: c', 'fingerprintLevel:',
                         '---', 'INPUT  ', 'OUTPUT ', 'HASH   ']) {
      assert.ok(addRegret.includes(field), `missing field "${field}" in add.regret:\n${addRegret}`)
    }
  })

  itIfC('validate PASSes for unchanged code', () => {
    run(CAPTURE_SH)
    const r = run(VALIDATE_SH)
    assert.equal(r.status, 0, `validate should PASS for unchanged code:\n${r.stdout}\n${r.stderr}`)
    assert.match(r.stdout, /Passed: 3/)
  })

  itIfC('C fingerprint matches JS fingerprint() (cross-stack parity)', () => {
    run(CAPTURE_SH)
    const cases = [
      { id: 'add',       input: [2, 3],            output: 5 },
      { id: 'fibonacci', input: 10,                output: 55 },
      { id: 'reverse',   input: 'Hello, World!',   output: '!dlroW ,olleH' },
    ]
    for (const c of cases) {
      const regret = readRegret(c.id)
      const m = regret.match(/^HASH\s+(\S+)/m)
      const cHash = m ? m[1] : null
      const jsHash = fingerprint(c.input, c.output)
      assert.equal(cHash, jsHash, `parity mismatch for ${c.id}: C=${cHash} JS=${jsHash}`)
    }
  })

  itIfC('validate PASSes for a valid refactor (output preserved)', () => {
    const demoPath = join(TMP, 'demo_math.c')
    const backup = join(TMP, 'demo_math.c.bak')
    copyFileSync(demoPath, backup)
    try {
      let src = readFileSync(demoPath, 'utf8')
      const old = `long demo_fibonacci(int n) {
    if (n < 0) return -1;  // error sentinel (skipped via trivial guard? no — non-null)
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
      const next = `long demo_fibonacci(int n) {
    /* Binet's closed-form formula — refactor (output preserved for n=10). */
    if (n < 0) return -1;
    if (n == 0) return 0L;
    if (n == 1) return 1L;
    double phi = (1.0 + sqrt(5.0)) / 2.0;
    double psi = (1.0 - sqrt(5.0)) / 2.0;
    return (long)((pow(phi, n) - pow(psi, n)) / sqrt(5.0));
}`
      assert.ok(src.includes(old), 'original fibonacci body not found')
      // Also need math.h if not already included
      if (!src.includes('#include <math.h>')) {
        src = src.replace('#include <ctype.h>', '#include <ctype.h>\n#include <math.h>')
      }
      writeFileSync(demoPath, src.replace(old, next))

      const r = run(VALIDATE_SH)
      assert.equal(r.status, 0, `valid refactor should PASS:\n${r.stdout}\n${r.stderr}`)
      assert.match(r.stdout, /Passed: 3/)
    } finally {
      copyFileSync(backup, demoPath)
      rmSync(backup, { force: true })
    }
  })

  itIfC('validate FAILs (non-zero exit) for a breaking refactor (output changed)', () => {
    const demoPath = join(TMP, 'demo_math.c')
    const backup = join(TMP, 'demo_math.c.bak')
    copyFileSync(demoPath, backup)
    try {
      let src = readFileSync(demoPath, 'utf8')
      const old = `long demo_fibonacci(int n) {
    if (n < 0) return -1;  // error sentinel (skipped via trivial guard? no — non-null)
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
      const next = `long demo_fibonacci(int n) {
    /* BREAKING refactor: now 1-indexed (n=10 → 89 instead of 55). */
    if (n < 0) return -1;
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
      writeFileSync(demoPath, src.replace(old, next))

      const r = run(VALIDATE_SH)
      assert.notEqual(r.status, 0, `breaking refactor should FAIL (non-zero exit)`)
      // fibonacci cluster should be the one that FAILs — fibonacci appears on
      // the line above the FAIL line, so use a multiline-aware regex.
      assert.match(r.stdout, /fibonacci[\s\S]*FAIL/, 'FAIL should be on the fibonacci cluster')
      assert.match(r.stdout, /Failed: 1/, 'summary should show 1 failure')
    } finally {
      copyFileSync(backup, demoPath)
      rmSync(backup, { force: true })
    }
  })
})

describe('C stack (no C toolchain)', () => {
  it('capture_c.sh prints a clear error when gcc is missing', { skip: hasGcc }, () => {
    setupProject()
    try {
      const r = run(CAPTURE_SH)
      assert.notEqual(r.status, 0, 'should exit non-zero when gcc is missing')
      assert.match(r.stdout + r.stderr, /gcc|C compiler/i)
    } finally {
      if (existsSync(TMP)) rmSync(TMP, { recursive: true, force: true })
    }
  })
})

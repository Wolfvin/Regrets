// tests/cpp-stack.test.js
// Verifies the C++ stack (capture_cpp.sh + validate_cpp.sh + regret_harness.cpp):
//   - capture writes .regret files with the standard format
//   - validate PASSes when the captured code is unchanged
//   - validate PASSes for a valid refactor (output preserved)
//   - validate FAILs (non-zero exit) for a breaking refactor (output changed)
//   - C++ exceptions during validate are caught and reported as FAIL (no crash)
//   - C++ fingerprint matches JS fingerprint() for the same (input, output)
//
// Skips automatically when `g++` is not on PATH or when libcrypto/json-c
// headers are missing (so this test is safe in environments without a C++
// toolchain).

import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, writeFileSync, readFileSync, rmSync, copyFileSync, existsSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { fingerprint } from '../scripts/fingerprint.js'

const ROOT = resolve(import.meta.dirname, '..')
const SCRIPTS_DIR = join(ROOT, 'scripts')
const CAPTURE_SH  = join(SCRIPTS_DIR, 'capture_cpp.sh')
const VALIDATE_SH = join(SCRIPTS_DIR, 'validate_cpp.sh')
const DEMO_SRC    = join(ROOT, 'proof', 'cpp', 'demo_math.cpp')
const DEMO_HDR    = join(ROOT, 'proof', 'cpp', 'demo_math.hpp')
const ADAPTER_SRC = join(ROOT, 'proof', 'cpp', 'regret_adapter.cpp')

const TMP = resolve(join(process.cwd(), 'tests', `__cpp_${process.pid}__`))

// Detect C++ toolchain availability
const hasGpp = (() => {
  const r = spawnSync('g++', ['--version'], { stdio: 'ignore' })
  return r.status === 0
})()
const hasLibs = (() => {
  if (!hasGpp) return false
  const tmpC = join(TMP, '_probe.cpp')
  try {
    mkdirSync(TMP, { recursive: true })
    writeFileSync(tmpC,
      `#include <openssl/sha.h>\n#include <json-c/json.h>\nint main(){return 0;}\n`)
    const r = spawnSync('g++', [tmpC, '-o', join(TMP, '_probe'), '-lcrypto', '-ljson-c'],
      { stdio: 'ignore' })
    return r.status === 0
  } catch {
    return false
  }
})()

const itIfCpp = (hasGpp && hasLibs) ? it : it.skip

function setupProject() {
  mkdirSync(join(TMP, 'regrets'), { recursive: true })
  writeFileSync(join(TMP, 'regrets', 'manifest.json'), JSON.stringify({
    clusters: [
      {
        id: 'add', entry: 'regret_add', stack: 'cpp',
        fingerprintLevel: 'entry', watches: ['demo_add'],
        inputs: [[2, 3]],
      },
      {
        id: 'fibonacci', entry: 'regret_fibonacci', stack: 'cpp',
        fingerprintLevel: 'entry', watches: ['demo_fibonacci'],
        inputs: [10],
      },
      {
        id: 'reverse', entry: 'regret_reverse', stack: 'cpp',
        fingerprintLevel: 'entry', watches: ['demo_reverse'],
        inputs: ['Hello, World!'],
      },
      {
        // Class-method example
        id: 'factorial', entry: 'regret_factorial', stack: 'cpp',
        fingerprintLevel: 'entry', watches: ['MathUtils::factorial'],
        inputs: [5],
      },
    ],
  }, null, 2))
  copyFileSync(DEMO_SRC, join(TMP, 'demo_math.cpp'))
  copyFileSync(DEMO_HDR, join(TMP, 'demo_math.hpp'))
  copyFileSync(ADAPTER_SRC, join(TMP, 'regret_adapter.cpp'))
}

function run(script, args = [], opts = {}) {
  return spawnSync('bash', [script, ...args], {
    cwd: TMP,
    encoding: 'utf8',
    env: {
      ...process.env,
      CPP_SOURCES: `${TMP}/demo_math.cpp:${TMP}/regret_adapter.cpp`,
      CPP_INCLUDE: TMP,
    },
    ...opts,
  })
}

function readRegret(id) {
  return readFileSync(join(TMP, 'regrets', `${id}.regret`), 'utf8')
}

describe('C++ stack', () => {
  before(() => {
    if (!hasGpp || !hasLibs) return
    setupProject()
  })

  after(() => {
    if (existsSync(TMP)) rmSync(TMP, { recursive: true, force: true })
  })

  itIfCpp('capture writes .regret files with the standard format', () => {
    const r = run(CAPTURE_SH)
    assert.equal(r.status, 0, `capture failed: ${r.stdout}\n${r.stderr}`)

    const addRegret = readRegret('add')
    for (const field of ['cluster:', 'version:', 'fingerprint:', 'captured:',
                         'watches:', 'entry:', 'stack: cpp', 'fingerprintLevel:',
                         '---', 'INPUT  ', 'OUTPUT ', 'HASH   ']) {
      assert.ok(addRegret.includes(field), `missing field "${field}" in add.regret:\n${addRegret}`)
    }
  })

  itIfCpp('validate PASSes for unchanged code', () => {
    run(CAPTURE_SH)
    const r = run(VALIDATE_SH)
    assert.equal(r.status, 0, `validate should PASS for unchanged code:\n${r.stdout}\n${r.stderr}`)
    assert.match(r.stdout, /Passed: 4/)
  })

  itIfCpp('C++ fingerprint matches JS fingerprint() (cross-stack parity)', () => {
    run(CAPTURE_SH)
    const cases = [
      { id: 'add',        input: [2, 3],          output: 5 },
      { id: 'fibonacci',  input: 10,              output: 55 },
      { id: 'reverse',    input: 'Hello, World!', output: '!dlroW ,olleH' },
      { id: 'factorial',  input: 5,               output: 120 },
    ]
    for (const c of cases) {
      const regret = readRegret(c.id)
      const m = regret.match(/^HASH\s+(\S+)/m)
      const cppHash = m ? m[1] : null
      const jsHash = fingerprint(c.input, c.output)
      assert.equal(cppHash, jsHash, `parity mismatch for ${c.id}: C++=${cppHash} JS=${jsHash}`)
    }
  })

  itIfCpp('class-method cluster captures correctly (MathUtils.factorial)', () => {
    run(CAPTURE_SH)
    const regret = readRegret('factorial')
    assert.match(regret, /cluster: factorial/)
    assert.match(regret, /INPUT  5/)
    assert.match(regret, /OUTPUT 120/)
    assert.match(regret, /watches: \[MathUtils::factorial\]/)
  })

  itIfCpp('validate PASSes for a valid refactor (output preserved)', () => {
    const demoPath = join(TMP, 'demo_math.cpp')
    const backup = join(TMP, 'demo_math.cpp.bak')
    copyFileSync(demoPath, backup)
    try {
      let src = readFileSync(demoPath, 'utf8')
      const old = `long demo_fibonacci(int n) {
    if (n < 0) throw std::invalid_argument("n must be >= 0");
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
    if (n < 0) throw std::invalid_argument("n must be >= 0");
    if (n == 0) return 0L;
    if (n == 1) return 1L;
    double phi = (1.0 + std::sqrt(5.0)) / 2.0;
    double psi = (1.0 - std::sqrt(5.0)) / 2.0;
    return static_cast<long>((std::pow(phi, n) - std::pow(psi, n)) / std::sqrt(5.0));
}`
      assert.ok(src.includes(old), 'original fibonacci body not found')
      writeFileSync(demoPath, src.replace(old, next))

      const r = run(VALIDATE_SH)
      assert.equal(r.status, 0, `valid refactor should PASS:\n${r.stdout}\n${r.stderr}`)
      assert.match(r.stdout, /Passed: 4/)
    } finally {
      copyFileSync(backup, demoPath)
      rmSync(backup, { force: true })
    }
  })

  itIfCpp('validate FAILs (non-zero exit) for a breaking refactor (output changed)', () => {
    const demoPath = join(TMP, 'demo_math.cpp')
    const backup = join(TMP, 'demo_math.cpp.bak')
    copyFileSync(demoPath, backup)
    try {
      let src = readFileSync(demoPath, 'utf8')
      const old = `long demo_fibonacci(int n) {
    if (n < 0) throw std::invalid_argument("n must be >= 0");
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
    if (n < 0) throw std::invalid_argument("n must be >= 0");
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
      assert.match(r.stdout, /fibonacci[\s\S]*FAIL/, 'FAIL should be on the fibonacci cluster')
      assert.match(r.stdout, /Failed: 1/, 'summary should show 1 failure')
    } finally {
      copyFileSync(backup, demoPath)
      rmSync(backup, { force: true })
    }
  })

  itIfCpp('C++ exceptions during validate are caught (no crash, cluster FAILs)', () => {
    // Make factorial throw std::runtime_error. The harness should catch the
    // exception and report factorial as FAIL (no segfault, no abort).
    const demoPath = join(TMP, 'demo_math.cpp')
    const backup = join(TMP, 'demo_math.cpp.bak')
    copyFileSync(demoPath, backup)
    try {
      let src = readFileSync(demoPath, 'utf8')
      const old = `long MathUtils::factorial(int n) const {
    if (n < 0) throw std::invalid_argument("n must be >= 0");
    long r = 1;
    for (int i = 2; i <= n; i++) r *= i;
    return r;
}`
      const next = `long MathUtils::factorial(int n) const {
    /* Refactor that throws — harness should catch the C++ exception. */
    throw std::runtime_error("intentional exception for test");
}`
      assert.ok(src.includes(old), 'original factorial body not found')
      writeFileSync(demoPath, src.replace(old, next))

      const r = run(VALIDATE_SH)
      // factorial should FAIL (regression), other clusters should still PASS.
      assert.notEqual(r.status, 0, `validate should FAIL (factorial threw)`)
      assert.match(r.stdout, /factorial[\s\S]*C\+\+ exception/, 'factorial should report exception')
      assert.match(r.stdout, /Failed: 1/, 'summary should show 1 failure')
      assert.match(r.stdout, /Passed: 3/, 'other clusters should still pass')
      // Most importantly: the harness did NOT crash (no segfault message)
      assert.doesNotMatch(r.stdout + r.stderr, /Segmentation fault|Aborted|core dumped/i,
        'harness must not crash on C++ exception')
    } finally {
      copyFileSync(backup, demoPath)
      rmSync(backup, { force: true })
    }
  })
})

describe('C++ stack (no C++ toolchain)', () => {
  it('capture_cpp.sh prints a clear error when g++ is missing', { skip: hasGpp }, () => {
    setupProject()
    try {
      const r = run(CAPTURE_SH)
      assert.notEqual(r.status, 0, 'should exit non-zero when g++ is missing')
      assert.match(r.stdout + r.stderr, /g\+\+|C\+\+ compiler/i)
    } finally {
      if (existsSync(TMP)) rmSync(TMP, { recursive: true, force: true })
    }
  })
})

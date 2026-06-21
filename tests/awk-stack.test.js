// tests/awk-stack.test.js
// Verifies the awk stack (capture_awk.mjs + validate_awk.mjs):
//   - capture writes .regret files with the standard format
//   - validate PASSes when the captured code is unchanged
//   - validate PASSes for a valid refactor (output preserved)
//   - validate FAILs (non-zero exit) for a breaking refactor (output changed)
//   - awk fingerprint matches JS fingerprint() for the same (input, output)
//
// Skips automatically when `awk` is not on PATH (so this test is safe in
// environments without an awk interpreter — though awk is on every Unix).

import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, writeFileSync, readFileSync, rmSync, copyFileSync, existsSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { fingerprint } from '../scripts/fingerprint.js'

const ROOT = resolve(import.meta.dirname, '..')
const SCRIPTS_DIR = join(ROOT, 'scripts')
const CAPTURE_MJS  = join(SCRIPTS_DIR, 'capture_awk.mjs')
const VALIDATE_MJS = join(SCRIPTS_DIR, 'validate_awk.mjs')

const TMP = resolve(join(process.cwd(), 'tests', `__awk_${process.pid}__`))

const hasAwk = (() => {
  const r = spawnSync('awk', ['--version'], { stdio: 'ignore' })
  // mawk exits 0 on --version; nawk exits 2; both are usable
  // Try a real invocation instead
  const r2 = spawnSync('awk', ['BEGIN { print "ok" }'], { stdio: ['pipe', 'pipe', 'pipe'] })
  return r2.status === 0 && r2.stdout.toString().trim() === 'ok'
})()

const itIfAwk = hasAwk ? it : it.skip

function setupProject() {
  mkdirSync(join(TMP, 'regrets'), { recursive: true })

  // Write awk programs
  writeFileSync(join(TMP, 'sum_column.awk'), '{ sum += $1 }\nEND { print sum }\n')

  writeFileSync(join(TMP, 'fibonacci.awk'),
`BEGIN {
  getline n
  print fib(n + 0)
}

function fib(n,  a, b, c, i) {
  if (n < 0) return -1
  if (n == 0) return 0
  if (n == 1) return 1
  a = 0; b = 1
  for (i = 2; i <= n; i++) {
    c = a + b
    a = b
    b = c
  }
  return b
}
`)

  writeFileSync(join(TMP, 'reverse_lines.awk'),
`{
  lines[NR] = $0
  n = NR
}

END {
  for (i = n; i >= 1; i--) {
    line = lines[i]
    out = ""
    len = length(line)
    for (j = len; j >= 1; j--) {
      out = out substr(line, j, 1)
    }
    if (i < n) printf "\\n"
    printf "%s", out
  }
  printf "\\n"
}
`)

  // Manifest
  writeFileSync(join(TMP, 'regrets', 'manifest.json'), JSON.stringify({
    clusters: [
      {
        id: 'sum-column', stack: 'awk', file: 'sum_column.awk',
        entry: 'sum_column.awk', fingerprintLevel: 'entry',
        watches: [],
        inputs: ['1\n2\n3\n4\n5\n'],
      },
      {
        id: 'fibonacci', stack: 'awk', file: 'fibonacci.awk',
        entry: 'fibonacci.awk', fingerprintLevel: 'entry',
        watches: ['fib'],
        inputs: ['10'],
      },
      {
        id: 'reverse-lines', stack: 'awk', file: 'reverse_lines.awk',
        entry: 'reverse_lines.awk', fingerprintLevel: 'entry',
        watches: [],
        inputs: ['Hello\nWorld\n'],
      },
    ],
  }, null, 2))
}

function run(script, args = [], opts = {}) {
  return spawnSync('node', [script, ...args], {
    cwd: TMP,
    encoding: 'utf8',
    ...opts,
  })
}

function readRegret(id) {
  return readFileSync(join(TMP, 'regrets', `${id}.regret`), 'utf8')
}

describe('awk stack', () => {
  before(() => {
    if (!hasAwk) return
    setupProject()
  })

  after(() => {
    if (existsSync(TMP)) rmSync(TMP, { recursive: true, force: true })
  })

  itIfAwk('capture writes .regret files with the standard format', () => {
    const r = run(CAPTURE_MJS)
    assert.equal(r.status, 0, `capture failed: ${r.stdout}\n${r.stderr}`)

    const sumRegret = readRegret('sum-column')
    for (const field of ['cluster:', 'version:', 'fingerprint:', 'captured:',
                         'watches:', 'entry:', 'stack: awk', 'fingerprintLevel:',
                         '---', 'INPUT  ', 'OUTPUT ', 'HASH   ']) {
      assert.ok(sumRegret.includes(field), `missing field "${field}" in sum-column.regret:\n${sumRegret}`)
    }
  })

  itIfAwk('validate PASSes for unchanged code', () => {
    run(CAPTURE_MJS)
    const r = run(VALIDATE_MJS)
    assert.equal(r.status, 0, `validate should PASS for unchanged code:\n${r.stdout}\n${r.stderr}`)
    assert.match(r.stdout, /Passed: 3/)
  })

  itIfAwk('awk fingerprint matches JS fingerprint() (cross-stack parity)', () => {
    run(CAPTURE_MJS)
    const cases = [
      { id: 'sum-column',    input: '1\n2\n3\n4\n5\n',  output: '15' },
      { id: 'fibonacci',     input: '10',                output: '55' },
      { id: 'reverse-lines', input: 'Hello\nWorld\n',    output: 'dlroW\nolleH' },
    ]
    for (const c of cases) {
      const regret = readRegret(c.id)
      const m = regret.match(/^HASH\s+(\S+)/m)
      const awkHash = m ? m[1] : null
      const jsHash = fingerprint(c.input, c.output)
      assert.equal(awkHash, jsHash, `parity mismatch for ${c.id}: awk=${awkHash} JS=${jsHash}`)
    }
  })

  itIfAwk('trivial-input guard: empty stdout → skip', () => {
    // Write an awk program that produces no output
    writeFileSync(join(TMP, 'empty.awk'), 'BEGIN { /* no-op */ }\n')
    writeFileSync(join(TMP, 'regrets', 'manifest.json'), JSON.stringify({
      clusters: [
        {
          id: 'sum-column', stack: 'awk', file: 'sum_column.awk',
          entry: 'sum_column.awk', fingerprintLevel: 'entry',
          inputs: ['1\n2\n3\n'],
        },
        {
          id: 'empty', stack: 'awk', file: 'empty.awk',
          entry: 'empty.awk', fingerprintLevel: 'entry',
          inputs: ['anything'],
        },
      ],
    }, null, 2))

    const r = run(CAPTURE_MJS)
    assert.equal(r.status, 0, `capture should succeed (skip is not failure):\n${r.stdout}`)
    assert.match(r.stdout, /Skipped: 1/, 'should skip 1 cluster (empty output)')
    assert.match(r.stdout, /Captured: 1/, 'should capture 1 cluster (sum-column)')

    // Restore original manifest
    setupProject()
  })

  itIfAwk('validate PASSes for a valid refactor (output preserved)', () => {
    const fibPath = join(TMP, 'fibonacci.awk')
    const backup = join(TMP, 'fibonacci.awk.bak')
    copyFileSync(fibPath, backup)
    try {
      // Replace iterative fib with Binet's formula (output preserved for n=10)
      writeFileSync(fibPath,
`BEGIN {
  getline n
  print fib(n + 0)
}

function fib(n,  phi, psi, result) {
  if (n < 0) return -1
  if (n == 0) return 0
  if (n == 1) return 1
  phi = (1 + sqrt(5)) / 2
  psi = (1 - sqrt(5)) / 2
  result = (phi ^ n - psi ^ n) / sqrt(5)
  return int(result + 0.5)
}
`)

      const r = run(VALIDATE_MJS)
      assert.equal(r.status, 0, `valid refactor should PASS:\n${r.stdout}\n${r.stderr}`)
      assert.match(r.stdout, /Passed: 3/)
    } finally {
      copyFileSync(backup, fibPath)
      rmSync(backup, { force: true })
    }
  })

  itIfAwk('validate FAILs (non-zero exit) for a breaking refactor (output changed)', () => {
    const fibPath = join(TMP, 'fibonacci.awk')
    const backup = join(TMP, 'fibonacci.awk.bak')
    copyFileSync(fibPath, backup)
    try {
      // Change fibonacci to 1-indexed (n=10 returns 89 instead of 55)
      writeFileSync(fibPath,
`BEGIN {
  getline n
  print fib(n + 0)
}

function fib(n,  a, b, c, i) {
  if (n < 0) return -1
  if (n == 0) return 1
  if (n == 1) return 1
  a = 1; b = 1
  for (i = 2; i <= n; i++) {
    c = a + b
    a = b
    b = c
  }
  return b
}
`)

      const r = run(VALIDATE_MJS)
      assert.notEqual(r.status, 0, `breaking refactor should FAIL (non-zero exit)`)
      assert.match(r.stdout, /fibonacci[\s\S]*FAIL/, 'FAIL should be on the fibonacci cluster')
      assert.match(r.stdout, /Failed: 1/, 'summary should show 1 failure')
    } finally {
      copyFileSync(backup, fibPath)
      rmSync(backup, { force: true })
    }
  })
})

describe('awk stack (no awk interpreter)', () => {
  it('capture_awk.mjs prints an error when awk is missing', { skip: hasAwk }, () => {
    setupProject()
    try {
      // Force AWK_BIN to a non-existent binary
      const r = spawnSync('node', [CAPTURE_MJS], {
        cwd: TMP,
        encoding: 'utf8',
        env: { ...process.env, AWK_BIN: '/nonexistent/awk' },
      })
      assert.notEqual(r.status, 0, 'should exit non-zero when awk is missing')
    } finally {
      if (existsSync(TMP)) rmSync(TMP, { recursive: true, force: true })
    }
  })
})

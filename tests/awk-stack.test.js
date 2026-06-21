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

// ─────────────────────────────────────────────────────────────────────────────
// Issue #315 parity — multi-input INPUTS line
//
// Mirrors the test block added to tests/vue-stack.test.js when Vue got the
// same multi-input parity. Tests the contract end-to-end:
//   1. capture OMITS INPUTS when only 1 input (backward compat)
//   2. capture WRITES INPUTS when inputs.length > 1 (Issue #315 parity)
//   3. validate PASSes for unchanged multi-input
//   4. validate FAILs when ONLY non-first input breaks (core #315 guarantee —
//      this is the "false GREEN" scenario that INPUTS line prevents)
//   5. --update refreshes INPUTS line with new per-input hashes
//   6. --json output surfaces multiInputFailures[] array on FAIL
// ─────────────────────────────────────────────────────────────────────────────

describe('Issue #315 — multi-input INPUTS line parity (awk)', () => {
  // Use a separate temp dir so we don't pollute the main `awk stack` suite
  const TMP2 = resolve(join(process.cwd(), 'tests', `__awk_multi_${process.pid}__`))

  // Program whose output we can selectively break for one input only.
  // fib(n) returns the n-th Fibonacci number. We'll write a 3-input manifest
  // and then mutate fib(n) to specifically break n=15 while preserving n=10.
  const FIB_AWK = `BEGIN {
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
`

  // Same as FIB_AWK but with a deliberate bug that ONLY triggers for n >= 15.
  // n=10 still returns 55 (matches golden); n=15 returns 609 (off by one);
  // n=20 returns 6764 (off by one). Without INPUTS line this would be a
  // false GREEN. With INPUTS line validate must FAIL.
  const FIB_AWK_SUBTLE_BUG = `BEGIN {
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
  if (n >= 15) return b - 1
  return b
}
`

  function setupMultiInputProject() {
    mkdirSync(join(TMP2, 'regrets'), { recursive: true })
    writeFileSync(join(TMP2, 'fibonacci.awk'), FIB_AWK)
    writeFileSync(join(TMP2, 'regrets', 'manifest.json'), JSON.stringify({
      clusters: [
        {
          id: 'fib-multi', stack: 'awk', file: 'fibonacci.awk',
          entry: 'fibonacci.awk', fingerprintLevel: 'entry',
          watches: ['fib'],
          inputs: ['10', '15', '20'],
        },
      ],
    }, null, 2))
  }

  function setupSingleInputProject() {
    mkdirSync(join(TMP2, 'regrets'), { recursive: true })
    writeFileSync(join(TMP2, 'fibonacci.awk'), FIB_AWK)
    writeFileSync(join(TMP2, 'regrets', 'manifest.json'), JSON.stringify({
      clusters: [
        {
          id: 'fib-single', stack: 'awk', file: 'fibonacci.awk',
          entry: 'fibonacci.awk', fingerprintLevel: 'entry',
          watches: ['fib'],
          inputs: ['10'],
        },
      ],
    }, null, 2))
  }

  function run2(script, args = [], opts = {}) {
    return spawnSync('node', [script, ...args], {
      cwd: TMP2,
      encoding: 'utf8',
      ...opts,
    })
  }

  before(() => {
    if (!hasAwk) return
    if (existsSync(TMP2)) rmSync(TMP2, { recursive: true, force: true })
  })

  after(() => {
    if (existsSync(TMP2)) rmSync(TMP2, { recursive: true, force: true })
  })

  itIfAwk('capture OMITS INPUTS line when only 1 input (backward compat)', () => {
    if (existsSync(TMP2)) rmSync(TMP2, { recursive: true, force: true })
    setupSingleInputProject()
    const r = run2(CAPTURE_MJS)
    assert.equal(r.status, 0, `capture failed: ${r.stdout}\n${r.stderr}`)
    const regret = readFileSync(join(TMP2, 'regrets', 'fib-single.regret'), 'utf8')
    assert.ok(regret.includes('INPUT  '), 'should have top-level INPUT line')
    assert.ok(regret.includes('HASH   '), 'should have top-level HASH line')
    assert.ok(!regret.includes('INPUTS '), 'should NOT have INPUTS line for single-input cluster')
  })

  itIfAwk('capture WRITES INPUTS line when inputs.length > 1 (Issue #315 parity)', () => {
    if (existsSync(TMP2)) rmSync(TMP2, { recursive: true, force: true })
    setupMultiInputProject()
    const r = run2(CAPTURE_MJS)
    assert.equal(r.status, 0, `capture failed: ${r.stdout}\n${r.stderr}`)
    const regret = readFileSync(join(TMP2, 'regrets', 'fib-multi.regret'), 'utf8')
    assert.ok(regret.includes('INPUTS '), 'should have INPUTS line for multi-input cluster')

    // Parse the INPUTS line and verify structure
    const inputsLineMatch = regret.match(/^INPUTS\s+(\[.+\])$/m)
    assert.ok(inputsLineMatch, 'INPUTS line should be parseable')
    const inputsPayload = JSON.parse(inputsLineMatch[1])
    assert.equal(inputsPayload.length, 2, 'INPUTS should contain inputs[1+] (2 entries for 3-input manifest)')
    for (const entry of inputsPayload) {
      assert.ok('input' in entry, 'each INPUTS entry should have input')
      assert.ok('output' in entry, 'each INPUTS entry should have output')
      assert.ok('hash' in entry, 'each INPUTS entry should have hash')
    }
    // Verify the inputs are inputs[1] and inputs[2] (not inputs[0])
    const inputValues = inputsPayload.map(e => e.input)
    assert.deepEqual(inputValues, ['15', '20'], 'INPUTS should contain inputs[1+] in order')

    // Verify each per-input hash matches fingerprint(input, output)
    for (const entry of inputsPayload) {
      const expectedHash = fingerprint(entry.input, entry.output)
      assert.equal(entry.hash, expectedHash,
        `INPUTS hash mismatch for input ${entry.input}: stored=${entry.hash} computed=${expectedHash}`)
    }
  })

  itIfAwk('validate PASSes for unchanged multi-input cluster', () => {
    if (existsSync(TMP2)) rmSync(TMP2, { recursive: true, force: true })
    setupMultiInputProject()
    run2(CAPTURE_MJS)
    const r = run2(VALIDATE_MJS)
    assert.equal(r.status, 0, `validate should PASS for unchanged multi-input:\n${r.stdout}\n${r.stderr}`)
    assert.match(r.stdout, /Passed: 1/, 'should pass the 1 multi-input cluster')
  })

  itIfAwk('validate FAILs when ONLY non-first input breaks (core #315 guarantee — false GREEN scenario)', () => {
    if (existsSync(TMP2)) rmSync(TMP2, { recursive: true, force: true })
    setupMultiInputProject()
    run2(CAPTURE_MJS)  // capture with correct code → golden hashes for all 3 inputs

    // Apply subtle bug that only breaks inputs[1+] (n=15, n=20), preserves input[0] (n=10)
    writeFileSync(join(TMP2, 'fibonacci.awk'), FIB_AWK_SUBTLE_BUG)

    const r = run2(VALIDATE_MJS)
    assert.notEqual(r.status, 0, `validate should FAIL when inputs[1+] break — false GREEN would be a bug`)
    assert.match(r.stdout, /FAIL/, 'should report FAIL')
    assert.match(r.stdout, /Multi-input failures/, 'should report multi-input failures')
    // The golden hash for input[0] (n=10) should still match — but inputs[1+] should be reported
    assert.match(r.stdout, /input "15"/, 'should report input "15" as failed')
    assert.match(r.stdout, /input "20"/, 'should report input "20" as failed')
  })

  itIfAwk('--update refreshes INPUTS line with new per-input hashes', () => {
    if (existsSync(TMP2)) rmSync(TMP2, { recursive: true, force: true })
    setupMultiInputProject()
    run2(CAPTURE_MJS)
    const beforeRegret = readFileSync(join(TMP2, 'regrets', 'fib-multi.regret'), 'utf8')
    const beforeHashMatch = beforeRegret.match(/^HASH\s+(\S+)/m)
    const beforeInputsMatch = beforeRegret.match(/^INPUTS\s+(\[.+\])$/m)
    assert.ok(beforeHashMatch, 'before: should have HASH line')
    assert.ok(beforeInputsMatch, 'before: should have INPUTS line')
    const beforeHash = beforeHashMatch[1]
    const beforeInputs = JSON.parse(beforeInputsMatch[1])

    // Apply a deliberate breaking change (add 1 to all outputs) so --update has work to do
    writeFileSync(join(TMP2, 'fibonacci.awk'),
`BEGIN {
  getline n
  print fib(n + 0) + 1
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

    const r = run2(VALIDATE_MJS, [
      '--update', 'fib-multi',
      '--reason', 'deliberate off-by-one refactor for awk Issue #315 update-mode test',
    ])
    assert.equal(r.status, 0, `--update should succeed:\n${r.stdout}\n${r.stderr}`)
    assert.match(r.stdout, /UPDATED/, 'should report UPDATED')

    const afterRegret = readFileSync(join(TMP2, 'regrets', 'fib-multi.regret'), 'utf8')
    const afterHashMatch = afterRegret.match(/^HASH\s+(\S+)/m)
    const afterInputsMatch = afterRegret.match(/^INPUTS\s+(\[.+\])$/m)
    assert.ok(afterHashMatch, 'after: should have HASH line')
    assert.ok(afterInputsMatch, 'after: should still have INPUTS line (refreshed)')
    const afterHash = afterHashMatch[1]
    const afterInputs = JSON.parse(afterInputsMatch[1])

    assert.notEqual(afterHash, beforeHash, 'top-level HASH should change after update')
    assert.equal(afterInputs.length, beforeInputs.length,
      'INPUTS line should have same number of entries after update')

    // Each per-input hash should also be different
    for (let i = 0; i < beforeInputs.length; i++) {
      assert.notEqual(afterInputs[i].hash, beforeInputs[i].hash,
        `INPUTS[${i}] hash should change after update (input=${beforeInputs[i].input})`)
    }

    // Audit log should have been written
    const auditLog = readFileSync(join(TMP2, 'regrets', 'audit.log'), 'utf8')
    assert.match(auditLog, /UPDATE\s+fib-multi/, 'audit.log should record the update')
    assert.match(auditLog, /old: \S+/, 'audit.log should record old hash')
    assert.match(auditLog, /new: \S+/, 'audit.log should record new hash')
    assert.match(auditLog, /chain: \S+/, 'audit.log should have chain hash')

    // Re-validate after update — should PASS now (golden matches live)
    const r2 = run2(VALIDATE_MJS)
    assert.equal(r2.status, 0, `after update, validate should PASS:\n${r2.stdout}\n${r2.stderr}`)
    assert.match(r2.stdout, /Passed: 1/)
  })

  itIfAwk('--json output surfaces multiInputFailures[] array on FAIL', () => {
    if (existsSync(TMP2)) rmSync(TMP2, { recursive: true, force: true })
    setupMultiInputProject()
    run2(CAPTURE_MJS)
    // Apply subtle bug
    writeFileSync(join(TMP2, 'fibonacci.awk'), FIB_AWK_SUBTLE_BUG)
    const r = run2(VALIDATE_MJS, ['--json'])
    assert.notEqual(r.status, 0, `--json should still exit non-zero on FAIL`)
    const out = JSON.parse(r.stdout)
    assert.equal(out.stack, 'awk')
    assert.equal(out.failed, 1, 'should report 1 failure in JSON summary')
    const fibResult = out.results.find(x => x.id === 'fib-multi')
    assert.ok(fibResult, 'should have fib-multi result')
    assert.equal(fibResult.pass, false)
    assert.ok(Array.isArray(fibResult.multiInputFailures), 'should have multiInputFailures array')
    assert.ok(fibResult.multiInputFailures.length >= 2,
      `should have at least 2 multi-input failures (n=15 and n=20), got ${fibResult.multiInputFailures.length}`)
    // Verify each failure entry has the right shape
    for (const f of fibResult.multiInputFailures) {
      assert.ok('input' in f, 'each failure should have input')
      assert.ok('goldenHash' in f, 'each failure should have goldenHash')
      assert.ok('liveHash' in f, 'each failure should have liveHash')
    }
    // Verify the failed inputs are exactly "15" and "20"
    const failedInputs = fibResult.multiInputFailures.map(f => f.input).sort()
    assert.deepEqual(failedInputs, ['15', '20'], 'should fail on inputs[1+] only')
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

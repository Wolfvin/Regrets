// tests/awk-stack-independent.test.js — Independent verification of Awk stack
//
// Verifies capture_awk.mjs + validate_awk.mjs work on a DIFFERENT awk codebase
// than the author's chosen proof/awk/ example. Uses the proof/awk_independent/
// fixture (text-processing domain: log parsing, markdown extraction, dedup,
// indent prefixing, matrix transpose) — different idioms than the math-heavy
// proof/awk/ fixture (sum_column, fibonacci, max_value).
//
// This addresses CONTEXT.md's "Lesson Learned" about confirmation-bias in
// self-chosen fixtures: a single example can pass while hiding bugs that only
// surface on different inputs.
//
// Run: node --test tests/awk-stack-independent.test.js

import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync, copyFileSync, rmSync, mkdirSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { fingerprint as jsFingerprint } from '../scripts/fingerprint.js'

const ROOT = resolve(import.meta.dirname, '..')
const SCRIPTS_DIR = join(ROOT, 'scripts')
const CAPTURE_MJS  = join(SCRIPTS_DIR, 'capture_awk.mjs')
const VALIDATE_MJS = join(SCRIPTS_DIR, 'validate_awk.mjs')
const FIXTURE_DIR  = join(ROOT, 'proof', 'awk_independent')

const hasAwk = (() => {
  const r = spawnSync('awk', ['BEGIN { print "ok" }'], { stdio: ['pipe', 'pipe', 'pipe'] })
  return r.status === 0 && r.stdout.toString().trim() === 'ok'
})()

const itIfAwk = hasAwk ? it : it.skip

// Backup directory — restore originals after test suite
const BACKUP_DIR = join(ROOT, 'tests', `__awk_indep_backup_${process.pid}__`)

function runInFixture(args = []) {
  return spawnSync('node', [args[0], ...args.slice(1)], {
    cwd: FIXTURE_DIR,
    encoding: 'utf8',
  })
}

function captureAll() {
  return runInFixture([CAPTURE_MJS])
}

function validateAll(extraArgs = []) {
  return runInFixture([VALIDATE_MJS, ...extraArgs])
}

function readRegret(id) {
  return readFileSync(join(FIXTURE_DIR, 'regrets', `${id}.regret`), 'utf8')
}

function backupAll() {
  if (!existsSync(BACKUP_DIR)) mkdirSync(BACKUP_DIR, { recursive: true })
  for (const f of [
    'apache_status_class.awk',
    'markdown_links.awk',
    'dedupe_lines.awk',
    'indent_prefix.awk',
    'transpose_matrix.awk',
  ]) {
    copyFileSync(join(FIXTURE_DIR, f), join(BACKUP_DIR, f))
  }
}

function restoreAll() {
  for (const f of [
    'apache_status_class.awk',
    'markdown_links.awk',
    'dedupe_lines.awk',
    'indent_prefix.awk',
    'transpose_matrix.awk',
  ]) {
    if (existsSync(join(BACKUP_DIR, f))) {
      copyFileSync(join(BACKUP_DIR, f), join(FIXTURE_DIR, f))
    }
  }
}

describe('Awk stack — independent fixture (text-processing domain)', () => {
  before(() => {
    if (!hasAwk) return
    backupAll()
    // Re-capture to ensure fresh .regret files exist
    captureAll()
  })

  after(() => {
    restoreAll()
    if (existsSync(BACKUP_DIR)) rmSync(BACKUP_DIR, { recursive: true, force: true })
  })

  itIfAwk('fixture has 5 clusters, all captured', () => {
    const r = captureAll()
    assert.equal(r.status, 0, `capture failed: ${r.stdout}\n${r.stderr}`)
    assert.match(r.stdout, /Captured: 5/)
    assert.match(r.stdout, /Skipped: 0/)
    assert.match(r.stdout, /Failed: 0/)
  })

  itIfAwk('each .regret file has the standard format', () => {
    const ids = ['apache-status-class', 'markdown-links', 'dedupe-lines', 'indent-prefix', 'transpose-matrix']
    for (const id of ids) {
      const regret = readRegret(id)
      for (const field of [
        'cluster:', 'version:', 'fingerprint:', 'captured:',
        'watches:', 'entry:', 'stack: awk', 'fingerprintLevel:',
        '---', 'INPUT  ', 'OUTPUT ', 'HASH   ',
      ]) {
        assert.ok(regret.includes(field), `missing field "${field}" in ${id}.regret`)
      }
    }
  })

  itIfAwk('validate PASSes for unchanged code (baseline)', () => {
    const r = validateAll()
    assert.equal(r.status, 0, `baseline validate should PASS:\n${r.stdout}\n${r.stderr}`)
    assert.match(r.stdout, /Passed: 5/)
    assert.match(r.stdout, /Failed: 0/)
  })

  itIfAwk('cross-stack fingerprint parity (awk HASH == JS fingerprint())', () => {
    const cases = [
      {
        id: 'apache-status-class',
        input: '127.0.0.1 - - [10/Oct/2026:13:55:36 -0700] "GET / HTTP/1.1" 200 2326\n10.0.0.5 - - [10/Oct/2026:13:55:42 -0700] "POST /login HTTP/1.1" 401 758\n',
        output: '2xx\n4xx',
      },
      {
        id: 'markdown-links',
        input: 'See [the docs](https://example.com/docs) and [source](src/index.js).\nNo links here.\nAnother [link](https://foo.bar).\n',
        output: 'the docs -> https://example.com/docs\nsource -> src/index.js\nlink -> https://foo.bar',
      },
      {
        id: 'dedupe-lines',
        input: 'alpha\nbeta\nalpha\ngamma\nbeta\n',
        output: 'alpha\nbeta\ngamma',
      },
      {
        id: 'indent-prefix',
        input: 'one\ntwo\nthree\n',
        output: '   one\n   two\n   three',   // 3-space prefix because cluster.args = ["-v","indent=3"]
      },
      {
        id: 'transpose-matrix',
        input: '1\t2\t3\n4\t5\t6\n',
        output: '1\t4\n2\t5\n3\t6',
      },
    ]
    for (const c of cases) {
      const regret = readRegret(c.id)
      const m = regret.match(/^HASH\s+(\S+)/m)
      const awkHash = m ? m[1] : null
      const jsHash = jsFingerprint(c.input, c.output)
      assert.equal(awkHash, jsHash, `parity mismatch for ${c.id}: awk=${awkHash} JS=${jsHash}`)
    }
  })

  itIfAwk('multi-input contract: markdown-links has INPUTS line with 1 entry (3 inputs total)', () => {
    const regret = readRegret('markdown-links')
    assert.ok(regret.includes('INPUTS '), 'markdown-links.regret should have INPUTS line')
    const m = regret.match(/^INPUTS\s+(\[.+\])$/m)
    assert.ok(m, 'INPUTS line should be parseable')
    const payload = JSON.parse(m[1])
    // Manifest has 3 inputs; first is top-level, remaining 2 go in INPUTS.
    // But one of those ("Plain text with no links at all.") produces empty
    // output → skipped by trivial-input guard → not in INPUTS line.
    // So INPUTS should have exactly 1 entry.
    assert.equal(payload.length, 1, 'INPUTS should have 1 entry (2nd input; 3rd is trivial-skipped)')
    assert.equal(payload[0].input, 'Single [solo](https://solo.example) link on its own line.\n')
  })

  itIfAwk('cluster.args pass-through: indent-prefix captured with -v indent=3', () => {
    const regret = readRegret('indent-prefix')
    // Output should have 3-space prefix (not default 2)
    assert.match(regret, /^OUTPUT "   one/m, 'output should have 3-space prefix from -v indent=3')
  })

  itIfAwk('VALID refactor — apache_status_class (regex tighten) PASSes', () => {
    const f = join(FIXTURE_DIR, 'apache_status_class.awk')
    const backup = join(BACKUP_DIR, 'apache_test_only.awk')
    copyFileSync(f, backup)
    try {
      writeFileSync(f,
`{
  s = $9
  if (s ~ /^[1-5][0-9][0-9]$/) {
    cls = substr(s, 1, 1) "xx"
    print cls
  } else {
    print "INVALID"
  }
}
`)
      const r = validateAll()
      assert.equal(r.status, 0, `valid refactor should PASS:\n${r.stdout}`)
      assert.match(r.stdout, /Passed: 5/)
    } finally {
      copyFileSync(backup, f)
      rmSync(backup, { force: true })
    }
  })

  itIfAwk('BREAKING refactor — apache_status_class (2xx → 3xx) FAILs', () => {
    const f = join(FIXTURE_DIR, 'apache_status_class.awk')
    const backup = join(BACKUP_DIR, 'apache_test_only.awk')
    copyFileSync(f, backup)
    try {
      writeFileSync(f,
`{
  s = $9
  if (s ~ /^[1-5][0-9][0-9]$/) {
    cls = substr(s, 1, 1) "xx"
    if (cls == "2xx") cls = "3xx"
    print cls
  } else {
    print "INVALID"
  }
}
`)
      const r = validateAll()
      assert.notEqual(r.status, 0, 'breaking refactor should FAIL (non-zero exit)')
      assert.match(r.stdout, /Failed: 1/)
    } finally {
      copyFileSync(backup, f)
      rmSync(backup, { force: true })
    }
  })

  itIfAwk('VALID refactor — transpose_matrix (ternary for missing val) PASSes', () => {
    const f = join(FIXTURE_DIR, 'transpose_matrix.awk')
    const backup = join(BACKUP_DIR, 'transpose_test_only.awk')
    copyFileSync(f, backup)
    try {
      writeFileSync(f,
`{
  n = split($0, fields, "\\t")
  if (n > maxCols) maxCols = n
  for (j = 1; j <= n; j++) {
    matrix[NR, j] = fields[j]
  }
  maxRows = NR
}

END {
  for (j = 1; j <= maxCols; j++) {
    out = ""
    for (i = 1; i <= maxRows; i++) {
      val = (matrix[i, j] != "") ? matrix[i, j] : "0"
      if (i > 1) out = out "\\t"
      out = out val
    }
    print out
  }
}
`)
      const r = validateAll()
      assert.equal(r.status, 0, `valid refactor should PASS:\n${r.stdout}`)
      assert.match(r.stdout, /Passed: 5/)
    } finally {
      copyFileSync(backup, f)
      rmSync(backup, { force: true })
    }
  })

  itIfAwk('BREAKING refactor — transpose_matrix (no transpose, emit as-is) FAILs', () => {
    const f = join(FIXTURE_DIR, 'transpose_matrix.awk')
    const backup = join(BACKUP_DIR, 'transpose_test_only.awk')
    copyFileSync(f, backup)
    try {
      writeFileSync(f, '{ print $0 }\n')
      const r = validateAll()
      assert.notEqual(r.status, 0, 'breaking refactor should FAIL')
      assert.match(r.stdout, /Failed: 1/)
    } finally {
      copyFileSync(backup, f)
      rmSync(backup, { force: true })
    }
  })

  itIfAwk('demo-refactor-flow.sh script runs end-to-end and all checks pass', () => {
    const demoScript = join(FIXTURE_DIR, 'demo-refactor-flow.sh')
    const r = spawnSync('bash', [demoScript], {
      encoding: 'utf8',
      cwd: ROOT,
    })
    assert.equal(r.status, 0, `demo script should exit 0:\n${r.stdout}\n${r.stderr}`)
    assert.match(r.stdout, /All checks PASS/)
    assert.match(r.stdout, /Passed: 13/)
    assert.match(r.stdout, /Failed: 0/)
  })
})

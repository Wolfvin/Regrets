// tests/go-stack-independent.test.js — Independent verification of Go stack
//
// Verifies capture_go.sh + validate (via capture_go.sh validate) work on a
// DIFFERENT Go codebase than the author's chosen proof/go_verify/ fixture.
// Uses proof/go_independent/ (datetime + finance + collections domains) —
// different function signatures, different return types (time.Time, map,
// slice, error), different multiArgs patterns than the proof/go_verify/
// fixture (string + hash + IP validation).
//
// This addresses CONTEXT.md's "Lesson Learned" about confirmation-bias in
// self-chosen fixtures.
//
// Skips automatically when `go` is not on PATH.
//
// Run: node --test tests/go-stack-independent.test.js

import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import {
  existsSync, readFileSync, writeFileSync, copyFileSync, rmSync, mkdirSync,
  readdirSync,
} from 'node:fs'
import { resolve, join } from 'node:path'
import { fingerprint as jsFingerprint } from '../scripts/fingerprint.js'

const ROOT = resolve(import.meta.dirname, '..')
const SCRIPTS_DIR = join(ROOT, 'scripts')
const CAPTURE_GO  = join(SCRIPTS_DIR, 'capture_go.sh')
const FIXTURE_DIR = join(ROOT, 'proof', 'go_independent')

const hasGo = (() => {
  const r = spawnSync('go', ['version'], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env },
  })
  return r.status === 0 && /go version/.test(r.stdout.toString())
})()

const itIfGo = hasGo ? it : it.skip

const BACKUP_DIR = join(ROOT, 'tests', `__go_indep_backup_${process.pid}__`)

const goEnv = {
  ...process.env,
  PATH: `/home/z/go/bin:${process.env.PATH || ''}`,
  GOPATH: '/home/z/go-path',
  GOCACHE: '/tmp/go-cache',
  GOMODCACHE: '/home/z/go-path/pkg/mod',
}

function runCaptureGo(args = []) {
  return spawnSync('bash', [CAPTURE_GO, ...args], {
    cwd: FIXTURE_DIR,
    encoding: 'utf8',
    env: goEnv,
  })
}

function captureAll() {
  return runCaptureGo(['capture'])
}

function validateAll() {
  return runCaptureGo(['validate'])
}

function readRegret(id) {
  return readFileSync(join(FIXTURE_DIR, 'regrets', `${id}.regret`), 'utf8')
}

function backupAll() {
  if (!existsSync(BACKUP_DIR)) mkdirSync(BACKUP_DIR, { recursive: true })
  for (const dir of ['datetime', 'finance', 'collections']) {
    const srcDir = join(FIXTURE_DIR, dir)
    if (!existsSync(srcDir)) continue
    for (const f of readdirSync(srcDir)) {
      if (f.endsWith('.go')) {
        copyFileSync(join(srcDir, f), join(BACKUP_DIR, `${dir}_${f}`))
      }
    }
  }
}

function restoreAll() {
  if (!existsSync(BACKUP_DIR)) return
  for (const f of readdirSync(BACKUP_DIR)) {
    const underscoreIdx = f.indexOf('_')
    const dir = f.slice(0, underscoreIdx)
    const file = f.slice(underscoreIdx + 1)
    const src = join(BACKUP_DIR, f)
    const dest = join(FIXTURE_DIR, dir, file)
    if (existsSync(src)) {
      copyFileSync(src, dest)
    }
  }
}

describe('Go stack — independent fixture (datetime + finance + collections)', () => {
  before(() => {
    if (!hasGo) return
    backupAll()
    captureAll()
  })

  after(() => {
    restoreAll()
    if (existsSync(BACKUP_DIR)) rmSync(BACKUP_DIR, { recursive: true, force: true })
  })

  itIfGo('fixture has 14 clusters, all captured', () => {
    const r = captureAll()
    assert.equal(r.status, 0, `capture failed: ${r.stdout}\n${r.stderr}`)
    assert.match(r.stdout, /--- PASS: TestRegretCapture\/parse-iso8601/)
    assert.match(r.stdout, /--- PASS: TestRegretCapture\/chunk/)
  })

  itIfGo('each .regret file has the standard format', () => {
    const ids = [
      'parse-iso8601', 'format-duration', 'weekday-name', 'days-between',
      'add-business-days', 'format-cents', 'apply-discount', 'sum-cents',
      'parse-money', 'dedupe-strings', 'sort-and-join', 'count-words',
      'intersect', 'chunk',
    ]
    for (const id of ids) {
      const regret = readRegret(id)
      for (const field of [
        'cluster:', 'version:', 'fingerprint:', 'captured:',
        'entry:', 'stack: go', 'fingerprintLevel:',
        '---', 'INPUT  ', 'OUTPUT ', 'HASH   ',
      ]) {
        assert.ok(regret.includes(field), `missing field "${field}" in ${id}.regret`)
      }
    }
  })

  itIfGo('validate PASSes for unchanged code (baseline)', () => {
    const r = validateAll()
    assert.equal(r.status, 0, `baseline validate should PASS:\n${r.stdout}\n${r.stderr}`)
    assert.match(r.stdout, /--- PASS: TestRegretValidate\/parse-iso8601/)
    assert.match(r.stdout, /--- PASS: TestRegretValidate\/chunk/)
  })

  itIfGo('cross-stack fingerprint parity (go HASH == JS fingerprint())', () => {
    const cases = [
      { id: 'parse-iso8601',     input: '2026-06-22T15:04:05Z',                 output: ['2026-06-22T15:04:05Z', null] },
      { id: 'format-duration',   input: 3661,                                   output: '1h 1m 1s' },
      { id: 'weekday-name',      input: '2026-06-22',                           output: 'Monday' },
      { id: 'days-between',      input: ['2026-01-01', '2026-01-10'],           output: 9 },
      { id: 'add-business-days', input: ['2026-06-22', 5],                      output: '2026-06-29' },
      { id: 'format-cents',      input: 1099,                                   output: '$10.99' },
      { id: 'apply-discount',    input: [1000, 10],                             output: 900 },
      { id: 'sum-cents',         input: '100|200|300',                          output: 600 },
      { id: 'parse-money',       input: '$10.99',                               output: 1099 },
      { id: 'dedupe-strings',    input: 'a|b|a|c|b',                             output: 'a|b|c' },
      { id: 'sort-and-join',     input: ['banana|apple|cherry', ','],           output: 'apple,banana,cherry' },
      { id: 'count-words',       input: 'The Quick Brown Fox the',              output: { The: 1, Quick: 1, Brown: 1, Fox: 1, the: 1 } },
      { id: 'intersect',         input: 'a|b|c||b|c|d',                         output: 'b|c' },
      { id: 'chunk',             input: '1|2|3|4|5|2',                          output: '1,2;3,4;5' },
    ]
    for (const c of cases) {
      const regret = readRegret(c.id)
      const m = regret.match(/^HASH\s+(\S+)/m)
      const goHash = m ? m[1] : null
      const jsHash = jsFingerprint(c.input, c.output)
      assert.equal(goHash, jsHash, `parity mismatch for ${c.id}: go=${goHash} JS=${jsHash}`)
    }
  })

  itIfGo('multi-input contract: days-between has INPUTS line with 3 entries (4 inputs total)', () => {
    const regret = readRegret('days-between')
    assert.ok(regret.includes('INPUTS '), 'days-between.regret should have INPUTS line')
    const m = regret.match(/^INPUTS\s+(\[.+\])$/m)
    assert.ok(m, 'INPUTS line should be parseable')
    const payload = JSON.parse(m[1])
    assert.equal(payload.length, 3, 'INPUTS should have 3 entries (inputs[1+])')
    for (const entry of payload) {
      assert.ok('input' in entry, 'each INPUTS entry should have input')
      assert.ok('output' in entry, 'each INPUTS entry should have output')
      assert.ok('hash' in entry, 'each INPUTS entry should have hash')
    }
  })

  itIfGo('multiArgs pass-through: days-between INPUT is a JSON array', () => {
    const regret = readRegret('days-between')
    assert.match(regret, /^INPUT  \["/m, 'INPUT should be a JSON array (multiArgs=true honored)')
  })

  itIfGo('error path: parse-iso8601 4th input "not-a-date" excluded from INPUTS (error sentinel)', () => {
    const regret = readRegret('parse-iso8601')
    const m = regret.match(/^INPUTS\s+(\[.+\])$/m)
    assert.ok(m, 'should have INPUTS line')
    const payload = JSON.parse(m[1])
    // 4 manifest inputs; 1 top-level, 3 should be in INPUTS, but 1 of those 3 errored → 2 in INPUTS
    assert.equal(payload.length, 2, 'INPUTS should have 2 entries (4 inputs - 1 top-level - 1 errored)')
    for (const entry of payload) {
      assert.notEqual(entry.input, 'not-a-date', 'errored input should not be in INPUTS')
    }
  })

  itIfGo('VALID refactor — format-duration (switch fast-path) PASSes', () => {
    const f = join(FIXTURE_DIR, 'datetime', 'datetime.go')
    const backup = join(BACKUP_DIR, 'datetime_test_only.go')
    copyFileSync(f, backup)
    try {
      writeFileSync(f,
`package datetime

import (
	"fmt"
	"time"
)

func ParseISO8601(input string) (time.Time, error) {
	t, err := time.Parse(time.RFC3339, input)
	if err != nil {
		return time.Time{}, fmt.Errorf("invalid ISO 8601: %w", err)
	}
	return t.UTC(), nil
}

func FormatDuration(seconds int) string {
	if seconds < 0 {
		seconds = 0
	}
	switch seconds {
	case 0:
		return "0h 0m 0s"
	case 45:
		return "0h 0m 45s"
	}
	h := seconds / 3600
	m := (seconds % 3600) / 60
	s := seconds % 60
	return fmt.Sprintf("%dh %dm %ds", h, m, s)
}

func WeekdayName(isoDate string) string {
	t, err := time.Parse("2006-01-02", isoDate)
	if err != nil {
		return "INVALID"
	}
	return t.Weekday().String()
}

func DaysBetween(from, to string) int {
	t1, err1 := time.Parse("2006-01-02", from)
	t2, err2 := time.Parse("2006-01-02", to)
	if err1 != nil || err2 != nil {
		return -1
	}
	diff := t2.Sub(t1)
	if diff < 0 {
		diff = -diff
	}
	return int(diff.Hours() / 24)
}

func AddBusinessDays(isoDate string, n int) string {
	if n < 0 {
		return "INVALID"
	}
	t, err := time.Parse("2006-01-02", isoDate)
	if err != nil {
		return "INVALID"
	}
	added := 0
	for added < n {
		t = t.AddDate(0, 0, 1)
		wd := t.Weekday()
		if wd != time.Saturday && wd != time.Sunday {
			added++
		}
	}
	return t.Format("2006-01-02")
}
`)
      const r = validateAll()
      assert.equal(r.status, 0, `valid refactor should PASS:\n${r.stdout}`)
    } finally {
      copyFileSync(backup, f)
      rmSync(backup, { force: true })
    }
  })

  itIfGo('BREAKING refactor — format-duration (omit hours) FAILs', () => {
    const f = join(FIXTURE_DIR, 'datetime', 'datetime.go')
    const backup = join(BACKUP_DIR, 'datetime_test_only.go')
    copyFileSync(f, backup)
    try {
      writeFileSync(f,
`package datetime

import (
	"fmt"
	"time"
)

func ParseISO8601(input string) (time.Time, error) {
	t, err := time.Parse(time.RFC3339, input)
	if err != nil {
		return time.Time{}, fmt.Errorf("invalid ISO 8601: %w", err)
	}
	return t.UTC(), nil
}

func FormatDuration(seconds int) string {
	if seconds < 0 {
		seconds = 0
	}
	m := seconds / 60
	s := seconds % 60
	return fmt.Sprintf("%dm %ds", m, s)
}

func WeekdayName(isoDate string) string {
	t, err := time.Parse("2006-01-02", isoDate)
	if err != nil {
		return "INVALID"
	}
	return t.Weekday().String()
}

func DaysBetween(from, to string) int {
	t1, err1 := time.Parse("2006-01-02", from)
	t2, err2 := time.Parse("2006-01-02", to)
	if err1 != nil || err2 != nil {
		return -1
	}
	diff := t2.Sub(t1)
	if diff < 0 {
		diff = -diff
	}
	return int(diff.Hours() / 24)
}

func AddBusinessDays(isoDate string, n int) string {
	if n < 0 {
		return "INVALID"
	}
	t, err := time.Parse("2006-01-02", isoDate)
	if err != nil {
		return "INVALID"
	}
	added := 0
	for added < n {
		t = t.AddDate(0, 0, 1)
		wd := t.Weekday()
		if wd != time.Saturday && wd != time.Sunday {
			added++
		}
	}
	return t.Format("2006-01-02")
}
`)
      const r = validateAll()
      assert.notEqual(r.status, 0, 'breaking refactor should FAIL')
      assert.match(r.stdout, /FAIL: TestRegretValidate\/format-duration/)
    } finally {
      copyFileSync(backup, f)
      rmSync(backup, { force: true })
    }
  })

  itIfGo('BREAKING refactor — count-words (lowercase) FAILs on mixed-case input', () => {
    const f = join(FIXTURE_DIR, 'collections', 'collections.go')
    const backup = join(BACKUP_DIR, 'collections_test_only.go')
    copyFileSync(f, backup)
    try {
      const orig = readFileSync(f, 'utf8')
      // Replace the CountWords body to lowercase each word before counting.
      // Original: out[w]++  →  Modified: out[strings.ToLower(w)]++
      // We must also ensure "strings" is already imported (it is, for the existing functions).
      const modified = orig.replace(
        /out\[w\]\+\+/,
        'out[strings.ToLower(w)]++'
      )
      assert.notEqual(orig, modified, 'fixture should have an out[w]++ to replace')
      writeFileSync(f, modified)
      const r = validateAll()
      assert.notEqual(r.status, 0, 'breaking refactor (lowercase) should FAIL')
      assert.match(r.stdout, /FAIL: TestRegretValidate\/count-words/)
    } finally {
      copyFileSync(backup, f)
      rmSync(backup, { force: true })
    }
  })

  itIfGo('demo-refactor-flow.sh script runs end-to-end and all 14 checks pass', () => {
    const demoScript = join(FIXTURE_DIR, 'demo-refactor-flow.sh')
    const r = spawnSync('bash', [demoScript], {
      encoding: 'utf8',
      cwd: ROOT,
      env: goEnv,
    })
    assert.equal(r.status, 0, `demo script should exit 0:\n${r.stdout}\n${r.stderr}`)
    assert.match(r.stdout, /All checks PASS/)
    assert.match(r.stdout, /Passed: 14/)
    assert.match(r.stdout, /Failed: 0/)
  })
})

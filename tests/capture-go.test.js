// tests/capture-go.test.js — End-to-end test for the Go capture/validate flow.
//
// Runs scripts/capture_go.sh against the fixture project in
// tests/fixtures/go-example/ and asserts that:
//   1. capture writes .regret files with the standard format (HASH field present)
//   2. validate (with no code change) exits 0 and prints ✅ PASS for each cluster
//
// The test is SKIPPED if the `go` binary is not on PATH (CI without Go).

import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { execSync, execFileSync } from 'node:child_process'
import { existsSync, readFileSync, rmSync, readdirSync } from 'node:fs'
import { resolve, join } from 'node:path'

const REPO_ROOT = resolve(import.meta.dirname, '..')
const CAPTURE_GO_SH = join(REPO_ROOT, 'scripts', 'capture_go.sh')
const FIXTURE_DIR = join(REPO_ROOT, 'tests', 'fixtures', 'go-example')
const FIXTURE_REGRETS = join(FIXTURE_DIR, 'regrets')

// Check if `go` is available — skip the entire suite if not.
let goAvailable = false
try {
  execFileSync('go', ['version'], { stdio: 'pipe', timeout: 5000 })
  goAvailable = true
} catch {
  goAvailable = false
}

describe('Go capture/validate end-to-end (scripts/capture_go.sh)', { skip: !goAvailable && 'go binary not on PATH' }, () => {
  // Clean up generated files before and after each test run.
  function cleanupGenerated() {
    for (const f of readdirSync(FIXTURE_REGRETS)) {
      if (f.endsWith('.regret') || f.startsWith('regret_') && f.endsWith('.go')) {
        rmSync(join(FIXTURE_REGRETS, f))
      }
    }
  }

  before(() => cleanupGenerated())
  after(() => cleanupGenerated())

  it('capture writes .regret files for all Go clusters with HASH field', () => {
    const output = execFileSync(
      'bash',
      [CAPTURE_GO_SH, 'capture'],
      { cwd: FIXTURE_DIR, encoding: 'utf8', timeout: 60000 }
    )

    // Both clusters should be captured
    assert.match(output, /reverse/)
    assert.match(output, /count-vowels/)

    // .regret files should exist
    const reverseRegret = join(FIXTURE_REGRETS, 'reverse.regret')
    const countVowelsRegret = join(FIXTURE_REGRETS, 'count-vowels.regret')
    assert.ok(existsSync(reverseRegret), 'reverse.regret was not written')
    assert.ok(existsSync(countVowelsRegret), 'count-vowels.regret was not written')

    // Each .regret file must contain the standard fields
    for (const p of [reverseRegret, countVowelsRegret]) {
      const content = readFileSync(p, 'utf8')
      assert.match(content, /^cluster: /m, `${p}: missing cluster: line`)
      assert.match(content, /^version: 1/m, `${p}: missing version: line`)
      assert.match(content, /^fingerprint: /m, `${p}: missing fingerprint: line`)
      assert.match(content, /^captured: /m, `${p}: missing captured: line`)
      assert.match(content, /^entry: /m, `${p}: missing entry: line`)
      assert.match(content, /^stack: go/m, `${p}: missing stack: line`)
      assert.match(content, /^goPackage: /m, `${p}: missing goPackage: line`)
      assert.match(content, /^---$/m, `${p}: missing --- separator`)
      assert.match(content, /^INPUT  /m, `${p}: missing INPUT line`)
      assert.match(content, /^OUTPUT /m, `${p}: missing OUTPUT line`)
      assert.match(content, /^HASH   /m, `${p}: missing HASH line`)
    }

    // Multi-input clusters should have an INPUTS line (3 inputs → INPUTS present)
    const reverseContent = readFileSync(reverseRegret, 'utf8')
    assert.match(reverseContent, /^INPUTS /m, 'reverse.regret: missing INPUTS line for multi-input cluster')
  })

  it('validate (no code change) exits 0 and prints PASS for all clusters', () => {
    // Ensure .regret files exist (capture first if needed)
    if (!existsSync(join(FIXTURE_REGRETS, 'reverse.regret'))) {
      execFileSync('bash', [CAPTURE_GO_SH, 'capture'], { cwd: FIXTURE_DIR, timeout: 60000 })
    }

    let output
    let exitCode
    try {
      output = execFileSync(
        'bash',
        [CAPTURE_GO_SH, 'validate'],
        { cwd: FIXTURE_DIR, encoding: 'utf8', timeout: 60000 }
      )
      exitCode = 0
    } catch (err) {
      output = err.stdout || ''
      exitCode = err.status ?? 1
    }

    assert.equal(exitCode, 0, `validate should exit 0 on no-change, got ${exitCode}.\nOutput:\n${output}`)
    assert.match(output, /✅ reverse PASS/, 'reverse should PASS')
    assert.match(output, /✅ count-vowels PASS/, 'count-vowels should PASS')
  })
})

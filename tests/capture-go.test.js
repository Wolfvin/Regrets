// capture-go.test.js — end-to-end test for the Go stack
// Runs capture_go.sh capture + validate against tests/fixtures/go-example/
// SKIPS if `go` is not on PATH (no regression risk for JS-only environments)

import { readFileSync, existsSync, unlinkSync, readdirSync } from 'fs'
import { resolve, join } from 'path'
import { execSync } from 'child_process'
import { test, describe, before, it } from 'node:test'
import assert from 'node:assert/strict'
import { fingerprint } from '../scripts/fingerprint.js'

const REPO_ROOT = resolve(import.meta.dirname, '..')
const FIXTURE = resolve(REPO_ROOT, 'tests/fixtures/go-example')
const REGRET_DIR = resolve(FIXTURE, 'regrets')
const CAPTURE_SCRIPT = resolve(REPO_ROOT, 'scripts/capture_go.sh')

let goAvailable = false
try {
  execSync('go version', { stdio: 'pipe' })
  goAvailable = true
} catch {
  goAvailable = false
}

const goEnv = () => ({
  ...process.env,
  PATH: `${resolve(process.env.HOME || '/root', '.local/go/bin')}:${process.env.PATH}`,
})

describe('Go stack', () => {
  before(() => {
    if (!goAvailable) return
    // Clean up any existing .regret and generated .go files
    for (const f of readdirSync(REGRET_DIR)) {
      if (f.endsWith('.regret') || f.startsWith('regret_')) {
        try { unlinkSync(join(REGRET_DIR, f)) } catch { /* ok */ }
      }
    }
  })

  it('should capture Go clusters and write .regret files', { skip: !goAvailable }, () => {
    const output = execSync(`bash ${CAPTURE_SCRIPT} capture`, {
      cwd: FIXTURE,
      encoding: 'utf8',
      env: goEnv(),
      timeout: 30000,
    })
    assert.ok(output.includes('reverse'), 'should find reverse cluster')
    assert.ok(output.includes('count-vowels'), 'should find count-vowels cluster')
    assert.ok(output.includes('add'), 'should find add cluster')

    // Verify .regret files exist
    assert.ok(existsSync(join(REGRET_DIR, 'reverse.regret')), 'reverse.regret should exist')
    assert.ok(existsSync(join(REGRET_DIR, 'count-vowels.regret')), 'count-vowels.regret should exist')
    assert.ok(existsSync(join(REGRET_DIR, 'add.regret')), 'add.regret should exist')
  })

  it('should validate .regret files with PASS for unchanged code', { skip: !goAvailable }, () => {
    const output = execSync(`bash ${CAPTURE_SCRIPT} validate`, {
      cwd: FIXTURE,
      encoding: 'utf8',
      env: goEnv(),
      timeout: 30000,
    })
    assert.ok(output.includes('PASS'), 'validate should PASS for unchanged code')
  })

  it('.regret files should have the correct format', { skip: !goAvailable }, () => {
    const content = readFileSync(join(REGRET_DIR, 'reverse.regret'), 'utf8')
    // Required fields
    assert.ok(content.includes('cluster: reverse'), 'should have cluster field')
    assert.ok(content.includes('version: 1'), 'should have version field')
    assert.ok(/^fingerprint: \w{7}$/m.test(content), 'should have 7-char fingerprint field')
    assert.ok(content.includes('stack: go'), 'should have stack: go')
    assert.ok(content.includes('fingerprintLevel: entry'), 'should have fingerprintLevel field')
    assert.ok(content.includes('---'), 'should have --- separator')
    assert.ok(content.includes('INPUT  '), 'should have INPUT line')
    assert.ok(content.includes('OUTPUT '), 'should have OUTPUT line')
    assert.ok(content.includes('HASH   '), 'should have HASH line')
    // INPUTS line for multi-input clusters
    assert.ok(content.includes('INPUTS '), 'should have INPUTS line for multi-input cluster')
  })

  it('cross-stack fingerprint parity: Go hash === JS hash', { skip: !goAvailable }, () => {
    const addContent = readFileSync(join(REGRET_DIR, 'add.regret'), 'utf8')
    const goHash = addContent.match(/^fingerprint: (\w{7})$/m)?.[1]
    assert.ok(goHash, 'should extract Go fingerprint')

    // Compute JS fingerprint for the same input/output
    const jsHash = fingerprint([1, 2], 3)
    assert.equal(goHash, jsHash, `Go hash ${goHash} should match JS hash ${jsHash}`)
  })
})

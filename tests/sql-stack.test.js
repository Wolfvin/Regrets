// tests/sql-stack.test.js — end-to-end test for the SQL stack
//
// Runs scripts/capture_sql.mjs and scripts/validate_sql.mjs against the
// tests/fixtures/sql-example fixture, then asserts:
//   1. capture writes .regret files with all standard fields + INPUTS line
//   2. validate (no code change) exits 0 and prints PASS for all clusters
//   3. validate detects breaking change → exit 1, FAIL
//   4. cross-stack parity: SQL-written HASH matches JS fingerprint()
//
// Skips automatically if `python3` is not on PATH.
//
// Run: node --test tests/sql-stack.test.js

import { describe, it, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, rmSync, readdirSync, writeFileSync, copyFileSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { fingerprint } from '../scripts/fingerprint.js'

const ROOT = resolve(import.meta.dirname, '..')
const SCRIPTS_DIR = join(ROOT, 'scripts')
const CAPTURE_SQL = join(SCRIPTS_DIR, 'capture_sql.mjs')
const VALIDATE_SQL = join(SCRIPTS_DIR, 'validate_sql.mjs')
const FIXTURE = join(ROOT, 'tests', 'fixtures', 'sql-example')

// ─── Skip if python3 is not available ──────────────────────────────────────

function python3Available() {
  const r = spawnSync('python3', ['-c', 'import sqlite3; print(sqlite3.sqlite_version)'], {
    encoding: 'utf8', timeout: 5_000,
  })
  return r.status === 0 && r.stdout.includes('.')
}

const hasPython3 = python3Available()

function runNode(scriptPath, args = [], cwd = FIXTURE) {
  const result = spawnSync('node', [scriptPath, ...args], {
    cwd,
    encoding: 'utf8',
    timeout: 60_000,
  })
  return {
    exitCode: result.status ?? 1,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  }
}

function parseRegret(content) {
  const inputMatch = content.match(/^INPUT\s+(.*)$/m)
  const outputMatch = content.match(/^OUTPUT\s+(.*)$/m)
  const hashMatch = content.match(/^HASH\s+(\S+)/m)
  const clusterMatch = content.match(/^cluster:\s*(\S+)/m)
  const inputsMatch = content.match(/^INPUTS\s+(.*)$/m)
  return {
    cluster: clusterMatch ? clusterMatch[1] : null,
    input: inputMatch ? JSON.parse(inputMatch[1]) : undefined,
    output: outputMatch ? JSON.parse(outputMatch[1]) : undefined,
    hash: hashMatch ? hashMatch[1] : null,
    extraInputs: inputsMatch ? JSON.parse(inputsMatch[1]) : [],
  }
}

describe('SQL stack — capture + validate', { skip: !hasPython3 }, () => {
  beforeEach(() => {
    // Clean .regret files before each test
    const regretDir = join(FIXTURE, 'regrets')
    if (existsSync(regretDir)) {
      for (const f of readdirSync(regretDir)) {
        if (f.endsWith('.regret')) rmSync(join(regretDir, f))
      }
    }
  })

  it('capture writes .regret files with all standard fields + INPUTS line', () => {
    const result = runNode(CAPTURE_SQL)
    assert.equal(result.exitCode, 0,
      `capture should exit 0\nstdout: ${result.stdout}\nstderr: ${result.stderr}`)

    const regretDir = join(FIXTURE, 'regrets')
    const regretFiles = readdirSync(regretDir).filter(f => f.endsWith('.regret'))
    assert.equal(regretFiles.length, 4,
      `expected 4 .regret files, got ${regretFiles.length}: ${regretFiles.join(', ')}`)

    for (const file of regretFiles) {
      const content = readFileSync(join(regretDir, file), 'utf8')
      assert.match(content, /^cluster:\s*\S+/m, `${file} missing cluster field`)
      assert.match(content, /^version:\s*\d+/m, `${file} missing version field`)
      assert.match(content, /^fingerprint:\s*\S+/m, `${file} missing fingerprint field`)
      assert.match(content, /^captured:\s*\S+/m, `${file} missing captured field`)
      assert.match(content, /^INPUT\s+/m, `${file} missing INPUT field`)
      assert.match(content, /^OUTPUT\s+/m, `${file} missing OUTPUT field`)
      assert.match(content, /^HASH\s+\S+/m, `${file} missing HASH field`)
    }

    // Multi-input clusters should have INPUTS line
    const upperContent = readFileSync(join(regretDir, 'upper-fn.regret'), 'utf8')
    assert.match(upperContent, /^INPUTS\s+\[/m, 'upper-fn should have INPUTS line (3 inputs)')
  })

  it('validate (no code change) exits 0 and prints PASS for all clusters', () => {
    // Capture first
    runNode(CAPTURE_SQL)

    const result = runNode(VALIDATE_SQL)
    assert.equal(result.exitCode, 0,
      `validate should exit 0\nstdout: ${result.stdout}\nstderr: ${result.stderr}`)

    const passCount = (result.stdout.match(/PASS/g) || []).length
    assert.ok(passCount >= 4,
      `expected at least 4 PASS, got ${passCount}\nstdout: ${result.stdout}`)
  })

  it('validate detects breaking change → exit 1, FAIL', () => {
    // Capture baseline
    runNode(CAPTURE_SQL)

    const manifestPath = join(FIXTURE, 'regrets', 'manifest.json')
    const backup = manifestPath + '.bak'
    copyFileSync(manifestPath, backup)

    try {
      // Breaking change: change UPPER to LOWER
      const original = readFileSync(manifestPath, 'utf8')
      const broken = original.replace('SELECT UPPER(?)', 'SELECT LOWER(?)')
      writeFileSync(manifestPath, broken)

      const result = runNode(VALIDATE_SQL)
      assert.notEqual(result.exitCode, 0,
        `validate should exit non-zero on breaking change\nstdout: ${result.stdout}`)
      assert.match(result.stdout, /FAIL/i,
        `should print FAIL\nstdout: ${result.stdout}`)
    } finally {
      copyFileSync(backup, manifestPath)
      rmSync(backup)
    }
  })

  it('cross-stack parity: SQL HASH matches JS fingerprint() for all clusters', () => {
    // Capture first
    runNode(CAPTURE_SQL)

    const regretDir = join(FIXTURE, 'regrets')
    const regretFiles = readdirSync(regretDir).filter(f => f.endsWith('.regret'))

    for (const file of regretFiles) {
      const content = readFileSync(join(regretDir, file), 'utf8')
      const { input, output, hash, cluster } = parseRegret(content)

      const jsHash = fingerprint(input, output)
      assert.equal(hash, jsHash,
        `${cluster}: SQL hash ${hash} must equal JS hash ${jsHash}`)
    }
  })
})

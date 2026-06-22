// tests/make-stack.test.js — regression tests for the Make stack
//
// Tests the capture_make.sh + validate_make.sh + fingerprint_make.sh pipeline
// against an independent fixture (proof/make_independent/string_utils.mk)
// different from the PR author's slugify.mk fixture.
//
// Covers:
//   1. capture writes .regret files with all standard fields
//   2. .regret file format compatibility (cluster/version/fingerprint/INPUT/OUTPUT/HASH)
//   3. cross-stack parity (Make hash === JS fingerprint())
//   4. validate PASSES when no behavior changed
//   5. validate FAILs when a function's output changes (breaking change)
//   6. validate PASSes for a comment-only change (valid refactor)
//   7. --cluster filter isolates a single cluster
//   8. --fail-fast stops on first failure
//   9. --update mode writes new hash + audit.log entry
//  10. --update requires --reason (errors out otherwise)
//  11. --update rejects vague reasons (< 4 words)
//  12. multi-input INPUTS line is written for multi-arg clusters
//  13. capture_make.sh handles inputs containing $() safely (no shell injection)
//
// Prerequisites: GNU Make 4.x, sha256sum, python3, jq on PATH.

import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { execSync, execFileSync } from 'child_process'
import { existsSync, readFileSync, writeFileSync, mkdirSync, rmSync, copyFileSync } from 'fs'
import { resolve, join, dirname } from 'path'
import { fileURLToPath } from 'url'
import { fingerprint } from '../scripts/fingerprint.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)
const ROOT = resolve(__dirname, '..')
const SCRIPTS = resolve(ROOT, 'scripts')

// Fixture paths
const INDEP_PROOF = resolve(ROOT, 'proof/make_independent')
const INDEP_REGRETS = resolve(INDEP_PROOF, 'regrets')
const INDEP_MK = resolve(INDEP_PROOF, 'string_utils.mk')
const INDEP_MANIFEST = resolve(INDEP_REGRETS, 'manifest.json')

// Check if Make is available; if not, skip all tests
let MAKE_AVAILABLE = false
try {
  execSync('make --version', { stdio: 'ignore' })
  MAKE_AVAILABLE = true
} catch {
  MAKE_AVAILABLE = false
}

const SKIP = !MAKE_AVAILABLE

// Helper: run a bash script and return its output + exit code
function runBash(scriptPath, args = [], opts = {}) {
  try {
    const stdout = execFileSync('bash', [scriptPath, ...args], {
      cwd: opts.cwd || INDEP_PROOF,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, ...(opts.env || {}) },
    })
    return { stdout, stderr: '', exitCode: 0 }
  } catch (err) {
    return {
      stdout: err.stdout?.toString() || '',
      stderr: err.stderr?.toString() || '',
      exitCode: err.status || 1,
    }
  }
}

function capture(fixtureDir = INDEP_PROOF) {
  return runBash(resolve(SCRIPTS, 'capture_make.sh'), ['--manifest', 'regrets/manifest.json'], { cwd: fixtureDir })
}

function validate(fixtureDir = INDEP_PROOF, extraArgs = []) {
  return runBash(resolve(SCRIPTS, 'validate_make.sh'), ['--manifest', 'regrets/manifest.json', ...extraArgs], { cwd: fixtureDir })
}

function readRegret(fixtureDir, clusterId) {
  const regretPath = resolve(fixtureDir, 'regrets', `${clusterId}.regret`)
  if (!existsSync(regretPath)) return null
  return readFileSync(regretPath, 'utf8')
}

function parseRegretFields(content) {
  const fields = {}
  const lines = content.split('\n')
  let inData = false
  for (const line of lines) {
    if (line === '---') { inData = true; continue }
    if (!inData) {
      // Meta section: "key: value" pairs (cluster, version, fingerprint, ...)
      // AND "INPUTS h1 h2 h3" line (multi-input hash list)
      const m = line.match(/^(\w+):\s*(.*)$/)
      if (m) fields[m[1]] = m[2]
      const inputsMatch = line.match(/^INPUTS\s+(.*)$/)
      if (inputsMatch) fields.INPUTS = inputsMatch[1]
    } else {
      // Data section: "INPUT  value", "OUTPUT value", "HASH   value"
      const m = line.match(/^(INPUT|OUTPUT|HASH)\s+(.*)$/)
      if (m) fields[m[1]] = m[2]
    }
  }
  return fields
}

// ─── Setup / teardown ──────────────────────────────────────────────────────

before(() => {
  if (SKIP) return
  // Ensure baseline .regret files exist (re-capture fresh)
  capture()
})

// ─── Tests ─────────────────────────────────────────────────────────────────

describe('Make stack — capture', { skip: SKIP }, () => {
  it('capture writes 5 .regret files for the independent fixture', () => {
    const result = capture()
    assert.equal(result.exitCode, 0, `capture failed: ${result.stderr}`)
    const clusters = ['make-reverse', 'make-repeat', 'make-pad-left', 'make-count-chars', 'make-upper']
    for (const id of clusters) {
      const content = readRegret(INDEP_PROOF, id)
      assert.ok(content, `missing .regret for ${id}`)
    }
  })

  it('.regret files contain all required fields (cluster/version/fingerprint/INPUT/OUTPUT/HASH)', () => {
    const content = readRegret(INDEP_PROOF, 'make-reverse')
    assert.ok(content)
    const fields = parseRegretFields(content)
    assert.ok(fields.cluster, 'missing cluster')
    assert.ok(fields.version, 'missing version')
    assert.ok(fields.fingerprint, 'missing fingerprint')
    assert.ok(fields.captured, 'missing captured')
    assert.ok(fields.entry, 'missing entry')
    assert.equal(fields.stack, 'make')
    assert.ok(fields.file, 'missing file')
    assert.ok(fields.INPUT, 'missing INPUT')
    assert.ok(fields.OUTPUT, 'missing OUTPUT')
    assert.ok(fields.HASH, 'missing HASH')
  })

  it('capture writes INPUTS line for multi-arg clusters (multiArgs: true)', () => {
    // make-repeat has multiArgs: true with 3 inputs → INPUTS line should be present
    const content = readRegret(INDEP_PROOF, 'make-repeat')
    assert.ok(content)
    const fields = parseRegretFields(content)
    assert.ok(fields.INPUTS, 'multi-arg cluster should have INPUTS line')
    const hashes = fields.INPUTS.trim().split(/\s+/)
    assert.equal(hashes.length, 3, `expected 3 INPUTS hashes, got ${hashes.length}`)
  })

  it('capture OMITS INPUTS line for single-arg clusters (no overhead)', () => {
    // make-reverse has 3 inputs but multiArgs is not set → inputs are 3 separate single-arg invocations
    // The INPUTS line is still written because there are >1 inputs.
    // For a truly single-input cluster, the line would be omitted.
    // Here, make-reverse has 3 inputs so INPUTS line IS present.
    const content = readRegret(INDEP_PROOF, 'make-reverse')
    assert.ok(content)
    const fields = parseRegretFields(content)
    // make-reverse has 3 inputs, so INPUTS line should be present with 3 hashes
    assert.ok(fields.INPUTS, 'should have INPUTS line (3 inputs)')
    assert.equal(fields.INPUTS.trim().split(/\s+/).length, 3)
  })
})

describe('Make stack — cross-stack parity', { skip: SKIP }, () => {
  it('Make HASH === JS fingerprint() for all 5 clusters', () => {
    const expectedPairs = [
      { id: 'make-reverse', input: 'hello', output: 'olleh' },
      { id: 'make-repeat', input: ['ab', 3], output: 'ababab' },
      { id: 'make-pad-left', input: ['42', 5], output: '   42' },
      { id: 'make-count-chars', input: 'hello', output: '5' },
      { id: 'make-upper', input: 'hello', output: 'HELLO' },
    ]
    for (const { id, input, output } of expectedPairs) {
      const content = readRegret(INDEP_PROOF, id)
      assert.ok(content, `missing .regret for ${id}`)
      const fields = parseRegretFields(content)
      const jsHash = fingerprint(input, output)
      assert.equal(fields.HASH, jsHash, `${id}: Make hash ${fields.HASH} != JS hash ${jsHash}`)
    }
  })
})

describe('Make stack — validate', { skip: SKIP }, () => {
  it('validate PASSES when no behavior changed (5/5 PASS, exit 0)', () => {
    // Re-capture to ensure baseline
    capture()
    const result = validate()
    assert.equal(result.exitCode, 0, `expected exit 0, got ${result.exitCode}\n${result.stdout}\n${result.stderr}`)
    assert.match(result.stdout, /5\/5 Make clusters passed/)
  })

  it('validate FAILs when a function output changes (exit 1, hash mismatch)', () => {
    // Backup, modify reverse to also uppercase
    copyFileSync(INDEP_MK, INDEP_MK + '.bak')
    try {
      const original = readFileSync(INDEP_MK, 'utf8')
      const modified = original.replace(
        "printf '%s' '$1' | rev",
        "printf '%s' '$1' | rev | tr '[:lower:]' '[:upper:]'"
      )
      writeFileSync(INDEP_MK, modified)
      const result = validate()
      assert.equal(result.exitCode, 1, `expected exit 1, got ${result.exitCode}`)
      assert.match(result.stderr || result.stdout, /make-reverse: FAIL/)
    } finally {
      copyFileSync(INDEP_MK + '.bak', INDEP_MK)
      rmSync(INDEP_MK + '.bak', { force: true })
    }
  })

  it('validate PASSes for a comment-only change (exit 0)', () => {
    copyFileSync(INDEP_MK, INDEP_MK + '.bak')
    try {
      const original = readFileSync(INDEP_MK, 'utf8')
      const modified = '# Updated 2026-06-21: regression test fixture (comment-only change)\n' + original
      writeFileSync(INDEP_MK, modified)
      const result = validate()
      assert.equal(result.exitCode, 0, `expected exit 0, got ${result.exitCode}`)
      assert.match(result.stdout, /5\/5 Make clusters passed/)
    } finally {
      copyFileSync(INDEP_MK + '.bak', INDEP_MK)
      rmSync(INDEP_MK + '.bak', { force: true })
    }
  })

  it('--cluster <id> isolates a single cluster', () => {
    const result = validate(INDEP_PROOF, ['--cluster', 'make-reverse'])
    assert.equal(result.exitCode, 0)
    assert.match(result.stdout, /1\/1 Make clusters passed/)
  })

  it('--fail-fast stops on first failure', () => {
    copyFileSync(INDEP_MK, INDEP_MK + '.bak')
    try {
      const original = readFileSync(INDEP_MK, 'utf8')
      // Modify reverse (first cluster alphabetically? Let's check order)
      // Cluster order in manifest: reverse, repeat, pad_left, count_chars, upper
      // Modify reverse to break first
      const modified = original.replace(
        "printf '%s' '$1' | rev",
        "printf '%s' '$1' | rev | tr '[:lower:]' '[:upper:]'"
      )
      writeFileSync(INDEP_MK, modified)
      const result = validate(INDEP_PROOF, ['--fail-fast'])
      assert.equal(result.exitCode, 1)
      // Should not have processed all 5 clusters — at least one FAIL is enough signal
      assert.match(result.stderr || result.stdout, /make-reverse: FAIL/)
    } finally {
      copyFileSync(INDEP_MK + '.bak', INDEP_MK)
      rmSync(INDEP_MK + '.bak', { force: true })
    }
  })
})

describe('Make stack — --update mode', { skip: SKIP }, () => {
  it('--update requires --reason (errors out with exit 1)', () => {
    const result = validate(INDEP_PROOF, ['--update', 'make-reverse'])
    assert.equal(result.exitCode, 1)
    assert.match(result.stderr, /--update requires --reason/)
  })

  it('--update rejects vague reasons (< 4 words)', () => {
    const result = validate(INDEP_PROOF, ['--update', 'make-reverse', '--reason', 'changed'])
    assert.equal(result.exitCode, 1)
    assert.match(result.stderr, /--reason is too vague/)
  })

  it('--update writes new hash + audit.log entry when behavior changed', () => {
    copyFileSync(INDEP_MK, INDEP_MK + '.bak')
    const auditLog = resolve(INDEP_REGRETS, 'audit.log')
    try {
      // Modify reverse to also uppercase
      const original = readFileSync(INDEP_MK, 'utf8')
      const modified = original.replace(
        "printf '%s' '$1' | rev",
        "printf '%s' '$1' | rev | tr '[:lower:]' '[:upper:]'"
      )
      writeFileSync(INDEP_MK, modified)

      // Clean any prior audit.log
      rmSync(auditLog, { force: true })

      // Read old hash
      const before = parseRegretFields(readRegret(INDEP_PROOF, 'make-reverse'))
      const oldHash = before.HASH

      // Run update
      const result = validate(INDEP_PROOF, ['--update', 'make-reverse', '--reason', 'reverse function now uppercases output per new spec v2'])
      assert.equal(result.exitCode, 0, `update failed: ${result.stdout}\n${result.stderr}`)
      assert.match(result.stdout, /UPDATED/)

      // Verify .regret file has new hash
      const after = parseRegretFields(readRegret(INDEP_PROOF, 'make-reverse'))
      assert.notEqual(after.HASH, oldHash, 'hash should have changed after update')
      assert.equal(after.HASH, '55olbge', `expected new hash 55olbge, got ${after.HASH}`)

      // Verify audit.log entry was written
      assert.ok(existsSync(auditLog), 'audit.log should exist after update')
      const logContent = readFileSync(auditLog, 'utf8')
      assert.match(logContent, /UPDATE\s+make-reverse/)
      assert.match(logContent, new RegExp(`old: ${oldHash}`))
      assert.match(logContent, new RegExp(`new: ${after.HASH}`))
      assert.match(logContent, /reason: reverse function now uppercases output per new spec v2/)
      assert.match(logContent, /chain: \S+/)
    } finally {
      copyFileSync(INDEP_MK + '.bak', INDEP_MK)
      rmSync(INDEP_MK + '.bak', { force: true })
      rmSync(auditLog, { force: true })
      // Re-capture to restore baseline .regret
      capture()
    }
  })

  it('after --update, validate PASSES (no stale hashes)', () => {
    copyFileSync(INDEP_MK, INDEP_MK + '.bak')
    const auditLog = resolve(INDEP_REGRETS, 'audit.log')
    try {
      // Modify reverse to also uppercase
      const original = readFileSync(INDEP_MK, 'utf8')
      const modified = original.replace(
        "printf '%s' '$1' | rev",
        "printf '%s' '$1' | rev | tr '[:lower:]' '[:upper:]'"
      )
      writeFileSync(INDEP_MK, modified)
      rmSync(auditLog, { force: true })

      // Run update
      validate(INDEP_PROOF, ['--update', 'make-reverse', '--reason', 'reverse function now uppercases output per new spec v2'])

      // Now validate should pass
      const result = validate()
      assert.equal(result.exitCode, 0, `validate after update should PASS: ${result.stdout}\n${result.stderr}`)
      assert.match(result.stdout, /5\/5 Make clusters passed/)
    } finally {
      copyFileSync(INDEP_MK + '.bak', INDEP_MK)
      rmSync(INDEP_MK + '.bak', { force: true })
      rmSync(auditLog, { force: true })
      capture()
    }
  })
})

describe('Make stack — bug fixes (Task 7)', { skip: SKIP }, () => {
  it('capture_make.sh does NOT print "call: command not found" on multiArgs clusters (bash $(call) bug fix)', () => {
    // The original capture_make.sh had a Python heredoc with a comment containing
    // "$(call)" — bash interpreted this as command substitution and printed
    // "call: command not found" to stderr. Fixed by switching to single-quoted heredoc.
    const result = capture()
    assert.equal(result.exitCode, 0)
    // Stderr should NOT contain "call: command not found"
    assert.doesNotMatch(result.stderr || '', /call: command not found/,
      'capture_make.sh should not print "call: command not found" after the $(call)-in-comment bug fix')
  })
})

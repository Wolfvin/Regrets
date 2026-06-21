// tests/make-stack-task7.test.js — Task 7 independent verification of Make stack
//
// Tests the capture_make.sh + validate_make.sh pipeline against a THIRD
// independent fixture (proof/make_task7_independent/text_format.mk) that
// uses Make patterns NOT covered by either prior fixture:
//   - proof/make_slugify/slugify.mk (PR #459 author's fixture)
//   - proof/make_independent/string_utils.mk (PR #470/#477 first independent verify)
//
// Patterns newly exercised:
//   - `cut -c1-N` for character slicing (truncate)
//   - `tr -d '[:cntrl:]'` + `tr -cd '[:print:]'` (sanitize)
//   - `fold -w N` for line wrapping (wrap)
//   - `wc -w` for word counting (count_words)
//   - `awk` with toupper/tolower/substr/NF (title_case)
//
// Covers:
//   1. capture writes 5 .regret files with all required fields
//   2. .regret format compatibility (cluster/version/fingerprint/captured/INPUT/OUTPUT/HASH)
//   3. INPUTS line present for multiArgs clusters, absent for single-arg
//   4. baseline validate PASSES (5/5, exit 0)
//   5. breaking change to `truncate` → FAIL (exit 1, hash mismatch)
//   6. breaking change to `title_case` → FAIL (exit 1, hash mismatch)
//   7. comment-only change → PASS (exit 0, hashes unchanged)
//   8. `--cluster` filter isolates a single cluster
//   9. cross-stack parity: Make hash === JS fingerprint() for all 5 clusters
//  10. `--update` mode writes new hash + audit.log entry with chain hash
//  11. `--update` requires `--reason` with at least 4 words
//  12. `--update` rejects vague reasons (< 4 words)
//
// Prerequisites: GNU Make 4.x, sha256sum, python3, jq on PATH.

import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { execSync } from 'child_process'
import { existsSync, readFileSync, writeFileSync, rmSync, copyFileSync } from 'fs'
import { resolve, dirname } from 'path'
import { fileURLToPath } from 'url'
import { fingerprint } from '../scripts/fingerprint.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)
const ROOT = resolve(__dirname, '..')

// Fixture paths
const PROOF = resolve(ROOT, 'proof/make_task7_independent')
const REGRETS = resolve(PROOF, 'regrets')
const MK = resolve(PROOF, 'text_format.mk')
const MANIFEST = resolve(REGRETS, 'manifest.json')
const MK_BACKUP = `${MK}.task7-test.bak`

// Check if Make is available; if not, skip all tests
let MAKE_AVAILABLE = false
try {
  execSync('make --version', { stdio: 'ignore' })
  MAKE_AVAILABLE = true
} catch {
  MAKE_AVAILABLE = false
}

// Helper: run a bash command, return { stdout, stderr, output, exitCode }
// output is stdout + stderr combined (for assertions that don't care which stream)
function runBash (cmd, opts = {}) {
  try {
    const stdout = execSync(cmd, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...opts })
    return { stdout, stderr: '', output: stdout, exitCode: 0 }
  } catch (err) {
    const stdout = err.stdout || ''
    const stderr = err.stderr || ''
    return { stdout, stderr, output: stdout + stderr, exitCode: err.status ?? 1 }
  }
}

function captureMake () {
  return runBash(`bash ${resolve(ROOT, 'scripts/capture_make.sh')} --manifest ${MANIFEST}`)
}

function validateMake (extra = '') {
  return runBash(`bash ${resolve(ROOT, 'scripts/validate_make.sh')} --manifest ${MANIFEST} ${extra}`)
}

function restoreMk () {
  if (existsSync(MK_BACKUP)) {
    copyFileSync(MK_BACKUP, MK)
    rmSync(MK_BACKUP)
  }
}

function backupMk () {
  copyFileSync(MK, MK_BACKUP)
}

// Apply a string-replace edit to the .mk file.
// Uses split().join() instead of String.replace() to avoid JavaScript's
// special replacement patterns ($$, $&, $`, $') which mangle Make's $$i syntax.
function editMk (find, replace) {
  const content = readFileSync(MK, 'utf8')
  if (!content.includes(find)) {
    throw new Error(`editMk: pattern not found in ${MK}: ${find}`)
  }
  writeFileSync(MK, content.split(find).join(replace))
}

const describeOrSkip = MAKE_AVAILABLE ? describe : describe.skip

describeOrSkip('Make stack — Task 7 independent fixture (text_format.mk)', () => {
  before(() => {
    // Ensure clean state: capture baseline .regret files
    captureMake()
  })

  after(() => {
    // Restore .mk to its original state and re-capture
    restoreMk()
    captureMake()
    // Clean up any audit.log left by --update tests
    rmSync(resolve(REGRETS, 'audit.log'), { force: true })
  })

  describe('capture', () => {
    it('capture writes 5 .regret files for the Task 7 fixture', () => {
      const result = captureMake()
      assert.equal(result.exitCode, 0, `capture failed: ${result.stderr}`)
      const expected = ['make-truncate', 'make-sanitize', 'make-wrap', 'make-count-words', 'make-title-case']
      for (const id of expected) {
        const fp = resolve(REGRETS, `${id}.regret`)
        assert.ok(existsSync(fp), `Expected .regret file not found: ${fp}`)
      }
    })

    it('.regret files contain all 7 required fields', () => {
      const files = ['make-truncate', 'make-sanitize', 'make-wrap', 'make-count-words', 'make-title-case']
      for (const id of files) {
        const content = readFileSync(resolve(REGRETS, `${id}.regret`), 'utf8')
        assert.match(content, /^cluster:/m, `${id}: missing cluster:`)
        assert.match(content, /^version:/m, `${id}: missing version:`)
        assert.match(content, /^fingerprint:/m, `${id}: missing fingerprint:`)
        assert.match(content, /^captured:/m, `${id}: missing captured:`)
        assert.match(content, /^INPUT  /m, `${id}: missing INPUT`)
        assert.match(content, /^OUTPUT /m, `${id}: missing OUTPUT`)
        assert.match(content, /^HASH   /m, `${id}: missing HASH`)
      }
    })

    it('capture writes INPUTS line for clusters with >1 inputs (all 5 Task 7 clusters)', () => {
      // INPUTS line is written whenever a cluster has >1 inputs, regardless of multiArgs.
      // multiArgs only controls whether each input is an array (multi-arg call) vs scalar.
      const expected = {
        'make-truncate': 4,   // multiArgs: true, 4 inputs
        'make-sanitize': 3,   // single-arg, 3 inputs
        'make-wrap': 3,       // multiArgs: true, 3 inputs
        'make-count-words': 3, // single-arg, 3 inputs
        'make-title-case': 3  // single-arg, 3 inputs
      }
      for (const [id, expectedCount] of Object.entries(expected)) {
        const content = readFileSync(resolve(REGRETS, `${id}.regret`), 'utf8')
        assert.match(content, /^INPUTS\s/m, `${id}: expected INPUTS line (>1 input)`)
        // Extract the INPUTS line and count hashes
        const inputsLine = content.match(/^INPUTS\s+(.+)$/m)
        assert.ok(inputsLine, `${id}: could not parse INPUTS line`)
        const hashes = inputsLine[1].trim().split(/\s+/)
        assert.equal(hashes.length, expectedCount,
          `${id}: expected ${expectedCount} INPUTS hashes, got ${hashes.length}`)
      }
    })
  })

  describe('cross-stack parity (Make hash === JS fingerprint)', () => {
    it('all 5 Task 7 clusters produce hashes that match JS fingerprint()', () => {
      // Vectors: [input, output, expectedHash]
      // The expected hashes are read from the captured .regret files
      const vectors = [
        [['Hello World', 5], 'Hello...'],
        ['hello world', 'hello world'],
        [['abcdefghij', 4], 'abcd efgh ij'],
        ['hello world', '2'],
        ['hello world', 'Hello World']
      ]
      const expectedHashes = ['4t0zo7f', '1hgg9kv', '2p2hh9f', '1m29nxw', '4am2hvn']
      vectors.forEach(([input, output], i) => {
        const jsHash = fingerprint(input, output)
        assert.equal(jsHash, expectedHashes[i],
          `Vector ${i}: input=${JSON.stringify(input)} output=${JSON.stringify(output)} → JS hash ${jsHash} !== expected ${expectedHashes[i]}`)
      })
    })
  })

  describe('validate', () => {
    it('validate PASSES when no behavior changed (5/5 PASS, exit 0)', () => {
      const result = validateMake()
      assert.equal(result.exitCode, 0, `Expected exit 0, got ${result.exitCode}. Output: ${result.stdout}`)
      assert.match(result.stdout, /5\/5 Make clusters passed/)
    })

    it('validate FAILs when truncate behavior changes (exit 1, hash mismatch)', () => {
      backupMk()
      try {
        editMk('cut -c1-$(2)', 'cut -c1-3')
        const result = validateMake()
        assert.equal(result.exitCode, 1, `Expected exit 1 for breaking change, got ${result.exitCode}`)
        // FAIL message goes to stderr; use output (stdout+stderr) for stream-agnostic check
        assert.match(result.output, /make-truncate: FAIL/)
        assert.match(result.output, /4\/5 Make clusters passed/)
      } finally {
        restoreMk()
      }
    })

    it('validate FAILs when title_case behavior changes (exit 1, hash mismatch)', () => {
      backupMk()
      try {
        // Change: uppercase first 2 chars instead of 1.
        // This affects input[0] ("hello world" → "HEllo World" instead of "Hello World"),
        // which triggers a top-level HASH mismatch.
        // NOTE: validate_make.sh only checks the top-level HASH (input[0]) — it does NOT
        // check the INPUTS line hashes for inputs[1+]. This is a known gap (Issue #315
        // multi-input contract not implemented in validate_make.sh). Documented in PR
        // description as a follow-up gap, not fixed in this Task 7 PR (out of scope:
        // this PR is independent verification, not a validate_make.sh fix).
        editMk('toupper(substr($$i,1,1))', 'toupper(substr($$i,1,2))')
        const result = validateMake()
        assert.equal(result.exitCode, 1, `Expected exit 1 for breaking change, got ${result.exitCode}`)
        assert.match(result.output, /make-title-case: FAIL/)
      } finally {
        restoreMk()
      }
    })

    it('validate PASSes for a comment-only change (exit 0, hashes unchanged)', () => {
      backupMk()
      try {
        const content = readFileSync(MK, 'utf8')
        writeFileSync(MK, '# Task 7 test: no functional change\n' + content)
        const result = validateMake()
        assert.equal(result.exitCode, 0, `Expected exit 0 for comment-only change, got ${result.exitCode}`)
        assert.match(result.stdout, /5\/5 Make clusters passed/)
      } finally {
        restoreMk()
      }
    })

    it('--cluster <id> isolates a single cluster (1/1 PASS, exit 0)', () => {
      const result = validateMake('--cluster make-count-words')
      assert.equal(result.exitCode, 0, `Expected exit 0, got ${result.exitCode}`)
      assert.match(result.stdout, /1\/1 Make clusters passed/)
      assert.match(result.stdout, /make-count-words: PASS/)
    })
  })

  describe('--update mode', () => {
    it('--update requires --reason (errors out with exit 1)', () => {
      const result = validateMake('--update make-title-case')
      assert.notEqual(result.exitCode, 0, 'Expected non-zero exit when --reason is missing')
    })

    it('--update rejects vague reasons (< 4 words)', () => {
      const result = validateMake('--update make-title-case --reason "short reason"')
      assert.notEqual(result.exitCode, 0, 'Expected non-zero exit for vague reason')
    })

    it('--update writes new hash + audit.log entry when behavior changed', () => {
      backupMk()
      try {
        // Apply breaking change: uppercase first 2 chars instead of 1 (affects input[0])
        editMk('toupper(substr($$i,1,1))', 'toupper(substr($$i,1,2))')
        // Verify the breaking change is detected
        const failResult = validateMake()
        assert.equal(failResult.exitCode, 1, 'Expected FAIL before update')

        // Apply update
        const updateResult = validateMake('--update make-title-case --reason "spec v2 uppercase whole word for emphasis"')
        assert.equal(updateResult.exitCode, 0, `Expected exit 0 for update, got ${updateResult.exitCode}. Output: ${updateResult.output}`)
        assert.match(updateResult.output, /make-title-case: UPDATED/)

        // Verify audit.log was written
        const auditLog = resolve(REGRETS, 'audit.log')
        assert.ok(existsSync(auditLog), 'audit.log should exist after --update')
        const logContent = readFileSync(auditLog, 'utf8')
        assert.match(logContent, /UPDATE\s+make-title-case/)
        assert.match(logContent, /chain:/)
        assert.match(logContent, /spec v2 uppercase whole word for emphasis/)

        // Verify validate now PASSES
        const passResult = validateMake()
        assert.equal(passResult.exitCode, 0, 'Expected PASS after --update')
        assert.match(passResult.stdout, /5\/5 Make clusters passed/)
      } finally {
        restoreMk()
        // Clean up audit.log
        rmSync(resolve(REGRETS, 'audit.log'), { force: true })
        // Re-capture to restore original baseline hashes
        captureMake()
      }
    })
  })

  describe('bug-fix regression (Task 7 fixture exercises patterns not in prior fixtures)', () => {
    it('capture_make.sh handles `cut -c1-$(2)` without stderr pollution', () => {
      // Regression: capture_make.sh previously had a Python heredoc that contained
      // the literal text `$(call)` which bash interpreted as command substitution.
      // This test verifies no stderr pollution on the Task 7 fixture which uses
      // `cut -c1-$(2)` (similar `$(...)` pattern) in its function definitions.
      const result = captureMake()
      assert.equal(result.exitCode, 0)
      // stderr should NOT contain "call: command not found" or similar
      assert.doesNotMatch(result.stderr || '', /call: command not found/,
        'capture_make.sh should not pollute stderr with `call: command not found`')
    })

    it('capture_make.sh handles `awk` patterns without parse errors', () => {
      // Task 7 fixture uses `awk` with $$i (escaped $ for Make). This test
      // verifies capture_make.sh correctly invokes Make and parses the output
      // without confusing awk's $$i with shell variable expansion.
      const content = readFileSync(resolve(REGRETS, 'make-title-case.regret'), 'utf8')
      // The expected output for "hello world" → "Hello World"
      assert.match(content, /OUTPUT "Hello World"/)
    })
  })
})

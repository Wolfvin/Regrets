// tests/cpp-stack-multi-input.test.js
// Issue #315 multi-input INPUTS contract for the C++ stack.
//
// Verifies that the C++ harness (`regret_harness.cpp`):
//   - capture writes an INPUTS line for multi-input clusters (inputs.length > 1)
//   - capture OMITS the INPUTS line for single-input clusters (no overhead)
//   - validate PASSES when no behavior changed (INPUTS line is present)
//   - validate FAILs when ONLY a non-first input changes behavior
//   - validate output reports "multi-input mismatch" with golden/live hashes
//   - backward compat: old .regret files (no INPUTS line) still validate
//   - cross-stack fingerprint parity (C++ === JS) for ALL inputs (input[0] + INPUTS[])
//
// This brings the C++ stack to parity with the JS / React / Perl / Bash stacks
// which already implement the Issue #315 multi-input contract.

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
const HARNESS_SRC = join(SCRIPTS_DIR, 'regret_cpp', 'regret_harness.cpp')
const REGRET_HPP  = join(SCRIPTS_DIR, 'regret_cpp', 'regret.hpp')

// Use the string-utils fixture from PR #465's independent verification
const STRING_UTILS_HPP = join(ROOT, 'proof', 'cpp_independent', 'string_utils.hpp')
const STRING_ADAPTER_CPP = join(ROOT, 'proof', 'cpp_independent', 'string_adapter.cpp')

const TMP = resolve(join(process.cwd(), 'tests', `__cpp_multi_${process.pid}__`))

// Detect C++ toolchain availability (same logic as cpp-stack.test.js)
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

// ─── Multi-input manifest with 5 clusters (string-utils domain) ──────────
// Each cluster has 2-3 inputs so we can test the INPUTS line contract.
const MULTI_MANIFEST = {
  clusters: [
    {
      id: 'reverse', entry: 'regret_reverse', stack: 'cpp',
      fingerprintLevel: 'entry', watches: ['reverse'],
      inputs: ['hello', 'Regrets', 'abc123'],
    },
    {
      id: 'is-palindrome', entry: 'regret_is_palindrome', stack: 'cpp',
      fingerprintLevel: 'entry', watches: ['is_palindrome'],
      inputs: ['Race Car', 'hello', 'A man a plan a canal Panama'],
    },
    {
      id: 'word-count', entry: 'regret_word_count', stack: 'cpp',
      fingerprintLevel: 'entry', watches: ['word_count'],
      inputs: ['hello world', 'one two three four', ''],
    },
  ],
}

// Single-input manifest — verifies INPUTS line is OMITTED when inputs.length === 1
const SINGLE_MANIFEST = {
  clusters: [
    {
      id: 'reverse-once', entry: 'regret_reverse', stack: 'cpp',
      fingerprintLevel: 'entry', watches: ['reverse'],
      inputs: ['only-input'],
    },
  ],
}

function setupProject(manifest) {
  mkdirSync(join(TMP, 'regrets'), { recursive: true })
  writeFileSync(join(TMP, 'regrets', 'manifest.json'), JSON.stringify(manifest, null, 2))
  copyFileSync(STRING_UTILS_HPP, join(TMP, 'string_utils.hpp'))
  copyFileSync(STRING_ADAPTER_CPP, join(TMP, 'string_adapter.cpp'))
}

function runCaptureOrValidate(script, opts = {}) {
  return spawnSync('bash', [script], {
    cwd: TMP,
    encoding: 'utf8',
    env: {
      ...process.env,
      CPP_SOURCES: `${TMP}/string_adapter.cpp`,
      CPP_INCLUDE: TMP,
    },
    ...opts,
  })
}

function readRegret(id) {
  return readFileSync(join(TMP, 'regrets', `${id}.regret`), 'utf8')
}

describe('C++ stack — Issue #315 multi-input INPUTS contract', () => {
  before(() => {
    if (!hasGpp || !hasLibs) return
    setupProject(MULTI_MANIFEST)
  })

  after(() => {
    if (existsSync(TMP)) rmSync(TMP, { recursive: true, force: true })
  })

  itIfCpp('capture writes INPUTS line for multi-input clusters', () => {
    const r = runCaptureOrValidate(CAPTURE_SH)
    assert.equal(r.status, 0, `capture failed: ${r.stdout}\n${r.stderr}`)

    const reverseRegret = readRegret('reverse')
    assert.match(reverseRegret, /^INPUTS /m,
      'reverse.regret (3 inputs) must contain an INPUTS line')
    assert.match(reverseRegret, /^INPUTS \[.+\]/m,
      'INPUTS line must be a JSON array')

    const isPalRegret = readRegret('is-palindrome')
    assert.match(isPalRegret, /^INPUTS /m,
      'is-palindrome.regret (3 inputs) must contain an INPUTS line')
  })

  itIfCpp('INPUTS line contains entries for inputs 1+ (not input[0])', () => {
    runCaptureOrValidate(CAPTURE_SH)
    const reverseRegret = readRegret('reverse')
    const m = reverseRegret.match(/^INPUTS (\[.+\])/m)
    assert.ok(m, 'INPUTS line must be present')
    const inputs = JSON.parse(m[1])
    // reverse cluster has 3 inputs; INPUTS should have 2 entries (inputs 1+)
    assert.equal(inputs.length, 2,
      `INPUTS array must have 2 entries (inputs 1+), got ${inputs.length}`)
    // First INPUTS entry must NOT be input[0] ("hello")
    assert.notEqual(inputs[0].input, 'hello',
      'INPUTS[0] must not be input[0] (already in top-level INPUT line)')
    // Each entry must have input, output, hash fields
    for (const entry of inputs) {
      assert.ok('input' in entry, 'entry must have input field')
      assert.ok('output' in entry, 'entry must have output field')
      assert.ok('hash' in entry, 'entry must have hash field')
      assert.match(entry.hash, /^[0-9a-z]{7}$/,
        `hash must be 7-char base36, got "${entry.hash}"`)
    }
  })

  itIfCpp('capture OMITS INPUTS line for single-input clusters (no overhead)', () => {
    // Switch to single-input manifest
    setupProject(SINGLE_MANIFEST)
    const r = runCaptureOrValidate(CAPTURE_SH)
    assert.equal(r.status, 0, `capture failed: ${r.stdout}\n${r.stderr}`)

    const singleRegret = readRegret('reverse-once')
    assert.doesNotMatch(singleRegret, /^INPUTS /m,
      'single-input .regret file must NOT have an INPUTS line (no overhead)')

    // Restore multi-input setup for subsequent tests
    setupProject(MULTI_MANIFEST)
    runCaptureOrValidate(CAPTURE_SH)
  })

  itIfCpp('validate PASSES when no behavior changed (INPUTS line present)', () => {
    runCaptureOrValidate(CAPTURE_SH)
    const r = runCaptureOrValidate(VALIDATE_SH)
    assert.equal(r.status, 0,
      `validate should PASS for unchanged multi-input code:\n${r.stdout}\n${r.stderr}`)
    assert.match(r.stdout, /Passed: 3/)
  })

  itIfCpp('validate FAILs when ONLY a non-first input changes behavior', () => {
    // Subtle breaking change: only affects inputs LONGER than 5 chars.
    // input[0]="hello" (len 5) → still reversed correctly → top-level golden MATCHES
    // input[1]="Regrets" (len 7) → uppercase first char → INPUTS[0] hash MISMATCHES
    // Without Issue #315 multi-input contract, this would be a false GREEN.
    const stringUtilsPath = join(TMP, 'string_utils.hpp')
    const backup = join(TMP, 'string_utils.hpp.bak')
    copyFileSync(stringUtilsPath, backup)
    try {
      let src = readFileSync(stringUtilsPath, 'utf8')
      const old = `inline std::string reverse(const std::string& s) {
    std::string result(s.rbegin(), s.rend());
    return result;
}`
      const next = `inline std::string reverse(const std::string& s) {
    std::string result(s.rbegin(), s.rend());
    if (result.size() > 5) {
        result[0] = static_cast<char>(std::toupper(static_cast<unsigned char>(result[0])));
    }
    return result;
}`
      assert.ok(src.includes(old), 'original reverse() body not found')
      writeFileSync(stringUtilsPath, src.replace(old, next))

      const r = runCaptureOrValidate(VALIDATE_SH)
      assert.notEqual(r.status, 0,
        `validate must FAIL (multi-input contract catches subtle breaking change)`)
      // The reverse cluster must FAIL even though input[0] still matches
      assert.match(r.stdout, /reverse[\s\S]*FAIL/,
        'FAIL must be on the reverse cluster')
      // The output must mention "multi-input mismatch" with golden/live hashes
      assert.match(r.stdout, /multi-input mismatch/,
        'output must report "multi-input mismatch"')
      assert.match(r.stdout, /golden=[0-9a-z]+\s+live=[0-9a-z]+/,
        'multi-input mismatch must show golden and live hashes')
      // Other clusters (is-palindrome, word-count) should still PASS
      assert.match(r.stdout, /Passed: 2/)
      assert.match(r.stdout, /Failed: 1/)
    } finally {
      copyFileSync(backup, stringUtilsPath)
      rmSync(backup, { force: true })
    }
  })

  itIfCpp('cross-stack fingerprint parity — C++ INPUTS hashes === JS fingerprint()', () => {
    runCaptureOrValidate(CAPTURE_SH)

    // reverse cluster: inputs=["hello", "Regrets", "abc123"], outputs=["olleh", "stergeR", "321cba"]
    const cases = [
      { input: 'hello',    output: 'olleh'   },
      { input: 'Regrets',  output: 'stergeR' },
      { input: 'abc123',   output: '321cba'  },
      // is-palindrome: inputs=["Race Car", "hello", "A man a plan a canal Panama"]
      { input: 'Race Car', output: true },
      { input: 'hello',    output: false },
      { input: 'A man a plan a canal Panama', output: true },
      // word-count: inputs=["hello world", "one two three four", ""]
      { input: 'hello world',         output: 2 },
      { input: 'one two three four',  output: 4 },
      { input: '',                    output: 0 },
    ]

    // Read all three .regret files and collect (input, hash) pairs from top-level + INPUTS
    const collected = []
    for (const id of ['reverse', 'is-palindrome', 'word-count']) {
      const regret = readRegret(id)
      // Top-level INPUT/OUTPUT/HASH
      const topInput = regret.match(/^INPUT\s+(.+)$/m)?.[1]
      const topHash  = regret.match(/^HASH\s+(\S+)/m)?.[1]
      if (topInput && topHash) {
        collected.push({ input: JSON.parse(topInput), hash: topHash, cluster: id })
      }
      // INPUTS line entries
      const inputsLine = regret.match(/^INPUTS (\[.+\])/m)?.[1]
      if (inputsLine) {
        for (const entry of JSON.parse(inputsLine)) {
          collected.push({ input: entry.input, hash: entry.hash, cluster: id })
        }
      }
    }

    assert.equal(collected.length, cases.length,
      `expected ${cases.length} (input, hash) pairs across 3 clusters, got ${collected.length}`)

    for (let i = 0; i < cases.length; i++) {
      const c = cases[i]
      const coll = collected[i]
      const jsHash = fingerprint(c.input, c.output)
      assert.equal(coll.hash, jsHash,
        `parity mismatch for ${coll.cluster} input=${JSON.stringify(c.input)}: ` +
        `C++=${coll.hash} JS=${jsHash}`)
    }
  })

  itIfCpp('backward compat: old .regret files (no INPUTS line) still validate', () => {
    // Re-capture to ensure we have current .regret files
    runCaptureOrValidate(CAPTURE_SH)

    // Strip the INPUTS line from each .regret file (simulating an old capture)
    for (const id of ['reverse', 'is-palindrome', 'word-count']) {
      const regretPath = join(TMP, 'regrets', `${id}.regret`)
      const content = readFileSync(regretPath, 'utf8')
      const stripped = content.split('\n').filter(line => !line.startsWith('INPUTS ')).join('\n')
      writeFileSync(regretPath, stripped)
    }

    // Validate must still PASS for unchanged code (backward compat)
    const r = runCaptureOrValidate(VALIDATE_SH)
    assert.equal(r.status, 0,
      `old .regret files (no INPUTS) must still validate for unchanged code:\n${r.stdout}`)
    assert.match(r.stdout, /Passed: 3/)
  })
})

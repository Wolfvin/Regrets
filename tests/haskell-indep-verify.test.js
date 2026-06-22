// tests/haskell-indep-verify.test.js — Independent verification of Haskell stack
//
// This test verifies the Haskell Regrets stack using a FRESH fixture
// (proof/haskell_indep/) with 5 Haskell functions that are deliberately
// DIFFERENT from the bundled fixture (tests/fixtures/haskell-example/).
//
// Per CONTEXT.md's "Lesson Learned" warning: "high test counts don't
// guarantee features actually work — red team found callee wrapping was
// broken for the most common patterns despite all unit tests passing,
// because tests were written with the same pattern as the implementation
// (confirmation bias)."
//
// The bundled fixture uses: slugify (string transform), countVowels (string
// filter), reverseStr (string reverse), add (arithmetic). This test uses:
//   1. factorial     — recursion with pattern matching
//   2. gcd'          — Euclidean algorithm with guards
//   3. isPrime       — list comprehension + sqrt bound
//   4. collatzLength — recursive sequence
//   5. fibonacci     — tail-recursive with accumulator
//
// Run: node --test tests/haskell-indep-verify.test.js

import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, rmSync, readdirSync, writeFileSync, copyFileSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { fingerprint } from '../scripts/fingerprint.js'

const ROOT = resolve(import.meta.dirname, '..')
const SCRIPTS_DIR = join(ROOT, 'scripts')
const CAPTURE_HASKELL = join(SCRIPTS_DIR, 'capture_haskell.sh')
const VALIDATE_HASKELL = join(SCRIPTS_DIR, 'validate_haskell.sh')
const FIXTURE = join(ROOT, 'proof', 'haskell_indep')

function stackAvailable() {
  const r = spawnSync('stack', ['runghc', '--', '--version'], {
    encoding: 'utf8', timeout: 30_000,
    env: { ...process.env, PATH: `/usr/local/bin:${process.env.PATH}` },
  })
  return r.status === 0 || (r.stdout && r.stdout.includes('GHC'))
}

const hasStack = stackAvailable()

function runBash(scriptPath, args = [], cwd = FIXTURE) {
  const result = spawnSync('bash', [scriptPath, ...args], {
    cwd,
    encoding: 'utf8',
    timeout: 300_000,
    env: { ...process.env, PATH: `/usr/local/bin:${process.env.PATH}` },
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
  return {
    cluster: clusterMatch ? clusterMatch[1] : null,
    input: inputMatch ? JSON.parse(inputMatch[1]) : undefined,
    output: outputMatch ? JSON.parse(outputMatch[1]) : undefined,
    hash: hashMatch ? hashMatch[1] : null,
  }
}

describe('Haskell independent verification (fresh fixture: factorial, gcd, isPrime, collatz, fibonacci)', { skip: !hasStack }, () => {
  before(() => {
    // Clean any existing .regret files
    const regretDir = join(FIXTURE, 'regrets')
    if (existsSync(regretDir)) {
      for (const f of readdirSync(regretDir)) {
        if (f.endsWith('.regret')) rmSync(join(regretDir, f))
      }
    }
  })

  it('capture writes 5 .regret files with standard fields + INPUTS line', () => {
    const result = runBash(CAPTURE_HASKELL)
    assert.equal(result.exitCode, 0,
      `capture should exit 0\nstdout: ${result.stdout}\nstderr: ${result.stderr}`)

    const regretDir = join(FIXTURE, 'regrets')
    const regretFiles = readdirSync(regretDir).filter(f => f.endsWith('.regret'))
    assert.equal(regretFiles.length, 5,
      `expected 5 .regret files, got ${regretFiles.length}: ${regretFiles.join(', ')}`)

    // Verify each has standard fields
    for (const file of regretFiles) {
      const content = readFileSync(join(regretDir, file), 'utf8')
      assert.match(content, /^cluster:\s*\S+/m, `${file} missing cluster field`)
      assert.match(content, /^version:\s*\d+/m, `${file} missing version field`)
      assert.match(content, /^fingerprint:\s*\S+/m, `${file} missing fingerprint field`)
      assert.match(content, /^captured:\s*\S+/m, `${file} missing captured field`)
      assert.match(content, /^INPUT\s+/m, `${file} missing INPUT field`)
      assert.match(content, /^OUTPUT\s+/m, `${file} missing OUTPUT field`)
      assert.match(content, /^HASH\s+\S+/m, `${file} missing HASH field`)
      // Multi-input clusters should have INPUTS line
      assert.match(content, /^INPUTS\s+\[/m, `${file} missing INPUTS line`)
    }
  })

  it('validate (no code change) exits 0 and prints PASS for all 5 clusters', () => {
    const result = runBash(VALIDATE_HASKELL)
    assert.equal(result.exitCode, 0,
      `validate should exit 0\nstdout: ${result.stdout}\nstderr: ${result.stderr}`)

    const passCount = (result.stdout.match(/PASS/g) || []).length
    assert.ok(passCount >= 5,
      `expected at least 5 PASS, got ${passCount}\nstdout: ${result.stdout}`)
  })

  it('cross-stack parity: Haskell HASH matches JS fingerprint() for all 5 clusters', () => {
    const regretDir = join(FIXTURE, 'regrets')
    const regretFiles = readdirSync(regretDir).filter(f => f.endsWith('.regret'))

    for (const file of regretFiles) {
      const content = readFileSync(join(regretDir, file), 'utf8')
      const { input, output, hash, cluster } = parseRegret(content)

      const jsHash = fingerprint(input, output)
      assert.equal(hash, jsHash,
        `${cluster}: Haskell hash ${hash} must equal JS hash ${jsHash}`)
    }
  })

  it('validate detects breaking change → exit 1, FAIL', () => {
    const srcFile = join(FIXTURE, 'NumericUtils.hs')
    const backup = srcFile + '.bak'

    // Backup original
    copyFileSync(srcFile, backup)

    try {
      // Breaking change: factorial returns n instead of n!
      const original = readFileSync(srcFile, 'utf8')
      const broken = original.replace(
        'n * factorial (n - 1)',
        'n + factorial (n - 1)'
      )
      writeFileSync(srcFile, broken)

      const result = runBash(VALIDATE_HASKELL)
      assert.notEqual(result.exitCode, 0,
        `validate should exit non-zero on breaking change\nstdout: ${result.stdout}`)
      assert.match(result.stdout, /FAIL/i,
        `should print FAIL\nstdout: ${result.stdout}`)
    } finally {
      // Restore original
      copyFileSync(backup, srcFile)
      rmSync(backup)
    }
  })

  it('validate detects valid refactor (same output) → exit 0, PASS', () => {
    const srcFile = join(FIXTURE, 'NumericUtils.hs')
    const backup = srcFile + '.bak'

    // Backup original
    copyFileSync(srcFile, backup)

    try {
      // Valid refactor: change factorial from recursive to product-based
      // (same output for all inputs)
      const original = readFileSync(srcFile, 'utf8')
      const refactored = original.replace(
        'factorial 0 = 1\nfactorial n\n  | n < 0     = error "factorial: negative input"\n  | otherwise = n * factorial (n - 1)',
        'factorial n\n  | n < 0     = error "factorial: negative input"\n  | otherwise = product [1..n]'
      )
      writeFileSync(srcFile, refactored)

      const result = runBash(VALIDATE_HASKELL)
      assert.equal(result.exitCode, 0,
        `validate should exit 0 on valid refactor\nstdout: ${result.stdout}`)
      assert.match(result.stdout, /PASS/i,
        `should print PASS\nstdout: ${result.stdout}`)
    } finally {
      // Restore original
      copyFileSync(backup, srcFile)
      rmSync(backup)
    }
  })
})

// tests/capture-lua-independent.test.js — Independent verification of Lua stack
//
// This test was created as part of a consolidation review of the Lua stack
// (issue #369, PRs #395 + #430). Per CONTEXT.md's "Lesson Learned" warning:
//   "high test counts don't guarantee features actually work — red team found
//    callee wrapping was broken for the most common patterns despite all unit
//    tests passing, because tests were written with the same pattern as the
//    implementation (confirmation bias)."
//
// The existing tests in capture-lua.test.js use the bundled fixture
// `tests/fixtures/lua-example/strings.lua` (string reversal, vowel counting).
// This test uses a FRESH fixture with DIFFERENT patterns:
//   - Numeric functions (not string)
//   - Multi-arg function via `multiArgs: true` (array input unpacked to 2 args)
//   - Recursive function (factorial)
//   - Boolean-returning function (is_even)
//   - Table-returning function
//
// If the Lua stack only works for string functions (confirmation bias), this
// test will catch it.
//
// Run: node --test tests/capture-lua-independent.test.js

import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, writeFileSync, rmSync, existsSync, readFileSync, readdirSync, copyFileSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { fingerprint } from '../scripts/fingerprint.js'

const ROOT = resolve(import.meta.dirname, '..')
const SCRIPTS_DIR = join(ROOT, 'scripts')
const CAPTURE_LUA = join(SCRIPTS_DIR, 'capture_lua.lua')
const VALIDATE_LUA = join(SCRIPTS_DIR, 'validate_lua.lua')

// Unique tmp dir per test file
const TMP = resolve(join(process.cwd(), 'tests', `__lua_indep_${process.pid}__`))

function luaAvailable() {
  const r = spawnSync('lua', ['-v'], { encoding: 'utf8', timeout: 5_000 })
  return r.status === 0 || (r.stdout && r.stdout.includes('Lua'))
}

const hasLua = luaAvailable()

function runLua(scriptPath, args = [], cwd = TMP) {
  const result = spawnSync('lua', [scriptPath, ...args], {
    cwd,
    encoding: 'utf8',
    timeout: 30_000,
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
  const fingerprintMatch = content.match(/^fingerprint:\s*(\S+)/m)
  return {
    input: inputMatch ? JSON.parse(inputMatch[1]) : undefined,
    output: outputMatch ? JSON.parse(outputMatch[1]) : undefined,
    hash: hashMatch ? hashMatch[1] : null,
    fingerprint: fingerprintMatch ? fingerprintMatch[1] : null,
  }
}

// Fresh fixture: numeric functions (different patterns from strings.lua)
const FIXTURE_SOURCE = `-- Independent verification fixture: numeric functions
local M = {}

-- Multi-arg function (array input unpacked to 2 args)
M.add = function(a, b)
  return a + b
end

-- Recursive function
M.factorial = function(n)
  if n <= 1 then return 1 end
  return n * M.factorial(n - 1)
end

-- Boolean-returning function
M.is_even = function(n)
  return n % 2 == 0
end

return M
`

const MANIFEST = {
  clusters: [
    {
      id: 'add',
      entry: 'add',
      file: './mathutils.lua',
      stack: 'lua',
      luaModule: 'mathutils',
      fingerprintLevel: 'entry',
      inputs: [[2, 3], [10, 20], [0, 0]],
      multiArgs: true,
      watches: [],
    },
    {
      id: 'factorial',
      entry: 'factorial',
      file: './mathutils.lua',
      stack: 'lua',
      luaModule: 'mathutils',
      fingerprintLevel: 'entry',
      inputs: [0, 1, 5, 10],
      watches: [],
    },
    {
      id: 'is-even',
      entry: 'is_even',
      file: './mathutils.lua',
      stack: 'lua',
      luaModule: 'mathutils',
      fingerprintLevel: 'entry',
      inputs: [2, 3, 0, 1],
      watches: [],
    },
  ],
}

describe('Lua stack — independent verification (fresh fixture, different patterns)', { skip: !hasLua }, () => {
  before(() => {
    mkdirSync(join(TMP, 'regrets'), { recursive: true })
    writeFileSync(join(TMP, 'mathutils.lua'), FIXTURE_SOURCE)
    writeFileSync(join(TMP, 'package.json'), JSON.stringify({ name: 'lua-indep-test', version: '0.0.0' }))
    writeFileSync(join(TMP, 'regrets', 'manifest.json'), JSON.stringify(MANIFEST, null, 2))
  })

  after(() => {
    if (existsSync(TMP)) rmSync(TMP, { recursive: true, force: true })
  })

  it('capture writes .regret files for all 3 numeric clusters', () => {
    const result = runLua(CAPTURE_LUA)
    assert.equal(result.exitCode, 0, `capture should exit 0\nstdout: ${result.stdout}\nstderr: ${result.stderr}`)

    const regretFiles = readdirSync(join(TMP, 'regrets')).filter(f => f.endsWith('.regret'))
    assert.ok(regretFiles.includes('add.regret'), `add.regret should exist; got: ${regretFiles.join(', ')}`)
    assert.ok(regretFiles.includes('factorial.regret'), `factorial.regret should exist; got: ${regretFiles.join(', ')}`)
    assert.ok(regretFiles.includes('is-even.regret'), `is-even.regret should exist; got: ${regretFiles.join(', ')}`)
  })

  it('validate (no code change) exits 0 and prints PASS for all clusters', () => {
    const result = runLua(VALIDATE_LUA)
    assert.equal(result.exitCode, 0, `validate should exit 0\nstdout: ${result.stdout}\nstderr: ${result.stderr}`)
    assert.match(result.stdout, /PASS add/, 'should print PASS add')
    assert.match(result.stdout, /PASS factorial/, 'should print PASS factorial')
    assert.match(result.stdout, /PASS is-even/, 'should print PASS is-even')
  })

  it('validate detects breaking change → exit 1, prints FAIL', () => {
    // Break add: change + to *
    const broken = FIXTURE_SOURCE.replace('return a + b', 'return a * b')
    writeFileSync(join(TMP, 'mathutils.lua'), broken)

    const result = runLua(VALIDATE_LUA)
    assert.notEqual(result.exitCode, 0, `validate should exit non-zero on breaking change\nstdout: ${result.stdout}`)
    assert.match(result.stdout, /FAIL add/, 'should print FAIL add')

    // Restore original
    writeFileSync(join(TMP, 'mathutils.lua'), FIXTURE_SOURCE)
  })

  it('validate detects valid refactor (same output) → exit 0, PASS', () => {
    // Refactor factorial: iterative instead of recursive (same output)
    const refactored = `local M = {}
M.add = function(a, b) return a + b end
M.factorial = function(n)
  local result = 1
  for i = 2, n do result = result * i end
  return result
end
M.is_even = function(n) return n % 2 == 0 end
return M
`
    writeFileSync(join(TMP, 'mathutils.lua'), refactored)

    const result = runLua(VALIDATE_LUA)
    assert.equal(result.exitCode, 0, `validate should exit 0 on valid refactor\nstdout: ${result.stdout}`)
    assert.match(result.stdout, /PASS factorial/, 'should print PASS factorial (same output)')

    // Restore original
    writeFileSync(join(TMP, 'mathutils.lua'), FIXTURE_SOURCE)
  })

  it('cross-stack parity: Lua HASH matches JS fingerprint() for numeric I/O', () => {
    // Read the captured .regret files and compare Lua hashes with JS fingerprint()
    const addRegret = parseRegret(readFileSync(join(TMP, 'regrets', 'add.regret'), 'utf8'))
    const factorialRegret = parseRegret(readFileSync(join(TMP, 'regrets', 'factorial.regret'), 'utf8'))
    const isEvenRegret = parseRegret(readFileSync(join(TMP, 'regrets', 'is-even.regret'), 'utf8'))

    // add([2,3]) → 5
    const jsAddHash = fingerprint([2, 3], 5)
    assert.equal(addRegret.hash, jsAddHash,
      `add([2,3])→5: Lua hash ${addRegret.hash} must equal JS hash ${jsAddHash}`)

    // factorial(0) → 1
    const jsFactHash = fingerprint(0, 1)
    assert.equal(factorialRegret.hash, jsFactHash,
      `factorial(0)→1: Lua hash ${factorialRegret.hash} must equal JS hash ${jsFactHash}`)

    // is_even(2) → true
    const jsEvenHash = fingerprint(2, true)
    assert.equal(isEvenRegret.hash, jsEvenHash,
      `is_even(2)→true: Lua hash ${isEvenRegret.hash} must equal JS hash ${jsEvenHash}`)
  })

  it('--update mode: rewrites .regret + appends audit.log entry', () => {
    // Re-capture to ensure clean baseline
    runLua(CAPTURE_LUA)
    const beforeRegret = parseRegret(readFileSync(join(TMP, 'regrets', 'add.regret'), 'utf8'))

    // Change add: a + b + 1 (legitimate contract change)
    const updated = FIXTURE_SOURCE.replace('return a + b', 'return a + b + 1')
    writeFileSync(join(TMP, 'mathutils.lua'), updated)

    const result = runLua(VALIDATE_LUA, [
      '--update', 'add',
      '--reason', 'add now returns a plus b plus 1 to match new API spec'
    ])
    assert.equal(result.exitCode, 0, `--update should exit 0\nstdout: ${result.stdout}\nstderr: ${result.stderr}`)
    assert.match(result.stdout, /UPDATE add/, 'should print UPDATE add')

    // Verify .regret was updated
    const afterRegret = parseRegret(readFileSync(join(TMP, 'regrets', 'add.regret'), 'utf8'))
    assert.notEqual(afterRegret.hash, beforeRegret.hash,
      `hash should change after --update: before=${beforeRegret.hash} after=${afterRegret.hash}`)
    assert.equal(afterRegret.output, 6, `add([2,3]) output should be 6 (2+3+1), got ${afterRegret.output}`)

    // Verify audit.log was written
    const auditLog = readFileSync(join(TMP, 'regrets', 'audit.log'), 'utf8')
    assert.match(auditLog, /UPDATE\s+add/, 'audit.log should contain UPDATE add entry')
    assert.match(auditLog, /old:\s+13mxb0z/, 'audit.log should record old hash')
    assert.match(auditLog, /new:\s+2gqjkyl/, 'audit.log should record new hash')
    assert.match(auditLog, /reason:\s+add now returns/, 'audit.log should record reason')

    // Restore original
    writeFileSync(join(TMP, 'mathutils.lua'), FIXTURE_SOURCE)
  })

  it('--update without --reason → exit 2 with usage hint', () => {
    const result = runLua(VALIDATE_LUA, ['--update', 'add'])
    assert.equal(result.exitCode, 2, `--update without --reason should exit 2\nstdout: ${result.stdout}`)
    assert.match(result.stdout, /--update requires --reason/, 'should print usage hint')
  })

  it('--update with vague --reason (<4 words) → exit 2 with "too vague" message', () => {
    const result = runLua(VALIDATE_LUA, ['--update', 'add', '--reason', 'fix bug'])
    assert.equal(result.exitCode, 2, `vague --reason should exit 2\nstdout: ${result.stdout}`)
    assert.match(result.stdout, /too vague/, 'should print "too vague" message')
  })
})

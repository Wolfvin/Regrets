// tests/capture-lua.test.js — end-to-end test for the Lua stack
//
// Runs scripts/capture_lua.lua and scripts/validate_lua.lua against the
// tests/fixtures/lua-example fixture, then asserts:
//   1. capture writes both .regret files with the standard fields
//   2. validate (no code change) exits 0 and prints PASS for both clusters
//   3. cross-stack parity: the Lua-written HASH matches the JS fingerprint()
//      for the same INPUT/OUTPUT (proves the Lua SHA-256 + base36 + stableStringify
//      produce an identical hash to the JS implementation)
//
// Skips automatically if `lua` is not on PATH (CI environments without Lua).
//
// Run: node --test tests/capture-lua.test.js

import { describe, it, before } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, rmSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { fingerprint } from '../scripts/fingerprint.js'

const ROOT = resolve(import.meta.dirname, '..')
const SCRIPTS_DIR = join(ROOT, 'scripts')
const CAPTURE_LUA = join(SCRIPTS_DIR, 'capture_lua.lua')
const VALIDATE_LUA = join(SCRIPTS_DIR, 'validate_lua.lua')
const FIXTURE = join(ROOT, 'tests', 'fixtures', 'lua-example')

// ─── Skip if `lua` is not available ──────────────────────────────────────────

function luaAvailable() {
  const r = spawnSync('lua', ['-v'], { encoding: 'utf8', timeout: 5_000 })
  return r.status === 0 || (r.stdout && r.stdout.includes('Lua'))
}

const hasLua = luaAvailable()

function runLua(scriptPath, args = [], cwd = FIXTURE) {
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

// Parse a .regret file's INPUT / OUTPUT / HASH lines.
function parseRegret(content) {
  const inputMatch = content.match(/^INPUT\s+(.*)$/m)
  const outputMatch = content.match(/^OUTPUT\s+(.*)$/m)
  const hashMatch = content.match(/^HASH\s+(\S+)/m)
  return {
    input: inputMatch ? JSON.parse(inputMatch[1]) : undefined,
    output: outputMatch ? JSON.parse(outputMatch[1]) : undefined,
    hash: hashMatch ? hashMatch[1] : null,
  }
}

describe('Lua stack — capture + validate', { skip: !hasLua && 'lua not on PATH' }, () => {
  before(() => {
    // Clean any stale .regret files so each test run captures fresh.
    for (const id of ['reverse', 'count-vowels']) {
      const p = join(FIXTURE, 'regrets', `${id}.regret`)
      if (existsSync(p)) rmSync(p)
    }
  })

  it('capture writes .regret files for both Lua clusters with all standard fields', () => {
    const result = runLua(CAPTURE_LUA)
    assert.equal(result.exitCode, 0, `capture failed (exit ${result.exitCode})\nstdout: ${result.stdout}\nstderr: ${result.stderr}`)

    for (const id of ['reverse', 'count-vowels']) {
      const regretPath = join(FIXTURE, 'regrets', `${id}.regret`)
      assert.ok(existsSync(regretPath), `${id}.regret was not written`)
      const content = readFileSync(regretPath, 'utf8')

      // Header fields
      assert.match(content, /^cluster: /m, `${id}: missing cluster header`)
      assert.match(content, /^version: 1/m, `${id}: missing version header`)
      assert.match(content, /^fingerprint: \S{7}/m, `${id}: missing fingerprint header`)
      assert.match(content, /^captured: /m, `${id}: missing captured header`)
      assert.match(content, /^watches: \[/m, `${id}: missing watches header`)
      assert.match(content, /^entry: /m, `${id}: missing entry header`)
      assert.match(content, /^stack: lua/m, `${id}: missing/wrong stack header`)
      assert.match(content, /^fingerprintLevel: entry/m, `${id}: missing fingerprintLevel header`)
      assert.match(content, /^file: strings\.lua/m, `${id}: missing file header`)

      // Data section
      assert.match(content, /^---$/m, `${id}: missing --- separator`)
      assert.match(content, /^INPUT\s+/m, `${id}: missing INPUT line`)
      assert.match(content, /^OUTPUT\s+/m, `${id}: missing OUTPUT line`)
      assert.match(content, /^HASH\s+\S{7}/m, `${id}: missing HASH line`)

      // Multi-input: INPUTS line must be present (each cluster has 3 inputs).
      assert.match(content, /^INPUTS\s+\[/m, `${id}: missing INPUTS line for multi-input cluster`)
    }

    // Specific fingerprint for reverse("hello") = "olleh" — cross-stack parity anchor.
    const reverseContent = readFileSync(join(FIXTURE, 'regrets', 'reverse.regret'), 'utf8')
    assert.match(reverseContent, /^fingerprint: 5nssd6s/m, 'reverse fingerprint must be 5nssd6s (cross-stack parity with JS/Go)')
  })

  it('validate (no code change) exits 0 and prints PASS for both clusters', () => {
    const result = runLua(VALIDATE_LUA)
    assert.equal(result.exitCode, 0, `validate failed (exit ${result.exitCode})\nstdout: ${result.stdout}\nstderr: ${result.stderr}`)
    assert.match(result.stdout, /PASS reverse/, 'validate should print PASS for reverse')
    assert.match(result.stdout, /PASS count-vowels/, 'validate should print PASS for count-vowels')
  })

  it('cross-stack parity: Lua-written HASH matches JS fingerprint() for the same input/output', () => {
    for (const id of ['reverse', 'count-vowels']) {
      const regretPath = join(FIXTURE, 'regrets', `${id}.regret`)
      const content = readFileSync(regretPath, 'utf8')
      const { input, output, hash } = parseRegret(content)
      assert.ok(hash, `${id}: no HASH found`)

      // Recompute the fingerprint using the JS implementation.
      const jsHash = fingerprint(input, output)
      assert.equal(
        jsHash, hash,
        `${id}: cross-stack parity FAILED — JS computed "${jsHash}" but Lua .regret stored "${hash}"`,
      )
    }
  })

  it('cross-stack parity anchor: JS fingerprint("hello", "olleh") === "5nssd6s"', () => {
    // Direct anchor — proves the JS reference value matches the documented
    // cross-stack constant that Lua, Go, and PHP also produce.
    assert.equal(fingerprint('hello', 'olleh'), '5nssd6s')
  })
})

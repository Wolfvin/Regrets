// tests/valid-stacks-registry.test.js
//
// Regression test for the gap where init.js, check.js, and api.js each
// maintained their own VALID_STACKS / validStacks list — and all three
// fell behind the actual set of supported stacks.
//
// This caused three observable bugs:
//   1. `node scripts/init.js --stack <missing>` errored with
//      "Unknown stack" even though capture_<stack>.sh existed.
//   2. `node scripts/check.js` reported "Unknown stack '<missing>'"
//      in the manifest structure validation phase, blocking CI.
//   3. `scripts/api.js#check()` (MCP path) did the same rejection.
//
// The fix: all three files now list every stack that has a capture_<stack>
// adapter in scripts/. This test pins the list so a future stack added
// without updating the registries will fail loudly here.
//
// Run: node --test tests/valid-stacks-registry.test.js

import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, writeFileSync, rmSync, readFileSync, existsSync } from 'node:fs'
import { resolve, join } from 'node:path'

const REPO_ROOT = resolve(import.meta.dirname, '..')
const SCRIPTS_DIR = join(REPO_ROOT, 'scripts')
const INIT_JS = join(SCRIPTS_DIR, 'init.js')
const CHECK_JS = join(SCRIPTS_DIR, 'check.js')
const API_JS = join(SCRIPTS_DIR, 'api.js')

// Stacks that must be in every VALID_STACKS list.
// Sourced from the actual capture_<stack>.* files present in scripts/.
const EXPECTED_STACKS = [
  'js', 'ts', 'python', 'react', 'vue', 'go', 'php', 'rust', 'ruby',
  'perl', 'lua', 'kotlin', 'scala', 'dart', 'java', 'c', 'cpp',
  'csharp', 'bash', 'awk', 'nim', 'zig', 'crystal', 'fsharp', 'css',
]

describe('VALID_STACKS registry — all stacks present in init.js / check.js / api.js', () => {
  it('init.js validStacks contains every expected stack', () => {
    const initSrc = readFileSync(INIT_JS, 'utf8')
    const m = initSrc.match(/const validStacks = \[([^\]]+)\]/)
    assert.ok(m, 'init.js should define a validStacks array literal')
    const declared = m[1].split(',').map(s => s.trim().replace(/['"]/g, '')).filter(Boolean)
    for (const stack of EXPECTED_STACKS) {
      assert.ok(declared.includes(stack),
        `init.js validStacks is missing '${stack}'. Declared: [${declared.join(', ')}]`)
    }
  })

  it('check.js VALID_STACKS contains every expected stack', () => {
    const checkSrc = readFileSync(CHECK_JS, 'utf8')
    const m = checkSrc.match(/const VALID_STACKS = \[([^\]]+)\]/)
    assert.ok(m, 'check.js should define a VALID_STACKS array literal')
    const declared = m[1].split(',').map(s => s.trim().replace(/['"]/g, '')).filter(Boolean)
    for (const stack of EXPECTED_STACKS) {
      assert.ok(declared.includes(stack),
        `check.js VALID_STACKS is missing '${stack}'. Declared: [${declared.join(', ')}]`)
    }
  })

  it('api.js VALID_STACKS contains every expected stack', () => {
    const apiSrc = readFileSync(API_JS, 'utf8')
    const m = apiSrc.match(/const VALID_STACKS = \[([^\]]+)\]/)
    assert.ok(m, 'api.js should define a VALID_STACKS array literal')
    const declared = m[1].split(',').map(s => s.trim().replace(/['"]/g, '')).filter(Boolean)
    for (const stack of EXPECTED_STACKS) {
      assert.ok(declared.includes(stack),
        `api.js VALID_STACKS is missing '${stack}'. Declared: [${declared.join(', ')}]`)
    }
  })
})

describe('VALID_STACKS registry — end-to-end behavior for previously-missing stacks', () => {
  const TMP = resolve(join(process.cwd(), 'tests', `__valid_stacks_${process.pid}__`))

  before(() => {
    mkdirSync(TMP, { recursive: true })
  })
  after(() => {
    if (existsSync(TMP)) rmSync(TMP, { recursive: true, force: true })
  })

  it('init.js --stack ruby succeeds (was "Unknown stack" before fix)', () => {
    const initTmp = join(TMP, 'init_ruby')
    mkdirSync(initTmp, { recursive: true })
    const result = spawnSync('node', [INIT_JS, '--stack', 'ruby'], {
      cwd: initTmp, encoding: 'utf8', timeout: 15_000,
    })
    assert.equal(result.status, 0,
      `init.js --stack ruby should exit 0. stderr: ${result.stderr}`)
    assert.ok(existsSync(join(initTmp, 'regrets', 'manifest.json')),
      'manifest.json should be created')
  })

  it('check.js accepts a manifest with stack: "ruby" (was "Unknown stack" before fix)', () => {
    const checkTmp = join(TMP, 'check_ruby')
    mkdirSync(join(checkTmp, 'regrets'), { recursive: true })
    writeFileSync(join(checkTmp, 'regrets', 'manifest.json'), JSON.stringify({
      clusters: [{
        id: 'slugify',
        entry: 'slugify',
        file: 'lib/slugify.rb',
        stack: 'ruby',
        fingerprintLevel: 'entry',
        inputs: ['hello'],
      }],
    }, null, 2))

    const result = spawnSync('node', [CHECK_JS], {
      cwd: checkTmp, encoding: 'utf8', timeout: 15_000,
    })
    assert.equal(result.status, 0,
      `check.js should exit 0 for a Ruby manifest. stdout: ${result.stdout}`)
    assert.ok(!/Unknown stack/i.test(result.stdout),
      'check.js should NOT report "Unknown stack" for ruby')
  })

  it('init.js --stack nim succeeds', () => {
    const initTmp = join(TMP, 'init_nim')
    mkdirSync(initTmp, { recursive: true })
    const result = spawnSync('node', [INIT_JS, '--stack', 'nim'], {
      cwd: initTmp, encoding: 'utf8', timeout: 15_000,
    })
    assert.equal(result.status, 0,
      `init.js --stack nim should exit 0. stderr: ${result.stderr}`)
  })

  it('init.js --stack zig succeeds', () => {
    const initTmp = join(TMP, 'init_zig')
    mkdirSync(initTmp, { recursive: true })
    const result = spawnSync('node', [INIT_JS, '--stack', 'zig'], {
      cwd: initTmp, encoding: 'utf8', timeout: 15_000,
    })
    assert.equal(result.status, 0,
      `init.js --stack zig should exit 0. stderr: ${result.stderr}`)
  })
})

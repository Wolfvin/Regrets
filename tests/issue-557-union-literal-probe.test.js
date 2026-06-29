// tests/issue-557-union-literal-probe.test.js
//
// Integration tests for issue #557: TypeScript string-literal-union
// parameter types should generate union-literal probe inputs instead of
// generic defaults.
//
// Without this fix, a function like:
//   function canUseOffline(mode: "company" | "personal_subscribed"): boolean
// gets generic probes ["", "test", 0, 1, {}, [], null] which never match
// any literal in the union, so union-gated logic branches are never exercised.
//
// Run: node --test tests/issue-557-union-literal-probe.test.js

import { describe, it, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import {
  mkdirSync, writeFileSync, rmSync,
  readFileSync,
} from 'node:fs'
import { resolve, join } from 'node:path'

const SCRIPTS_DIR = resolve(import.meta.dirname, '..', 'scripts')
const INSTALL_JS = join(SCRIPTS_DIR, 'install.js')

const TMP_BASE = resolve(join(process.cwd(), 'tests', '__issue_557__'))

function makeTmpDir(label) {
  const dir = join(TMP_BASE, label)
  rmSync(dir, { recursive: true, force: true })
  mkdirSync(dir, { recursive: true })
  return dir
}

function cleanupAll() {
  rmSync(TMP_BASE, { recursive: true, force: true })
}

function runInstall(args, cwd) {
  const result = spawnSync('node', [INSTALL_JS, ...args], {
    cwd,
    stdio: 'pipe',
    timeout: 60_000,
  })
  return {
    exitCode: result.status ?? (result.signal ? 1 : 0),
    stdout: result.stdout ? result.stdout.toString() : '',
    stderr: result.stderr ? result.stderr.toString() : '',
  }
}

// ─── #557 — Inline union-literal probe inputs ────────────────────────────────

describe('#557 — inline string-literal-union generates literal probe inputs', () => {
  after(() => cleanupAll())

  it('function with inline union type gets union values as probe inputs', () => {
    const dir = makeTmpDir('inline-union')
    mkdirSync(join(dir, 'src'), { recursive: true })
    mkdirSync(join(dir, 'dist'), { recursive: true })

    // TS source with inline union type
    writeFileSync(join(dir, 'src', 'mode.ts'), `
type Status = "active" | "inactive" | "pending";

export function checkStatus(status: Status): boolean {
  return status === "active" || status === "pending";
}
`)

    // Compiled JS
    writeFileSync(join(dir, 'dist', 'mode.js'), `
export function checkStatus(status) {
  return status === "active" || status === "pending";
}
`)

    writeFileSync(join(dir, 'package.json'), JSON.stringify({
      name: 'test-557-inline', type: 'module',
    }))

    const result = runInstall(['--scope', 'src/mode.ts', '--skip-capture'], dir)
    assert.equal(result.exitCode, 0,
      `install should exit 0. stderr: ${result.stderr}`)

    const manifest = JSON.parse(readFileSync(join(dir, 'regrets', 'manifest.json'), 'utf8'))
    const cluster = manifest.clusters.find(c => c.entry === 'checkStatus')
    assert.ok(cluster, 'checkStatus cluster should exist')

    // Probe inputs should be the union literal values, not generic defaults
    assert.ok(cluster.inputs.includes('active'),
      'inputs should include "active" from union')
    assert.ok(cluster.inputs.includes('inactive'),
      'inputs should include "inactive" from union')
    assert.ok(cluster.inputs.includes('pending'),
      'inputs should include "pending" from union')

    // Should NOT have generic string/number probes since generic probes
    // never match union literals (single-param function)
    assert.ok(!cluster.inputs.includes(''),
      'single-param union should not include empty string')
    assert.ok(!cluster.inputs.includes('test'),
      'single-param union should not include "test"')
    assert.ok(!cluster.inputs.includes(0),
      'single-param union should not include 0')
    assert.ok(!cluster.inputs.includes(1),
      'single-param union should not include 1')
  })
})

// ─── #557 — Type alias reference resolution ──────────────────────────────────

describe('#557 — type alias reference resolved to literal probe inputs', () => {
  after(() => cleanupAll())

  it('function with type alias parameter gets resolved union values', () => {
    const dir = makeTmpDir('type-alias')
    mkdirSync(join(dir, 'src'), { recursive: true })
    mkdirSync(join(dir, 'dist'), { recursive: true })

    // TS source with type alias
    writeFileSync(join(dir, 'src', 'access.ts'), `
type AccessMode = "company" | "personal_subscribed" | "personal_free" | "signed_out";

export function canUseOffline(mode: AccessMode): boolean {
  return mode === "company" || mode === "personal_subscribed";
}
`)

    // Compiled JS
    writeFileSync(join(dir, 'dist', 'access.js'), `
export function canUseOffline(mode) {
  return mode === "company" || mode === "personal_subscribed";
}
`)

    writeFileSync(join(dir, 'package.json'), JSON.stringify({
      name: 'test-557-alias', type: 'module',
    }))

    const result = runInstall(['--scope', 'src/access.ts', '--skip-capture'], dir)
    assert.equal(result.exitCode, 0,
      `install should exit 0. stderr: ${result.stderr}`)

    const manifest = JSON.parse(readFileSync(join(dir, 'regrets', 'manifest.json'), 'utf8'))
    const cluster = manifest.clusters.find(c => c.entry === 'canUseOffline')
    assert.ok(cluster, 'canUseOffline cluster should exist')

    // All four union values from the type alias should be probe inputs
    assert.ok(cluster.inputs.includes('company'),
      'inputs should include "company" from type alias')
    assert.ok(cluster.inputs.includes('personal_subscribed'),
      'inputs should include "personal_subscribed" from type alias')
    assert.ok(cluster.inputs.includes('personal_free'),
      'inputs should include "personal_free" from type alias')
    assert.ok(cluster.inputs.includes('signed_out'),
      'inputs should include "signed_out" from type alias')
  })
})

// ─── #557 — Arrow function with inline union ─────────────────────────────────

describe('#557 — arrow function with inline union gets literal probe inputs', () => {
  after(() => cleanupAll())

  it('exported const arrow function with union param gets union values', () => {
    const dir = makeTmpDir('arrow-union')
    mkdirSync(join(dir, 'src'), { recursive: true })
    mkdirSync(join(dir, 'dist'), { recursive: true })

    writeFileSync(join(dir, 'src', 'handler.ts'), `
export const handleMode = (m: "admin" | "user" | "guest"): string => {
  if (m === "admin") return "full";
  return "limited";
};
`)

    writeFileSync(join(dir, 'dist', 'handler.js'), `
export const handleMode = (m) => {
  if (m === "admin") return "full";
  return "limited";
};
`)

    writeFileSync(join(dir, 'package.json'), JSON.stringify({
      name: 'test-557-arrow', type: 'module',
    }))

    const result = runInstall(['--scope', 'src/handler.ts', '--skip-capture'], dir)
    assert.equal(result.exitCode, 0,
      `install should exit 0. stderr: ${result.stderr}`)

    const manifest = JSON.parse(readFileSync(join(dir, 'regrets', 'manifest.json'), 'utf8'))
    const cluster = manifest.clusters.find(c => c.entry === 'handleMode')
    assert.ok(cluster, 'handleMode cluster should exist')

    assert.ok(cluster.inputs.includes('admin'),
      'inputs should include "admin"')
    assert.ok(cluster.inputs.includes('user'),
      'inputs should include "user"')
    assert.ok(cluster.inputs.includes('guest'),
      'inputs should include "guest"')
  })
})

// ─── #557 — JS files still get generic probe inputs (no regression) ──────────

describe('#557 — JS files without type annotations get generic probes', () => {
  after(() => cleanupAll())

  it('plain JS function gets DEFAULT_PROBE_INPUTS', () => {
    const dir = makeTmpDir('js-generic')

    writeFileSync(join(dir, 'math.js'), `
export function add(a, b) { return a + b; }
`)

    writeFileSync(join(dir, 'package.json'), JSON.stringify({
      name: 'test-557-js', type: 'module',
    }))

    const result = runInstall(['--scope', 'math.js', '--skip-capture'], dir)
    assert.equal(result.exitCode, 0,
      `install should exit 0. stderr: ${result.stderr}`)

    const manifest = JSON.parse(readFileSync(join(dir, 'regrets', 'manifest.json'), 'utf8'))
    const cluster = manifest.clusters.find(c => c.entry === 'add')
    assert.ok(cluster, 'add cluster should exist')

    // JS function should still get generic probe inputs
    assert.ok(cluster.inputs.includes(''),
      'JS function should include empty string')
    assert.ok(cluster.inputs.includes('test'),
      'JS function should include "test"')
    assert.ok(cluster.inputs.includes(0),
      'JS function should include 0')
    assert.ok(cluster.inputs.includes(1),
      'JS function should include 1')
  })
})

// ─── #557 — TS function without union type gets generic probes ───────────────

describe('#557 — TS function without union type gets generic probes', () => {
  after(() => cleanupAll())

  it('TS function with generic string param gets DEFAULT_PROBE_INPUTS', () => {
    const dir = makeTmpDir('ts-generic')
    mkdirSync(join(dir, 'src'), { recursive: true })
    mkdirSync(join(dir, 'dist'), { recursive: true })

    writeFileSync(join(dir, 'src', 'util.ts'), `
export function greet(name: string): string {
  return "Hello, " + name;
}
`)

    writeFileSync(join(dir, 'dist', 'util.js'), `
export function greet(name) {
  return "Hello, " + name;
}
`)

    writeFileSync(join(dir, 'package.json'), JSON.stringify({
      name: 'test-557-ts-generic', type: 'module',
    }))

    const result = runInstall(['--scope', 'src/util.ts', '--skip-capture'], dir)
    assert.equal(result.exitCode, 0,
      `install should exit 0. stderr: ${result.stderr}`)

    const manifest = JSON.parse(readFileSync(join(dir, 'regrets', 'manifest.json'), 'utf8'))
    const cluster = manifest.clusters.find(c => c.entry === 'greet')
    assert.ok(cluster, 'greet cluster should exist')

    // Generic string param should still get DEFAULT_PROBE_INPUTS
    assert.ok(cluster.inputs.includes(''),
      'generic string param should include empty string')
    assert.ok(cluster.inputs.includes('test'),
      'generic string param should include "test"')
    assert.ok(cluster.inputs.includes(0),
      'generic string param should include 0')
  })
})

// ─── #557 — Number and boolean literal unions ────────────────────────────────

describe('#557 — number and boolean literal unions generate correct probe inputs', () => {
  after(() => cleanupAll())

  it('number literal union gets numeric probe inputs', () => {
    const dir = makeTmpDir('number-union')
    mkdirSync(join(dir, 'src'), { recursive: true })
    mkdirSync(join(dir, 'dist'), { recursive: true })

    writeFileSync(join(dir, 'src', 'levels.ts'), `
type Level = 1 | 2 | 3;

export function getPermission(lvl: Level): string {
  if (lvl === 3) return "admin";
  if (lvl === 2) return "editor";
  return "viewer";
}
`)

    writeFileSync(join(dir, 'dist', 'levels.js'), `
export function getPermission(lvl) {
  if (lvl === 3) return "admin";
  if (lvl === 2) return "editor";
  return "viewer";
}
`)

    writeFileSync(join(dir, 'package.json'), JSON.stringify({
      name: 'test-557-number', type: 'module',
    }))

    const result = runInstall(['--scope', 'src/levels.ts', '--skip-capture'], dir)
    assert.equal(result.exitCode, 0,
      `install should exit 0. stderr: ${result.stderr}`)

    const manifest = JSON.parse(readFileSync(join(dir, 'regrets', 'manifest.json'), 'utf8'))
    const cluster = manifest.clusters.find(c => c.entry === 'getPermission')
    assert.ok(cluster, 'getPermission cluster should exist')

    assert.ok(cluster.inputs.includes(1), 'inputs should include 1')
    assert.ok(cluster.inputs.includes(2), 'inputs should include 2')
    assert.ok(cluster.inputs.includes(3), 'inputs should include 3')
  })
})

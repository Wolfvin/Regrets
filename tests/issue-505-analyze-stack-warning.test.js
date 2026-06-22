// tests/issue-505-analyze-stack-warning.test.js — Closes #505
//
// `regret analyze` unconditionally dispatches to the Python-only analyze.py,
// even on a JS/TS/other-stack project, where it silently reports "No Python
// functions found" with no indication this is a scope limitation rather
// than a tool bug. Meanwhile `regret structure`'s own deprecation message
// told users to switch to `analyze` without qualification, even though
// `structure` is the one that actually works for non-Python stacks.
//
// This test spawns the real CLI to confirm:
//   1. `regret analyze` on a JS-only project prints an explicit
//      Python-only warning naming the detected (unsupported) stack.
//   2. `regret structure`'s deprecation message is qualified ("for Python
//      projects"), not a blanket "replaced by".
//
// Run: node --test tests/issue-505-analyze-stack-warning.test.js

import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { resolve, join } from 'node:path'

const SCRIPTS_DIR = resolve(import.meta.dirname, '..', 'scripts')
const REGRET_JS = join(SCRIPTS_DIR, 'regret.js')
const TMP = resolve(join(process.cwd(), 'tests', `__issue505_${process.pid}__`))

function run(args) {
  const result = spawnSync('node', [REGRET_JS, ...args], { cwd: TMP, encoding: 'utf8' })
  return (result.stdout ?? '') + (result.stderr ?? '')
}

before(() => {
  mkdirSync(join(TMP, 'regrets'), { recursive: true })
  writeFileSync(join(TMP, 'lib.mjs'), `export function greet(name) { return 'hi ' + name }\n`)
  writeFileSync(join(TMP, 'regrets', 'manifest.json'), JSON.stringify({
    clusters: [{
      id: 'greet', entry: 'greet', file: './lib.mjs', stack: 'js',
      fingerprintLevel: 'entry', inputs: ['world'], watches: [],
    }],
  }, null, 2))
})

after(() => {
  rmSync(TMP, { recursive: true, force: true })
})

describe('#505 analyze/structure stack-awareness messaging', () => {
  it('`regret analyze` on a JS-only project warns it is Python-only and names the unsupported stack', () => {
    const out = run(['analyze', '.'])
    assert.match(out, /Python-only today/i)
    assert.match(out, /\bjs\b/, 'must name the detected (unsupported) stack')
    assert.match(out, /regret structure/, 'must point the user at the working alternative')
  })

  it('`regret structure`\'s deprecation message is qualified, not a blanket "replaced by analyze"', () => {
    const out = run(['structure'])
    assert.match(out, /for Python projects/i, 'must qualify that analyze is the Python-only replacement')
  })
})

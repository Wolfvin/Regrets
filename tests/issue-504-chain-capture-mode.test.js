// tests/issue-504-chain-capture-mode.test.js — Closes #504
//
// `regret chain capture` was silently always running validate mode instead
// of capture mode, because scripts/regret.js forwarded the bare positional
// word "capture"/"validate" straight through to contest.mjs, which only
// recognizes the flag forms --capture/--validate. This meant a chain
// baseline could never be established through the documented `regret chain`
// CLI surface — every invocation fell through to validate mode and failed
// with "no golden file", which looks like normal first-run behavior rather
// than a broken dispatcher.
//
// This test spawns the real CLI end-to-end (not just the hash algorithm)
// to catch any regression in the regret.js -> contest.mjs argument wiring.

import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs'
import { resolve, join } from 'node:path'

const ROOT = resolve(import.meta.dirname, '..')
const TMP = resolve(join(process.cwd(), 'tests', `__issue504_${process.pid}__`))

function run(args) {
  try {
    const out = execFileSync('node', [join(ROOT, 'scripts', 'regret.js'), ...args], {
      cwd: TMP,
      encoding: 'utf8',
    })
    return { code: 0, out }
  } catch (err) {
    return { code: err.status ?? 1, out: (err.stdout ?? '') + (err.stderr ?? '') }
  }
}

before(() => {
  mkdirSync(join(TMP, 'regrets', 'chains'), { recursive: true })
  writeFileSync(join(TMP, 'lib.mjs'), `export function greet(name) { return 'hi ' + name }\n`)
  writeFileSync(join(TMP, 'regrets', 'manifest.json'), JSON.stringify({
    clusters: [{
      id: 'greet', entry: 'greet', file: './lib.mjs', stack: 'js',
      fingerprintLevel: 'entry', inputs: ['world'], watches: [],
    }],
  }, null, 2))
  writeFileSync(join(TMP, 'regrets', 'chains.json'), JSON.stringify({
    chains: [{ id: 'greet-flow', steps: [{ cluster: 'greet', input: 'world' }] }],
  }, null, 2))
})

after(() => {
  rmSync(TMP, { recursive: true, force: true })
})

describe('#504 regret chain capture/validate mode dispatch', () => {
  it('`regret chain capture` actually runs capture mode (not validate)', () => {
    const { code, out } = run(['chain', 'capture'])
    assert.equal(code, 0, `expected exit 0, got ${code}. Output:\n${out}`)
    assert.match(out, /CHAIN CAPTURE MODE/, 'must print capture-mode banner, not validate-mode')
    assert.doesNotMatch(out, /no golden file/i, 'capture must not report a missing-golden-file validate failure')
  })

  it('writes a golden chain file that a subsequent `regret chain validate` can match against', () => {
    assert.ok(
      existsSync(join(TMP, 'regrets', 'chains', 'greet-flow.chain')),
      'capture must write regrets/chains/<id>.chain'
    )
    const { code, out } = run(['chain', 'validate'])
    assert.equal(code, 0, `expected exit 0, got ${code}. Output:\n${out}`)
    assert.match(out, /CHAIN VALIDATE MODE/)
    assert.match(out, /✅ Match/, 'validate must match the just-captured baseline')
  })
})

// tests/issue-500-update-cluster-flag-form.test.js — Closes #500
//
// `regret update <id> --reason "..."` is translated by regret.js into TWO
// different shapes depending on stack, per the documented contract in
// regret.js's own comments:
//   - JS/TS/CSS:        --update --cluster <id> --reason "..."   (--update is BARE)
//   - Python/PHP/etc:   --update <id> --reason "..."             (--update HAS the id)
//
// validate.js's `updateTarget = getArg(args, '--update')` only correctly
// handles the second (Python-style) form. In the JS-style form, --update is
// a bare flag immediately followed by --cluster, so getArg() naively grabs
// the literal string "--cluster" as updateTarget. The existing test suite
// (tests/callee-update-and-missing.test.js) only ever exercised the
// Python-style form directly against validate.js, so this never surfaced.
//
// Two observable bugs from this:
//   1. The "Update mode — cluster: X" display line shows "--cluster"
//      instead of the real cluster id.
//   2. The guard that rejects direct `regret update <parent>.calls.<callee>`
//      (#284 Bug B) checks `updateTarget.includes('.calls.')` — which never
//      matches when updateTarget is always "--cluster", so the documented
//      rejection (exit 1 with a clear error) silently never fires for the
//      JS-style invocation form.
//
// Run: node --test tests/issue-500-update-cluster-flag-form.test.js

import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { resolve, join } from 'node:path'

const SCRIPTS_DIR = resolve(import.meta.dirname, '..', 'scripts')
const VALIDATE_JS = join(SCRIPTS_DIR, 'validate.js')
const CAPTURE_JS = join(SCRIPTS_DIR, 'capture.js')

const TMP = resolve(join(process.cwd(), 'tests', `__issue500_${process.pid}__`))

function runCli(cwd, args) {
  const result = spawnSync('node', [VALIDATE_JS, ...args], { cwd, encoding: 'utf8' })
  return { code: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' }
}

before(() => {
  mkdirSync(join(TMP, 'regrets'), { recursive: true })
  writeFileSync(join(TMP, 'api.mjs'), `
export function main(x) { return add(x) }
export function add(x) { return x + 1 }
`)
  writeFileSync(join(TMP, 'regrets', 'manifest.json'), JSON.stringify({
    clusters: [{
      id: 'main', entry: 'main', file: './api.mjs', stack: 'js',
      fingerprintLevel: 'entry', inputs: [5], watches: [], callees: ['add'],
    }],
  }, null, 2))
  spawnSync('node', [CAPTURE_JS], { cwd: TMP, encoding: 'utf8' })
})

after(() => {
  rmSync(TMP, { recursive: true, force: true })
})

describe('#500 validate.js --update --cluster <id> (JS-style form) argument parsing', () => {
  it('display shows the real cluster id, not the literal "--cluster" flag', () => {
    const { stdout } = runCli(TMP, ['--update', '--cluster', 'main', '--reason', 'testing display fix for issue 500'])
    assert.match(stdout, /cluster:\s*main\b/, 'must show the real cluster id')
    assert.doesNotMatch(stdout, /cluster:\s*--cluster/, 'must not show the literal flag name')
  })

  it('rejects direct callee update via the JS-style --cluster form (must not silently no-op)', () => {
    const result = runCli(TMP, ['--update', '--cluster', 'main.calls.add', '--reason', 'trying to bypass the callee guard'])
    assert.equal(result.code, 1, 'must exit 1, not silently succeed with 0 updated')
    const combined = result.stdout + result.stderr
    assert.match(combined, /Cannot update callee contract/i, 'must show the documented rejection error')
  })
})

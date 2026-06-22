// tests/issue-503-python-callee-wrapping.test.js — Closes #503
//
// scripts/capture.py and scripts/validate.py had ZERO callee-wrapping (Phase
// 2) support: a manifest cluster declaring "callees": [...] was silently
// ignored — no <parent>.calls.<callee>.regret files were written, and
// validate.py reported a clean PASS even though the declared callees had no
// contract at all. This closed exactly the blind spot callee-wrapping (a
// flagship, heavily-documented feature) exists to catch: a refactor to a
// callee's internal behavior that doesn't change the entry's final output
// for the captured inputs went completely undetected on the Python stack.
//
// This test requires `python3` (or `python`) on PATH — skips gracefully if
// neither is available (matches the project's existing Windows-CI pattern
// where some stack runtimes aren't installed locally).
//
// Run: node --test tests/issue-503-python-callee-wrapping.test.js

import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from 'node:fs'
import { resolve, join } from 'node:path'

const SCRIPTS_DIR = resolve(import.meta.dirname, '..', 'scripts')
const CAPTURE_PY = join(SCRIPTS_DIR, 'capture.py')
const VALIDATE_PY = join(SCRIPTS_DIR, 'validate.py')
const TMP = resolve(join(process.cwd(), 'tests', `__issue503_${process.pid}__`))

function findPython() {
  for (const bin of ['python3', 'python']) {
    const probe = spawnSync(bin, ['--version'], { encoding: 'utf8' })
    if (probe.status === 0) return bin
  }
  return null
}

const PYTHON = findPython()

function run(scriptPath, args) {
  const result = spawnSync(PYTHON, [scriptPath, ...args], {
    cwd: TMP,
    encoding: 'utf8',
    env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
  })
  return { code: result.status, out: (result.stdout ?? '') + (result.stderr ?? '') }
}

function writeInvoiceModule(roundDecimals) {
  writeFileSync(join(TMP, 'pkg', 'invoice.py'), `
def calc_total(price, qty, discount_pct):
    subtotal = price * qty
    return apply_discount(subtotal, discount_pct)

def apply_discount(amount, pct):
    return round_money(amount * (1 - pct / 100))

def round_money(n):
    return round(n, ${roundDecimals})
`)
}

before(() => {
  mkdirSync(join(TMP, 'pkg'), { recursive: true })
  mkdirSync(join(TMP, 'regrets'), { recursive: true })
  writeFileSync(join(TMP, 'pkg', '__init__.py'), '')
  writeInvoiceModule(2)
  writeFileSync(join(TMP, 'regrets', 'manifest.json'), JSON.stringify({
    clusters: [{
      id: 'calc-total', entry: 'calc_total',
      watches: ['calc_total', 'apply_discount', 'round_money'],
      callees: ['apply_discount', 'round_money'],
      module: 'pkg.invoice', pythonPath: '.', stack: 'python',
      fingerprintLevel: 'entry', multiArgs: true,
      inputs: [[100.567, 1, 0]],
    }],
  }, null, 2))
})

after(() => {
  rmSync(TMP, { recursive: true, force: true })
})

describe('#503 Python stack callee-wrapping (Phase 2)', { skip: !PYTHON && 'no python3/python on PATH' }, () => {
  it('capture.py writes a separate .regret contract per declared callee that was actually called', () => {
    const { code } = run(CAPTURE_PY, [])
    assert.equal(code, 0)
    assert.ok(existsSync(join(TMP, 'regrets', 'calc-total.regret')), 'parent contract must exist')
    assert.ok(existsSync(join(TMP, 'regrets', 'calc-total.calls.apply_discount.regret')), 'apply_discount callee contract must exist')
    assert.ok(existsSync(join(TMP, 'regrets', 'calc-total.calls.round_money.regret')), 'round_money callee contract must exist')
  })

  it('validate.py re-validates callee contracts and PASSes on unchanged code', () => {
    const { code, out } = run(VALIDATE_PY, [])
    assert.equal(code, 0, out)
    assert.match(out, /calc-total\.calls\.apply_discount\s+\S+\s+PASS \(callee\)/)
    assert.match(out, /calc-total\.calls\.round_money\s+\S+\s+PASS \(callee\)/)
  })

  it('validate.py FAILs the callee specifically when ONLY that callee\'s behavior changes (the core blind spot)', () => {
    writeInvoiceModule(1) // round_money: 2 decimals -> 1 decimal, a real behavior change
    const { code, out } = run(VALIDATE_PY, [])
    assert.equal(code, 1)
    assert.match(out, /calc-total\.calls\.round_money.*FAIL \(callee\)/)
    writeInvoiceModule(2) // restore
  })

  it('validate.py FAILs with a clear message when a declared callee contract file is missing (#288 parity)', () => {
    rmSync(join(TMP, 'regrets', 'calc-total.calls.round_money.regret'))
    const { code, out } = run(VALIDATE_PY, [])
    assert.equal(code, 1)
    assert.match(out, /MISSING callee contract/)
    assert.match(out, /parent declares callee "round_money"/)
    // Re-capture for subsequent tests
    run(CAPTURE_PY, ['--cluster', 'calc-total'])
  })

  it('validate.py rejects direct update of a callee contract (#284 Bug B parity)', () => {
    const { code, out } = run(VALIDATE_PY, ['--update', 'calc-total.calls.round_money', '--reason', 'trying to bypass the guard'])
    assert.equal(code, 1)
    assert.match(out, /Cannot update callee contract "calc-total\.calls\.round_money" directly/)
  })

  it('--skip-callees opts out of callee re-validation entirely', () => {
    rmSync(join(TMP, 'regrets', 'calc-total.calls.round_money.regret'))
    const { code, out } = run(VALIDATE_PY, ['--skip-callees'])
    assert.equal(code, 0, out)
    assert.doesNotMatch(out, /MISSING callee contract/)
    run(CAPTURE_PY, ['--cluster', 'calc-total']) // restore for cleanliness
  })
})

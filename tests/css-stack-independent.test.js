// tests/css-stack-independent.test.js — Independent verification of CSS stack
//
// Verifies capture_css.mjs + validate_css.mjs work on a DIFFERENT CSS codebase
// than the author's chosen proofs/css_demo/ example. Uses the
// proofs/css_independent/ fixture (form controls domain) — different selectors,
// different @media queries, different pseudo-classes than the cue animation
// example in css_demo/.
//
// This addresses CONTEXT.md's "Lesson Learned" about confirmation-bias in
// self-chosen fixtures: a single example can pass while hiding bugs that only
// surface on different inputs.
//
// Run: node --test tests/css-stack-independent.test.js

import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync, copyFileSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { createRequire } from 'node:module'
import { fingerprint as jsFingerprint } from '../scripts/fingerprint.js'

const require = createRequire(import.meta.url)

const SCRIPTS_DIR = resolve(import.meta.dirname, '..', 'scripts')
const CAPTURE_CSS = join(SCRIPTS_DIR, 'capture_css.mjs')
const VALIDATE_CSS = join(SCRIPTS_DIR, 'validate_css.mjs')
const CSS_INDEPENDENT = resolve(import.meta.dirname, '..', 'proofs', 'css_independent')

function postcssAvailable() {
  try {
    require.resolve('postcss')
    return true
  } catch {
    return false
  }
}

const hasPostcss = postcssAvailable()

function runCapture(manifestPath) {
  return execFileSync('node', [CAPTURE_CSS, '--manifest', manifestPath], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  })
}

function runValidate(manifestPath, extraArgs = []) {
  let err = null
  let out = ''
  try {
    out = execFileSync('node', [VALIDATE_CSS, '--manifest', manifestPath, ...extraArgs], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    })
  } catch (e) {
    err = e
    out = (e.stdout || '') + (e.stderr || '')
  }
  return { err, out }
}

function parseRegret(regretPath) {
  const content = readFileSync(regretPath, 'utf8')
  const lines = content.split('\n')
  const sepIdx = lines.findIndex(l => l.trim() === '---')
  const dataLines = lines.slice(sepIdx + 1)
  let input = null, output = null, hash = null
  for (const line of dataLines) {
    if (line.startsWith('INPUT ')) input = JSON.parse(line.substring(6))
    else if (line.startsWith('OUTPUT ')) output = JSON.parse(line.substring(7))
    else if (line.startsWith('HASH ')) hash = line.substring(5).trim()
  }
  return { content, input, output, hash }
}

describe('CSS stack — independent fixture (form controls domain)', () => {
  before(() => {
    if (!hasPostcss) return
    // Re-capture to ensure fresh .regret files exist for the independent fixture
    runCapture(join(CSS_INDEPENDENT, 'regrets', 'manifest.json'))
  })

  it('should skip when postcss is not available', { skip: hasPostcss }, () => {
    assert.ok(true, 'this test is a skip placeholder')
  })

  it('capture writes 4 .regret files for the form-controls fixture', { skip: !hasPostcss }, () => {
    const expectedClusters = ['form-input', 'form-submit', 'form-helper', 'button-element']
    for (const id of expectedClusters) {
      const regretPath = join(CSS_INDEPENDENT, 'regrets', `${id}.regret`)
      assert.ok(existsSync(regretPath), `.regret file missing for cluster "${id}"`)
      const { content } = parseRegret(regretPath)
      for (const field of ['cluster:', 'version:', 'fingerprint:', 'captured:', 'INPUT ', 'OUTPUT ', 'HASH ']) {
        assert.ok(content.includes(field),
          `.regret file for "${id}" missing required field "${field}"`)
      }
    }
  })

  it('cross-stack parity — CSS HASH === JS fingerprint() for all 4 clusters', { skip: !hasPostcss }, () => {
    const clusters = ['form-input', 'form-submit', 'form-helper', 'button-element']
    for (const id of clusters) {
      const regretPath = join(CSS_INDEPENDENT, 'regrets', `${id}.regret`)
      const { input, output, hash } = parseRegret(regretPath)
      const jsHash = jsFingerprint(input, output)
      assert.strictEqual(hash, jsHash,
        `Cross-stack parity broken for "${id}": CSS hash "${hash}" !== JS fingerprint() "${jsHash}".
         If this fails, capture_css.mjs / validate_css.mjs may have reverted to the 64-bit hash truncation.`)
    }
  })

  it('validate (no change) — 4/4 PASS, exit 0', { skip: !hasPostcss }, () => {
    const { err, out } = runValidate(join(CSS_INDEPENDENT, 'regrets', 'manifest.json'))
    assert.ok(!err, `Expected validate to exit 0. Got non-zero. Output:\n${out}`)
    assert.match(out, /4\/4 CSS clusters passed/, `Expected "4/4 CSS clusters passed". Got:\n${out}`)
    for (const id of ['form-input', 'form-submit', 'form-helper', 'button-element']) {
      assert.match(out, new RegExp(`${id}: PASS`), `Expected "${id}: PASS" in output. Got:\n${out}`)
    }
  })

  it('breaking change to form-submit bg color → FAIL on form-submit only', { skip: !hasPostcss }, () => {
    const cssPath = join(CSS_INDEPENDENT, 'form.css')
    const backupPath = join(CSS_INDEPENDENT, 'form.css.bak')
    copyFileSync(cssPath, backupPath)
    try {
      // Change --form-accent → #cc0000 in .form-submit
      const original = readFileSync(cssPath, 'utf8')
      writeFileSync(cssPath, original.replace(
        'background-color: var(--form-accent);',
        'background-color: #cc0000;'
      ))

      const { err, out } = runValidate(join(CSS_INDEPENDENT, 'regrets', 'manifest.json'))
      assert.ok(err, `Expected validate to exit non-zero for breaking change. Got exit 0. Output:\n${out}`)
      assert.match(out, /form-submit: FAIL/, `Expected "form-submit: FAIL". Got:\n${out}`)
      // The other 3 clusters should still PASS
      for (const id of ['form-input', 'form-helper', 'button-element']) {
        assert.match(out, new RegExp(`${id}: PASS`), `Expected "${id}: PASS" (unaffected by form-submit change). Got:\n${out}`)
      }
      assert.match(out, /3\/4 CSS clusters passed/, `Expected "3/4 CSS clusters passed". Got:\n${out}`)
    } finally {
      // Restore
      copyFileSync(backupPath, cssPath)
      const fs = require('fs')
      fs.unlinkSync(backupPath)
    }
  })

  it('comment-only change → 4/4 PASS (no declaration change)', { skip: !hasPostcss }, () => {
    const cssPath = join(CSS_INDEPENDENT, 'form.css')
    const backupPath = join(CSS_INDEPENDENT, 'form.css.bak')
    copyFileSync(cssPath, backupPath)
    try {
      const original = readFileSync(cssPath, 'utf8')
      writeFileSync(cssPath, '/* Independent verification comment */\n' + original)

      const { err, out } = runValidate(join(CSS_INDEPENDENT, 'regrets', 'manifest.json'))
      assert.ok(!err, `Expected validate to exit 0 for comment-only change. Got non-zero. Output:\n${out}`)
      assert.match(out, /4\/4 CSS clusters passed/, `Expected "4/4 CSS clusters passed" for comment-only change. Got:\n${out}`)
    } finally {
      copyFileSync(backupPath, cssPath)
      const fs = require('fs')
      fs.unlinkSync(backupPath)
    }
  })

  it('--cluster form-submit isolates a single cluster', { skip: !hasPostcss }, () => {
    const { err, out } = runValidate(
      join(CSS_INDEPENDENT, 'regrets', 'manifest.json'),
      ['--cluster', 'form-submit']
    )
    assert.ok(!err, `Expected validate --cluster form-submit to exit 0. Got non-zero. Output:\n${out}`)
    assert.match(out, /1\/1 CSS clusters passed/, `Expected "1/1 CSS clusters passed" with --cluster form-submit. Got:\n${out}`)
    assert.match(out, /form-submit: PASS/, `Expected "form-submit: PASS". Got:\n${out}`)
    // Should NOT contain other clusters
    assert.doesNotMatch(out, /form-input: PASS/, `Should not contain "form-input: PASS" with --cluster form-submit. Got:\n${out}`)
  })

  it('@media declarations ARE captured (font-size: 16px + transition: none)', { skip: !hasPostcss }, () => {
    const regretPath = join(CSS_INDEPENDENT, 'regrets', 'form-input.regret')
    const { content } = parseRegret(regretPath)
    // font-size: 16px comes from @media (max-width: 600px) .form-input
    assert.ok(content.includes('font-size: 16px'),
      `Expected "font-size: 16px" from @media (max-width: 600px) block in form-input .regret. Got:\n${content}`)
    // transition: none comes from @media (prefers-reduced-motion: reduce) .form-input
    assert.ok(content.includes('transition: none'),
      `Expected "transition: none" from @media (prefers-reduced-motion: reduce) block in form-input .regret. Got:\n${content}`)
    // Base declarations should also be there
    assert.ok(content.includes('font-size: 14px'),
      `Expected "font-size: 14px" (base) in form-input .regret. Got:\n${content}`)
  })

  it('element selector (button) captures correctly', { skip: !hasPostcss }, () => {
    const regretPath = join(CSS_INDEPENDENT, 'regrets', 'button-element.regret')
    const { input, output, hash } = parseRegret(regretPath)
    assert.deepStrictEqual(input, { selector: 'button' },
      `Expected input to be {selector: "button"}. Got: ${JSON.stringify(input)}`)
    assert.deepStrictEqual(output, ['font-family: inherit'],
      `Expected output to be ["font-family: inherit"]. Got: ${JSON.stringify(output)}`)
    // Cross-stack parity check (JS hash for the same input/output)
    const jsHash = jsFingerprint(input, output)
    assert.strictEqual(hash, jsHash,
      `button-element cross-stack parity broken: CSS "${hash}" !== JS "${jsHash}"`)
  })
})

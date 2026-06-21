// tests/capture-css-stack.test.js — Regression tests for PR #366 CSS stack
//
// Two main concerns locked in here:
//
//   1. Cross-stack parity — CSS .regret HASH values MUST match what JS
//      fingerprint.js would compute for the same (input, output) pair.
//      PR #366 originally used BigInt('0x' + hash.substring(0, 16)) (64-bit
//      truncation), which diverged from JS's BigInt('0x' + hash) (full
//      256-bit). The fix uses the full hash, matching the JS reference.
//
//   2. @media declarations ARE captured — the original references/css.md
//      docs claimed "@media query fingerprinting (currently ignored)", but
//      the actual implementation captures declarations inside @media blocks
//      (only the media condition itself is not part of the fingerprint).
//      Docs have been updated to match actual behavior.
//
// This test skips with exit 0 (not fail) when postcss is not available,
// so CI environments without `npm install` don't break.
//
// Run: node --test tests/capture-css-stack.test.js

import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { rmSync, existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { createRequire } from 'node:module'
import { fingerprint as jsFingerprint } from '../scripts/fingerprint.js'

const require = createRequire(import.meta.url)

const SCRIPTS_DIR = resolve(import.meta.dirname, '..', 'scripts')
const CAPTURE_CSS = join(SCRIPTS_DIR, 'capture_css.mjs')
const VALIDATE_CSS = join(SCRIPTS_DIR, 'validate_css.mjs')
const CSS_DEMO = resolve(import.meta.dirname, '..', 'proofs', 'css_demo')

function postcssAvailable() {
  try {
    require.resolve('postcss')
    return true
  } catch {
    return false
  }
}

const hasPostcss = postcssAvailable()
const TMP = resolve(join(process.cwd(), 'tests', '__css_stack_tmp__'))

function setupTmp() {
  rmSync(TMP, { recursive: true, force: true })
  mkdirSync(join(TMP, 'regrets'), { recursive: true })
  writeFileSync(join(TMP, 'test.css'), `/* Test CSS */
.foo {
  color: red;
  opacity: 1;
}
.foo:hover {
  color: blue;
}
@media (max-width: 600px) {
  .foo {
    color: green;
  }
}
`)
  writeFileSync(join(TMP, 'regrets', 'manifest.json'), JSON.stringify({
    clusters: [
      { id: 'foo', entry: '.foo', file: '../test.css', stack: 'css' },
    ],
  }, null, 2))
}

function cleanupTmp() {
  rmSync(TMP, { recursive: true, force: true })
}

describe('CSS stack — capture+validate contract (regression for PR #366)', () => {
  before(() => {
    if (!hasPostcss) return
    setupTmp()
  })

  after(() => {
    if (!hasPostcss) return
    cleanupTmp()
  })

  it('should skip when postcss is not available', { skip: hasPostcss }, () => {
    assert.ok(true, 'this test is a skip placeholder')
  })

  it('capture writes .regret file with all required fields', { skip: !hasPostcss }, () => {
    const out = execFileSync('node', [CAPTURE_CSS, '--manifest', join(TMP, 'regrets', 'manifest.json')], {
      encoding: 'utf8',
    })
    assert.match(out, /foo:.*declarations/, `Expected capture output to mention foo cluster. Got:\n${out}`)

    const regretPath = join(TMP, 'regrets', 'foo.regret')
    assert.ok(existsSync(regretPath), '.regret file should exist after capture')

    const content = readFileSync(regretPath, 'utf8')
    for (const field of ['cluster:', 'version:', 'fingerprint:', 'captured:', 'INPUT ', 'OUTPUT ', 'HASH ']) {
      assert.ok(content.includes(field), `.regret file missing required field "${field}"`)
    }
  })

  it('CSS HASH === JS fingerprint() for same input+output (regression for 64-bit bug)', { skip: !hasPostcss }, () => {
    const regretPath = join(TMP, 'regrets', 'foo.regret')
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

    const jsHash = jsFingerprint(input, output)
    assert.strictEqual(hash, jsHash,
      `CSS hash "${hash}" must equal JS fingerprint() "${jsHash}" for input=${JSON.stringify(input)} output=${JSON.stringify(output)}.
       If this fails, capture_css.mjs / validate_css.mjs may have reverted to the 64-bit BigInt('0x' + hash.substring(0, 16)) truncation.`
    )
  })

  it('validate (no change) exits 0 with PASS', { skip: !hasPostcss }, () => {
    const out = execFileSync('node', [VALIDATE_CSS, '--manifest', join(TMP, 'regrets', 'manifest.json')], {
      encoding: 'utf8',
    })
    assert.match(out, /foo: PASS/, `Expected "foo: PASS" in output. Got:\n${out}`)
    assert.match(out, /1\/1 CSS clusters passed/, `Expected "1/1 CSS clusters passed". Got:\n${out}`)
  })

  it('validate (breaking change) exits non-zero with FAIL', { skip: !hasPostcss }, () => {
    // Mutate: change color: red → color: orange
    writeFileSync(join(TMP, 'test.css'), `/* Test CSS */
.foo {
  color: orange;
  opacity: 1;
}
.foo:hover {
  color: blue;
}
@media (max-width: 600px) {
  .foo {
    color: green;
  }
}
`)
    let err = null
    let out = ''
    try {
      out = execFileSync('node', [VALIDATE_CSS, '--manifest', join(TMP, 'regrets', 'manifest.json')], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      })
    } catch (e) {
      err = e
      out = (e.stdout || '') + (e.stderr || '')
    }
    assert.ok(err, `Expected validate to exit non-zero for breaking change. Got exit 0, output:\n${out}`)
    assert.match(out, /foo: FAIL|FAIL.*foo/, `Expected FAIL for foo. Got:\n${out}`)
  })

  it('--cluster flag isolates a single cluster', { skip: !hasPostcss }, () => {
    // Restore the CSS first
    writeFileSync(join(TMP, 'test.css'), `/* Test CSS */
.foo {
  color: red;
  opacity: 1;
}
.foo:hover {
  color: blue;
}
@media (max-width: 600px) {
  .foo {
    color: green;
  }
}
`)
    const out = execFileSync('node', [VALIDATE_CSS, '--manifest', join(TMP, 'regrets', 'manifest.json'), '--cluster', 'foo'], {
      encoding: 'utf8',
    })
    assert.match(out, /1\/1 CSS clusters passed/, `Expected "1/1 CSS clusters passed" with --cluster foo. Got:\n${out}`)
  })

  it('@media declarations ARE captured (docs accuracy regression)', { skip: !hasPostcss }, () => {
    // Re-capture to ensure we have current state
    execFileSync('node', [CAPTURE_CSS, '--manifest', join(TMP, 'regrets', 'manifest.json')], {
      encoding: 'utf8',
      stdio: 'ignore',
    })
    const regretPath = join(TMP, 'regrets', 'foo.regret')
    const content = readFileSync(regretPath, 'utf8')

    // Should have BOTH "color: red" (non-media) AND "color: green" (@media)
    assert.ok(content.includes('color: red'),
      `Expected "color: red" in .regret OUTPUT. Got:\n${content}`)
    assert.ok(content.includes('color: green'),
      `Expected "color: green" (from @media block) in .regret OUTPUT. If missing, @media declarations are no longer captured. Got:\n${content}`)
  })

  it('bundled demo (proofs/css_demo) passes validate', { skip: !hasPostcss }, () => {
    // Re-capture demo .regret files (in case previous test run left stale state)
    execFileSync('node', [CAPTURE_CSS, '--manifest', join(CSS_DEMO, 'regrets', 'manifest.json')], {
      encoding: 'utf8',
      stdio: 'ignore',
    })
    const out = execFileSync('node', [VALIDATE_CSS, '--manifest', join(CSS_DEMO, 'regrets', 'manifest.json')], {
      encoding: 'utf8',
    })
    assert.match(out, /4\/4 CSS clusters passed/, `Expected "4/4 CSS clusters passed" for bundled demo. Got:\n${out}`)
  })
})

// tests/ruby-stack.test.js
//
// Tests for the Ruby stack adapter (PR #354, claim issue #339).
//
// Three test groups:
//   1. Static verification (no Ruby installed required):
//      - .regret file format compliance
//      - Cross-stack fingerprint parity (Ruby hash vs JS fingerprint)
//      - regret.js + regret.py dispatch wired for Ruby
//
//   2. End-to-end Ruby runtime (auto-skip when Ruby is not installed):
//      - capture → validate PASS for unchanged code
//      - validate FAIL for breaking refactor
//      - PASS for non-breaking refactor
//
// Run: node --test tests/ruby-stack.test.js

import { describe, it, before, after, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import {
  existsSync, readFileSync, readdirSync, mkdirSync, writeFileSync, rmSync, copyFileSync,
} from 'node:fs'
import { resolve, join } from 'node:path'

const REPO_ROOT = resolve(import.meta.dirname, '..')
const SCRIPTS_DIR = join(REPO_ROOT, 'scripts')
const REGRET_JS = join(SCRIPTS_DIR, 'regret.js')
const REGRET_PY = join(SCRIPTS_DIR, 'regret.py')

// Detect ruby availability once
const RUBY_AVAILABLE = (() => {
  const r = spawnSync('ruby', ['--version'], { encoding: 'utf8', timeout: 5_000 })
  return r.status === 0 && r.stdout.includes('ruby')
})()

// ─── Group 1: Static verification (no Ruby required) ─────────────────────────

describe('Ruby stack — static verification (no Ruby required)', () => {
  const PROOF_DIR = join(REPO_ROOT, 'proof', 'ruby_slugify')

  it('scripts/capture_ruby.rb, validate_ruby.rb, fingerprint_rb.rb all exist', () => {
    assert.ok(existsSync(join(SCRIPTS_DIR, 'capture_ruby.rb')),
      'scripts/capture_ruby.rb should exist')
    assert.ok(existsSync(join(SCRIPTS_DIR, 'validate_ruby.rb')),
      'scripts/validate_ruby.rb should exist')
    assert.ok(existsSync(join(SCRIPTS_DIR, 'fingerprint_rb.rb')),
      'scripts/fingerprint_rb.rb should exist')
  })

  it('proof/ruby_slugify/ fixture exists with manifest + .regret files + source', () => {
    assert.ok(existsSync(join(PROOF_DIR, 'manifest.json')), 'manifest.json should exist')
    assert.ok(existsSync(join(PROOF_DIR, 'lib', 'slugify.rb')), 'slugify.rb should exist')
    const regretsDir = join(PROOF_DIR, 'regrets')
    assert.ok(existsSync(regretsDir), 'regrets/ dir should exist')
    const regretFiles = readdirSync(regretsDir).filter(f => f.endsWith('.regret'))
    assert.ok(regretFiles.length >= 2,
      `expected at least 2 .regret files, found: ${regretFiles.join(', ')}`)
  })

  it('.regret files have the standard format (cluster/version/fingerprint/captured/INPUT/OUTPUT/HASH)', () => {
    const regretFiles = readdirSync(join(PROOF_DIR, 'regrets')).filter(f => f.endsWith('.regret'))
    for (const f of regretFiles) {
      const content = readFileSync(join(PROOF_DIR, 'regrets', f), 'utf8')
      assert.match(content, /^cluster: \S+$/m, `${f} must have cluster field`)
      assert.match(content, /^version: 1$/m, `${f} must have version field`)
      assert.match(content, /^fingerprint: [a-z0-9]{7}$/m, `${f} must have 7-char base36 fingerprint`)
      assert.match(content, /^captured: .+$/m, `${f} must have captured timestamp`)
      assert.match(content, /^stack: ruby$/m, `${f} must have stack: ruby`)
      assert.match(content, /^INPUT  /m, `${f} must have INPUT line`)
      assert.match(content, /^OUTPUT /m, `${f} must have OUTPUT line`)
      assert.match(content, /^HASH   [a-z0-9]{7}$/m, `${f} must have HASH line`)
    }
  })

  it('cross-stack fingerprint parity: Ruby HASH matches JS fingerprint(input, output)', async () => {
    const { fingerprint } = await import(join(SCRIPTS_DIR, 'fingerprint.js'))
    const regretsDir = join(PROOF_DIR, 'regrets')
    const regretFiles = readdirSync(regretsDir).filter(f => f.endsWith('.regret'))
    for (const f of regretFiles) {
      const content = readFileSync(join(regretsDir, f), 'utf8')
      const inputMatch = content.match(/^INPUT  (.+)$/m)
      const outputMatch = content.match(/^OUTPUT (.+)$/m)
      const hashMatch = content.match(/^HASH   (\S+)$/m)
      assert.ok(inputMatch && outputMatch && hashMatch, `${f} must have INPUT/OUTPUT/HASH`)
      const input = JSON.parse(inputMatch[1])
      const output = JSON.parse(outputMatch[1])
      const rubyHash = hashMatch[1]
      const jsFp = fingerprint(input, output)
      assert.equal(jsFp, rubyHash,
        `${f}: Ruby HASH ${rubyHash} must match JS fingerprint ${jsFp} for input=${JSON.stringify(input)} output=${JSON.stringify(output)}`)
    }
  })

  it('regret.js dispatches stack=ruby in capture/validate/update/drift/ci/guard', () => {
    const regretJs = readFileSync(REGRET_JS, 'utf8')
    // Look for ruby dispatch in capture
    assert.match(regretJs, /stack === 'ruby'/,
      'regret.js should check stack === "ruby"')
    assert.match(regretJs, /capture_ruby\.rb/,
      'regret.js should reference capture_ruby.rb')
    assert.match(regretJs, /validate_ruby\.rb/,
      'regret.js should reference validate_ruby.rb')
  })

  it('regret.py dispatches stack=ruby in capture/validate/update/drift/ci/guard', () => {
    const regretPy = readFileSync(REGRET_PY, 'utf8')
    assert.match(regretPy, /stack == 'ruby'/,
      'regret.py should check stack == "ruby"')
    assert.match(regretPy, /capture_ruby\.rb/,
      'regret.py should reference capture_ruby.rb')
    assert.match(regretPy, /validate_ruby\.rb/,
      'regret.py should reference validate_ruby.rb')
  })
})

// ─── Group 2: End-to-end Ruby runtime (skip if Ruby not installed) ──────────

describe('Ruby stack — end-to-end runtime', { skip: !RUBY_AVAILABLE }, () => {
  const TMP = resolve(join(process.cwd(), 'tests', `__ruby_stack_${process.pid}__`))

  const SLUGIFY_RB = `# frozen_string_literal: true
def slugify(text)
  s = text.to_s.downcase
  s = s.gsub(/[^a-z0-9]+/, '-')
  s = s.gsub(/\\A-+|-+\\z/, '')
  s
end

def slugify_batch(texts)
  texts.map { |t| slugify(t) }
end
`

  const SLUGIFY_BREAKING = `# frozen_string_literal: true
def slugify(text)
  s = text.to_s.downcase
  s = s.gsub(/[^a-z0-9]+/, '_')  # BREAKING: hyphen -> underscore
  s = s.gsub(/\\A-+|-+\\z/, '')
  s
end

def slugify_batch(texts)
  texts.map { |t| slugify(t) }
end
`

  const SLUGIFY_REFACTOR = `# frozen_string_literal: true
# Refactor: extracted constant inline, no behavior change
def slugify(text)
  result = text.to_s.downcase
  result = result.gsub(/[^a-z0-9]+/, '-')
  result = result.gsub(/^[-]+/, '')
  result = result.gsub(/[-]+$/, '')
  result
end

def slugify_batch(texts)
  texts.map { |t| slugify(t) }
end
`

  beforeEach(() => {
    rmSync(TMP, { recursive: true, force: true })
    mkdirSync(join(TMP, 'lib'), { recursive: true })
    mkdirSync(join(TMP, 'regrets'), { recursive: true })
    writeFileSync(join(TMP, 'lib', 'slugify.rb'), SLUGIFY_RB)
    writeFileSync(join(TMP, 'package.json'), JSON.stringify({
      name: 'ruby-stack-test', version: '1.0.0',
    }))
  })
  after(() => {
    rmSync(TMP, { recursive: true, force: true })
  })

  function writeManifest() {
    writeFileSync(join(TMP, 'regrets', 'manifest.json'), JSON.stringify({
      clusters: [
        {
          id: 'slugify',
          entry: 'slugify',
          watches: ['slugify'],
          file: 'lib/slugify.rb',
          stack: 'ruby',
          fingerprintLevel: 'entry',
          inputs: ['Hello, World!', 'foo bar', ''],
        },
      ],
    }, null, 2))
  }

  function runRuby(script, args = []) {
    const result = spawnSync('ruby', [script, ...args], {
      cwd: TMP, encoding: 'utf8', timeout: 30_000,
    })
    return {
      exitCode: result.status ?? 1,
      stdout: result.stdout ?? '',
      stderr: result.stderr ?? '',
    }
  }

  it('capture writes .regret file in standard format', () => {
    writeManifest()
    const r = runRuby(join(SCRIPTS_DIR, 'capture_ruby.rb'))
    assert.equal(r.exitCode, 0,
      `capture should exit 0. stderr: ${r.stderr}`)
    const regretPath = join(TMP, 'regrets', 'slugify.regret')
    assert.ok(existsSync(regretPath), 'slugify.regret should be written')
    const content = readFileSync(regretPath, 'utf8')
    assert.match(content, /^cluster: slugify$/m)
    assert.match(content, /^stack: ruby$/m)
    assert.match(content, /^HASH   [a-z0-9]{7}$/m)
  })

  it('validate PASSes for unchanged code', () => {
    writeManifest()
    runRuby(join(SCRIPTS_DIR, 'capture_ruby.rb'))
    const v = runRuby(join(SCRIPTS_DIR, 'validate_ruby.rb'))
    assert.equal(v.exitCode, 0,
      `validate should exit 0 for unchanged code. stdout: ${v.stdout}`)
    assert.match(v.stdout, /PASS/)
  })

  it('validate FAILs (non-zero exit) for breaking refactor', () => {
    writeManifest()
    runRuby(join(SCRIPTS_DIR, 'capture_ruby.rb'))
    // Apply breaking change
    writeFileSync(join(TMP, 'lib', 'slugify.rb'), SLUGIFY_BREAKING)
    const v = runRuby(join(SCRIPTS_DIR, 'validate_ruby.rb'))
    assert.notEqual(v.exitCode, 0,
      `validate must exit non-zero for breaking change. Got ${v.exitCode}. stdout: ${v.stdout}`)
    assert.match(v.stdout, /FAIL/i)
  })

  it('validate PASSes for non-breaking refactor', () => {
    writeManifest()
    runRuby(join(SCRIPTS_DIR, 'capture_ruby.rb'))
    // Apply non-breaking refactor (same output, different impl)
    writeFileSync(join(TMP, 'lib', 'slugify.rb'), SLUGIFY_REFACTOR)
    const v = runRuby(join(SCRIPTS_DIR, 'validate_ruby.rb'))
    assert.equal(v.exitCode, 0,
      `validate should exit 0 for non-breaking refactor. stdout: ${v.stdout}`)
    assert.match(v.stdout, /PASS/)
  })
})

// Always print a status note about Ruby availability so the test output
// makes it clear whether the end-to-end tests ran or were skipped.
describe('Ruby stack — environment note', () => {
  it(RUBY_AVAILABLE
    ? 'Ruby IS installed — end-to-end tests above ran'
    : 'Ruby NOT installed — end-to-end tests above were skipped (static tests above still ran)', () => {
    // This test always passes — it is just a status note.
    assert.ok(true)
  })
})

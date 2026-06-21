// tests/dart-stack.test.js — Cross-stack .regret format compatibility tests.
//
// These tests verify that .regret files produced by capture_dart.sh (the Dart
// stack capture script) are:
//   1. Parseable by scripts/validate.js parseRegret() (the JS validator).
//   2. Carry all required fields per the standard .regret format.
//   3. Contain a HASH that matches what JS fingerprint() would compute for
//      the same (input, output) pair — the cross-stack portability contract.
//
// These tests do NOT require the Dart SDK to be installed. They run against
// the committed sample .regret files in proof/dart_stack/example_output/.
//
// If capture_dart.sh ever produces .regret files that fail these tests, the
// cross-stack portability contract is broken — a .regret captured by Dart
// would no longer be validatable by JS (and vice versa).

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'fs'
import { resolve, join } from 'path'
import { fingerprint } from '../scripts/fingerprint.js'

// Dynamically import parseRegret from validate.js (it's not in the exports map).
// We use a direct import path.
const { parseRegret } = await import('../scripts/validate.js')

const EXAMPLE_DIR = resolve(process.cwd(), 'proof/dart_stack/example_output')

// All sample .regret files committed by PR #405.
const REGRET_FILES = readdirSync(EXAMPLE_DIR).filter(f => f.endsWith('.regret'))

describe('Dart stack — .regret format compatibility', () => {
  test('proof/dart_stack/example_output/ contains sample .regret files', () => {
    assert.ok(REGRET_FILES.length >= 7,
      `Expected at least 7 sample .regret files, got ${REGRET_FILES.length}`)
  })

  for (const file of REGRET_FILES) {
    describe(`.regret file: ${file}`, () => {
      const content = readFileSync(join(EXAMPLE_DIR, file), 'utf8')
      let parsed

      test('parseRegret() does not throw', () => {
        parsed = parseRegret(content)
        assert.ok(parsed, 'parseRegret returned null/undefined')
      })

      test('has all required meta fields', () => {
        assert.ok(parsed.cluster, 'missing cluster')
        assert.ok(parsed.version != null, 'missing version')
        assert.ok(parsed.fingerprint, 'missing fingerprint')
        assert.ok(parsed.captured, 'missing captured')
        assert.ok(parsed.entry, 'missing entry')
        assert.ok(parsed.stack === 'dart', `stack should be "dart", got ${parsed.stack}`)
        assert.ok(parsed.fingerprintLevel, 'missing fingerprintLevel')
      })

      test('has INPUT, OUTPUT, and HASH fields', () => {
        assert.ok(parsed.input !== undefined, 'missing input')
        assert.ok(parsed.output !== undefined, 'missing output')
        assert.ok(parsed.goldenHash, 'missing goldenHash')
      })

      test('JS fingerprint(input, output) matches stored HASH', () => {
        const jsHash = fingerprint(parsed.input, parsed.output)
        assert.equal(jsHash, parsed.goldenHash,
          `Cross-stack hash mismatch in ${file}:\n` +
          `  input:    ${JSON.stringify(parsed.input)}\n` +
          `  output:   ${JSON.stringify(parsed.output)}\n` +
          `  JS hash:  ${jsHash}\n` +
          `  Dart hash (stored): ${parsed.goldenHash}\n` +
          `  → If this fails, the Dart fingerprint implementation diverges from JS.`)
      })

      test('top-level fingerprint field matches HASH field', () => {
        assert.equal(parsed.fingerprint, parsed.goldenHash,
          `fingerprint (${parsed.fingerprint}) should equal HASH (${parsed.goldenHash})`)
      })
    })
  }
})

describe('Dart stack — fingerprint algorithm parity (synthetic cases)', () => {
  // These cases are the same ones verified by scripts/_dart_cross_stack_check.mjs.
  // Re-checking them here ensures the contract holds even if the mjs script is
  // not run as part of npm test.
  const CASES = [
    { input: 'HelloWorld',           output: 'hello_world', expected: '69495z4' },
    { input: ['kitten', 'sitting'],  output: 3,             expected: 'tu16lpe' },
    { input: 0,                      output: '0',           expected: '1r8v87w' },
    { input: 'user@example.com',     output: true,          expected: '1cb1iqg' },
  ]

  for (const { input, output, expected } of CASES) {
    test(`JS fingerprint(${JSON.stringify(input)} → ${JSON.stringify(output)}) === ${expected}`, () => {
      const jsHash = fingerprint(input, output)
      assert.equal(jsHash, expected,
        `JS hash ${jsHash} !== expected ${expected} — ` +
        `cross-stack contract broken (Dart produces ${expected} for the same input/output).`)
    })
  }
})

describe('Dart stack — scripts/capture_dart.sh + scripts/validate_dart.sh exist', () => {
  test('capture_dart.sh exists and is a bash script', () => {
    const p = resolve(process.cwd(), 'scripts/capture_dart.sh')
    const content = readFileSync(p, 'utf8')
    assert.match(content, /^#!/, 'missing shebang')
    assert.match(content, /capture_dart/, 'file should reference capture_dart')
  })

  test('validate_dart.sh exists and is a bash script', () => {
    const p = resolve(process.cwd(), 'scripts/validate_dart.sh')
    const content = readFileSync(p, 'utf8')
    assert.match(content, /^#!/, 'missing shebang')
    assert.match(content, /validate_dart/, 'file should reference validate_dart')
  })

  test('fingerprint_dart.dart exists and implements the standard algorithm', () => {
    const p = resolve(process.cwd(), 'scripts/fingerprint_dart.dart')
    const content = readFileSync(p, 'utf8')
    assert.match(content, /sha256/, 'should use sha256')
    assert.match(content, /stableStringify/, 'should implement stableStringify')
    assert.match(content, /base36|toRadixString\(36\)/, 'should use base36')
  })
})

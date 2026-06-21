import test from 'node:test'
import assert from 'node:assert/strict'
import { writeFileSync, mkdirSync, rmSync } from 'fs'
import { join } from 'path'
import { spawnSync } from 'child_process'

// Issue #278: Class callee warning suggests nonsensical arrow-function refactor
//
// When a cluster declares `callees: ["Thing"]` and `Thing` is a class
// (not a function), wrapCallees in scripts/ghost.js previously emitted a
// warning suggesting the user refactor the class into an arrow function —
// which is nonsensical because classes have `new` semantics, prototype
// chain, `instanceof`, etc.
//
// Fix: detect if `original` is a class via `original.toString().slice(0, 30)`
// matching `/^\s*class[\s{]/`. When a class is detected, emit a class-specific
// warning that suggests (1) wrapping instantiation in a factory function,
// (2) converting to CJS, or (3) removing the callee from the manifest.

const TMP = '/tmp/regrets-278-test'
const REPO_ROOT = join(import.meta.dirname, '..')

function setupFixture(fixture) {
  mkdirSync(join(TMP, 'regrets'), { recursive: true })
  writeFileSync(join(TMP, 'api.mjs'), fixture.api)
  writeFileSync(join(TMP, 'regrets', 'manifest.json'), JSON.stringify(fixture.manifest))
  writeFileSync(join(TMP, 'package.json'), JSON.stringify({ name: 'test-278', version: '0.0.0', type: 'module' }))
}

function captureOutput() {
  // Run capture.js and combine stdout + stderr (warnings go to stderr)
  const result = spawnSync('node', [join(REPO_ROOT, 'scripts', 'capture.js')], {
    cwd: TMP,
    encoding: 'utf8',
  })
  return (result.stdout || '') + (result.stderr || '')
}

test('#278 — class callee gets class-specific warning, not arrow-function suggestion', () => {
  rmSync(TMP, { recursive: true, force: true })
  setupFixture({
    api: `class Thing {
  constructor(x) { this.x = x }
  value() { return this.x }
}
function main(x) { return new Thing(x).value() }
export { main, Thing }
`,
    manifest: {
      clusters: [{
        id: 'main',
        entry: 'main',
        file: './api.mjs',
        stack: 'js',
        inputs: [5],
        watches: [],
        callees: ['Thing'],
      }],
    },
  })

  const output = captureOutput()

  // 1. Capture still succeeds (cluster captured despite callee skip)
  assert.match(output, /Fingerprint:/, 'capture succeeded — cluster captured')

  // 2. Class-specific warning IS emitted
  assert.match(
    output,
    /Callee "Thing" is a class — ESM class declarations cannot be intercepted for callee wrapping/,
    'class-specific warning emitted'
  )

  // 3. Class-specific suggestions ARE emitted (factory function pattern)
  assert.match(
    output,
    /Wrap the class instantiation in a factory function/,
    'class-specific factory function suggestion emitted'
  )

  // 4. The nonsensical arrow-function suggestion is NOT emitted for classes
  // Find the class-warning block and verify it doesn't contain the
  // generic "Refactor to a supported pattern" suggestion.
  const lines = output.split('\n')
  const classWarningStart = lines.findIndex(l => l.includes('is a class'))
  assert.notEqual(classWarningStart, -1, 'class warning found in output')

  // Take the next 12 lines after the class warning starts (the full block)
  const blockEnd = classWarningStart + 12
  const classWarningBlock = lines.slice(classWarningStart, blockEnd).join('\n')

  assert.doesNotMatch(
    classWarningBlock,
    /Refactor to a supported pattern/,
    'nonsensical generic refactor suggestion NOT emitted for class callees'
  )
  assert.doesNotMatch(
    classWarningBlock,
    /export const Thing = \(\) =>/,
    'nonsensical arrow-function suggestion NOT emitted for class callees'
  )
})

test('#278 — non-class callee still gets generic warning or succeeds (no regression)', () => {
  rmSync(TMP, { recursive: true, force: true })
  setupFixture({
    api: `function helper(a, b) { return a + b }
function main(x) { return helper(x, x) }
export { main, helper }
`,
    manifest: {
      clusters: [{
        id: 'main',
        entry: 'main',
        file: './api.mjs',
        stack: 'js',
        inputs: [5],
        watches: [],
        callees: ['helper'],
      }],
    },
  })

  const output = captureOutput()

  // Capture succeeds (callee is either wrapped successfully OR skipped with warning)
  assert.match(output, /Fingerprint:/, 'capture succeeded')

  // Non-class callee NEVER gets the class-specific warning
  assert.doesNotMatch(
    output,
    /Callee "helper" is a class/,
    'class-specific warning NOT emitted for non-class callee (no regression)'
  )

  // For non-class callees, two outcomes are valid (no regression):
  //   a. Callee wrapped successfully — capture writes callee contract file
  //   b. Callee couldn't be wrapped — generic warning emitted
  // The test only asserts that the class-specific path is NOT taken.
  const wrapped = output.includes('callee fingerprint') || output.includes('Callee "helper" was intercepted')
  const warned = /could not be installed on the holder|found but module is frozen/.test(output)
  assert.ok(
    wrapped || warned,
    'non-class callee either wrapped successfully or got generic warning (no class-specific warning)'
  )
})

test('#278 — class detection regex handles whitespace and anonymous classes', () => {
  // Direct unit test of the detection logic without full capture pipeline.
  // Validates the regex used in scripts/ghost.js:
  //   /^\s*class[\s{]/.test(original.toString().slice(0, 30))
  // against various class declaration styles.

  // Named class
  class NamedClass { constructor() {} }
  // Anonymous class expression assigned to const
  const AnonClass = class { constructor() {} }
  // Class with extends
  class Derived extends NamedClass { constructor() { super() } }
  // Regular function (should NOT match)
  function regularFn() { return 42 }
  // Arrow function (should NOT match)
  const arrowFn = () => 42

  const detectClass = (fn) => {
    if (!fn || typeof fn !== 'function') return false
    try {
      const srcPrefix = fn.toString().slice(0, 30)
      return /^\s*class[\s{]/.test(srcPrefix)
    } catch {
      return false
    }
  }

  assert.equal(detectClass(NamedClass), true, 'named class detected')
  assert.equal(detectClass(AnonClass), true, 'anonymous class expression detected')
  assert.equal(detectClass(Derived), true, 'derived class detected')
  assert.equal(detectClass(regularFn), false, 'regular function NOT detected as class')
  assert.equal(detectClass(arrowFn), false, 'arrow function NOT detected as class')
  assert.equal(detectClass(null), false, 'null handled')
  assert.equal(detectClass(undefined), false, 'undefined handled')
  assert.equal(detectClass({}), false, 'non-function object handled')
})

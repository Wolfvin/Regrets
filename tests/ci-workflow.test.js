// tests/ci-workflow.test.js — Tests for #251
// Verifies the regret-validate CI workflow exists and is well-formed.
//
// This test doesn't run the workflow (GitHub Actions does that). It just
// sanity-checks the YAML structure so a typo doesn't silently disable the
// PR check.
//
// Run: node --test tests/ci-workflow.test.js

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, existsSync } from 'node:fs'
import { resolve, join } from 'node:path'

const ROOT = resolve(import.meta.dirname, '..')
const WORKFLOW_PATH = join(ROOT, '.github', 'workflows', 'regret-validate.yml')

describe('#251 CI workflow — .github/workflows/regret-validate.yml', () => {
  it('the workflow file exists', () => {
    assert.ok(existsSync(WORKFLOW_PATH),
      `Expected workflow file at ${WORKFLOW_PATH}`)
  })

  it('the workflow file is valid YAML (parseable)', () => {
    const content = readFileSync(WORKFLOW_PATH, 'utf8')
    // We can't use a real YAML parser without adding a dependency, but we
    // can sanity-check that the file is non-empty and contains the expected
    // top-level key (allowing for leading comments).
    assert.ok(content.length > 0, 'workflow file must not be empty')
    assert.ok(/^name:\s/m.test(content),
      `workflow file should contain a top-level "name:" key — got: ${content.slice(0, 80)}`)
  })

  it('workflow name is "regret-validate"', () => {
    const content = readFileSync(WORKFLOW_PATH, 'utf8')
    assert.ok(content.includes('name: regret-validate'),
      'workflow name should be "regret-validate"')
  })

  it('workflow triggers on pull_request to main', () => {
    const content = readFileSync(WORKFLOW_PATH, 'utf8')
    assert.ok(content.includes('pull_request:'),
      'workflow should trigger on pull_request')
    assert.ok(/branches:\s*\[main\]/.test(content) || content.includes('- main'),
      'workflow should target main branch')
  })

  it('workflow triggers on push to main', () => {
    const content = readFileSync(WORKFLOW_PATH, 'utf8')
    assert.ok(content.includes('push:'),
      'workflow should trigger on push (so merges to main are also gated)')
  })

  it('workflow supports manual triggering (workflow_dispatch)', () => {
    const content = readFileSync(WORKFLOW_PATH, 'utf8')
    assert.ok(content.includes('workflow_dispatch:'),
      'workflow should support workflow_dispatch for manual debugging')
  })

  it('workflow has a regret-validate job', () => {
    const content = readFileSync(WORKFLOW_PATH, 'utf8')
    assert.ok(content.includes('regret-validate:'),
      'workflow should define a regret-validate job')
  })

  it('workflow checks out the repo and sets up Node.js', () => {
    const content = readFileSync(WORKFLOW_PATH, 'utf8')
    assert.ok(content.includes('actions/checkout@v4'),
      'workflow should use actions/checkout@v4')
    assert.ok(content.includes('actions/setup-node@v4'),
      'workflow should use actions/setup-node@v4')
  })

  it('workflow runs `regret validate --fail-fast` when a manifest exists', () => {
    const content = readFileSync(WORKFLOW_PATH, 'utf8')
    // The actual command should be `node scripts/regret.js validate --fail-fast`
    // (we invoke scripts/regret.js directly because the `regret` bin may not
    // be on PATH in CI before npm install runs).
    assert.ok(content.includes('regret.js validate --fail-fast'),
      'workflow should run regret validate --fail-fast')
    assert.ok(content.includes('--fail-fast'),
      'workflow should use --fail-fast so CI fails on the first RED cluster')
  })

  it('workflow gracefully skips when no manifest exists (no-op for repos without regrets/)', () => {
    const content = readFileSync(WORKFLOW_PATH, 'utf8')
    assert.ok(content.includes('regrets/manifest.json'),
      'workflow should check for regrets/manifest.json')
    // The skip is implemented via a conditional step (if: steps.check_manifest.outputs.has_manifest == 'true')
    assert.ok(content.includes('has_manifest'),
      'workflow should expose a has_manifest output for the conditional step')
  })

  it('workflow installs dependencies before running validate', () => {
    const content = readFileSync(WORKFLOW_PATH, 'utf8')
    assert.ok(/npm (install|ci)/.test(content),
      'workflow should install npm dependencies before running validate')
  })

  it('workflow is companion to ci.yml (does not replace the unit-test suite)', () => {
    // ci.yml runs `npm test` (unit tests). regret-validate.yml runs
    // `regret validate` (behavioral fingerprint checks). They are
    // intentionally separate so a failing regret validate shows up as its
    // own status check.
    const ciYmlPath = join(ROOT, '.github', 'workflows', 'ci.yml')
    assert.ok(existsSync(ciYmlPath),
      'ci.yml should still exist (regret-validate.yml is companion, not replacement)')
    const ciContent = readFileSync(ciYmlPath, 'utf8')
    assert.ok(ciContent.includes('npm test'),
      'ci.yml should still run `npm test` for the unit-test suite')
  })
})

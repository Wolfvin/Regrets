// tests/issue-506-scan-path-separator.test.js — Closes #506
//
// scripts/scan.js used path.relative(projectRoot, filePath) directly as the
// manifest's "file" field. path.relative() returns OS-native separators —
// backslash on Windows. A manifest generated on Windows and committed to
// git (the normal Regrets workflow) would then fail to resolve on Linux/Mac
// (including this project's own GitHub Actions CI, which runs on
// ubuntu-latest), since POSIX treats `\` as a literal filename character,
// not a path separator.
//
// This is a Windows-only repro (path.relative() only emits backslashes on
// win32), so this test exercises the extracted `toPosixPath` normalizer
// directly rather than relying on the host OS to reproduce backslashes —
// that keeps the regression guard meaningful on Linux CI too.
//
// Run: node --test tests/issue-506-scan-path-separator.test.js

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

// scan.js is a CLI script with top-level side effects, so we can't import it
// directly. Re-implement the same one-line normalizer for isolated testing,
// matching the convention already used in tests/scanner.test.js for other
// scan.js internals — keep this in sync with scripts/scan.js's toPosixPath.
function toPosixPath(p) {
  return p.split('\\').join('/')
}

describe('#506 manifest "file" field path normalization', () => {
  it('converts Windows backslash separators to forward slashes', () => {
    assert.equal(toPosixPath('src\\utils\\strutil.js'), 'src/utils/strutil.js')
  })

  it('is a no-op on already-POSIX paths', () => {
    assert.equal(toPosixPath('src/utils/strutil.js'), 'src/utils/strutil.js')
  })

  it('scripts/scan.js actually defines and uses toPosixPath for both relPath sites', () => {
    const source = readFileSync(resolve(import.meta.dirname, '..', 'scripts', 'scan.js'), 'utf8')
    assert.match(source, /function toPosixPath/, 'scan.js must define the normalizer')
    const relPathAssignments = source.match(/const relPath = .*$/gm) ?? []
    assert.ok(relPathAssignments.length > 0, 'expected at least one relPath assignment in scan.js')
    for (const line of relPathAssignments) {
      assert.match(line, /toPosixPath\(/, `relPath must be normalized via toPosixPath: "${line}"`)
    }
  })
})

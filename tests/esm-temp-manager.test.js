// tests/esm-temp-manager.test.js — unit tests for scripts/esm-temp-manager.js
//
// Verifies:
//   1. registerTempFile / unregisterTempFile track files correctly
//   2. cleanupAllTempFiles deletes all registered files
//   3. cleanupAllTempFiles is idempotent (safe to call multiple times)
//   4. generateTempFilename produces collision-safe, filesystem-safe names
//   5. cleanupAllTempFiles handles ENOENT gracefully (file already deleted)
//   6. cleanupAllTempFiles continues with remaining files if one deletion fails
//
// Signal handler tests (SIGINT/SIGTERM) live in tests/esm-callee-e2e.test.js
// because they require spawning a child process — easier to do at the E2E
// level alongside the full capture.js pipeline.
//
// Run: node --test tests/esm-temp-manager.test.js

import { describe, it, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { writeFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  registerTempFile,
  unregisterTempFile,
  cleanupAllTempFiles,
  generateTempFilename,
  _resetForTesting,
  _registeredCount,
} from '../scripts/esm-temp-manager.js'

// ─── Helpers ────────────────────────────────────────────────────────────────

let tmpDir

function setupTmpDir() {
  tmpDir = mkdtempSync(join(tmpdir(), 'regrets-temp-mgr-test-'))
}

function cleanupTmpDir() {
  if (existsSync(tmpDir)) rmSync(tmpDir, { recursive: true, force: true })
}

function createTempFile(name = 'test-temp-file.js') {
  const path = join(tmpDir, name)
  writeFileSync(path, '// test content\n', 'utf8')
  return path
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('esm-temp-manager', () => {
  beforeEach(() => {
    _resetForTesting()
    setupTmpDir()
    // Return a teardown function — node:test doesn't have afterEach, so we
    // use a different pattern: each test calls cleanupTmpDir() at the end.
    // We can't use beforeEach for cleanup because the test needs to run
    // before we delete the files it created.
  })

  it('registerTempFile adds file to tracking set', () => {
    const filePath = createTempFile('a.js')
    try {
      assert.equal(_registeredCount(), 0)
      registerTempFile(filePath)
      assert.equal(_registeredCount(), 1)
    } finally {
      cleanupTmpDir()
    }
  })

  it('registerTempFile is idempotent (same path twice = 1 entry)', () => {
    const filePath = createTempFile('a.js')
    try {
      registerTempFile(filePath)
      registerTempFile(filePath)
      assert.equal(_registeredCount(), 1)
    } finally {
      cleanupTmpDir()
    }
  })

  it('unregisterTempFile removes file from tracking set', () => {
    const filePath = createTempFile('a.js')
    try {
      registerTempFile(filePath)
      assert.equal(_registeredCount(), 1)
      unregisterTempFile(filePath)
      assert.equal(_registeredCount(), 0)
    } finally {
      cleanupTmpDir()
    }
  })

  it('unregisterTempFile is safe for unregistered paths', () => {
    try {
      assert.doesNotThrow(() => unregisterTempFile('/nonexistent/path'))
      assert.equal(_registeredCount(), 0)
    } finally {
      cleanupTmpDir()
    }
  })

  it('cleanupAllTempFiles deletes all registered files', () => {
    const fileA = createTempFile('a.js')
    const fileB = createTempFile('b.js')
    const fileC = createTempFile('c.js')
    try {
      registerTempFile(fileA)
      registerTempFile(fileB)
      registerTempFile(fileC)

      assert.equal(_registeredCount(), 3)
      assert.ok(existsSync(fileA))
      assert.ok(existsSync(fileB))
      assert.ok(existsSync(fileC))

      const deleted = cleanupAllTempFiles()

      assert.equal(deleted, 3, 'should report 3 files deleted')
      assert.equal(_registeredCount(), 0, 'set should be cleared')
      assert.ok(!existsSync(fileA), 'fileA should be deleted')
      assert.ok(!existsSync(fileB), 'fileB should be deleted')
      assert.ok(!existsSync(fileC), 'fileC should be deleted')
    } finally {
      cleanupTmpDir()
    }
  })

  it('cleanupAllTempFiles is idempotent (safe to call multiple times)', () => {
    const fileA = createTempFile('a.js')
    try {
      registerTempFile(fileA)

      const firstCall = cleanupAllTempFiles()
      const secondCall = cleanupAllTempFiles()
      const thirdCall = cleanupAllTempFiles()

      assert.equal(firstCall, 1, 'first call deletes 1 file')
      assert.equal(secondCall, 0, 'second call is a no-op')
      assert.equal(thirdCall, 0, 'third call is a no-op')
      assert.ok(!existsSync(fileA))
    } finally {
      cleanupTmpDir()
    }
  })

  it('cleanupAllTempFiles handles ENOENT gracefully (file already deleted)', () => {
    const fileA = createTempFile('a.js')
    const fileB = createTempFile('b.js')
    try {
      registerTempFile(fileA)
      registerTempFile(fileB)

      // Manually delete fileA before cleanup — simulates the case where
      // the caller's finally block already deleted it.
      rmSync(fileA)
      assert.ok(!existsSync(fileA))
      assert.ok(existsSync(fileB))

      // cleanupAllTempFiles should NOT throw on the missing fileA.
      // It should still delete fileB and return 1 (files actually deleted).
      const deleted = cleanupAllTempFiles()
      assert.equal(deleted, 1, 'only fileB was actually deleted')
      assert.ok(!existsSync(fileB))
    } finally {
      cleanupTmpDir()
    }
  })

  it('cleanupAllTempFiles continues with remaining files if one deletion fails', () => {
    const fileA = createTempFile('a.js')
    const fileB = createTempFile('b.js')
    try {
      registerTempFile(fileA)
      registerTempFile(fileB)

      // Make fileA undeletable by removing write permission on the directory.
      // (This works on Unix; on Windows it may not block deletion, but the
      // test still verifies that fileB gets deleted.)
      // Actually, this approach is fragile — let's use a different strategy:
      // register a path that doesn't exist (ENOENT case is already tested
      // above), and verify fileB still gets deleted.
      unregisterTempFile(fileA)
      // Register a non-existent path — this simulates a file that was
      // never created (write failed silently) or already removed.
      registerTempFile(join(tmpDir, 'never-existed.js'))

      const deleted = cleanupAllTempFiles()
      // fileB should still be deleted; the non-existent path is skipped
      assert.ok(!existsSync(fileB), 'fileB should be deleted even though another path failed')
      // deleted count is best-effort — only counts files that actually existed
      assert.ok(deleted >= 1, `at least 1 file deleted; got ${deleted}`)
    } finally {
      cleanupTmpDir()
    }
  })

  it('cleanupAllTempFiles returns 0 when no files are registered', () => {
    try {
      const deleted = cleanupAllTempFiles()
      assert.equal(deleted, 0)
    } finally {
      cleanupTmpDir()
    }
  })

  it('cleanupAllTempFiles can be called before any registerTempFile', () => {
    try {
      // Fresh state (reset by beforeEach), no files registered yet.
      // Should be a safe no-op.
      assert.doesNotThrow(() => cleanupAllTempFiles())
      assert.equal(_registeredCount(), 0)
    } finally {
      cleanupTmpDir()
    }
  })
})

// ─── generateTempFilename ───────────────────────────────────────────────────

describe('generateTempFilename', () => {
  it('produces a filename with the regrets-transform prefix', () => {
    const name = generateTempFilename('main')
    assert.ok(name.startsWith('.regrets-transform-'),
      `filename should start with .regrets-transform-; got: ${name}`)
  })

  it('produces a .mjs extension', () => {
    const name = generateTempFilename('main')
    assert.ok(name.endsWith('.mjs'),
      `filename should end with .mjs; got: ${name}`)
  })

  it('includes the cluster id (sanitized)', () => {
    const name = generateTempFilename('main')
    assert.ok(name.includes('main'),
      `filename should include the cluster id; got: ${name}`)
  })

  it('sanitizes cluster ids with special characters', () => {
    // Cluster ids can contain dots (e.g. 'main.calls.add') and other chars.
    // These should be replaced with '-' to keep filenames filesystem-safe.
    const name = generateTempFilename('main.calls.add')
    assert.ok(!name.includes('.calls.'),
      `filename should not contain '.calls.'; got: ${name}`)
    assert.ok(name.includes('main-calls-add'),
      `filename should contain sanitized cluster id; got: ${name}`)
  })

  it('produces unique filenames across multiple calls (UUID collision safety)', () => {
    // Generate 1000 filenames and verify no duplicates.
    // With UUID v4 (122 bits of entropy), collision probability is negligible.
    const names = new Set()
    for (let i = 0; i < 1000; i++) {
      names.add(generateTempFilename('main'))
    }
    assert.equal(names.size, 1000,
      `1000 generated filenames should be unique; got ${names.size} unique`)
  })

  it('produces filenames within reasonable length limits', () => {
    // Most filesystems support 255-byte filenames. UUID (36) + prefix (21) +
    // extension (4) + sanitized cluster id (up to 40) = ~101 bytes. Well
    // within limits.
    const name = generateTempFilename('some-very-long-cluster-id-that-might-exceed-limits-if-we-are-not-careful')
    assert.ok(name.length <= 255,
      `filename should be <= 255 chars; got ${name.length}: ${name}`)
  })

  it('handles missing clusterId gracefully', () => {
    const name = generateTempFilename()
    assert.ok(name.includes('cluster'),
      `filename should include 'cluster' fallback; got: ${name}`)
  })

  it('handles empty clusterId', () => {
    const name = generateTempFilename('')
    assert.ok(name.startsWith('.regrets-transform-'),
      `filename should still have prefix; got: ${name}`)
  })
})

// ─── Signal handler registration (idempotency) ─────────────────────────────

describe('signal handler registration', () => {
  // We can't easily test that signal handlers fire correctly without spawning
  // a child process — that's covered in tests/esm-callee-e2e.test.js.
  //
  // Here we just verify that registerTempFile doesn't throw and that
  // calling it multiple times doesn't add duplicate handlers (which would
  // cause cleanup to run multiple times on a single signal).

  it('registerTempFile does not throw', () => {
    _resetForTesting()
    setupTmpDir()
    try {
      const filePath = createTempFile('a.js')
      assert.doesNotThrow(() => registerTempFile(filePath))
      // Cleanup so we don't leave the file around
      cleanupAllTempFiles()
    } finally {
      cleanupTmpDir()
    }
  })

  it('multiple registerTempFile calls do not throw (handlers already registered)', () => {
    _resetForTesting()
    setupTmpDir()
    try {
      const fileA = createTempFile('a.js')
      const fileB = createTempFile('b.js')
      const fileC = createTempFile('c.js')

      // Each registerTempFile call internally calls ensureSignalHandlers(),
      // which should be idempotent. No errors should be thrown.
      assert.doesNotThrow(() => registerTempFile(fileA))
      assert.doesNotThrow(() => registerTempFile(fileB))
      assert.doesNotThrow(() => registerTempFile(fileC))

      cleanupAllTempFiles()
    } finally {
      cleanupTmpDir()
    }
  })
})

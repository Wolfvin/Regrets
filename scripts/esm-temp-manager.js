// esm-temp-manager.js — Process-level temp file lifecycle manager
//
// Background
// ─────────
// `capture.js` writes transformed ESM source to temp files in the SAME
// directory as the original source (so relative imports resolve unchanged).
// These temp files are normally deleted in a `finally` block. However, if
// the process crashes or receives SIGINT/SIGTERM between file creation
// and the `finally` block, the temp files leak.
//
// In CI environments with many concurrent `regret capture` runs, leaked
// temp files can accumulate and (in rare cases) cause race conditions if
// two processes happen to generate the same temp filename.
//
// Solution
// ────────
// This module tracks every temp file created during the process lifetime
// and registers cleanup handlers for SIGINT, SIGTERM, exit, and
// uncaughtException. The cleanup function is idempotent and best-effort —
// it swallows ENOENT errors (file already deleted) and continues with
// remaining files even if one deletion fails.
//
// Temp filenames include a UUID v4 (crypto.randomUUID) for collision
// safety across concurrent processes — no reliance on Date.now()+random()
// which has a small but non-zero collision probability.
//
// Why a separate module?
// ──────────────────────
// - Single responsibility: capture.js focuses on capture logic; this
//   module focuses on temp file hygiene.
// - Testable in isolation: unit tests can import this module and verify
//   cleanup behavior without running the full capture pipeline.
// - Idempotent signal registration: the module uses a module-level
//   `registered` boolean so signal handlers are only attached once per
//   process, even if `ensureSignalHandlers()` is called multiple times.
//
// CJS path is never touched — this module is only imported when the ESM
// transformation path is actually taken (capture.js imports it lazily
// inside the transform branch). CJS-only captures never load this code.

import { randomUUID } from 'crypto'
import { unlinkSync, existsSync } from 'fs'
import { join } from 'path'

// ─── Module state ──────────────────────────────────────────────────────────
//
// `tempFiles` is a Set of absolute paths registered since process start.
// Using a Set (not an array) so deletion is O(1) and duplicate registrations
// are deduped automatically.
//
// `cleaned` is a boolean flag set to true once cleanup runs. Subsequent
// calls to `cleanupAllTempFiles()` short-circuit — this is what makes the
// function idempotent. Signal handlers and the `process.on('exit')` hook
// can both fire (e.g. SIGINT → cleanup → process.exit → exit event →
// cleanup again) without trying to delete files twice.

const tempFiles = new Set()
let cleaned = false

// ─── Signal handler registration (idempotent) ──────────────────────────────
//
// `ensureSignalHandlers()` is safe to call multiple times — the
// `handlersRegistered` boolean guarantees we only attach listeners once.
//
// Signal handlers MUST be fast and synchronous — Node's signal handling
// does not support async handlers in the typical case, and `process.on('exit')`
// ONLY runs synchronous code. Our cleanup is fully synchronous (unlinkSync),
// so this constraint is satisfied.

let handlersRegistered = false

function ensureSignalHandlers() {
  if (handlersRegistered) return
  handlersRegistered = true

  // SIGINT (Ctrl+C) and SIGTERM (kill default) — graceful shutdown.
  // We run cleanup synchronously, then re-emit the default behavior by
  // exiting with code 130 (SIGINT) or 143 (SIGTERM) which matches
  // shell convention. This mirrors what Node would do without our handler.
  //
  // Important: we do NOT call process.exit() inside the 'exit' event
  // handler below — that would be a no-op (Node is already exiting) and
  // would interfere with the synchronous-only exit-handler contract.
  const signalHandler = (signal) => {
    cleanupAllTempFiles()
    // Re-raise as a non-zero exit so CI systems detect the interruption.
    // 128 + signal number is the Unix convention:
    //   SIGINT = 2  → exit 130
    //   SIGTERM = 15 → exit 143
    const exitCode = 128 + (signal === 'SIGINT' ? 2 : 15)
    process.exit(exitCode)
  }

  process.on('SIGINT', () => signalHandler('SIGINT'))
  process.on('SIGTERM', () => signalHandler('SIGTERM'))

  // 'exit' fires on normal termination AND on process.exit(). It ONLY
  // runs synchronous code. This is our last-resort cleanup for the case
  // where capture.js throws an uncaught exception that triggers process
  // exit without hitting a finally block.
  //
  // (Yes, finally blocks normally run on throw — but if the throw happens
  //  in a top-level await or in a Promise rejection that nobody catches,
  //  Node terminates without running finally. The 'exit' handler catches
  //  that case.)
  process.on('exit', () => {
    cleanupAllTempFiles()
  })

  // uncaughtException — last-ditch cleanup before Node terminates.
  // We run cleanup, then re-throw so Node's default behavior (print stack,
  // exit 1) is preserved. Without re-throwing, the error would be silently
  // swallowed and the process would continue — that's worse than a crash.
  //
  // Note: 'unhandledRejection' is intentionally NOT hooked. Per Node docs,
  // unhandled rejections don't necessarily crash the process (they emit a
  // warning in Node 14, become errors in Node 15+). Hooking them for
  // cleanup would be premature — the process may continue running and
  // produce more temp files. The 'exit' handler will clean up when the
  // process actually terminates.
  process.on('uncaughtException', (err) => {
    cleanupAllTempFiles()
    // Re-throw to preserve default crash behavior. We do this on the next
    // tick so the current call stack unwinds cleanly — throwing synchronously
    // inside the handler can cause recursive uncaughtException in rare cases.
    setImmediate(() => { throw err })
  })
}

// ─── Public API ────────────────────────────────────────────────────────────

/**
 * Register a temp file for process-level cleanup.
 *
 * Call this immediately after creating the file. The file will be deleted:
 *   - By the caller's normal `finally` block (preferred), OR
 *   - By cleanupAllTempFiles() if the caller's finally never runs (crash,
 *     SIGINT, SIGTERM, uncaughtException).
 *
 * Calling this also (idempotently) registers the process-level signal/exit
 * handlers. This is a no-op if handlers are already registered.
 *
 * @param {string} absolutePath - Absolute path to the temp file
 */
export function registerTempFile(absolutePath) {
  // Ensure handlers are attached before the first file is registered —
  // otherwise a crash before the first registerTempFile call would leak.
  ensureSignalHandlers()
  tempFiles.add(absolutePath)
}

/**
 * Unregister a temp file (call after successful normal cleanup).
 *
 * This is the counterpart to `registerTempFile`. After the caller's
 * `finally` block successfully deletes the temp file, call this so that
 * the exit-time cleanup doesn't try to delete it again (and so the Set
 * doesn't grow unboundedly for long-running processes).
 *
 * Safe to call with a path that was never registered — it's a no-op.
 *
 * @param {string} absolutePath - Absolute path to the temp file
 */
export function unregisterTempFile(absolutePath) {
  tempFiles.delete(absolutePath)
}

/**
 * Delete all registered temp files. Idempotent — safe to call multiple times.
 *
 * Behavior:
 *   - First call: iterates the Set, deletes each file (best-effort),
 *     clears the Set, sets `cleaned = true`.
 *   - Subsequent calls: no-op (returns 0).
 *
 * Errors are swallowed per-file (ENOENT is expected if the caller's finally
 * already deleted the file; other errors are logged to stderr but don't
 * abort cleanup of remaining files).
 *
 * After this runs, `registerTempFile` still works — new files registered
 * post-cleanup will NOT be cleaned up (this is a known limitation; in
 * practice, cleanup runs at process exit so no new files are registered
 * after it).
 *
 * @returns {number} Number of files actually deleted (best-effort count)
 */
export function cleanupAllTempFiles() {
  if (cleaned) return 0
  cleaned = true

  let deleted = 0
  for (const path of tempFiles) {
    try {
      if (existsSync(path)) {
        unlinkSync(path)
        deleted++
      }
    } catch (e) {
      // ENOENT: file was already deleted by the caller's finally — fine.
      // Other errors: log to stderr but continue with remaining files.
      // We deliberately don't throw — cleanup must be best-effort.
      if (e.code !== 'ENOENT') {
        try {
          console.error(`[esm-temp-manager] Failed to delete temp file ${path}: ${e.message}`)
        } catch {
          // Even console.error can fail in edge cases (stdout closed).
          // Swallow to ensure we keep cleaning up other files.
        }
      }
    }
  }
  tempFiles.clear()
  return deleted
}

/**
 * Generate a collision-safe temp filename for an ESM transform.
 *
 * Format: `.regrets-transform-<uuid>.mjs`
 *
 * The UUID v4 (from crypto.randomUUID) provides 122 bits of entropy —
 * collision probability across concurrent processes is negligible
 * (~10^-37 even with 1 million concurrent files generated per second).
 *
 * The leading `.` makes the file hidden on Unix (so `ls` doesn't show it
 * during normal directory listing — only `ls -a` does).
 *
 * The `.mjs` extension ensures Node treats it as ESM regardless of the
 * nearest package.json `type` field. This matters because the original
 * source could be `.js` with `"type": "module"` in package.json, but the
 * temp file is in the same directory so the same package.json applies —
 * using `.mjs` makes the ESM-ness explicit and avoids any ambiguity.
 *
 * @param {string} [clusterId] - Optional cluster id for debuggability
 *   (included in the filename when verbose logging is on, so users can
 *   identify which cluster a leaked temp file came from)
 * @returns {string} Filename (NOT full path — caller joins with directory)
 */
export function generateTempFilename(clusterId) {
  const uuid = randomUUID()
  // Sanitize clusterId: replace non-alphanumeric with '-' to keep filename
  // filesystem-safe across all platforms (Windows is the most restrictive).
  const safeId = clusterId
    ? clusterId.replace(/[^a-zA-Z0-9]/g, '-').slice(0, 40)
    : 'cluster'
  return `.regrets-transform-${safeId}-${uuid}.mjs`
}

/**
 * Test-only helper: reset module state between unit tests.
 *
 * This is NOT intended for production use. It exists so tests can verify
 * idempotency by calling cleanup twice and checking that the second call
 * is a no-op, then reset and test again.
 *
 * @visibleForTesting
 */
export function _resetForTesting() {
  tempFiles.clear()
  cleaned = false
  // NOTE: we intentionally do NOT reset `handlersRegistered` — once signal
  // handlers are attached, re-attaching them would cause duplicate handlers
  // to fire. Tests that need a fresh process should use child_process.
}

/**
 * Test-only helper: get the current count of registered temp files.
 *
 * @visibleForTesting
 * @returns {number}
 */
export function _registeredCount() {
  return tempFiles.size
}

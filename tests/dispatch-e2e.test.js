// tests/dispatch-e2e.test.js — End-to-end dispatch test for regret.js (issue #550)
//
// Regression test for the silent-no-op bug fixed in PR #537.
//
// Background:
//   PR #537 fixed a critical bug where 5 stacks (crystal, dart, fsharp,
//   kotlin, zig) had NO dispatch case in scripts/regret.js. The if-else
//   chain had no `else` clause, so when a stack didn't match -> exit 0
//   doing nothing. Users got silent success with no work done.
//
//   Existing tests called validate_<stack>.sh directly, bypassing
//   regret.js dispatch, so this bug class was invisible to CI. Red team
//   audit R-2 (Major #4) flagged the gap; boss filed issue #550.
//
// This test exercises the regret.js dispatch layer end-to-end for all 6
// stacks addressed by PR #537 (rust + the 5 silent-no-op stacks):
//
// Test groups:
//   1. Static source verification (always runs, no runtime needed):
//      For each stack, assert scripts/regret.js source contains a dispatch
//      case referencing capture_<stack>.sh AND validate_<stack>.sh. This
//      catches the literal "dispatch case removed" regression.
//
//   2. Dispatch invocation (always runs, no runtime needed):
//      For each stack, build a temp fixture with a manifest containing one
//      cluster of that stack. Run `node scripts/regret.js capture|validate`
//      from that fixture. Assert that regret.js actually invoked the
//      capture/validate script (stdout contains the script name). regret.js's
//      run() helper prints "$ bash <SCRIPTS_DIR>/<script>.sh" to stdout
//      BEFORE spawning the child, so the script name in stdout is definitive
//      proof that the dispatch case fired. The child may exit non-zero due
//      to a missing runtime -- that's fine; we only care that dispatch
//      happened, not that capture succeeded. This catches regressions where
//      the dispatch case is present in source BUT broken (e.g., typo in the
//      stack-name check, wrong script path) -- which the static check
//      alone would miss.
//
//   3. Full E2E (skips per-stack if runtime missing):
//      For each stack, run capture + validate against the existing proof
//      project fixture. Assert exit 0, at least one .regret file freshly
//      modified, and "PASS" in validate stdout. This is the happy-path
//      test that runs on CI where runtimes are installed.
//      NOTE: dart's proof project (proof/dart_stack/) has its manifest.json
//      at the ROOT rather than in regrets/, and its file: paths are
//      repo-root-relative. So for dart we build a temp working copy of the
//      proof project (copy source + write regrets/manifest.json with
//      adjusted file: path) instead of cd-ing into the proof dir directly.
//      This is test scaffolding, not a new proof project.
//
//   4. Negative test (always runs, no runtime needed):
//      Build a fixture with a stack name that regret.js has NO dispatch
//      case for (e.g., "__nonexistent_550__"). Run regret.js capture.
//      Assert SILENT NO-OP: exit 0 AND stdout does NOT contain any
//      "capture_" script invocation. This reproduces the exact PR #537
//      bug behavior and proves that the Group 2 assertion
//      (stdout.includes('capture_<stack>.sh')) would FAIL if a dispatch
//      case were removed -- i.e., the test genuinely catches the
//      regression. This avoids modifying scripts/regret.js (per the
//      task constraint) by using an unsupported stack name as the
//      control instead of surgically editing the dispatch chain.
//
// Run: node --test tests/dispatch-e2e.test.js

import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import {
  existsSync, readFileSync, readdirSync, mkdirSync, writeFileSync, rmSync,
  mkdtempSync, copyFileSync, statSync,
} from 'node:fs'
import { resolve, join } from 'node:path'
import { tmpdir } from 'node:os'

const REPO_ROOT = resolve(import.meta.dirname, '..')
const SCRIPTS_DIR = join(REPO_ROOT, 'scripts')
const REGRET_JS = join(SCRIPTS_DIR, 'regret.js')

// ─── Stack fixtures ──────────────────────────────────────────────────────────
// Each entry maps a stack to:
//   - runtimeBin: the CLI binary used to detect if the runtime is installed
//   - proofDir: existing proof project containing source + manifest
//   - manifestPath: absolute path to the manifest (regrets/manifest.json,
//                   except dart which has manifest.json at the proof-dir root)
//   - sourceFile: absolute path to the source file referenced by the manifest
//   - sourceRelPath: the source path AS IT APPEARS in the manifest's file:
//                    field (used to rewrite it for the dart temp working copy)
//   - captureScript / validateScript: script filenames regret.js should
//                                     dispatch to

const STACKS = [
  {
    name: 'rust',
    runtimeBin: 'rustc',
    proofDir: join(REPO_ROOT, 'proof', 'rust_verify'),
    manifestPath: join(REPO_ROOT, 'proof', 'rust_verify', 'regrets', 'manifest.json'),
    sourceFile: join(REPO_ROOT, 'proof', 'rust_verify', 'src', 'lib.rs'),
    sourceRelPath: 'src/lib.rs',
    captureScript: 'capture_rust.sh',
    validateScript: 'validate_rust.sh',
  },
  {
    name: 'crystal',
    runtimeBin: 'crystal',
    proofDir: join(REPO_ROOT, 'proof', 'crystal_demo'),
    manifestPath: join(REPO_ROOT, 'proof', 'crystal_demo', 'regrets', 'manifest.json'),
    sourceFile: join(REPO_ROOT, 'proof', 'crystal_demo', 'strings.cr'),
    sourceRelPath: 'strings.cr',
    captureScript: 'capture_crystal.sh',
    validateScript: 'validate_crystal.sh',
  },
  {
    name: 'dart',
    runtimeBin: 'dart',
    proofDir: join(REPO_ROOT, 'proof', 'dart_stack'),
    // dart_stack has manifest.json at ROOT (not regrets/). This is a known
    // layout inconsistency vs other proof projects. Group 3 (full E2E)
    // handles this by building a temp working copy with a regrets/manifest.json
    // whose file: paths are relative to the temp dir.
    manifestPath: join(REPO_ROOT, 'proof', 'dart_stack', 'manifest.json'),
    sourceFile: join(REPO_ROOT, 'proof', 'dart_stack', 'string_utils.dart'),
    sourceRelPath: 'string_utils.dart',
    captureScript: 'capture_dart.sh',
    validateScript: 'validate_dart.sh',
  },
  {
    name: 'fsharp',
    runtimeBin: 'dotnet',
    proofDir: join(REPO_ROOT, 'proofs', 'fsharp_demo'),
    manifestPath: join(REPO_ROOT, 'proofs', 'fsharp_demo', 'regrets', 'manifest.json'),
    sourceFile: join(REPO_ROOT, 'proofs', 'fsharp_demo', 'lib', 'MathUtils.fs'),
    sourceRelPath: 'lib/MathUtils.fs',
    captureScript: 'capture_fsharp.sh',
    validateScript: 'validate_fsharp.sh',
  },
  {
    name: 'kotlin',
    runtimeBin: 'kotlinc',
    proofDir: join(REPO_ROOT, 'proof', 'kotlin'),
    manifestPath: join(REPO_ROOT, 'proof', 'kotlin', 'regrets', 'manifest.json'),
    sourceFile: join(REPO_ROOT, 'proof', 'kotlin', 'src', 'Example.kt'),
    sourceRelPath: 'src/Example.kt',
    captureScript: 'capture_kotlin.sh',
    validateScript: 'validate_kotlin.sh',
  },
  {
    name: 'zig',
    runtimeBin: 'zig',
    proofDir: join(REPO_ROOT, 'proof', 'zig'),
    manifestPath: join(REPO_ROOT, 'proof', 'zig', 'regrets', 'manifest.json'),
    sourceFile: join(REPO_ROOT, 'proof', 'zig', 'src', 'example.zig'),
    sourceRelPath: 'src/example.zig',
    captureScript: 'capture_zig.sh',
    validateScript: 'validate_zig.sh',
  },
]

// ─── Helpers ─────────────────────────────────────────────────────────────────

// Detect whether a runtime binary is installed and functional.
// We accept --version succeeding OR producing any stdout (some tools write
// version info to stdout and return non-zero in odd environments).
function isRuntimeInstalled(bin) {
  try {
    const r = spawnSync(bin, ['--version'], { encoding: 'utf8', timeout: 10_000 })
    return r.status === 0 || !!(r.stdout && r.stdout.trim().length > 0)
  } catch {
    return false
  }
}

// Run regret.js with the given args + cwd. Returns {exitCode, stdout, stderr}.
function runRegret(args, opts = {}) {
  const result = spawnSync(process.execPath, [REGRET_JS, ...args], {
    cwd: opts.cwd || REPO_ROOT,
    encoding: 'utf8',
    timeout: opts.timeout || 180_000,
    env: { ...process.env, ...opts.env },
  })
  return {
    exitCode: result.status,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  }
}

// Build a temp work dir with a regrets/manifest.json containing exactly one
// cluster of the given stack. The cluster's `file` field points (via absolute
// path) to the real source file in the existing proof project. This lets us
// exercise regret.js dispatch WITHOUT modifying any tracked proof project
// files. We don't need capture to SUCCEED -- we just need regret.js to
// DISPATCH. If the runtime is missing, the capture script will exit non-zero
// with an "SDK not found" message, but regret.js will still have printed the
// "$ bash <SCRIPTS_DIR>/capture_<stack>.sh" dispatch line to stdout.
function buildTempFixture(stack) {
  const tmp = mkdtempSync(join(tmpdir(), `regret-dispatch-${stack.name}-`))
  mkdirSync(join(tmp, 'regrets'), { recursive: true })
  const manifest = {
    clusters: [{
      id: `dispatch-test-${stack.name}`,
      entry: 'dispatchTestEntry',
      watches: ['dispatchTestEntry'],
      file: stack.sourceFile,
      stack: stack.name,
      fingerprintLevel: 'entry',
      inputs: ['test-input'],
    }],
  }
  writeFileSync(join(tmp, 'regrets', 'manifest.json'), JSON.stringify(manifest, null, 2))
  return tmp
}

// For dart's full E2E test (Group 3): build a temp working COPY of the dart
// proof project. We copy string_utils.dart into the temp dir and write a
// regrets/manifest.json whose `file:` paths are relative to the temp dir
// (the original manifest uses repo-root-relative "proof/dart_stack/..."
// paths, which only resolve when running from the repo root -- but running
// regret.js from the repo root would require a regrets/manifest.json at the
// repo root, polluting the workspace). This temp copy lets us run regret.js
// from a clean cwd that has a proper regrets/manifest.json layout.
function buildDartTempWorkingCopy() {
  const stack = STACKS.find(s => s.name === 'dart')
  const tmp = mkdtempSync(join(tmpdir(), 'regret-dart-e2e-'))
  // Copy the source file into temp dir at the same relative path the manifest
  // expects (string_utils.dart at the root of the proof project).
  copyFileSync(stack.sourceFile, join(tmp, 'string_utils.dart'))
  mkdirSync(join(tmp, 'regrets'), { recursive: true })
  // Copy the root manifest, rewriting file: paths from
  // "proof/dart_stack/string_utils.dart" -> "string_utils.dart".
  const manifest = JSON.parse(readFileSync(stack.manifestPath, 'utf8'))
  for (const c of manifest.clusters) {
    if (typeof c.file === 'string' && c.file.startsWith('proof/dart_stack/')) {
      c.file = c.file.slice('proof/dart_stack/'.length)
    }
  }
  writeFileSync(join(tmp, 'regrets', 'manifest.json'), JSON.stringify(manifest, null, 2))
  return tmp
}

// ─── Group 1: Static source verification (always runs) ──────────────────────

describe('regret.js dispatch — static source verification (issue #550)', () => {
  for (const stack of STACKS) {
    it(`regret.js source has dispatch case for stack="${stack.name}" (capture + validate)`, () => {
      const src = readFileSync(REGRET_JS, 'utf8')
      // The dispatch case checks `stack === '<name>'` and references the
      // capture_<name>.sh / validate_<name>.sh script. If any of these are
      // missing, this is the PR #537 silent-no-op bug class.
      assert.match(
        src,
        new RegExp(`stack === '${stack.name}'`),
        `regret.js must check stack === '${stack.name}' (dispatch case missing — PR #537 silent-no-op bug)`,
      )
      assert.match(
        src,
        new RegExp(`capture_${stack.name}\\.sh`),
        `regret.js must reference capture_${stack.name}.sh`,
      )
      assert.match(
        src,
        new RegExp(`validate_${stack.name}\\.sh`),
        `regret.js must reference validate_${stack.name}.sh`,
      )
    })
  }
})

// ─── Group 2: Dispatch invocation (always runs, no runtime needed) ───────────

describe('regret.js dispatch — invocation test (issue #550)', () => {
  for (const stack of STACKS) {
    it(`regret.js capture dispatches to ${stack.captureScript} for stack="${stack.name}"`, () => {
      const tmp = buildTempFixture(stack)
      try {
        const r = runRegret(['capture'], { cwd: tmp })
        // regret.js's run() helper prints "$ bash <SCRIPTS_DIR>/capture_<stack>.sh"
        // to stdout BEFORE spawning the child. So stdout containing the script
        // name is definitive proof that the dispatch case fired. The child may
        // exit non-zero due to missing runtime -- that's fine; we only care
        // that dispatch happened, not that capture succeeded.
        assert.ok(
          r.stdout.includes(stack.captureScript),
          `DISPATCH MISSING: regret.js did not invoke ${stack.captureScript} for stack="${stack.name}".\n` +
          `This is the PR #537 silent-no-op bug — the if-else chain fell through with no else clause.\n` +
          `exitCode=${r.exitCode}\nstdout:\n${r.stdout}\nstderr:\n${r.stderr}`,
        )
      } finally {
        rmSync(tmp, { recursive: true, force: true })
      }
    })

    it(`regret.js validate dispatches to ${stack.validateScript} for stack="${stack.name}"`, () => {
      const tmp = buildTempFixture(stack)
      try {
        const r = runRegret(['validate'], { cwd: tmp })
        assert.ok(
          r.stdout.includes(stack.validateScript),
          `DISPATCH MISSING: regret.js did not invoke ${stack.validateScript} for stack="${stack.name}".\n` +
          `This is the PR #537 silent-no-op bug.\n` +
          `exitCode=${r.exitCode}\nstdout:\n${r.stdout}\nstderr:\n${r.stderr}`,
        )
      } finally {
        rmSync(tmp, { recursive: true, force: true })
      }
    })
  }
})

// ─── Group 3: Full E2E (skips per-stack if runtime missing) ──────────────────

describe('regret.js dispatch — full E2E (issue #550)', () => {
  for (const stack of STACKS) {
    const installed = isRuntimeInstalled(stack.runtimeBin)
    const skipReason = !installed
      ? `${stack.runtimeBin} not on PATH — full E2E skipped (dispatch-invocation test in Group 2 still ran)`
      : false

    describe(`stack="${stack.name}"`, { skip: skipReason }, () => {
      // For dart, we run against a temp working copy (see buildDartTempWorkingCopy).
      // For all other stacks, we run against the existing proof project dir
      // directly and restore any modified .regret files via git checkout after.
      const useTempCopy = stack.name === 'dart'
      let workDir = null

      before(() => {
        if (useTempCopy) {
          workDir = buildDartTempWorkingCopy()
        } else {
          workDir = stack.proofDir
        }
      })

      after(() => {
        if (useTempCopy) {
          // Temp working copy — just rm it.
          if (workDir) rmSync(workDir, { recursive: true, force: true })
        } else {
          // Existing proof project — restore any .regret files modified by
          // capture so the working tree stays clean. Use git checkout on the
          // regrets/ subdir of the proof project.
          try {
            spawnSync('git', ['checkout', '--', join(stack.proofDir, 'regrets')], {
              cwd: REPO_ROOT, encoding: 'utf8', timeout: 30_000,
            })
          } catch { /* ignore — best-effort cleanup */ }
        }
        workDir = null
      })

      it('capture dispatches and produces freshly-modified .regret files', () => {
        const before = Date.now()
        const r = runRegret(['capture'], { cwd: workDir, timeout: 600_000 })
        assert.equal(r.exitCode, 0,
          `regret.js capture should exit 0 for stack="${stack.name}".\n` +
          `stdout:\n${r.stdout}\nstderr:\n${r.stderr}`)

        // Assert at least one .regret file was modified within the last few
        // seconds — meaning capture actually ran and wrote output (not a
        // silent no-op).
        const regretsDir = join(workDir, 'regrets')
        assert.ok(existsSync(regretsDir),
          `regrets/ dir should exist at ${regretsDir} after capture`)
        const regretFiles = readdirSync(regretsDir).filter(f => f.endsWith('.regret'))
        assert.ok(regretFiles.length > 0,
          `Expected at least one .regret file in ${regretsDir} after capture`)
        const freshFiles = regretFiles.filter(f => {
          const st = statSync(join(regretsDir, f))
          return st.mtimeMs >= before
        })
        assert.ok(freshFiles.length > 0,
          `Capture did not modify any .regret files (looked for files modified after ${new Date(before).toISOString()}).\n` +
          `This indicates the capture script ran but did not write output — possibly a silent no-op.\n` +
          `Existing .regret files: ${regretFiles.join(', ')}`)
      })

      it('validate dispatches and reports PASS', () => {
        const r = runRegret(['validate'], { cwd: workDir, timeout: 600_000 })
        assert.equal(r.exitCode, 0,
          `regret.js validate should exit 0 for stack="${stack.name}".\n` +
          `stdout:\n${r.stdout}\nstderr:\n${r.stderr}`)
        assert.match(r.stdout, /PASS/i,
          `Expected "PASS" in validate stdout for stack="${stack.name}" — meaning validate actually ran and reported results.\n` +
          `stdout:\n${r.stdout}\nstderr:\n${r.stderr}`)
      })
    })
  }
})

// ─── Group 4: Negative test (always runs, no runtime needed) ─────────────────
// This test PROVES that the Group 2 dispatch-invocation assertion catches the
// PR #537 silent-no-op bug. We use a stack name that regret.js has NO dispatch
// case for ("__nonexistent_550__"). regret.js's if-else chain falls through
// with no else clause -> exit 0, no capture script invoked, no output.
// This reproduces the exact bug behavior and demonstrates that the Group 2
// assertion (stdout.includes('capture_<stack>.sh')) would FAIL if a real
// dispatch case were removed.
//
// We use this approach (unsupported stack name) rather than surgically editing
// scripts/regret.js because the task constraint forbids touching production
// code, even temporarily. The effect is identical: a manifest stack with no
// matching dispatch case.

describe('regret.js dispatch — negative test (issue #550 regression catcher)', () => {
  it('unsupported stack name -> silent no-op (proves Group 2 catches missing dispatch)', () => {
    const fakeStack = '__nonexistent_550__'
    const tmp = mkdtempSync(join(tmpdir(), 'regret-negative-'))
    try {
      mkdirSync(join(tmp, 'regrets'), { recursive: true })
      const manifest = {
        clusters: [{
          id: 'negative-test',
          entry: 'noop',
          watches: ['noop'],
          file: '/dev/null',
          stack: fakeStack,
          fingerprintLevel: 'entry',
          inputs: ['x'],
        }],
      }
      writeFileSync(join(tmp, 'regrets', 'manifest.json'), JSON.stringify(manifest, null, 2))

      const r = runRegret(['capture'], { cwd: tmp, timeout: 60_000 })

      // PR #537 bug behavior: exit 0, no dispatch line in stdout.
      assert.equal(r.exitCode, 0,
        `Unsupported stack "${fakeStack}" should produce silent no-op (exit 0). ` +
        `Got exitCode=${r.exitCode}. This simulates the pre-PR-#537 bug for the 5 stacks.`)

      // No capture_*.sh script should appear in stdout — regret.js dispatched
      // to NOTHING. If Group 2's assertion (stdout.includes('capture_<stack>.sh'))
      // were applied here, it would FAIL — proving the test catches the regression.
      assert.doesNotMatch(
        r.stdout,
        /capture_[a-z]+\.sh/,
        `Unsupported stack should NOT invoke any capture_*.sh script. ` +
        `If it did, the negative test is invalid.\n` +
        `stdout:\n${r.stdout}\nstderr:\n${r.stderr}`,
      )

      // Cross-check: also verify NO validate_*.sh script was invoked (same
      // dispatch logic applies to the validate case).
      const r2 = runRegret(['validate'], { cwd: tmp, timeout: 60_000 })
      assert.equal(r2.exitCode, 0,
        `Unsupported stack "${fakeStack}" validate should also produce silent no-op (exit 0).`)
      assert.doesNotMatch(
        r2.stdout,
        /validate_[a-z]+\.sh/,
        `Unsupported stack should NOT invoke any validate_*.sh script.\n` +
        `stdout:\n${r2.stdout}\nstderr:\n${r2.stderr}`,
      )
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })
})

// ─── Environment status note (always runs, always passes) ───────────────────
// Prints which runtimes are installed so test output makes it clear what was
// actually exercised vs skipped.

describe('regret.js dispatch — environment status', () => {
  it('reports which runtimes are installed (informational)', () => {
    const status = STACKS.map(s => {
      const installed = isRuntimeInstalled(s.runtimeBin)
      return `  ${s.name.padEnd(8)} (${s.runtimeBin}): ${installed ? 'INSTALLED — full E2E ran' : 'missing — full E2E skipped (Group 2 dispatch test still ran)'}`
    })
    const note = [
      'issue #550 dispatch-e2e test — runtime availability:',
      ...status,
      '',
      'Group 1 (static source check): always runs — verifies dispatch cases exist in regret.js source.',
      'Group 2 (dispatch invocation): always runs — verifies regret.js actually invokes capture/validate scripts.',
      'Group 3 (full E2E): runs per-stack only when the runtime is installed.',
      'Group 4 (negative test): always runs — proves Group 2 catches the PR #537 regression.',
    ].join('\n')
    console.log(note)
    assert.ok(true, note)
  })
})

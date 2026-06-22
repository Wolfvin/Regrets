// tests/cpp-stack-update-mode.test.js
// C++ stack — `regret update` mode (parity with JS/Python/Bash/Perl).
//
// Verifies that the C++ harness (`regret_harness.cpp`) `update` mode:
//   - refreshes the .regret file's HASH + OUTPUT + INPUTS line atomically
//   - appends a chain-hashed audit.log entry
//   - rejects --reason shorter than 4 words (parity with JS validate.js)
//   - rejects update without --cluster
//   - rejects update without --reason
//   - after update, validate PASSES (the new behavior is now the golden)
//   - the chain hash is sha256(prevChain + entryContent)[:7] (independently
//     verifiable via node:crypto)
//
// This brings the C++ stack to parity with JS / Python / Bash / Perl stacks
// which all support `regret update <id> --reason "..."`.

import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, writeFileSync, readFileSync, rmSync, copyFileSync, existsSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { createHash } from 'node:crypto'
import { fingerprint } from '../scripts/fingerprint.js'

const ROOT = resolve(import.meta.dirname, '..')
const SCRIPTS_DIR = join(ROOT, 'scripts')
const CAPTURE_SH  = join(SCRIPTS_DIR, 'capture_cpp.sh')
const VALIDATE_SH = join(SCRIPTS_DIR, 'validate_cpp.sh')
const HARNESS_SRC = join(SCRIPTS_DIR, 'regret_cpp', 'regret_harness.cpp')
const REGRET_HPP  = join(SCRIPTS_DIR, 'regret_cpp', 'regret.hpp')

const STRING_UTILS_HPP = join(ROOT, 'proof', 'cpp_independent', 'string_utils.hpp')
const STRING_ADAPTER_CPP = join(ROOT, 'proof', 'cpp_independent', 'string_adapter.cpp')

const TMP = resolve(join(process.cwd(), 'tests', `__cpp_update_${process.pid}__`))

// Detect C++ toolchain availability (same logic as cpp-stack.test.js)
const hasGpp = (() => {
  const r = spawnSync('g++', ['--version'], { stdio: 'ignore' })
  return r.status === 0
})()
const hasLibs = (() => {
  if (!hasGpp) return false
  const tmpC = join(TMP, '_probe.cpp')
  try {
    mkdirSync(TMP, { recursive: true })
    writeFileSync(tmpC,
      `#include <openssl/sha.h>\n#include <json-c/json.h>\nint main(){return 0;}\n`)
    const r = spawnSync('g++', [tmpC, '-o', join(TMP, '_probe'), '-lcrypto', '-ljson-c'],
      { stdio: 'ignore' })
    return r.status === 0
  } catch {
    return false
  }
})()

const itIfCpp = (hasGpp && hasLibs) ? it : it.skip

// Multi-input manifest — reverse cluster has 3 inputs so we can verify the
// INPUTS line is refreshed atomically alongside the top-level HASH.
const MANIFEST = {
  clusters: [
    {
      id: 'reverse', entry: 'regret_reverse', stack: 'cpp',
      fingerprintLevel: 'entry', watches: ['reverse'],
      inputs: ['hello', 'Regrets', 'abc123'],
    },
  ],
}

function setupProject(manifest) {
  mkdirSync(join(TMP, 'regrets'), { recursive: true })
  writeFileSync(join(TMP, 'regrets', 'manifest.json'), JSON.stringify(manifest, null, 2))
  copyFileSync(STRING_UTILS_HPP, join(TMP, 'string_utils.hpp'))
  copyFileSync(STRING_ADAPTER_CPP, join(TMP, 'string_adapter.cpp'))
}

function runCaptureOrValidate(script, opts = {}) {
  return spawnSync('bash', [script], {
    cwd: TMP,
    encoding: 'utf8',
    env: {
      ...process.env,
      CPP_SOURCES: `${TMP}/string_adapter.cpp`,
      CPP_INCLUDE: TMP,
    },
    ...opts,
  })
}

function runValidateCppSh(args, opts = {}) {
  return spawnSync('bash', [VALIDATE_SH, ...args], {
    cwd: TMP,
    encoding: 'utf8',
    env: {
      ...process.env,
      CPP_SOURCES: `${TMP}/string_adapter.cpp`,
      CPP_INCLUDE: TMP,
    },
    ...opts,
  })
}

function readRegret(id) {
  return readFileSync(join(TMP, 'regrets', `${id}.regret`), 'utf8')
}

function readAuditLog() {
  const p = join(TMP, 'regrets', 'audit.log')
  if (!existsSync(p)) return ''
  return readFileSync(p, 'utf8')
}

describe('C++ stack — `regret update` mode (parity with JS/Python/Bash/Perl)', () => {
  before(() => {
    if (!hasGpp || !hasLibs) return
    setupProject(MANIFEST)
    // Capture baseline so .regret exists for update mode.
    runCaptureOrValidate(CAPTURE_SH)
  })

  after(() => {
    if (existsSync(TMP)) rmSync(TMP, { recursive: true, force: true })
  })

  itIfCpp('update mode rejects invocation without --cluster', () => {
    const r = runValidateCppSh(['update', '--reason', 'this reason has enough words'])
    assert.notEqual(r.status, 0,
      `update without --cluster must fail (got exit ${r.status})`)
    assert.match(r.stderr + r.stdout, /update mode requires --cluster/i)
  })

  itIfCpp('update mode rejects invocation without --reason', () => {
    const r = runValidateCppSh(['update', '--cluster', 'reverse'])
    assert.notEqual(r.status, 0,
      `update without --reason must fail (got exit ${r.status})`)
    assert.match(r.stderr + r.stdout, /--update requires --reason/)
  })

  itIfCpp('update mode rejects vague --reason (<4 words)', () => {
    const r = runValidateCppSh(['update', '--cluster', 'reverse', '--reason', 'fix bug'])
    assert.notEqual(r.status, 0,
      `update with vague reason must fail (got exit ${r.status})`)
    assert.match(r.stderr + r.stdout, /too vague/)
  })

  itIfCpp('update mode refreshes HASH + OUTPUT + INPUTS + captured timestamp', () => {
    // Re-capture baseline (in case prior tests mutated the .regret)
    runCaptureOrValidate(CAPTURE_SH)

    const before = readRegret('reverse')
    const beforeCaptured = before.match(/^captured: (.+)$/m)?.[1]
    const beforeHash = before.match(/^HASH\s+(\S+)/m)?.[1]
    assert.ok(beforeCaptured, 'before: captured line present')
    assert.ok(beforeHash, 'before: HASH line present')

    // Wait a moment so the captured timestamp will differ.
    const sleep = spawnSync('sleep', ['1'])
    assert.equal(sleep.status, 0)

    // Run update with a specific ≥4-word reason.
    const r = runValidateCppSh([
      'update', '--cluster', 'reverse',
      '--reason', 'intentional no-op refresh for testing update mode timestamp',
    ])
    assert.equal(r.status, 0,
      `update must succeed (got exit ${r.status}):\n${r.stdout}\n${r.stderr}`)

    const after = readRegret('reverse')
    const afterCaptured = after.match(/^captured: (.+)$/m)?.[1]
    const afterHash = after.match(/^HASH\s+(\S+)/m)?.[1]

    assert.notEqual(afterCaptured, beforeCaptured,
      'captured timestamp MUST change after update')
    assert.equal(afterHash, beforeHash,
      'HASH should be identical when no behavior changed (still uses same input[0])')

    // INPUTS line must still be present (multi-input cluster).
    assert.match(after, /^INPUTS \[.+\]/m,
      'INPUTS line must be present after update (multi-input cluster)')
  })

  itIfCpp('update mode appends audit.log entry with chain hash', () => {
    runCaptureOrValidate(CAPTURE_SH)
    // Ensure clean audit.log
    const auditPath = join(TMP, 'regrets', 'audit.log')
    if (existsSync(auditPath)) rmSync(auditPath, { force: true })

    const reason = 'first update to verify chain hash genesis calculation works correctly'
    const r = runValidateCppSh([
      'update', '--cluster', 'reverse',
      '--reason', reason,
    ])
    assert.equal(r.status, 0,
      `update must succeed (got exit ${r.status}):\n${r.stdout}\n${r.stderr}`)

    const audit = readAuditLog()
    assert.match(audit, /UPDATE\s+reverse/,
      'audit.log must contain "UPDATE  reverse" entry')
    assert.match(audit, /by: AI refactor session/,
      'audit.log must contain "by: AI refactor session" line')
    assert.match(audit, new RegExp(`reason: ${reason.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`),
      'audit.log must contain the reason text')
    assert.match(audit, /chain: [0-9a-f]{7}/,
      'audit.log must contain a 7-hex-char chain hash')
  })

  itIfCpp('update mode chain hash is independently verifiable via sha256', () => {
    runCaptureOrValidate(CAPTURE_SH)
    // Clean audit.log
    const auditPath = join(TMP, 'regrets', 'audit.log')
    if (existsSync(auditPath)) rmSync(auditPath, { force: true })

    const reason = 'independently verify chain hash matches sha256 of prevChain plus entry'
    const r = runValidateCppSh([
      'update', '--cluster', 'reverse',
      '--reason', reason,
    ])
    assert.equal(r.status, 0, `update must succeed: ${r.stdout}\n${r.stderr}`)

    const audit = readAuditLog()
    // Extract the chain hash from the audit entry.
    const chainMatch = audit.match(/chain: ([0-9a-f]{7})/)
    assert.ok(chainMatch, 'chain hash must be present in audit.log')
    const actualChain = chainMatch[1]

    // Reconstruct entry content (lines BEFORE the chain line).
    // The audit.log starts with a leading '\n' followed by entry lines,
    // then the chain line.
    const lines = audit.replace(/^\n+/, '').split('\n')
    // Find the chain line and split content from it.
    const chainLineIdx = lines.findIndex(l => l.startsWith('  chain:'))
    assert.notEqual(chainLineIdx, -1, 'chain line must be present')
    const entryLines = lines.slice(0, chainLineIdx)
    const entryContent = entryLines.join('\n')

    // Compute expected chain hash: sha256('0000000' + entryContent) → first 7 hex.
    const prevChain = '0000000'  // first entry, no prior chain
    const expected = createHash('sha256')
      .update(prevChain + entryContent)
      .digest('hex')
      .slice(0, 7)

    assert.equal(actualChain, expected,
      `chain hash must match sha256('${prevChain}' + entryContent)[:7]\n` +
      `  expected: ${expected}\n` +
      `  actual:   ${actualChain}\n` +
      `  entryContent:\n${entryContent}`)
  })

  itIfCpp('update mode chain hash chains from previous entry on second update', () => {
    runCaptureOrValidate(CAPTURE_SH)
    const auditPath = join(TMP, 'regrets', 'audit.log')
    if (existsSync(auditPath)) rmSync(auditPath, { force: true })

    // First update.
    const reason1 = 'first update in chain sequence for testing chain hash propagation'
    let r = runValidateCppSh(['update', '--cluster', 'reverse', '--reason', reason1])
    assert.equal(r.status, 0, `first update must succeed: ${r.stdout}\n${r.stderr}`)
    const audit1 = readAuditLog()
    const chain1 = audit1.match(/chain: ([0-9a-f]{7})/)?.[1]
    assert.ok(chain1, 'first chain hash must be present')

    // Second update — should chain from chain1.
    const reason2 = 'second update in chain sequence to verify prevChain propagation works'
    r = runValidateCppSh(['update', '--cluster', 'reverse', '--reason', reason2])
    assert.equal(r.status, 0, `second update must succeed: ${r.stdout}\n${r.stderr}`)

    const audit2 = readAuditLog()
    // Find the SECOND chain hash (last occurrence).
    const chainMatches = [...audit2.matchAll(/chain: ([0-9a-f]{7})/g)]
    assert.equal(chainMatches.length, 2,
      `audit.log must have 2 chain entries after 2 updates (got ${chainMatches.length})`)
    const chain2 = chainMatches[1][1]

    // Extract the second entry's content (lines after the first chain line,
    // excluding the second chain line itself).
    const auditLines = audit2.replace(/^\n+/, '').split('\n')
    const firstChainIdx = auditLines.findIndex(l => l.startsWith('  chain:'))
    const secondChainIdx = auditLines.findIndex((l, i) => i > firstChainIdx && l.startsWith('  chain:'))
    const secondEntryLines = auditLines.slice(firstChainIdx + 1, secondChainIdx)
    const secondEntryContent = secondEntryLines.join('\n')

    const expected = createHash('sha256')
      .update(chain1 + secondEntryContent)
      .digest('hex')
      .slice(0, 7)

    assert.equal(chain2, expected,
      `second chain hash must match sha256(chain1 + secondEntryContent)[:7]\n` +
      `  expected: ${expected}\n` +
      `  actual:   ${chain2}\n` +
      `  chain1: ${chain1}\n` +
      `  secondEntryContent:\n${secondEntryContent}`)
  })

  itIfCpp('after update, validate PASSES for the accepted new behavior', () => {
    runCaptureOrValidate(CAPTURE_SH)
    // Make a BREAKING change: only affects inputs longer than 5 chars.
    const stringUtilsPath = join(TMP, 'string_utils.hpp')
    const backup = join(TMP, 'string_utils.hpp.bak')
    copyFileSync(stringUtilsPath, backup)
    try {
      let src = readFileSync(stringUtilsPath, 'utf8')
      const old = `inline std::string reverse(const std::string& s) {
    std::string result(s.rbegin(), s.rend());
    return result;
}`
      const next = `inline std::string reverse(const std::string& s) {
    std::string result(s.rbegin(), s.rend());
    if (result.size() > 5) {
        result[0] = static_cast<char>(std::toupper(static_cast<unsigned char>(result[0])));
    }
    return result;
}`
      assert.ok(src.includes(old), 'original reverse() body not found')
      writeFileSync(stringUtilsPath, src.replace(old, next))

      // Validate must FAIL before update (multi-input contract catches it).
      let r = runCaptureOrValidate(VALIDATE_SH)
      assert.notEqual(r.status, 0,
        `validate must FAIL before update (multi-input contract catches breaking change): ${r.stdout}`)
      assert.match(r.stdout, /multi-input mismatch/)

      // Now run update — accept the new behavior.
      r = runValidateCppSh([
        'update', '--cluster', 'reverse',
        '--reason', 'intentionally capitalized first letter of reversed strings longer than 5 chars per new branding',
      ])
      assert.equal(r.status, 0,
        `update must succeed: ${r.stdout}\n${r.stderr}`)

      // Validate must now PASS — the .regret file has been refreshed.
      r = runCaptureOrValidate(VALIDATE_SH)
      assert.equal(r.status, 0,
        `validate must PASS after update (new behavior accepted): ${r.stdout}`)
      assert.match(r.stdout, /Passed: 1/)

      // Also verify the INPUTS line was refreshed — the second input's hash
      // must now differ from the original (because the breaking change affected
      // input[1] "Regrets").
      const regret = readRegret('reverse')
      const inputsLine = regret.match(/^INPUTS (\[.+\])/m)?.[1]
      assert.ok(inputsLine, 'INPUTS line must be present')
      const inputs = JSON.parse(inputsLine)
      assert.equal(inputs.length, 2, 'INPUTS must have 2 entries (inputs 1+)')
      // input[1]="Regrets" → output should now be "StergeR" (capitalized)
      assert.equal(inputs[0].input, 'Regrets',
        'INPUTS[0].input must be "Regrets"')
      assert.equal(inputs[0].output, 'StergeR',
        `INPUTS[0].output must be "StergeR" (capitalized), got ${inputs[0].output}`)
      // Cross-stack parity: JS fingerprint() of (input, output) must match.
      const jsHash = fingerprint('Regrets', 'StergeR')
      assert.equal(inputs[0].hash, jsHash,
        `INPUTS[0].hash must match JS fingerprint('Regrets', 'StergeR'): ` +
        `C++=${inputs[0].hash} JS=${jsHash}`)
    } finally {
      copyFileSync(backup, stringUtilsPath)
      rmSync(backup, { force: true })
    }
  })
})

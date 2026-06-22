// tests/c-stack-independent.test.js
// INDEPENDENT verification of the C stack (capture_c.sh + validate_c.sh +
// regret_harness.c) using a FRESH fixture (proof/c_independent/) whose
// function idioms DIFFER from those in proof/c/ — to avoid the confirmation-
// bias trap documented in CONTEXT.md's "Lesson Learned".
//
// This test exercises the same C stack code path as tests/c-stack.test.js
// but with COMPLETELY DIFFERENT target functions:
//   - proof/c/      uses add / fibonacci / reverse / parse_csv_line / format_bytes
//   - proof/c_independent/ uses slugify / base64_encode / crc32 / fnv1a_32 / is_valid_ipv4
//
// Coverage:
//   - capture writes .regret files with the standard format
//   - validate PASSes when the captured code is unchanged (5/5 clusters)
//   - validate FAILs (non-zero exit) for a breaking refactor (slugify)
//   - validate PASSes for a valid refactor with hash UNCHANGED (crc32)
//   - C fingerprint matches JS fingerprint() for ALL 15 (input, output) pairs
//   - Multi-input #315 parity: INPUTS line present + correct for multi-input
//     clusters, OMITTED for single-input clusters
//
// Skips automatically when `gcc` is not on PATH or when libcrypto/json-c
// headers are missing.

import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, writeFileSync, readFileSync, rmSync, copyFileSync, existsSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { fingerprint } from '../scripts/fingerprint.js'

const ROOT = resolve(import.meta.dirname, '..')
const SCRIPTS_DIR = join(ROOT, 'scripts')
const CAPTURE_SH  = join(SCRIPTS_DIR, 'capture_c.sh')
const VALIDATE_SH = join(SCRIPTS_DIR, 'validate_c.sh')
const TEXT_UTILS_SRC = join(ROOT, 'proof', 'c_independent', 'text_utils.c')
const TEXT_UTILS_HDR = join(ROOT, 'proof', 'c_independent', 'text_utils.h')
const ADAPTER_SRC    = join(ROOT, 'proof', 'c_independent', 'regret_adapter.c')

const TMP = resolve(join(process.cwd(), 'tests', `__c_indep_${process.pid}__`))

// Detect C toolchain availability
const hasGcc = (() => {
  const r = spawnSync('gcc', ['--version'], { stdio: 'ignore' })
  return r.status === 0
})()
const hasLibs = (() => {
  if (!hasGcc) return false
  const tmpC = join(TMP, '_probe.c')
  try {
    mkdirSync(TMP, { recursive: true })
    writeFileSync(tmpC, `#include <openssl/sha.h>\n#include <json-c/json.h>\nint main(){return 0;}\n`)
    const r = spawnSync('gcc', [tmpC, '-o', join(TMP, '_probe'), '-lcrypto', '-ljson-c'], { stdio: 'ignore' })
    return r.status === 0
  } catch {
    return false
  }
})()

const itIfC = (hasGcc && hasLibs) ? it : it.skip

// Reference (input, output) pairs — INDEPENDENTLY verified against Python's
// base64, zlib.crc32, and hand-rolled slugify + ipv4 + fnv1a.
const REFERENCE_CASES = [
  { cluster: 'slugify',         input: 'Hello, World! This is a TEST.',          output: 'hello-world-this-is-a-test' },
  { cluster: 'slugify',         input: '  multiple   spaces   here  ',           output: 'multiple-spaces-here' },
  { cluster: 'slugify',         input: 'ABC---DEF???GHI',                        output: 'abc-def-ghi' },
  { cluster: 'base64-encode',   input: 'Hello',                                  output: 'SGVsbG8=' },
  { cluster: 'base64-encode',   input: 'hello world',                            output: 'aGVsbG8gd29ybGQ=' },
  { cluster: 'base64-encode',   input: '',                                       output: '' },
  { cluster: 'crc32',           input: 'Hello',                                  output: 4157704578 },
  { cluster: 'crc32',           input: 'The quick brown fox jumps over the lazy dog', output: 1095738169 },
  { cluster: 'fnv1a-32',        input: 'Hello',                                  output: 4116459851 },
  { cluster: 'fnv1a-32',        input: '',                                       output: 2166136261 },
  { cluster: 'is-valid-ipv4',   input: '192.168.1.1',                            output: true },
  { cluster: 'is-valid-ipv4',   input: '255.255.255.255',                        output: true },
  { cluster: 'is-valid-ipv4',   input: '256.0.0.1',                              output: false },
  { cluster: 'is-valid-ipv4',   input: '01.02.03.04',                            output: false },
  { cluster: 'is-valid-ipv4',   input: '1.2.3',                                  output: false },
]

function setupProject() {
  mkdirSync(join(TMP, 'regrets'), { recursive: true })
  writeFileSync(join(TMP, 'regrets', 'manifest.json'), JSON.stringify({
    clusters: [
      {
        id: 'slugify', entry: 'regret_slugify', stack: 'c',
        fingerprintLevel: 'entry', watches: ['slugify'],
        inputs: [
          'Hello, World! This is a TEST.',
          '  multiple   spaces   here  ',
          'ABC---DEF???GHI',
        ],
      },
      {
        id: 'base64-encode', entry: 'regret_base64_encode', stack: 'c',
        fingerprintLevel: 'entry', watches: ['base64_encode'],
        inputs: ['Hello', 'hello world', ''],
      },
      {
        id: 'crc32', entry: 'regret_crc32', stack: 'c',
        fingerprintLevel: 'entry', watches: ['crc32'],
        inputs: ['Hello', 'The quick brown fox jumps over the lazy dog'],
      },
      {
        id: 'fnv1a-32', entry: 'regret_fnv1a_32', stack: 'c',
        fingerprintLevel: 'entry', watches: ['fnv1a_32'],
        inputs: ['Hello', ''],
      },
      {
        id: 'is-valid-ipv4', entry: 'regret_is_valid_ipv4', stack: 'c',
        fingerprintLevel: 'entry', watches: ['is_valid_ipv4'],
        inputs: ['192.168.1.1', '255.255.255.255', '256.0.0.1', '01.02.03.04', '1.2.3'],
      },
    ],
  }, null, 2))
  // Copy the fresh sources + adapter
  copyFileSync(TEXT_UTILS_SRC, join(TMP, 'text_utils.c'))
  copyFileSync(TEXT_UTILS_HDR, join(TMP, 'text_utils.h'))
  copyFileSync(ADAPTER_SRC,    join(TMP, 'regret_adapter.c'))
}

function run(script, args = [], opts = {}) {
  return spawnSync('bash', [script, ...args], {
    cwd: TMP,
    encoding: 'utf8',
    env: {
      ...process.env,
      C_SOURCES: `${TMP}/text_utils.c:${TMP}/regret_adapter.c`,
      C_INCLUDE: TMP,
    },
    ...opts,
  })
}

function readRegret(clusterId) {
  const p = join(TMP, 'regrets', `${clusterId}.regret`)
  return readFileSync(p, 'utf8')
}

function patchSource(oldStr, newStr) {
  const p = join(TMP, 'text_utils.c')
  const src = readFileSync(p, 'utf8')
  if (!src.includes(oldStr)) {
    throw new Error(`patchSource: oldStr not found in text_utils.c:\n${oldStr}`)
  }
  writeFileSync(p, src.replace(oldStr, newStr))
}

function restoreSource() {
  copyFileSync(TEXT_UTILS_SRC, join(TMP, 'text_utils.c'))
}

describe('C stack — INDEPENDENT verification with proof/c_independent/ fixture', () => {
  before(() => {
    if (hasGcc && hasLibs) {
      setupProject()
    }
  })
  after(() => {
    try { rmSync(TMP, { recursive: true, force: true }) } catch {}
  })

  itIfC('capture writes 5 .regret files in the standard format', () => {
    const r = run(CAPTURE_SH)
    assert.equal(r.status, 0, `capture failed: ${r.stderr}`)
    for (const cid of ['slugify', 'base64-encode', 'crc32', 'fnv1a-32', 'is-valid-ipv4']) {
      const content = readRegret(cid)
      // Standard fields
      assert.match(content, /^cluster:\s+/m,    `${cid}: missing cluster field`)
      assert.match(content, /^version:\s+1/m,   `${cid}: missing version field`)
      assert.match(content, /^fingerprint:\s+\S{7}/m, `${cid}: missing/invalid fingerprint`)
      assert.match(content, /^captured:\s+\S+/m,`${cid}: missing captured field`)
      assert.match(content, /^entry:\s+\S+/m,   `${cid}: missing entry field`)
      assert.match(content, /^stack:\s+c/m,     `${cid}: missing/invalid stack field`)
      assert.match(content, /^fingerprintLevel:\s+entry/m, `${cid}: missing fingerprintLevel`)
      assert.match(content, /^---\s*$/m,        `${cid}: missing --- separator`)
      assert.match(content, /^INPUT\s+/m,       `${cid}: missing INPUT line`)
      assert.match(content, /^OUTPUT\s+/m,      `${cid}: missing OUTPUT line`)
      assert.match(content, /^HASH\s+\S{7}/m,   `${cid}: missing/invalid HASH line`)
    }
  })

  itIfC('validate PASSes baseline for all 5 clusters (15 input hashes)', () => {
    const r = run(VALIDATE_SH)
    assert.equal(r.status, 0, `baseline validate should PASS:\n${r.stdout}\n${r.stderr}`)
    assert.match(r.stdout, /Passed:\s+5\s+Failed:\s+0\s+Missing:\s+0/)
  })

  itIfC('multi-input #315 parity: INPUTS line present + correct count', () => {
    // slugify: 3 inputs → 2 in INPUTS
    // base64-encode: 3 inputs → 2 in INPUTS
    // crc32: 2 inputs → 1 in INPUTS
    // fnv1a-32: 2 inputs → 1 in INPUTS
    // is-valid-ipv4: 5 inputs → 4 in INPUTS
    const expected = {
      'slugify':       2,
      'base64-encode': 2,
      'crc32':         1,
      'fnv1a-32':      1,
      'is-valid-ipv4': 4,
    }
    for (const [cid, expectedCount] of Object.entries(expected)) {
      const content = readRegret(cid)
      const m = content.match(/^INPUTS\s+(\[.*\])\s*$/m)
      assert.ok(m, `${cid}: expected INPUTS line with ${expectedCount} entries, none found`)
      const entries = JSON.parse(m[1])
      assert.equal(entries.length, expectedCount,
        `${cid}: expected ${expectedCount} INPUTS entries, got ${entries.length}`)
      for (const e of entries) {
        assert.ok('input' in e,  `${cid}: INPUTS entry missing 'input' field`)
        assert.ok('output' in e, `${cid}: INPUTS entry missing 'output' field`)
        assert.ok('hash' in e,   `${cid}: INPUTS entry missing 'hash' field`)
      }
    }
  })

  itIfC('cross-stack parity: C hash == JS fingerprint() for all 15 (input, output) pairs', () => {
    for (const c of REFERENCE_CASES) {
      const jsFp = fingerprint(c.input, c.output)
      const content = readRegret(c.cluster)
      // Look up hash for this input — either top-level INPUT or INPUTS
      const topInputMatch = content.match(/^INPUT\s+(\S.*?)$/m)
      let cFp
      if (topInputMatch) {
        const topInput = JSON.parse(topInputMatch[1])
        if (JSON.stringify(topInput) === JSON.stringify(c.input)) {
          const m = content.match(/^HASH\s+(\S+)/m)
          cFp = m ? m[1] : null
        }
      }
      if (cFp === undefined) {
        const inputsMatch = content.match(/^INPUTS\s+(\[.*\])\s*$/m)
        if (inputsMatch) {
          const inputs = JSON.parse(inputsMatch[1])
          const entry = inputs.find(e => JSON.stringify(e.input) === JSON.stringify(c.input))
          cFp = entry ? entry.hash : null
        }
      }
      assert.equal(cFp, jsFp,
        `${c.cluster}: input=${JSON.stringify(c.input)} — C hash ${cFp} != JS hash ${jsFp}`)
    }
  })

  itIfC('BREAKING refactor (slugify no collapse) → validate FAILs with exit non-zero', () => {
    // Save current state, apply breaking refactor, validate, restore.
    const original = readFileSync(join(TMP, 'text_utils.c'), 'utf8')
    try {
      patchSource(
        `        if (!prev_was_hyphen) {
                out[j++] = '-';
                prev_was_hyphen = 1;
            }`,
        `        // BREAKING: always emit '-' (no collapse)
                out[j++] = '-';
                prev_was_hyphen = 1;`
      )
      const r = run(VALIDATE_SH)
      assert.notEqual(r.status, 0, 'Breaking refactor should FAIL validate (non-zero exit)')
      assert.match(r.stdout, /Failed:\s+[1-9]/, 'Validate should report at least 1 failure')
    } finally {
      writeFileSync(join(TMP, 'text_utils.c'), original)
    }
  })

  itIfC('VALID refactor (crc32 branchless mix) → validate PASSes with hash UNCHANGED', () => {
    // Read the original HASH for crc32 cluster
    const before = readRegret('crc32')
    const beforeHash = before.match(/^HASH\s+(\S+)/m)[1]

    const original = readFileSync(join(TMP, 'text_utils.c'), 'utf8')
    try {
      patchSource(
        `    for (unsigned int i = 0; i < 256; i++) {
        unsigned int c = i;
        for (int k = 0; k < 8; k++) {
            c = (c & 1) ? (0xEDB88320u ^ (c >> 1)) : (c >> 1);
        }
        crc32_table[i] = c;
    }`,
        `    for (unsigned int i = 0; i < 256; i++) {
        unsigned int c = i;
        /* VALID refactor: branchless mask-based mix — same OUTPUT, same HASH */
        for (int k = 0; k < 8; k++) {
            unsigned int mask = -(c & 1u);
            c = (0xEDB88320u & mask) ^ (c >> 1);
        }
        crc32_table[i] = c;
    }`
      )
      const r = run(VALIDATE_SH)
      assert.equal(r.status, 0, `Valid refactor should PASS validate:\n${r.stdout}\n${r.stderr}`)

      // Read the (regenerated) HASH and confirm it matches the pre-refactor one.
      // Note: validate does NOT rewrite .regret files, so the file should be unchanged.
      const after = readRegret('crc32')
      const afterHash = after.match(/^HASH\s+(\S+)/m)[1]
      assert.equal(afterHash, beforeHash,
        `crc32: hash changed after valid refactor — before=${beforeHash}, after=${afterHash}`)
    } finally {
      writeFileSync(join(TMP, 'text_utils.c'), original)
    }
  })
})

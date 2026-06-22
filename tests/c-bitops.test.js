// tests/c-bitops.test.js
// Independent verification of the C stack against the bit-manipulation
// fixture (proof/c_bitops/). This test exercises a domain that is
// structurally distinct from the canonical proof/c/ fixture (math) and
// from the feat/c-stack-verify fixture (string-transform/DP/encoding):
//   - bitops_count_set_bits  (Brian Kernighan popcount, uint32 single-arg)
//   - bitops_reverse_bits    (32-bit reversal via mask-and-shift, uint32 single-arg)
//   - bitops_rotate_left     (left rotate, [uint32, uint32] multiArgs)
//   - bitops_rotate_right    (right rotate, [uint32, uint32] multiArgs)
//   - bitops_next_power_of_two (Hacker's Delight round-up, uint32 single-arg)
//
// What this test verifies:
//   1. capture writes .regret files in the standard format (cluster/version/
//      fingerprint/captured/watches/entry/stack/fingerprintLevel, ---, INPUT,
//      OUTPUT, HASH, INPUTS for multi-input clusters)
//   2. validate PASSes for unchanged code (5/5 clusters PASS, all 27 (input,
//      output) hashes match)
//   3. C fingerprint matches JS fingerprint() for all 27 (input, output) pairs
//      (cross-stack parity — the C harness and fingerprint.js must agree
//      byte-for-byte)
//   4. validate PASSes for a valid refactor (rotate_left: mod+branch →
//      branchless shift-mask — output preserved, hash unchanged)
//   5. validate FAILs (non-zero exit, 1 cluster FAIL, 4 PASS) for a breaking
//      refactor (count_set_bits: count init 0 → 1 — every output shifts by +1)
//
// Skips automatically when `gcc` is not on PATH or when libcrypto/json-c
// headers are missing (so this test is safe in environments without a C
// toolchain).

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
const BITOPS_SRC    = join(ROOT, 'proof', 'c_bitops', 'bitops.c')
const BITOPS_HDR    = join(ROOT, 'proof', 'c_bitops', 'bitops.h')
const ADAPTER_SRC = join(ROOT, 'proof', 'c_bitops', 'regret_adapter.c')

const TMP = resolve(join(process.cwd(), 'tests', `__c_bitops_${process.pid}__`))

// Detect C toolchain availability (same probe as c-stack.test.js)
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

// All 27 (input, expectedOutput) pairs across the 5 clusters. Expected
// outputs are hand-derived from the bit-manipulation algorithm, then
// cross-checked against the OUTPUT field in the committed .regret files.
const CASES = [
  // count-set-bits (6 inputs)
  { cluster: 'count-set-bits', input: 0,          output: 0  },
  { cluster: 'count-set-bits', input: 1,          output: 1  },
  { cluster: 'count-set-bits', input: 255,        output: 8  },
  { cluster: 'count-set-bits', input: 4294967295, output: 32 },
  { cluster: 'count-set-bits', input: 1431655765, output: 16 },
  { cluster: 'count-set-bits', input: 2863311530, output: 16 },
  // reverse-bits (5 inputs)
  { cluster: 'reverse-bits',   input: 0,          output: 0          },
  { cluster: 'reverse-bits',   input: 1,          output: 2147483648 },
  { cluster: 'reverse-bits',   input: 4294967295, output: 4294967295 },
  { cluster: 'reverse-bits',   input: 2147483648, output: 1          },
  { cluster: 'reverse-bits',   input: 305419896,  output: 510274632  },
  // rotate-left (5 inputs, multiArgs)
  { cluster: 'rotate-left',    input: [1, 4],           output: 16          },
  { cluster: 'rotate-left',    input: [1, 31],          output: 2147483648 },
  { cluster: 'rotate-left',    input: [305419896, 8],   output: 878082066  },
  { cluster: 'rotate-left',    input: [4294967295, 16], output: 4294967295 },
  { cluster: 'rotate-left',    input: [2147483648, 1],  output: 1          },
  // rotate-right (5 inputs, multiArgs)
  { cluster: 'rotate-right',   input: [16, 4],          output: 1          },
  { cluster: 'rotate-right',   input: [1, 1],           output: 2147483648 },
  { cluster: 'rotate-right',   input: [305419896, 8],   output: 2014458966 },
  { cluster: 'rotate-right',   input: [4294967295, 16], output: 4294967295 },
  { cluster: 'rotate-right',   input: [2147483648, 31], output: 1          },
  // next-power-of-two (6 inputs)
  { cluster: 'next-power-of-two', input: 0,          output: 1          },
  { cluster: 'next-power-of-two', input: 1,          output: 1          },
  { cluster: 'next-power-of-two', input: 3,          output: 4          },
  { cluster: 'next-power-of-two', input: 1024,       output: 1024       },
  { cluster: 'next-power-of-two', input: 1000000,    output: 1048576    },
  { cluster: 'next-power-of-two', input: 2147483647, output: 2147483648 },
]

function setupProject() {
  mkdirSync(join(TMP, 'regrets'), { recursive: true })
  writeFileSync(join(TMP, 'regrets', 'manifest.json'), JSON.stringify({
    clusters: [
      {
        id: 'count-set-bits', entry: 'regret_count_set_bits', stack: 'c',
        fingerprintLevel: 'entry', watches: ['bitops_count_set_bits'],
        inputs: [0, 1, 255, 4294967295, 1431655765, 2863311530],
        description: 'Population count (Brian Kernighan) on uint32 — multi-input contract',
      },
      {
        id: 'reverse-bits', entry: 'regret_reverse_bits', stack: 'c',
        fingerprintLevel: 'entry', watches: ['bitops_reverse_bits'],
        inputs: [0, 1, 4294967295, 2147483648, 305419896],
        description: 'Reverse the 32 bits of n (MSB <-> LSB) — multi-input contract',
      },
      {
        id: 'rotate-left', entry: 'regret_rotate_left', stack: 'c',
        fingerprintLevel: 'entry', watches: ['bitops_rotate_left'],
        inputs: [[1, 4], [1, 31], [305419896, 8], [4294967295, 16], [2147483648, 1]],
        multiArgs: true,
        description: 'Rotate n left by shift positions (mod 32) — multiArgs two-arg function',
      },
      {
        id: 'rotate-right', entry: 'regret_rotate_right', stack: 'c',
        fingerprintLevel: 'entry', watches: ['bitops_rotate_right'],
        inputs: [[16, 4], [1, 1], [305419896, 8], [4294967295, 16], [2147483648, 31]],
        multiArgs: true,
        description: 'Rotate n right by shift positions (mod 32) — multiArgs two-arg function',
      },
      {
        id: 'next-power-of-two', entry: 'regret_next_power_of_two', stack: 'c',
        fingerprintLevel: 'entry', watches: ['bitops_next_power_of_two'],
        inputs: [0, 1, 3, 1024, 1000000, 2147483647],
        description: 'Smallest power of two >= n (Hacker Delight 3-2) — multi-input contract',
      },
    ],
  }, null, 2))
  copyFileSync(BITOPS_SRC, join(TMP, 'bitops.c'))
  copyFileSync(BITOPS_HDR, join(TMP, 'bitops.h'))
  copyFileSync(ADAPTER_SRC, join(TMP, 'regret_adapter.c'))
}

function run(script, args = [], opts = {}) {
  return spawnSync('bash', [script, ...args], {
    cwd: TMP,
    encoding: 'utf8',
    env: {
      ...process.env,
      C_SOURCES: `${TMP}/bitops.c:${TMP}/regret_adapter.c`,
      C_INCLUDE: TMP,
    },
    ...opts,
  })
}

function readRegret(id) {
  return readFileSync(join(TMP, 'regrets', `${id}.regret`), 'utf8')
}

describe('C stack — bitops fixture (independent verification)', () => {
  before(() => {
    if (!hasGcc || !hasLibs) return
    setupProject()
  })

  after(() => {
    if (existsSync(TMP)) rmSync(TMP, { recursive: true, force: true })
  })

  itIfC('capture writes 5 .regret files with the standard format', () => {
    const r = run(CAPTURE_SH)
    assert.equal(r.status, 0, `capture failed: ${r.stdout}\n${r.stderr}`)
    assert.match(r.stdout, /Captured: 5\s+Skipped: 0\s+Failed: 0/)

    const ids = ['count-set-bits', 'reverse-bits', 'rotate-left', 'rotate-right', 'next-power-of-two']
    for (const id of ids) {
      const regret = readRegret(id)
      for (const field of ['cluster:', 'version:', 'fingerprint:', 'captured:',
                           'watches:', 'entry:', 'stack: c', 'fingerprintLevel:',
                           '---', 'INPUT  ', 'OUTPUT ', 'HASH   ']) {
        assert.ok(regret.includes(field), `missing field "${field}" in ${id}.regret:\n${regret}`)
      }
      // Multi-input contract — every cluster has >1 input, so INPUTS line MUST be present
      assert.ok(regret.includes('INPUTS ['), `${id}.regret must have INPUTS line (multi-input contract):\n${regret}`)
    }
  })

  itIfC('validate PASSes for unchanged code (5/5 clusters, multi-input verified)', () => {
    run(CAPTURE_SH)
    const r = run(VALIDATE_SH)
    assert.equal(r.status, 0, `validate should PASS for unchanged code:\n${r.stdout}\n${r.stderr}`)
    assert.match(r.stdout, /Passed: 5\s+Failed: 0\s+Missing: 0/)
    // Every cluster should report "All input hashes match (multi-input)"
    const multiInputMatches = r.stdout.match(/All input hashes match \(multi-input\)/g)
    assert.equal(multiInputMatches?.length, 5, 'expected 5 multi-input PASS lines')
  })

  itIfC('C fingerprint matches JS fingerprint() for all 27 (input, output) pairs', () => {
    run(CAPTURE_SH)
    for (const c of CASES) {
      const regret = readRegret(c.cluster)
      // The (input, output) pair could be either the top-level INPUT/OUTPUT or
      // one of the entries in the INPUTS line. Parse both and look up by input.
      const topInputMatch = regret.match(/^INPUT\s+(.+?)$/m)
      const topHashMatch  = regret.match(/^HASH\s+(\S+)/m)
      const topInput = topInputMatch ? JSON.parse(topInputMatch[1].trim()) : null
      let cHash = null
      if (topInput !== null && JSON.stringify(topInput) === JSON.stringify(c.input)) {
        cHash = topHashMatch ? topHashMatch[1] : null
      } else {
        const inputsMatch = regret.match(/^INPUTS\s+(\[.*\])$/m)
        if (inputsMatch) {
          const entries = JSON.parse(inputsMatch[1])
          const found = entries.find(e => JSON.stringify(e.input) === JSON.stringify(c.input))
          if (found) cHash = found.hash
        }
      }
      assert.ok(cHash, `no .regret hash found for cluster=${c.cluster} input=${JSON.stringify(c.input)}`)
      const jsHash = fingerprint(c.input, c.output)
      assert.equal(cHash, jsHash, `parity mismatch for ${c.cluster} input=${JSON.stringify(c.input)}: C=${cHash} JS=${jsHash}`)
    }
  })

  itIfC('validate PASSes for a valid refactor (rotate_left: mod+branch → branchless shift-mask)', () => {
    const bitopsPath = join(TMP, 'bitops.c')
    const backup = join(TMP, 'bitops.c.bak')
    copyFileSync(bitopsPath, backup)
    try {
      let src = readFileSync(bitopsPath, 'utf8')
      const old = `uint32_t bitops_rotate_left(uint32_t n, uint32_t shift) {
    shift &= 31u;  // mod 32
    if (shift == 0) return n;
    return (n << shift) | (n >> (32u - shift));
}`
      const next = `uint32_t bitops_rotate_left(uint32_t n, uint32_t shift) {
    /* Branchless refactor — output preserved for all 5 captured inputs. */
    uint32_t s = shift & 31u;
    uint32_t mask = (uint32_t)(s != 0);
    uint32_t hi = (s == 0) ? 0u : (32u - s);
    return (mask * ((n << s) | (n >> hi))) + (1u - mask) * n;
}`
      assert.ok(src.includes(old), 'original rotate_left body not found')
      writeFileSync(bitopsPath, src.replace(old, next))

      const r = run(VALIDATE_SH)
      assert.equal(r.status, 0, `valid refactor should PASS:\n${r.stdout}\n${r.stderr}`)
      assert.match(r.stdout, /Passed: 5\s+Failed: 0/)
    } finally {
      copyFileSync(backup, bitopsPath)
      rmSync(backup, { force: true })
    }
  })

  itIfC('validate FAILs (non-zero exit) for a breaking refactor (count_set_bits off-by-one)', () => {
    const bitopsPath = join(TMP, 'bitops.c')
    const backup = join(TMP, 'bitops.c.bak')
    copyFileSync(bitopsPath, backup)
    try {
      let src = readFileSync(bitopsPath, 'utf8')
      const old = `uint32_t bitops_count_set_bits(uint32_t n) {
    // Brian Kernighan's algorithm: each iteration clears the lowest set
    // bit, so the loop body runs exactly popcount(n) times.
    uint32_t count = 0;
    while (n) {
        n &= (n - 1);
        count++;
    }
    return count;
}`
      // Breaking: count initialized to 1 instead of 0 — every output shifts by +1
      const next = `uint32_t bitops_count_set_bits(uint32_t n) {
    /* OFF-BY-ONE: count initialized to 1 — every output shifts by +1. */
    uint32_t count = 1;
    while (n) {
        n &= (n - 1);
        count++;
    }
    return count;
}`
      assert.ok(src.includes(old), 'original count_set_bits body not found')
      writeFileSync(bitopsPath, src.replace(old, next))

      const r = run(VALIDATE_SH)
      assert.notEqual(r.status, 0, `breaking refactor should FAIL (non-zero exit):\n${r.stdout}\n${r.stderr}`)
      // count-set-bits cluster should be the one that FAILs
      assert.match(r.stdout, /count-set-bits[\s\S]*FAIL/, 'FAIL should be on the count-set-bits cluster')
      assert.match(r.stdout, /Failed: 1/, 'summary should show 1 failure')
    } finally {
      copyFileSync(backup, bitopsPath)
      rmSync(backup, { force: true })
    }
  })
})

// verify-parity.mjs — verify that the C harness produces the same 7-char
// base36 hash as the JS reference implementation (scripts/fingerprint.js)
// for the same (input, output) pair.
//
// This is the cross-stack fingerprint parity check for the bit-manipulation
// fixture. The C harness and the JS fingerprint() must agree byte-for-byte
// on the hash for every (input, output) pair — otherwise capture/validate
// across stacks would silently drift.
//
// Run: node proof/c_bitops/verify-parity.mjs

import { readFileSync } from 'node:fs'
import { fingerprint } from '../../scripts/fingerprint.js'

// (input, expectedOutput) pairs for each cluster. The OUTPUT is what the
// C function returns for that INPUT — we recompute the JS hash from
// (input, expectedOutput) and compare it to the HASH field in the .regret
// file produced by capture_c.sh.
//
// The expectedOutput values are derived by hand-computing the bit-manipulation
// result, then double-checked by reading the OUTPUT field from the captured
// .regret file. This way the parity test fails loudly if either side drifts.
const cases = [
  // count-set-bits — INPUT 0 (primary), INPUTS [1, 255, 4294967295, 1431655765, 2863311530]
  { cluster: 'count-set-bits', input: 0,           output: 0  },
  { cluster: 'count-set-bits', input: 1,           output: 1  },
  { cluster: 'count-set-bits', input: 255,         output: 8  },
  { cluster: 'count-set-bits', input: 4294967295,  output: 32 },
  { cluster: 'count-set-bits', input: 1431655765,  output: 16 },
  { cluster: 'count-set-bits', input: 2863311530,  output: 16 },

  // reverse-bits — INPUT 0 (primary), INPUTS [1, 4294967295, 2147483648, 305419896]
  { cluster: 'reverse-bits',   input: 0,           output: 0          },
  { cluster: 'reverse-bits',   input: 1,           output: 2147483648 },
  { cluster: 'reverse-bits',   input: 4294967295,  output: 4294967295 },
  { cluster: 'reverse-bits',   input: 2147483648,  output: 1          },
  { cluster: 'reverse-bits',   input: 305419896,   output: 510274632  },

  // rotate-left (multiArgs) — INPUT [1,4] (primary), INPUTS [1,31], [305419896,8], [4294967295,16], [2147483648,1]
  { cluster: 'rotate-left',    input: [1, 4],           output: 16          },
  { cluster: 'rotate-left',    input: [1, 31],          output: 2147483648 },
  { cluster: 'rotate-left',    input: [305419896, 8],   output: 878082066  },
  { cluster: 'rotate-left',    input: [4294967295, 16], output: 4294967295 },
  { cluster: 'rotate-left',    input: [2147483648, 1],  output: 1          },

  // rotate-right (multiArgs) — INPUT [16,4] (primary), INPUTS [1,1], [305419896,8], [4294967295,16], [2147483648,31]
  { cluster: 'rotate-right',   input: [16, 4],          output: 1          },
  { cluster: 'rotate-right',   input: [1, 1],           output: 2147483648 },
  { cluster: 'rotate-right',   input: [305419896, 8],   output: 2014458966 },
  { cluster: 'rotate-right',   input: [4294967295, 16], output: 4294967295 },
  { cluster: 'rotate-right',   input: [2147483648, 31], output: 1          },

  // next-power-of-two — INPUT 0 (primary), INPUTS [1, 3, 1024, 1000000, 2147483647]
  { cluster: 'next-power-of-two', input: 0,          output: 1          },
  { cluster: 'next-power-of-two', input: 1,          output: 1          },
  { cluster: 'next-power-of-two', input: 3,          output: 4          },
  { cluster: 'next-power-of-two', input: 1024,       output: 1024       },
  { cluster: 'next-power-of-two', input: 1000000,    output: 1048576    },
  { cluster: 'next-power-of-two', input: 2147483647, output: 2147483648 },
]

let failures = 0
let checked = 0
console.log('Comparing JS fingerprint() vs C-produced HASH from .regret files:\n')

// Map (cluster, input) → hash from .regret file. We parse each .regret once.
const regretHashes = new Map()
for (const clusterName of ['count-set-bits', 'reverse-bits', 'rotate-left', 'rotate-right', 'next-power-of-two']) {
  const regret = readFileSync(`proof/c_bitops/regrets/${clusterName}.regret`, 'utf8')
  // Top-level INPUT/HASH
  const topInputMatch = regret.match(/^INPUT\s+(.+?)$/m)
  const topHashMatch  = regret.match(/^HASH\s+(\S+)/m)
  if (topInputMatch && topHashMatch) {
    const topInput = JSON.parse(topInputMatch[1].trim())
    regretHashes.set(`${clusterName}::${JSON.stringify(topInput)}`, topHashMatch[1])
  }
  // INPUTS line — array of {input, output, hash}
  const inputsMatch = regret.match(/^INPUTS\s+(\[.*\])$/m)
  if (inputsMatch) {
    const entries = JSON.parse(inputsMatch[1])
    for (const e of entries) {
      regretHashes.set(`${clusterName}::${JSON.stringify(e.input)}`, e.hash)
    }
  }
}

for (const c of cases) {
  const jsFp = fingerprint(c.input, c.output)
  const key = `${c.cluster}::${JSON.stringify(c.input)}`
  const cFp = regretHashes.get(key)
  if (!cFp) {
    console.log(`❌ ${c.cluster.padEnd(20)} input=${JSON.stringify(c.input).padEnd(20)} — no .regret hash found for key ${key}`)
    failures++
    continue
  }
  const match = jsFp === cFp
  console.log(`${match ? '✅' : '❌'} ${c.cluster.padEnd(20)} input=${JSON.stringify(c.input).padEnd(20)} JS=${jsFp}  C=${cFp}  ${match ? '' : 'MISMATCH'}`)
  if (!match) failures++
  checked++
}

console.log(`\n${failures === 0 ? `✅ All ${checked} fingerprints match — cross-stack parity verified.` : `❌ ${failures} mismatches out of ${checked}`}`)
process.exit(failures === 0 ? 0 : 1)

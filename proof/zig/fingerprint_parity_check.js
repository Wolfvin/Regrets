// fingerprint_parity_check.js — compute JS reference fingerprints for known inputs.
// Output: JSON array of {input, output, hash} pairs that the Zig implementation
// must match byte-for-byte.
import { fingerprint } from '../../scripts/fingerprint.js'

const cases = [
  // Single-arg integer (add with multiArgs, but we test the fingerprint function directly)
  { label: 'add_int_1_2',   input: [1, 2],     output: 3 },
  { label: 'add_int_10_20', input: [10, 20],   output: 30 },
  { label: 'add_int_0_0',   input: [0, 0],     output: 0 },
  { label: 'add_int_neg',   input: [-5, 7],    output: 2 },
  // greet: String × Boolean → String
  { label: 'greet_world_true',  input: ['world', true],  output: 'Hello, world!' },
  { label: 'greet_world_false', input: ['world', false], output: 'Hello, world' },
  { label: 'greet_empty_true',  input: ['', true],       output: 'Hello, !' },
  // title-case-words: String → String
  { label: 'tcw_hello',         input: 'hello world',         output: 'Hello World' },
  { label: 'tcw_fox',           input: 'the quick brown fox', output: 'The Quick Brown Fox' },
  { label: 'tcw_empty',         input: '',                    output: '' },
]

const out = cases.map(c => ({
  label: c.label,
  input: c.input,
  output: c.output,
  hash: fingerprint(c.input, c.output),
}))
console.log(JSON.stringify(out, null, 2))

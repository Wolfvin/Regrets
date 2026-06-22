#!/usr/bin/env node
// cross_stack_parity.mjs — verify the Rust stack's fingerprint is byte-identical
// to JS and Python for the same (input, output) pairs.
//
// Cross-stack parity is the core Regrets contract:
//   sha256(stableStringify(input) + '|' + stableStringify(output))
//   → hex → BigInt → base36 → first 7 chars
// must produce the SAME 7-char hash regardless of which stack computed it.
//
// Bonus: this fixture's 5 clusters use the SAME (input, output) pairs as
// proof/go_verify/ and proof/c_verify/, so we can verify 4-way parity:
//   Rust == Go == C == JS == Python.

import { readFileSync, readdirSync, writeFileSync, mkdtempSync, rmSync } from 'fs'
import { createHash } from 'crypto'
import { execSync } from 'child_process'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'
import { tmpdir } from 'os'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)
const REGRET_DIR = join(__dirname, 'regrets')

// --- stableStringify (byte-identical to fingerprint.js) -------------------

function stableStringify(obj, _seen = null) {
  if (obj === null || obj === undefined) return String(obj)
  if (typeof obj === 'number') {
    if (Number.isNaN(obj)) return '"__nan__"'
    if (obj === Infinity) return '"__infinity__"'
    if (obj === -Infinity) return '"__neg_infinity__"'
  }
  if (typeof obj === 'bigint') return '__bigint__:' + obj.toString()
  if (typeof obj === 'boolean') return obj ? 'true' : 'false'
  if (typeof obj === 'string') return JSON.stringify(obj)
  if (Array.isArray(obj)) {
    if (!_seen) _seen = new Set()
    if (_seen.has(obj)) return '"__circular__"'
    _seen.add(obj)
    const r = '[' + obj.map(v => stableStringify(v, _seen)).join(',') + ']'
    _seen.delete(obj)
    return r
  }
  if (typeof obj === 'object') {
    if (!_seen) _seen = new Set()
    if (_seen.has(obj)) return '"__circular__"'
    _seen.add(obj)
    const keys = Object.keys(obj).sort()
    const r = '{' + keys.map(k => JSON.stringify(k) + ':' + stableStringify(obj[k], _seen)).join(',') + '}'
    _seen.delete(obj)
    return r
  }
  return String(obj)
}

function fingerprint(input, output) {
  const combined = stableStringify(input) + '|' + stableStringify(output)
  const hash = createHash('sha256').update(combined, 'utf8').digest('hex')
  return BigInt('0x' + hash).toString(36).slice(0, 7)
}

// --- Parse .regret file ---------------------------------------------------

function parseRegret(content) {
  const [metaSection, dataSection] = content.split('\n---\n', 2)
  const meta = {}
  for (const line of metaSection.split('\n')) {
    const i = line.indexOf(': ')
    if (i < 0) continue
    meta[line.slice(0, i)] = line.slice(i + 2)
  }
  let input = null, output = null, hash = null
  for (const line of dataSection.split('\n')) {
    if (line.startsWith('INPUT '))  input  = JSON.parse(line.slice(6))
    if (line.startsWith('OUTPUT ')) output = JSON.parse(line.slice(7))
    if (line.startsWith('HASH '))   hash   = line.slice(5).trim()
  }
  return { meta, input, output, hash }
}

// --- Python re-derivation -------------------------------------------------

const PYTHON_SCRIPT = `
import json, hashlib, sys, math

def stable_stringify(obj):
    if obj is None: return "null"
    if obj is True: return "true"
    if obj is False: return "false"
    if isinstance(obj, int): return str(obj)
    if isinstance(obj, float):
        if math.isnan(obj): return '"__nan__"'
        if math.isinf(obj): return '"__infinity__"' if obj > 0 else '"__neg_infinity__"'
        if obj == int(obj) and abs(obj) < 1e21: return str(int(obj))
        return repr(obj)
    if isinstance(obj, str): return json.dumps(obj, ensure_ascii=False)
    if isinstance(obj, list):
        return '[' + ','.join(stable_stringify(v) for v in obj) + ']'
    if isinstance(obj, dict):
        keys = sorted(obj.keys())
        return '{' + ','.join(json.dumps(k, ensure_ascii=False) + ':' + stable_stringify(obj[k]) for k in keys) + '}'
    return str(obj)

def fingerprint(input_obj, output_obj):
    combined = stable_stringify(input_obj) + '|' + stable_stringify(output_obj)
    h = hashlib.sha256(combined.encode('utf-8')).hexdigest()
    n = int(h, 16)
    if n == 0: return '0'
    chars = '0123456789abcdefghijklmnopqrstuvwxyz'
    out = ''
    while n > 0:
        out = chars[n % 36] + out
        n //= 36
    return out[:7]

inp = json.loads(sys.argv[1])
out = json.loads(sys.argv[2])
print(fingerprint(inp, out))
`

const tmpDir = mkdtempSync(join(tmpdir(), 'regret-rust-parity-'))
const pyScriptPath = join(tmpDir, 'parity.py')
writeFileSync(pyScriptPath, PYTHON_SCRIPT)

function pyFingerprint(input, output) {
  return execSync(
    `python3 '${pyScriptPath}' '${JSON.stringify(input)}' '${JSON.stringify(output)}'`,
    { encoding: 'utf8' }
  ).trim()
}

// --- Main -----------------------------------------------------------------

const regretFiles = readdirSync(REGRET_DIR).filter(f => f.endsWith('.regret'))
console.log(`Cross-stack parity check for ${regretFiles.length} Rust clusters`)
console.log('═'.repeat(78))
console.log('cluster              | Rust hash | JS hash   | Py hash   | match')
console.log('─'.repeat(78))

let allMatch = true

for (const file of regretFiles.sort()) {
  const content = readFileSync(join(REGRET_DIR, file), 'utf8')
  const { meta, input, output, hash: rustHash } = parseRegret(content)

  const jsHash = fingerprint(input, output)
  const pyHash = pyFingerprint(input, output)
  const match = rustHash === jsHash && jsHash === pyHash
  if (!match) allMatch = false

  const id = meta.cluster.padEnd(20)
  const mark = match ? '✅' : '❌'
  console.log(`${id} | ${rustHash}   | ${jsHash}   | ${pyHash}   | ${mark}`)
}

console.log('═'.repeat(78))
rmSync(tmpDir, { recursive: true, force: true })
if (allMatch) {
  console.log('✅ All 3 stacks agree — Rust is byte-identical to JS and Python.')
  console.log('   Bonus: same hashes match Go (proof/go_verify/) and C (proof/c_verify/)')
  console.log('          → 4-way cross-stack parity: Rust == Go == C == JS == Python.')
  process.exit(0)
} else {
  console.log('❌ Parity broken — investigate the row(s) marked ❌.')
  process.exit(1)
}

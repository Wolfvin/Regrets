#!/usr/bin/env node
// shim/capture.mjs — Generate .regret files for the proof/rust clusters.
//
// This is a one-shot capture tool for the proof-of-concept. It invokes the
// Rust binary (or Node shim) with each input from manifest.json, captures
// the output, computes the fingerprint using Regrets' scripts/fingerprint.js
// (the same algorithm validate_rust_runner.mjs uses), and writes .regret
// files in the canonical format.
//
// In a real Rust project, you'd use `bash scripts/capture_rust.sh` instead
// — which delegates to `cargo test --test regret_capture`. The capture_rust.sh
// path requires the user to write a tests/regret_capture.rs file by hand.
// For this proof we wanted a runnable end-to-end demo without that friction,
// so we ship a tiny capture helper alongside the validate script.
//
// Usage:
//   node proof/rust/shim/capture.mjs
//   node proof/rust/shim/capture.mjs --bin <path>      # override binary
//   node proof/rust/shim/capture.mjs --manifest <path> # override manifest

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs'
import { resolve, join, dirname } from 'path'
import { fileURLToPath } from 'url'
import { spawnSync } from 'child_process'

const __dirname = dirname(fileURLToPath(import.meta.url))
const PROOF_DIR = resolve(__dirname, '..')            // proof/rust/
const ROOT = resolve(__dirname, '..', '..', '..')     // Regrets repo root
const DEFAULT_MANIFEST = resolve(PROOF_DIR, 'regrets', 'manifest.json')
const REGRET_DIR = resolve(PROOF_DIR, 'regrets')

// ─── CLI args ─────────────────────────────────────────────────────────────────
const args = process.argv.slice(2)
function getArg(name) {
  const i = args.indexOf(name)
  return i !== -1 ? args[i + 1] ?? null : null
}
const manifestPath = getArg('--manifest') ?? DEFAULT_MANIFEST
const binOverride  = getArg('--bin')

// ─── Load fingerprint.js from the main Regrets scripts/ dir ───────────────────
const { fingerprint, stableStringify } = await import(resolve(ROOT, 'scripts', 'fingerprint.js'))

// ─── Resolve binary ───────────────────────────────────────────────────────────
function resolveBinary(manifest) {
  if (binOverride) return { cmd: binOverride, args: [] }
  if (manifest.cargoBin) {
    // cargoBinArgs are passed verbatim — e.g. ["shim/regret_proof_rust.mjs"]
    // for the Node shim demo. For a real Rust binary, omit cargoBinArgs.
    const args = (manifest.cargoBinArgs || []).map(a =>
      // Resolve relative paths against the proof dir so the demo works from
      // any cwd. For a real binary, args would typically be empty.
      a.endsWith('.mjs') || a.endsWith('.js')
        ? resolve(PROOF_DIR, a)
        : a
    )
    return { cmd: manifest.cargoBin, args }
  }
  // Default: try target/debug/<package-name>
  const pkgName = manifest.packageName
  if (pkgName) {
    const candidate = resolve(PROOF_DIR, 'target', 'debug', pkgName)
    if (existsSync(candidate)) return { cmd: candidate, args: [] }
  }
  return null
}

// ─── Invoke binary ────────────────────────────────────────────────────────────
function invoke(bin, cluster, input) {
  const payload = JSON.stringify({ cluster, input })
  const result = spawnSync(bin.cmd, bin.args, {
    input: payload,
    encoding: 'utf8',
    timeout: 30_000,
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  if (result.error) throw new Error(`spawn failed: ${result.error.message}`)
  if (result.status !== 0) {
    let errMsg = result.stdout?.trim() || result.stderr?.trim() || '(no output)'
    try {
      const parsed = JSON.parse(errMsg)
      if (parsed.error) errMsg = parsed.error
    } catch { /* not JSON */ }
    throw new Error(`exit ${result.status}: ${errMsg}`)
  }
  const stdout = result.stdout?.trim()
  if (!stdout) throw new Error('empty stdout')
  const parsed = JSON.parse(stdout)
  if (parsed.error) throw new Error(`binary reported error: ${parsed.error}`)
  if (!('output' in parsed)) throw new Error(`binary response missing "output" field: ${stdout}`)
  return parsed.output
}

// ─── Format .regret file ──────────────────────────────────────────────────────
function jsonSerialize(value) {
  return JSON.stringify(value)
}

function formatRegret(cluster, input, output, fp, captured) {
  const lines = [
    `cluster: ${cluster.id}`,
    'version: 1',
    `fingerprint: ${fp}`,
    `captured: ${captured}`,
    `watches: [${cluster.watches.join(', ')}]`,
    `entry: ${cluster.entry}`,
    'stack: rust',
  ]
  if (cluster.module) lines.push(`module: ${cluster.module}`)
  lines.push(`fingerprintLevel: ${cluster.fingerprintLevel || 'entry'}`)
  if (cluster.multiArgs) lines.push(`multiArgs: true`)
  lines.push('---')
  lines.push(`INPUT  ${jsonSerialize(input)}`)
  lines.push(`OUTPUT ${jsonSerialize(output)}`)
  lines.push(`HASH   ${fp}`)
  return lines.join('\n') + '\n'
}

// ─── Main ─────────────────────────────────────────────────────────────────────
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
const rustClusters = (manifest.clusters || []).filter(c => c.stack === 'rust')

if (rustClusters.length === 0) {
  console.error('No Rust clusters found in manifest')
  process.exit(2)
}

const bin = resolveBinary(manifest)
if (!bin) {
  console.error('No binary resolved — set cargoBin in manifest or pass --bin')
  process.exit(1)
}

console.log(`📡 Capturing ${rustClusters.length} Rust cluster(s)`)
console.log(`   Binary: ${bin.cmd} ${bin.args.join(' ')}`)
console.log('')

mkdirSync(REGRET_DIR, { recursive: true })

let passed = 0
let failed = 0

for (const cluster of rustClusters) {
  const cid = cluster.id
  console.log(`📡 Capturing: ${cid}`)
  console.log(`   Entry: ${cluster.entry}`)

  const inputs = cluster.inputs || [null]
  // Use the FIRST input as the golden input (matches capture.js behavior —
  // multi-input capture is a separate concern tracked in #315).
  const goldenInput = inputs[0]
  console.log(`   Input:  ${stableStringify(goldenInput)}`)

  let output
  try {
    output = invoke(bin, cid, goldenInput)
  } catch (e) {
    console.error(`   ❌ Invocation failed: ${e.message}`)
    failed++
    continue
  }
  console.log(`   Output: ${stableStringify(output)}`)

  const fp = fingerprint(goldenInput, output, {
    normalize: cluster.normalize || [],
    ignoreFields: cluster.ignoreFields || [],
  })
  console.log(`   ✅ Fingerprint: ${fp}`)

  const captured = new Date().toISOString()
  const regretContent = formatRegret(cluster, goldenInput, output, fp, captured)
  const regretPath = join(REGRET_DIR, `${cid}.regret`)
  writeFileSync(regretPath, regretContent)
  console.log(`   📄 Saved: regrets/${cid}.regret`)
  passed++
}

console.log('')
console.log(`📊 Capture: ${passed} captured, ${failed} failed`)
process.exit(failed > 0 ? 1 : 0)

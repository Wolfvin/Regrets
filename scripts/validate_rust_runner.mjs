#!/usr/bin/env node
// validate_rust_runner.mjs — Node runner for Rust cluster validation.
//
// Reads regrets/manifest.json, filters to stack=rust clusters, and for each
// cluster:
//   1. Reads the existing .regret file (INPUT/OUTPUT/HASH + meta)
//   2. Invokes the user's Rust binary with INPUT as JSON on stdin, expects
//      JSON output on stdout
//   3. Recomputes the fingerprint using scripts/fingerprint.js (identical
//      algorithm to JS/Python/Go — cross-stack parity verified)
//   4. Reports PASS/FAIL with diff if hashes diverge
//
// Rust binary contract (per references/rust.md and proof/rust/README.md):
//   - Reads JSON from stdin: { "cluster": "<id>", "input": <value> }
//   - Writes JSON to stdout: { "output": <value> }
//   - On error: writes { "error": "<message>" } and exits non-zero
//   - The binary is responsible for dispatching to the correct function
//     based on cluster id (typically via a match statement in main()).
//
// Usage:
//   node scripts/validate_rust_runner.mjs --manifest <path>
//   node scripts/validate_rust_runner.mjs --manifest <path> --cluster <id>
//   node scripts/validate_rust_runner.mjs --manifest <path> --fail-fast
//   node scripts/validate_rust_runner.mjs --manifest <path> --quiet
//   node scripts/validate_rust_runner.mjs --manifest <path> --verbose
//   node scripts/validate_rust_runner.mjs --manifest <path> --bin <path>
//
// Exit codes:
//   0 = all clusters PASS
//   1 = one or more clusters FAIL (or runner error)
//   2 = no Rust clusters found / manifest missing

import { readFileSync, existsSync } from 'fs'
import { resolve, join, dirname } from 'path'
import { fileURLToPath } from 'url'
import { spawnSync } from 'child_process'

// ─── Resolve sibling scripts ─────────────────────────────────────────────────
const __dirname = dirname(fileURLToPath(import.meta.url))
const FINGERPRINT_PATH = resolve(__dirname, 'fingerprint.js')

// Dynamic import of fingerprint.js — ESM
const { fingerprint, stableStringify } = await import(FINGERPRINT_PATH)

// ─── CLI args ─────────────────────────────────────────────────────────────────
const args = process.argv.slice(2)
function getArg(name) {
  const i = args.indexOf(name)
  return i !== -1 ? args[i + 1] ?? null : null
}
const manifestPath  = getArg('--manifest') ?? resolve(process.cwd(), 'regrets/manifest.json')
const clusterFilter = getArg('--cluster')
const failFast      = args.includes('--fail-fast')
const quiet         = args.includes('--quiet')
const verbose       = args.includes('--verbose')
const binOverride   = getArg('--bin')

if (quiet && verbose) {
  console.warn('⚠️  --quiet and --verbose are mutually exclusive; using --quiet')
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Parse a .regret file into meta + data sections.
 * Returns { meta, input, output, goldenHash, raw }.
 *
 * This is a deliberately minimal parser — it covers the fields validate_rust
 * needs. For the full canonical parser see scripts/validate.js#parseRegret.
 */
function parseRegret(content) {
  const [metaSection, dataSection] = content.split('\n---\n')
  const meta = {}
  for (const line of metaSection.split('\n')) {
    const colonIdx = line.indexOf(': ')
    if (colonIdx === -1) continue
    const key = line.slice(0, colonIdx)
    const val = line.slice(colonIdx + 2).trim()
    if (key === 'watches') meta.watches = val.slice(1, -1).split(', ').filter(Boolean)
    else if (key === 'normalize') meta.normalize = val.slice(1, -1).split(', ').filter(Boolean)
    else if (key === 'ignoreFields') meta.ignoreFields = val.slice(1, -1).split(', ').filter(Boolean)
    else if (key === 'version') meta.version = Number(val)
    else meta[key] = val
  }
  const lines = dataSection?.split('\n') ?? []
  const inputLine  = lines.find(l => l.startsWith('INPUT '))
  const outputLine = lines.find(l => l.startsWith('OUTPUT '))
  const hashLine   = lines.find(l => l.startsWith('HASH '))
  let parsedInput  = null
  let parsedOutput = null
  if (inputLine) {
    const s = inputLine.replace(/^INPUT\s+/, '')
    try { parsedInput = s === 'undefined' ? undefined : JSON.parse(s) } catch { parsedInput = null }
  }
  if (outputLine) {
    const s = outputLine.replace(/^OUTPUT\s+/, '')
    try { parsedOutput = s === 'undefined' ? undefined : JSON.parse(s) } catch { parsedOutput = null }
  }
  return {
    ...meta,
    input: parsedInput,
    output: parsedOutput,
    goldenHash: hashLine ? hashLine.replace(/^HASH\s+/, '').trim() : null,
    raw: content,
  }
}

/**
 * Resolve the Rust binary to invoke for a cluster.
 * Priority:
 *   1. --bin CLI override (single path)
 *   2. cluster.cargoBin (+ optional cluster.cargoBinArgs)
 *   3. manifest.cargoBin (+ optional manifest.cargoBinArgs)
 *   4. default: ./target/debug/<package-name> (cargo build default)
 *
 * `cargoBin` is the executable path. `cargoBinArgs` is an optional array of
 * string arguments passed verbatim — useful when the binary is invoked via
 * a wrapper (e.g. `cargoBin: "node"`, `cargoBinArgs: ["./shim/proxy.mjs"]`).
 *
 * Relative paths in `cargoBinArgs` are resolved against the manifest's
 * directory — this lets a manifest point at a project-relative shim without
 * requiring the caller to cd anywhere first.
 *
 * Returns { cmd, args } for spawnSync, or null if no binary can be resolved.
 */
function resolveBinary(cluster, manifest, manifestDir) {
  if (binOverride) return { cmd: binOverride, args: [] }
  const resolveArgs = (args) => (args || []).map(a => {
    // Resolve .js/.mjs relative paths against the manifest dir
    if ((a.endsWith('.js') || a.endsWith('.mjs')) && !existsSync(a)) {
      const resolved = resolve(manifestDir, a)
      if (existsSync(resolved)) return resolved
    }
    return a
  })
  if (cluster.cargoBin) {
    return { cmd: cluster.cargoBin, args: resolveArgs(cluster.cargoBinArgs) }
  }
  if (manifest.cargoBin) {
    return { cmd: manifest.cargoBin, args: resolveArgs(manifest.cargoBinArgs) }
  }
  // Default: try target/debug/<package-name> relative to manifest dir
  const pkgName = manifest.packageName || cluster.packageName
  if (pkgName) {
    const candidate = resolve(manifestDir, 'target', 'debug', pkgName)
    if (existsSync(candidate)) return { cmd: candidate, args: [] }
  }
  return null
}

/**
 * Invoke the Rust binary with a JSON payload on stdin, return parsed JSON
 * output. Throws on non-zero exit, missing stdout, or JSON parse error.
 */
function invokeRustBinary(bin, cluster, input) {
  const payload = JSON.stringify({ cluster: cluster.id, input })
  if (verbose && !quiet) {
    console.log(`   → invoking: ${bin.cmd} ${bin.args.join(' ')}`)
    console.log(`   → stdin: ${payload}`)
  }
  const result = spawnSync(bin.cmd, bin.args, {
    input: payload,
    encoding: 'utf8',
    timeout: 30_000,
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  if (result.error) {
    throw new Error(`spawn failed: ${result.error.message}`)
  }
  if (result.status !== 0) {
    // Try to parse error from stdout first, then stderr
    let errMsg = result.stdout?.trim() || result.stderr?.trim() || '(no output)'
    try {
      const parsed = JSON.parse(errMsg)
      if (parsed.error) errMsg = parsed.error
    } catch { /* not JSON — use raw output */ }
    throw new Error(`exit ${result.status}: ${errMsg}`)
  }
  const stdout = result.stdout?.trim()
  if (!stdout) {
    throw new Error(`empty stdout (exit ${result.status})`)
  }
  try {
    const parsed = JSON.parse(stdout)
    if (parsed.error) {
      throw new Error(`binary reported error: ${parsed.error}`)
    }
    if (!('output' in parsed)) {
      throw new Error(`binary response missing "output" field: ${stdout}`)
    }
    return parsed.output
  } catch (e) {
    if (e.message.startsWith('binary')) throw e
    throw new Error(`non-JSON stdout: ${stdout.slice(0, 200)}`)
  }
}

/**
 * Format a brief diff between golden and live values.
 */
function formatDiff(golden, live, maxLen = 80) {
  const g = typeof golden === 'string' ? golden : JSON.stringify(golden)
  const l = typeof live === 'string' ? live : JSON.stringify(live)
  const truncate = (s) => s.length > maxLen ? s.slice(0, maxLen) + '…' : s
  if (g === l) return null
  return `   ~ golden: ${truncate(g)}\n     live:   ${truncate(l)}`
}

// ─── Load manifest ────────────────────────────────────────────────────────────
let manifest
try {
  manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
} catch (e) {
  console.error(`❌ Could not read manifest: ${manifestPath}`)
  console.error(`   ${e.message}`)
  process.exit(2)
}

let clusters = (manifest.clusters || []).filter(c => c.stack === 'rust')
if (clusterFilter) {
  clusters = clusters.filter(c => c.id === clusterFilter)
}

if (clusters.length === 0) {
  if (quiet) {
    console.log(JSON.stringify({ passed: 0, failed: 0, clusters: [] }))
  } else {
    console.log(`No Rust clusters found${clusterFilter ? ` matching "${clusterFilter}"` : ''}.`)
  }
  process.exit(0)
}

// ─── Validate each cluster ─────────────────────────────────────────────────────
let passed = 0
let failed = 0
const results = []

for (const cluster of clusters) {
  const cid = cluster.id
  if (!quiet) {
    console.log(`\n🔍 Validating: ${cid}`)
    console.log(`   Entry:   ${cluster.entry}`)
    if (cluster.module) console.log(`   Module:  ${cluster.module}`)
  }

  // ── Read .regret file ──────────────────────────────────────────────────────
  const regretPath = join(dirname(manifestPath), `${cid}.regret`)
  if (!existsSync(regretPath)) {
    if (!quiet) {
      console.error(`   ❌ No .regret file: ${regretPath}`)
      console.error(`      Run \`bash scripts/capture_rust.sh\` first.`)
    }
    failed++
    results.push({ id: cid, pass: false, reason: 'no .regret file' })
    if (failFast) break
    continue
  }

  let regret
  try {
    regret = parseRegret(readFileSync(regretPath, 'utf8'))
  } catch (e) {
    if (!quiet) console.error(`   ❌ Failed to parse .regret file: ${e.message}`)
    failed++
    results.push({ id: cid, pass: false, reason: `parse error: ${e.message}` })
    if (failFast) break
    continue
  }

  if (!regret.goldenHash) {
    if (!quiet) console.error(`   ❌ .regret file missing HASH line`)
    failed++
    results.push({ id: cid, pass: false, reason: 'missing HASH' })
    if (failFast) break
    continue
  }

  if (verbose && !quiet) {
    console.log(`   Golden hash: ${regret.goldenHash}`)
    console.log(`   Golden input:  ${stableStringify(regret.input)}`)
    console.log(`   Golden output: ${stableStringify(regret.output)}`)
  }

  // ── Resolve binary ─────────────────────────────────────────────────────────
  const bin = resolveBinary(cluster, manifest, dirname(manifestPath))
  if (!bin) {
    if (!quiet) {
      console.error(`   ❌ No Rust binary resolved for cluster "${cid}"`)
      console.error(`      Set "cargoBin" in manifest.json (top-level or per-cluster),`)
      console.error(`      or pass --bin <path> to validate_rust.sh.`)
    }
    failed++
    results.push({ id: cid, pass: false, reason: 'no binary' })
    if (failFast) break
    continue
  }

  // ── Invoke binary with golden input ────────────────────────────────────────
  let liveOutput
  try {
    liveOutput = invokeRustBinary(bin, cluster, regret.input)
  } catch (e) {
    if (!quiet) console.error(`   ❌ Invocation failed: ${e.message}`)
    failed++
    results.push({ id: cid, pass: false, reason: `invoke error: ${e.message}` })
    if (failFast) break
    continue
  }

  if (verbose && !quiet) {
    console.log(`   Live output:    ${stableStringify(liveOutput)}`)
  }

  // ── Recompute fingerprint ──────────────────────────────────────────────────
  // Cluster config from manifest takes precedence (allows normalize/ignoreFields
  // updates to flow through without re-capture). Falls back to .regret meta for
  // clusters where the manifest is sparse.
  const clusterConfig = {
    normalize:    cluster.normalize    || regret.normalize    || [],
    ignoreFields: cluster.ignoreFields || regret.ignoreFields || [],
  }

  const liveHash = fingerprint(regret.input, liveOutput, clusterConfig)

  // ── Compare ────────────────────────────────────────────────────────────────
  if (liveHash === regret.goldenHash) {
    if (!quiet) console.log(`   ✅ PASS — hash ${liveHash} matches golden`)
    passed++
    results.push({ id: cid, pass: true, fingerprint: liveHash })
  } else {
    if (!quiet) {
      console.error(`   ❌ FAIL — hash mismatch`)
      console.error(`      Golden: ${regret.goldenHash}`)
      console.error(`      Live:   ${liveHash}`)
      const diff = formatDiff(regret.output, liveOutput)
      if (diff) console.error(diff)
    }
    failed++
    results.push({
      id: cid,
      pass: false,
      reason: 'hash mismatch',
      goldenHash: regret.goldenHash,
      liveHash,
    })
    if (failFast) break
  }
}

// ─── Summary ──────────────────────────────────────────────────────────────────
if (quiet) {
  console.log(JSON.stringify({ passed, failed, clusters: results }))
} else {
  console.log('')
  console.log(`📊 Rust validate: ${passed} passed, ${failed} failed, ${clusters.length} total`)
}

process.exit(failed > 0 ? 1 : 0)

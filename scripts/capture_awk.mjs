// capture_awk.mjs — capture regret contracts for awk clusters.
//
// Reads regrets/manifest.json, filters clusters with `stack: "awk"`,
// invokes each cluster's awk program (specified by `file`) with each of the
// cluster's INPUTs (from `inputs[]`) as stdin, captures stdout, computes the
// 7-char base36 fingerprint (identical to fingerprint.js / capture.js /
// capture.py), and writes `.regret files` in the standard format.
//
// Model: "Whole-program I/O contract"
//   - The awk program IS the "function" — input is stdin, output is stdout.
//   - This matches how awk is used in practice: pipeline text processing.
//   - Cross-stack parity: same fingerprint algorithm as JS/Python/C/C++/Vue.
//
// Issue #315 parity (multi-input contract):
//   When a cluster has more than one entry in `inputs[]`, capture writes an
//   `INPUTS` line in the .regret file containing a JSON array of
//   `{ input, output, hash }` entries for inputs[1+] (the first input is
//   already represented by the top-level INPUT/OUTPUT/HASH trio — it's
//   intentionally OMITTED to avoid duplication, matching capture.js +
//   capture_vue.mjs convention). validate_awk.mjs compares EVERY stored
//   input's hash on re-run, so a breaking change that only affects
//   inputs[1+] is detected (no false GREEN).
//
//   Backward compatibility:
//     - Old .regret files (no INPUTS line): validate_awk.mjs falls back to
//       comparing only the first hash. Old captures still work — they just
//       don't get multi-input protection. Re-capture to opt in.
//     - New .regret files with a single input: INPUTS line is OMITTED
//       (results.length <= 1) — no overhead for the common case.
//     - New .regret files with multiple inputs: INPUTS line contains
//       results.slice(1) — validate_awk.mjs compares every hash.
//
// Usage:
//   node scripts/capture_awk.mjs                       # capture all awk clusters
//   node scripts/capture_awk.mjs --cluster <id>
//   node scripts/capture_awk.mjs --manifest <path>
//
// Environment:
//   AWK_BIN  : awk interpreter to use (default: "awk", which resolves to mawk/nawk/gawk)
//
// Requirements: Node.js 16+, any POSIX awk on PATH.

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { resolve, dirname, join } from 'node:path'
import { fingerprint, stableStringify } from './fingerprint.js'

// ─── CLI args ─────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const args = argv.slice(2)
  let clusterFilter = null
  let manifestPath = null
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--cluster' && i + 1 < args.length) {
      clusterFilter = args[++i]
    } else if (args[i] === '--manifest' && i + 1 < args.length) {
      manifestPath = args[++i]
    }
  }
  if (!manifestPath) {
    manifestPath = resolve(process.cwd(), 'regrets', 'manifest.json')
  }
  return { clusterFilter, manifestPath }
}

// ─── Spawn awk and capture stdout ─────────────────────────────────────────

function runAwk(awkFile, input, extraArgs = []) {
  return new Promise((resolvePromise, rejectPromise) => {
    const bin = process.env.AWK_BIN || 'awk'
    const args = ['-f', awkFile, ...extraArgs]
    const child = spawn(bin, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, LC_ALL: 'C' },  // deterministic locale
    })

    let stdout = ''
    let stderr = ''
    let settled = false

    child.stdout.on('data', (chunk) => { stdout += chunk.toString('utf8') })
    child.stderr.on('data', (chunk) => { stderr += chunk.toString('utf8') })

    child.on('error', (err) => {
      if (!settled) {
        settled = true
        rejectPromise(new Error(`Failed to spawn awk: ${err.message}`))
      }
    })

    child.on('close', (code) => {
      if (settled) return
      settled = true
      if (code !== 0) {
        rejectPromise(new Error(
          `awk exited with code ${code}\n` +
          `  file: ${awkFile}\n` +
          `  args: ${args.join(' ')}\n` +
          `  stderr: ${stderr.trim()}`
        ))
      } else {
        resolvePromise({ stdout, stderr })
      }
    })

    // Write input to stdin
    if (input !== null && input !== undefined) {
      child.stdin.write(input)
    }
    child.stdin.end()
  })
}

// ─── Manifest reading ─────────────────────────────────────────────────────

function readAwkClusters(manifestPath, clusterFilter) {
  if (!existsSync(manifestPath)) {
    console.error(`❌ manifest not found: ${manifestPath}`)
    process.exit(1)
  }
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  const clusters = (manifest.clusters || []).filter(c => (c.stack || '') === 'awk')
  if (clusterFilter) {
    return clusters.filter(c => c.id === clusterFilter)
  }
  return clusters
}

// ─── .regret file format ──────────────────────────────────────────────────
//
// cluster: <id>
// version: 1
// fingerprint: <hash>
// captured: <ISO-8601>
// watches: [a, b]
// entry: <entry_or_file>
// stack: awk
// file: <path>
// fingerprintLevel: entry
// ---
// INPUT  <json>
// OUTPUT <json>
// HASH   <hash>
// INPUTS <json-array>      ← Issue #315 parity: only when inputs.length > 1

function buildRegretContent(cluster, id, input, output, fp, inputsLine) {
  const lines = []
  const watches = Array.isArray(cluster.watches) ? cluster.watches : []
  const watchStr = watches.length > 0 ? watches.join(', ') : ''
  const entry = cluster.entry || cluster.file || ''
  const file = cluster.file || ''
  const level = cluster.fingerprintLevel || 'entry'

  lines.push(`cluster: ${id}`)
  lines.push(`version: 1`)
  lines.push(`fingerprint: ${fp}`)
  lines.push(`captured: ${new Date().toISOString()}`)
  lines.push(`watches: [${watchStr}]`)
  lines.push(`entry: ${entry}`)
  lines.push(`stack: awk`)
  if (file) lines.push(`file: ${file}`)
  lines.push(`fingerprintLevel: ${level}`)
  lines.push(`---`)
  // INPUT/OUTPUT: serialize as JSON strings (the actual stdin/stdout text).
  // Issue #300: do NOT coerce undefined to null — but for awk we always have a string
  // (possibly empty), so this is fine.
  lines.push(`INPUT  ${JSON.stringify(input)}`)
  lines.push(`OUTPUT ${JSON.stringify(output)}`)
  lines.push(`HASH   ${fp}`)
  // Issue #315 parity: append INPUTS line when multi-input contract exists.
  if (inputsLine) {
    lines.push(inputsLine)
  }
  return lines.join('\n') + '\n'
}

// ─── Trivial-input guard ──────────────────────────────────────────────────
//
// Per CONTEXT.md: "Output null/undefined/NaN/throws → cluster di-skip"
// For awk: empty/whitespace-only stdout is treated as trivial (skip).
// awk exit code != 0 is also treated as skip (matching JS "throws" guard).

function isTrivialOutput(output) {
  if (output === null || output === undefined) return true
  if (typeof output === 'string' && output.trim() === '') return true
  return false
}

// ─── Normalize one awk invocation's output ────────────────────────────────
//
// Apply the same trailing-newline normalization that capture.js / capture_vue.mjs
// use: strip the single trailing newline that `print x` adds, so refactors that
// switch to `printf "%s", x` (no trailing newline) don't cause false FAILs.
// The user can opt out via `preserveNewlines: true` in the cluster config.

function normalizeOutput(output, cluster) {
  if (!cluster.preserveNewlines && output.endsWith('\n')) {
    return output.slice(0, -1)
  }
  return output
}

// ─── Capture flow ─────────────────────────────────────────────────────────

async function captureCluster(cluster, manifestDir) {
  const id = cluster.id
  if (!id) throw new Error(`cluster missing required field: id`)

  const file = cluster.file
  if (!file) throw new Error(`cluster "${id}" missing required field: file`)

  // Resolve awk file path relative to manifest dir (or cwd if absolute)
  const awkFile = file.startsWith('/')
    ? file
    : resolve(manifestDir, '..', file)

  if (!existsSync(awkFile)) {
    throw new Error(`cluster "${id}": awk file not found: ${awkFile}`)
  }

  // Get list of inputs to capture. Issue #315 parity: capture ALL inputs,
  // not just inputs[0]. First input becomes the top-level golden; inputs[1+]
  // are serialized into the INPUTS line for multi-input validation.
  const inputs = Array.isArray(cluster.inputs) && cluster.inputs.length > 0
    ? cluster.inputs.map(String)
    : ['']

  // Optional extra args (e.g., -v key=value)
  const extraArgs = Array.isArray(cluster.args) ? cluster.args : []

  // Run awk once per input, collect results
  const results = []
  for (const input of inputs) {
    let result
    try {
      result = await runAwk(awkFile, input, extraArgs)
    } catch (err) {
      // awk exited non-zero — for multi-input contracts, this is a per-input
      // failure (we still capture other inputs). For single-input contracts,
      // this triggers the trivial-input skip (matching JS "throws" guard).
      results.push({
        input,
        failed: true,
        error: err.message.split('\n')[0],
      })
      continue
    }

    let output = result.stdout
    if (isTrivialOutput(output)) {
      // Skip this input — trivial output (don't include in INPUTS line)
      results.push({
        input,
        skipped: true,
        skipReason: 'output is empty/whitespace (trivial-input guard)',
      })
      continue
    }
    output = normalizeOutput(output, cluster)
    const fp = fingerprint(input, output)
    results.push({ input, output, fp })
  }

  // Find the first non-failed, non-skipped result to use as the golden top-level
  const golden = results.find(r => !r.failed && !r.skipped)
  if (!golden) {
    // All inputs failed or skipped — treat as trivial-input skip (matching
    // the original single-input behavior where awk failure = skip)
    return {
      skipped: true,
      skipReason: results[0]?.error || results[0]?.skipReason || 'all inputs failed/skipped',
    }
  }

  // Build INPUTS line for inputs[1+] — Issue #315 parity.
  // Only includes results that produced a fingerprint (failed/skipped entries
  // are excluded — they wouldn't have a hash to compare against).
  const validResults = results.filter(r => r.fp !== undefined)
  let inputsLine = null
  if (validResults.length > 1) {
    const inputsPayload = validResults.slice(1).map(r => ({
      input: r.input,
      output: r.output,
      hash: r.fp,
    }))
    inputsLine = `INPUTS ${JSON.stringify(inputsPayload)}`
  }

  const regretContent = buildRegretContent(
    cluster, id, golden.input, golden.output, golden.fp, inputsLine
  )

  return {
    skipped: false,
    fingerprint: golden.fp,
    output: golden.output,
    input: golden.input,
    regretContent,
    inputsLine,
    multiInputCount: validResults.length,
  }
}

// ─── Main ─────────────────────────────────────────────────────────────────

async function main() {
  const { clusterFilter, manifestPath } = parseArgs(process.argv)
  const clusters = readAwkClusters(manifestPath, clusterFilter)

  if (clusters.length === 0) {
    console.log('No awk clusters found in manifest.')
    return 0
  }

  const regretDir = dirname(manifestPath)
  if (!existsSync(regretDir)) {
    mkdirSync(regretDir, { recursive: true })
  }

  let captured = 0, skipped = 0, failed = 0

  for (const cluster of clusters) {
    const id = cluster.id
    console.log(`\n📡 Capturing awk cluster: ${id}`)
    try {
      const result = await captureCluster(cluster, regretDir)
      if (result.skipped) {
        console.log(`   ⏭️  Skipped: ${result.skipReason}`)
        skipped++
        continue
      }
      const regretPath = join(regretDir, `${id}.regret`)
      writeFileSync(regretPath, result.regretContent, 'utf8')
      console.log(`   ✅ Fingerprint: ${result.fingerprint}`)
      if (result.multiInputCount > 1) {
        console.log(`   📋 Multi-input contract: ${result.multiInputCount} inputs (INPUTS line written)`)
      }
      console.log(`   📄 Saved: ${regretPath}`)
      captured++
    } catch (err) {
      console.log(`   ❌ Capture failed: ${err.message}`)
      failed++
    }
  }

  console.log('\n────────────────────────────────────────')
  console.log(`Captured: ${captured}  Skipped: ${skipped}  Failed: ${failed}`)
  return failed > 0 ? 1 : 0
}

main().then((code) => process.exit(code)).catch((err) => {
  console.error('FATAL:', err)
  process.exit(2)
})

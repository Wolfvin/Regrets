// validate_awk.mjs — validate regret contracts for awk clusters.
//
// Reads regrets/manifest.json, filters clusters with `stack: "awk"`,
// re-invokes each cluster's awk program with the INPUT stored in the
// `.regret` file, compares the recomputed hash against the golden HASH,
// and reports PASS/FAIL per cluster. Non-zero exit on any failure.
//
// Usage:
//   node scripts/validate_awk.mjs                       # validate all awk clusters
//   node scripts/validate_awk.mjs --cluster <id>
//   node scripts/validate_awk.mjs --manifest <path>
//
// Environment:
//   AWK_BIN  : awk interpreter to use (default: "awk")

import { readFileSync, existsSync } from 'node:fs'
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

// ─── Spawn awk (shared with capture_awk.mjs) ──────────────────────────────

function runAwk(awkFile, input, extraArgs = []) {
  return new Promise((resolvePromise, rejectPromise) => {
    const bin = process.env.AWK_BIN || 'awk'
    const args = ['-f', awkFile, ...extraArgs]
    const child = spawn(bin, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, LC_ALL: 'C' },
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

// ─── .regret file parser ──────────────────────────────────────────────────

function parseRegret(content) {
  const result = {}
  const lines = content.split('\n')
  for (const line of lines) {
    if (line === '---') continue
    if (!line) continue
    // Match "KEY  VALUE" or "KEY: VALUE" or "KEY VALUE" — first whitespace is separator
    const m = line.match(/^(\S+)\s+(.*)$/)
    if (!m) continue
    const key = m[1]
    const val = m[2]
    if (key === 'INPUT') {
      // Parse as JSON (preserves the original string value)
      try {
        result.INPUT = JSON.parse(val)
      } catch {
        result.INPUT = val
      }
    } else if (key === 'OUTPUT') {
      try {
        result.OUTPUT = JSON.parse(val)
      } catch {
        result.OUTPUT = val
      }
    } else if (key === 'HASH') {
      result.HASH = val.trim()
    } else if (key === 'fingerprint') {
      result.fingerprint = val.trim()
    } else if (key === 'file') {
      result.file = val.trim()
    } else if (key === 'entry') {
      result.entry = val.trim()
    } else if (key === 'preserveNewlines') {
      result.preserveNewlines = val.trim() === 'true'
    } else {
      result[key] = val
    }
  }
  return result
}

// ─── Validate flow ────────────────────────────────────────────────────────

async function validateCluster(cluster, manifestDir) {
  const id = cluster.id
  if (!id) throw new Error(`cluster missing required field: id`)

  const file = cluster.file
  if (!file) throw new Error(`cluster "${id}" missing required field: file`)

  const awkFile = file.startsWith('/')
    ? file
    : resolve(manifestDir, '..', file)

  if (!existsSync(awkFile)) {
    throw new Error(`cluster "${id}": awk file not found: ${awkFile}`)
  }

  // Read existing .regret file
  const regretPath = join(manifestDir, `${id}.regret`)
  if (!existsSync(regretPath)) {
    return { missing: true }
  }

  const regretContent = readFileSync(regretPath, 'utf8')
  const parsed = parseRegret(regretContent)

  if (!parsed.HASH || parsed.INPUT === undefined) {
    throw new Error(`cluster "${id}": .regret file missing HASH or INPUT`)
  }

  const goldenHash = parsed.HASH
  const goldenInput = parsed.INPUT  // already a string (parsed from JSON)
  const goldenOutput = parsed.OUTPUT

  // Re-invoke awk with the golden input
  let result
  try {
    result = await runAwk(awkFile, goldenInput, Array.isArray(cluster.args) ? cluster.args : [])
  } catch (err) {
    return {
      failed: true,
      reason: `awk invocation failed: ${err.message.split('\n')[0]}`,
      goldenHash,
    }
  }

  let liveOutput = result.stdout
  // Apply same trailing-newline normalization as capture
  const preserveNewlines = cluster.preserveNewlines === true || parsed.preserveNewlines === true
  if (!preserveNewlines && liveOutput.endsWith('\n')) {
    liveOutput = liveOutput.slice(0, -1)
  }

  const liveHash = fingerprint(goldenInput, liveOutput)

  if (liveHash === goldenHash) {
    return { passed: true, hash: liveHash }
  }
  return {
    failed: true,
    reason: `hash mismatch`,
    goldenHash,
    liveHash,
    goldenOutput,
    liveOutput,
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

  let passed = 0, failed = 0, missing = 0

  for (const cluster of clusters) {
    const id = cluster.id
    console.log(`\n🔍 Validating awk cluster: ${id}`)
    try {
      const result = await validateCluster(cluster, regretDir)
      if (result.missing) {
        console.log(`   ❌ MISSING .regret file`)
        missing++
      } else if (result.passed) {
        console.log(`   ✅ PASS  (hash ${result.hash})`)
        passed++
      } else if (result.failed) {
        console.log(`   ❌ FAIL  ${result.reason}`)
        console.log(`           golden=${result.goldenHash}  live=${result.liveHash}`)
        if (result.goldenOutput !== undefined && result.liveOutput !== undefined) {
          console.log(`   Golden output: ${JSON.stringify(result.goldenOutput)}`)
          console.log(`   Live   output: ${JSON.stringify(result.liveOutput)}`)
        }
        failed++
      }
    } catch (err) {
      console.log(`   ❌ Validate error: ${err.message}`)
      failed++
    }
  }

  console.log('\n────────────────────────────────────────')
  console.log(`Passed: ${passed}  Failed: ${failed}  Missing: ${missing}`)
  return (failed > 0 || missing > 0) ? 1 : 0
}

main().then((code) => process.exit(code)).catch((err) => {
  console.error('FATAL:', err)
  process.exit(2)
})

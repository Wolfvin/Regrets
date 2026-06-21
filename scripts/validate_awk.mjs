// validate_awk.mjs — validate regret contracts for awk clusters.
//
// Reads regrets/manifest.json, filters clusters with `stack: "awk"`,
// re-invokes each cluster's awk program with the INPUT stored in the
// `.regret` file (and, when present, the additional inputs from the INPUTS
// line), compares the recomputed hashes against the golden hashes, and
// reports PASS/FAIL per cluster. Non-zero exit on any failure.
//
// Issue #315 parity (multi-input contract):
//   When the .regret file has an `INPUTS` line (regret.goldenInputs),
//   validate EVERY stored input's hash against the live re-run — not just
//   the first. A breaking change that only affects inputs[1+] would
//   otherwise be invisible (false GREEN). Mirrors validate.js lines
//   1986-2032 exactly.
//
//   Backward compatibility: old .regret files without an INPUTS line
//   validate exactly as before (only the first hash is compared). Re-capture
//   to opt in to multi-input protection.
//
// Modes:
//   default       — validate all (or one) clusters, report PASS/FAIL
//   --update <id> — refresh .regret golden hash(es) + INPUTS line + audit.log
//   --json        — machine-readable output
//   --fail-fast   — stop on first failure
//   --quiet       — suppress per-cluster output
//   --verbose     — extra detail (golden vs live hashes, per-input diffs)
//
// Usage:
//   node scripts/validate_awk.mjs                       # validate all awk clusters
//   node scripts/validate_awk.mjs --cluster <id>
//   node scripts/validate_awk.mjs --manifest <path>
//   node scripts/validate_awk.mjs --update <id> --reason "explanation here"
//   node scripts/validate_awk.mjs --json
//   node scripts/validate_awk.mjs --fail-fast
//   node scripts/validate_awk.mjs --quiet
//   node scripts/validate_awk.mjs --verbose
//
// Environment:
//   AWK_BIN  : awk interpreter to use (default: "awk")

import { readFileSync, writeFileSync, existsSync, mkdirSync, appendFileSync, readdirSync } from 'node:fs'
import { spawn, execSync } from 'node:child_process'
import { resolve, dirname, join, basename } from 'node:path'
import { createHash } from 'node:crypto'
import { fingerprint, stableStringify } from './fingerprint.js'

// ─── CLI args ─────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const args = argv.slice(2)
  let clusterFilter = null
  let manifestPath = null
  let updateTarget = null
  let updateReason = null
  let failFast = false
  let quiet = false
  let verbose = false
  let jsonOutput = false

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--cluster' && i + 1 < args.length) {
      clusterFilter = args[++i]
    } else if (args[i] === '--manifest' && i + 1 < args.length) {
      manifestPath = args[++i]
    } else if (args[i] === '--update' && i + 1 < args.length) {
      updateTarget = args[++i]
    } else if (args[i] === '--reason' && i + 1 < args.length) {
      updateReason = args[++i]
    } else if (args[i] === '--fail-fast') {
      failFast = true
    } else if (args[i] === '--quiet') {
      quiet = true
    } else if (args[i] === '--verbose') {
      verbose = true
    } else if (args[i] === '--json') {
      jsonOutput = true
    }
  }
  if (!manifestPath) {
    manifestPath = resolve(process.cwd(), 'regrets', 'manifest.json')
  }
  return {
    clusterFilter, manifestPath,
    updateTarget, updateReason,
    failFast, quiet, verbose, jsonOutput,
  }
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
    } else if (key === 'INPUTS') {
      // Issue #315 parity: multi-input parent contract.
      // Format: `INPUTS  <json-array>` where each element is
      //   { input, output, hash }
      try {
        const parsed = JSON.parse(val)
        if (Array.isArray(parsed) && parsed.length > 0) {
          result.goldenInputs = parsed
        }
      } catch { /* malformed INPUTS line — treat as no multi-input contract */ }
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

async function validateCluster(cluster, manifestDir, regret) {
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

  const goldenHash = regret.HASH
  const goldenInput = regret.INPUT  // already a string (parsed from JSON)

  // ─── Build the list of inputs to validate ───────────────────────────────
  //
  // Always starts with the golden input from .regret (regret.INPUT). If the
  // .regret has an INPUTS line (Issue #315 parity), add each input from it.
  // If the manifest has its own `inputs` array, add those too. Deduped by
  // JSON.stringify so we never re-run the same input twice.
  //
  // Mirrors validate.js's `inputsToValidate` construction (line ~813).
  const inputsToValidate = [goldenInput]
  const seenInputs = new Set([JSON.stringify(goldenInput)])
  if (Array.isArray(regret.goldenInputs)) {
    for (const gi of regret.goldenInputs) {
      if (!gi || typeof gi !== 'object') continue
      const key = JSON.stringify(gi.input)
      if (!seenInputs.has(key)) {
        seenInputs.add(key)
        inputsToValidate.push(gi.input)
      }
    }
  }
  if (Array.isArray(cluster.inputs)) {
    for (const inp of cluster.inputs) {
      const strInp = String(inp)
      const key = JSON.stringify(strInp)
      if (!seenInputs.has(key)) {
        seenInputs.add(key)
        inputsToValidate.push(strInp)
      }
    }
  }

  const extraArgs = Array.isArray(cluster.args) ? cluster.args : []

  // Re-run awk for each input, collect live results
  const liveInputs = []
  let firstError = null
  for (const currentInput of inputsToValidate) {
    let result
    try {
      result = await runAwk(awkFile, currentInput, extraArgs)
    } catch (err) {
      // Record the failure but continue with other inputs
      liveInputs.push({
        input: currentInput,
        failed: true,
        error: err.message.split('\n')[0],
      })
      if (!firstError) firstError = err.message.split('\n')[0]
      continue
    }
    let liveOutput = result.stdout
    const preserveNewlines = cluster.preserveNewlines === true || regret.preserveNewlines === true
    if (!preserveNewlines && liveOutput.endsWith('\n')) {
      liveOutput = liveOutput.slice(0, -1)
    }
    const liveHash = fingerprint(currentInput, liveOutput)
    liveInputs.push({ input: currentInput, hash: liveHash, output: liveOutput })
  }

  // liveInputs[0] corresponds to regret.INPUT (the golden);
  // liveInputs[1+] correspond to regret.goldenInputs[0+].
  const goldenLive = liveInputs[0]
  if (!goldenLive || goldenLive.failed) {
    return {
      failed: true,
      reason: `awk invocation failed for golden input: ${firstError || 'unknown'}`,
      goldenHash,
    }
  }
  const liveHash = goldenLive.hash
  let isMatch = liveHash === goldenHash

  // ── Issue #315 parity: multi-input contract check ────────────────────────
  //
  // When the .regret file has an `INPUTS` line (regret.goldenInputs),
  // validate EVERY stored input's hash against the live re-run — not just
  // the first. A breaking change that only affects inputs[1+] would
  // otherwise be invisible (false GREEN).
  //
  // Mirrors validate.js lines 1986-2032 exactly: match by INPUT VALUE
  // (JSON.stringify) rather than by array index. If a golden input is no
  // longer in the manifest, skip with a verbose note (user changed inputs).
  // If a manifest input has no golden, skip (no golden to compare against —
  // re-capture to add it). If ANY golden input's live hash differs from
  // its stored hash, the cluster FAILs.
  let multiInputFailures = []
  if (Array.isArray(regret.goldenInputs) && regret.goldenInputs.length > 0) {
    for (const goldenEntry of regret.goldenInputs) {
      if (!goldenEntry || typeof goldenEntry !== 'object') continue
      const goldenInputStr = JSON.stringify(goldenEntry.input)
      const liveEntry = liveInputs.find(li => JSON.stringify(li.input) === goldenInputStr)
      if (!liveEntry) {
        // Golden input is no longer in the manifest — can't re-run.
        // Skip with a verbose-only note (user changed inputs).
        continue
      }
      if (liveEntry.failed) {
        multiInputFailures.push({
          input: goldenEntry.input,
          goldenHash: goldenEntry.hash,
          liveHash: null,
          error: liveEntry.error,
        })
      } else if (liveEntry.hash !== goldenEntry.hash) {
        multiInputFailures.push({
          input: goldenEntry.input,
          goldenHash: goldenEntry.hash,
          liveHash: liveEntry.hash,
          output: liveEntry.output,
        })
      }
    }
    if (multiInputFailures.length > 0) {
      isMatch = false  // any input mismatch FAILs the cluster
    }
  }

  if (isMatch) {
    return { passed: true, hash: liveHash, liveInputs }
  }
  return {
    failed: true,
    reason: `hash mismatch`,
    goldenHash,
    liveHash,
    goldenOutput: regret.OUTPUT,
    liveOutput: goldenLive.output,
    multiInputFailures,
    liveInputs,
  }
}

// ─── Update .regret file with new golden hash + INPUTS line + audit.log ────
//
// Mirrors validate_vue.mjs's updateRegret. Writes the new hash to the .regret
// file, refreshes the INPUTS line, then appends a chain entry to audit.log.

function updateRegret(regretPath, regret, newHash, liveOutput, reason, liveInputs = null) {
  const oldHash = regret.HASH
  const now = new Date().toISOString()
  const safeReason = reason.replace(/[\r\n]+/g, ' ')

  let newContent = regret.raw
  newContent = newContent.replace(/^fingerprint: .+$/m, `fingerprint: ${newHash}`)
  newContent = newContent.replace(/^captured: .+$/m, `captured: ${now}`)
  newContent = newContent.replace(/^OUTPUT .+$/m,
    `OUTPUT ${JSON.stringify(liveOutput)}`)
  newContent = newContent.replace(/^HASH   .+$/m, `HASH   ${newHash}`)

  // ─── Issue #315 parity: refresh the INPUTS line on update ────────────────
  //
  // When updating a multi-input contract, refresh the per-input hashes too.
  // liveInputs[0] corresponds to regret.INPUT (already covered by the
  // top-level lines above); liveInputs[1+] correspond to goldenInputs[0+].
  // We rebuild the INPUTS line from liveInputs.slice(1) (same omit-first
  // convention as capture.js).
  //
  // If liveInputs is null (caller didn't pass it — backward compat), or has
  // 0 or 1 entries, drop any stale INPUTS line so the next read sees no
  // multi-input contract.
  if (liveInputs && liveInputs.length > 1) {
    const validLive = liveInputs.filter(li => !li.failed && li.hash !== undefined)
    if (validLive.length > 1) {
      const inputsPayload = validLive.slice(1).map(li => ({
        input: li.input,
        output: li.output,
        hash: li.hash,
      }))
      const newInputsLine = `INPUTS ${JSON.stringify(inputsPayload)}`
      if (/^INPUTS .+$/m.test(newContent)) {
        newContent = newContent.replace(/^INPUTS .+$/m, newInputsLine)
      } else {
        // Insert INPUTS line right after the HASH line (matches capture_awk.mjs order)
        newContent = newContent.replace(/^HASH   .+$/m, `HASH   ${newHash}\n${newInputsLine}`)
      }
    } else {
      newContent = newContent.replace(/^INPUTS .+\n?/m, '')
    }
  } else {
    // No multi-input data — drop any stale INPUTS line so the next read
    // sees no multi-input contract (otherwise validate would compare
    // against stale hashes forever).
    newContent = newContent.replace(/^INPUTS .+\n?/m, '')
  }

  writeFileSync(regretPath, newContent, 'utf8')

  // ─── Hash chain ────────────────────────────────────────────────────────────
  const regretDir = dirname(regretPath)
  const auditLog = join(regretDir, 'audit.log')
  let prevChain = '0000000'
  if (existsSync(auditLog)) {
    const logContent = readFileSync(auditLog, 'utf8').trim()
    if (logContent) {
      const lines = logContent.split('\n')
      for (let i = lines.length - 1; i >= 0; i--) {
        const m = lines[i].match(/^\s*chain:\s*(\S+)/)
        if (m) { prevChain = m[1]; break }
      }
    }
  }

  const clusterId = basename(regretPath, '.regret')

  let gitAuthor = null
  let gitSha = null
  const ciRunId = process.env.GITHUB_RUN_ID || process.env.CI_RUN_ID || null
  try {
    const gitName = execSync('git config user.name',
      { stdio: ['ignore', 'pipe', 'ignore'], cwd: process.cwd() }).toString().trim()
    const gitEmail = execSync('git config user.email',
      { stdio: ['ignore', 'pipe', 'ignore'], cwd: process.cwd() }).toString().trim()
    if (gitName) gitAuthor = gitEmail ? `${gitName} <${gitEmail}>` : gitName
  } catch { /* not a git repo, or git missing */ }
  try {
    gitSha = execSync('git rev-parse --short HEAD',
      { stdio: ['ignore', 'pipe', 'ignore'], cwd: process.cwd() }).toString().trim()
  } catch { /* no commits yet */ }

  const newEntryLines = [
    `${now}  UPDATE  ${clusterId}`,
    `  old: ${oldHash}`,
    `  new: ${newHash}`,
    `  reason: ${safeReason}`,
    `  by: AI refactor session`,
  ]
  if (gitAuthor) newEntryLines.push(`  gitAuthor: ${gitAuthor}`)
  if (gitSha)    newEntryLines.push(`  gitSha: ${gitSha}`)
  if (ciRunId)   newEntryLines.push(`  ciRunId: ${ciRunId}`)
  const newEntryContent = newEntryLines.join('\n')
  const chainHash = createHash('sha256')
    .update(prevChain + newEntryContent).digest('hex').slice(0, 7)

  const entry = `\n${newEntryContent}\n  chain: ${chainHash}`
  mkdirSync(regretDir, { recursive: true })
  appendFileSync(auditLog, entry, 'utf8')

  return { oldHash, newHash }
}

// ─── Main ─────────────────────────────────────────────────────────────────

async function main() {
  const opts = parseArgs(process.argv)
  const { clusterFilter, manifestPath, updateTarget, updateReason,
          failFast, quiet, verbose, jsonOutput } = opts

  // Conflict guards
  if (quiet && verbose) {
    console.error('❌ --quiet and --verbose are mutually exclusive')
    process.exit(2)
  }
  if (updateTarget && clusterFilter && updateTarget !== clusterFilter) {
    console.error(`❌ --update ${updateTarget} and --cluster ${clusterFilter} conflict`)
    process.exit(2)
  }

  // Validate --update usage — require a reason with at least 4 words
  if (updateTarget && !updateReason) {
    console.error('❌ --update requires --reason')
    console.error('   Example: --update sum-column --reason "input format changed from csv to tsv per new spec"')
    process.exit(2)
  }
  if (updateReason && updateReason.trim().split(/\s+/).length < 4) {
    console.error(`❌ --reason is too vague: "${updateReason}"`)
    console.error('   Be specific. e.g. "input format changed from csv to tsv per new spec"')
    process.exit(2)
  }

  const clusters = readAwkClusters(manifestPath, updateTarget || clusterFilter)

  if (clusters.length === 0) {
    console.log('No awk clusters found in manifest.')
    return 0
  }

  const regretDir = dirname(manifestPath)

  if (!jsonOutput && !quiet) {
    if (updateTarget) {
      console.log(`\n🔄 Update mode — cluster: ${updateTarget}`)
      console.log(`   Reason: ${updateReason}\n`)
    } else {
      console.log(`\n🔍 Validating ${clusters.length} awk cluster(s)...\n`)
    }
  }

  let passed = 0, failed = 0, missing = 0, updated = 0
  const results = []

  for (const cluster of clusters) {
    const id = cluster.id
    if (!jsonOutput && !quiet) console.log(`🔍 Validating awk cluster: ${id}`)

    // Read existing .regret file
    const regretPath = join(regretDir, `${id}.regret`)
    if (!existsSync(regretPath)) {
      if (!jsonOutput && !quiet) console.log(`   ❌ MISSING .regret file`)
      missing++
      results.push({ id, pass: false, missing: true })
      if (failFast) break
      continue
    }

    const regretContent = readFileSync(regretPath, 'utf8')
    const regret = { ...parseRegret(regretContent), raw: regretContent }

    if (!regret.HASH || regret.INPUT === undefined) {
      if (!jsonOutput && !quiet) console.log(`   ❌ .regret file missing HASH or INPUT`)
      failed++
      results.push({ id, pass: false, error: 'missing HASH or INPUT' })
      if (failFast) break
      continue
    }

    let result
    try {
      result = await validateCluster(cluster, regretDir, regret)
    } catch (err) {
      if (!jsonOutput && !quiet) console.log(`   ❌ Validate error: ${err.message}`)
      failed++
      results.push({ id, pass: false, error: err.message })
      if (failFast) break
      continue
    }

    if (result.missing) {
      if (!jsonOutput && !quiet) console.log(`   ❌ MISSING .regret file`)
      missing++
      results.push({ id, pass: false, missing: true })
    } else if (result.passed) {
      if (updateTarget) {
        // No change → no update needed
        if (!jsonOutput && !quiet) console.log(`   ℹ️  ${id} unchanged — no update needed`)
        passed++
        results.push({ id, pass: true })
      } else {
        if (!jsonOutput && !quiet) console.log(`   ✅ PASS  (hash ${result.hash})`)
        passed++
        results.push({ id, pass: true, hash: result.hash })
      }
    } else if (result.failed) {
      if (updateTarget) {
        // Refresh the .regret with the new golden
        const liveInputs = result.liveInputs || []
        const updateResult = updateRegret(
          regretPath, regret, result.liveHash,
          result.liveOutput, updateReason, liveInputs
        )
        if (!jsonOutput && !quiet) {
          console.log(`   ✅ UPDATED  ${updateResult.oldHash} → ${updateResult.newHash}`)
          if (liveInputs.length > 1) {
            console.log(`   📋 Refreshed INPUTS line (${liveInputs.length} inputs)`)
          }
        }
        updated++
        results.push({
          id, pass: true, updated: true,
          oldHash: updateResult.oldHash, newHash: updateResult.newHash,
        })
      } else {
        if (!jsonOutput && !quiet) {
          console.log(`   ❌ FAIL  ${result.reason}`)
          console.log(`           golden=${result.goldenHash}  live=${result.liveHash}`)
          if (result.goldenOutput !== undefined && result.liveOutput !== undefined) {
            console.log(`   Golden output: ${JSON.stringify(result.goldenOutput)}`)
            console.log(`   Live   output: ${JSON.stringify(result.liveOutput)}`)
          }
          if (result.multiInputFailures && result.multiInputFailures.length > 0) {
            console.log(`   Multi-input failures:`)
            for (const f of result.multiInputFailures) {
              console.log(`     • input ${JSON.stringify(f.input)}`)
              if (f.error) {
                console.log(`       Error: ${f.error}`)
              } else {
                console.log(`       Expected: ${f.goldenHash}  Got: ${f.liveHash}`)
              }
            }
          }
        }
        failed++
        results.push({
          id, pass: false,
          golden: result.goldenHash, live: result.liveHash,
          ...(result.multiInputFailures && result.multiInputFailures.length > 0
              ? { multiInputFailures: result.multiInputFailures }
              : {}),
        })
      }
    }

    if (failFast && !results.at(-1).pass) {
      if (!jsonOutput && !quiet) console.log(`\n  --fail-fast: stopping.`)
      break
    }
  }

  if (jsonOutput) {
    console.log(JSON.stringify({
      stack: 'awk',
      total: results.length,
      passed, failed, missing, updated,
      results,
    }, null, 2))
  } else {
    console.log('\n────────────────────────────────────────')
    if (updateTarget) {
      console.log(`Updated: ${updated}  Unchanged: ${passed}  Failed: ${failed}  Missing: ${missing}`)
    } else {
      console.log(`Passed: ${passed}  Failed: ${failed}  Missing: ${missing}`)
    }
  }
  return (failed > 0 || missing > 0) ? 1 : 0
}

main().then((code) => process.exit(code)).catch((err) => {
  console.error('FATAL:', err)
  process.exit(2)
})

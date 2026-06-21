#!/usr/bin/env node
// validate_react.mjs — React component render validator
//
// Mirrors scripts/capture_react.mjs: re-renders each captured React component
// with the .regret INPUT, recomputes the fingerprint of the normalized HTML,
// and compares against the stored HASH. Reports PASS/FAIL per cluster.
//
// This is the React-aware counterpart to validate.js. The CLI dispatcher in
// scripts/regret.js routes `stack: "react"` clusters here for validate / update
// / drift, because validate.js cannot render React components — it would
// otherwise import the component and call it as a plain function, returning
// a React element object whose fingerprint never matches the captured HTML.
//
// Usage:
//   node scripts/validate_react.mjs
//   node scripts/validate_react.mjs --cluster invoice-card-render
//   node scripts/validate_react.mjs --manifest ./regrets/manifest.json
//   node scripts/validate_react.mjs --update invoice-card-render --reason "..."
//   node scripts/validate_react.mjs --fail-fast
//   node scripts/validate_react.mjs --quiet
//   node scripts/validate_react.mjs --verbose
//   node scripts/validate_react.mjs --json
//   node scripts/validate_react.mjs --runs 5    (drift detection)

import { readFileSync, writeFileSync, readdirSync, appendFileSync, existsSync, mkdirSync } from 'fs'
import { resolve, join, basename } from 'path'
import { fileURLToPath, pathToFileURL } from 'url'
import { execSync } from 'child_process'
import { createHash } from 'crypto'
import { fingerprint, normalize as fpNormalize, stableStringify, stripFields, extractSchema } from './fingerprint.js'
import { deepClone, normalizeHtml } from './ghost.js'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

const __dirname = fileURLToPath(new URL('.', import.meta.url))

// ─── CLI args ─────────────────────────────────────────────────────────────────

function getArg(args, flag) {
  const i = args.indexOf(flag)
  return i !== -1 ? args[i + 1] ?? null : null
}

const args = process.argv.slice(2)
const clusterFilter = getArg(args, '--cluster')
const manifestPath = getArg(args, '--manifest') ?? resolve(process.cwd(), 'regrets/manifest.json')
const updateTarget  = getArg(args, '--update')
const updateReason  = getArg(args, '--reason')
const failFast      = args.includes('--fail-fast')
const quiet         = args.includes('--quiet')
const verbose       = args.includes('--verbose')
const jsonOutput    = args.includes('--json')
const runsArg       = getArg(args, '--runs')
const runs          = parseInt(runsArg ?? '1', 10)
const driftMode     = runs > 1 && !updateTarget

// Conflict guards — quiet+verbose is nonsensical; --update with --cluster is
// confusing (we use --update's value as the cluster id directly).
if (quiet && verbose) {
  console.error('❌ --quiet and --verbose are mutually exclusive')
  process.exit(2)
}
if (updateTarget && clusterFilter && updateTarget !== clusterFilter) {
  console.error(`❌ --update ${updateTarget} and --cluster ${clusterFilter} conflict`)
  process.exit(2)
}

// Validate --update usage — require a reason with at least 4 words so the
// audit trail carries intent (mirrors validate.js / validate_php.php).
if (updateTarget && !updateReason) {
  console.error('❌ --update requires --reason')
  console.error('   Example: --update invoice-card-render --reason "currency code changed from IDR to USD"')
  process.exit(2)
}
if (updateReason && updateReason.trim().split(/\s+/).length < 4) {
  console.error(`❌ --reason is too vague: "${updateReason}"`)
  console.error('   Be specific. e.g. "currency code changed from IDR to USD per new locale requirement"')
  process.exit(2)
}

// ─── Load manifest ────────────────────────────────────────────────────────────

let manifest
try {
  manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
} catch (err) {
  console.error(`❌ Could not read manifest: ${manifestPath}`)
  console.error(`   ${err.message}`)
  process.exit(1)
}

const regretDir = resolve(process.cwd(), 'regrets')
const auditLog  = join(regretDir, 'audit.log')

// ─── Parse .regret file ───────────────────────────────────────────────────────
//
// Format (produced by capture_react.mjs):
//   cluster: <id>
//   version: 1
//   fingerprint: <7char>
//   captured: <ISO>
//   watches: [<entry>]
//   entry: <entry>
//   stack: react
//   renderMode: static
//   [normalize: [a, b]]
//   [ignoreFields: [a, b]]
//   [stripAttrs: [a, b]]
//   [fingerprintMode: schema|mixed|value]
//   ---
//   INPUT  <JSON>
//   OUTPUT <JSON>
//   HASH   <7char>
//
// We split on the first "\n---\n" boundary. Metadata lines are "key: value"
// (note the space after colon). The data section has three tagged lines.

function parseListLiteral(val) {
  // val looks like "[a, b, c]" or "[]" — strip brackets, split on commas,
  // trim each entry, drop empty strings. Strings stay unquoted (capture
  // writes them unquoted: "[style, data-testid]").
  if (!val) return []
  const inner = val.replace(/^\[/, '').replace(/\]$/, '').trim()
  if (!inner) return []
  return inner.split(',').map(s => s.trim()).filter(Boolean)
}

function parseRegret(content) {
  const sections = content.split('\n---\n', 2)
  if (sections.length !== 2) {
    throw new Error('Invalid .regret format: missing "---" separator')
  }
  const metaSection = sections[0]
  const dataSection = sections[1]

  const meta = {}
  for (const line of metaSection.split('\n')) {
    const colonIdx = line.indexOf(': ')
    if (colonIdx === -1) continue
    const key = line.slice(0, colonIdx)
    const val = line.slice(colonIdx + 2).trim()
    if (key === 'watches' || key === 'normalize' || key === 'ignoreFields' ||
        key === 'stripAttrs' || key === 'valuePaths') {
      meta[key] = parseListLiteral(val)
    } else if (key === 'version') {
      meta[key] = parseInt(val, 10)
    } else if (key === 'multiArgs') {
      meta[key] = val === 'true'
    } else {
      meta[key] = val
    }
  }

  // Parse data section: find INPUT / OUTPUT / HASH / INPUTS lines
  let parsedInput = null
  let parsedOutput = null
  let goldenHash = null
  let goldenInputs = null  // Issue #315 — multi-input contract

  for (const line of dataSection.split('\n')) {
    if (line.startsWith('INPUT ')) {
      const s = line.slice('INPUT '.length)
      parsedInput = s === 'undefined' ? null : JSON.parse(s)
    } else if (line.startsWith('OUTPUT ')) {
      const s = line.slice('OUTPUT '.length)
      parsedOutput = s === 'undefined' ? null : JSON.parse(s)
    } else if (line.startsWith('HASH ')) {
      goldenHash = line.slice('HASH '.length).trim()
    } else if (line.startsWith('INPUTS ')) {
      // Multi-input contract: array of { input, output, hash } for inputs[1+]
      // (first input is in the top-level INPUT/OUTPUT/HASH lines).
      // Absent on old .regret files and on single-input captures.
      try {
        const parsed = JSON.parse(line.slice('INPUTS '.length))
        if (Array.isArray(parsed) && parsed.length > 0) {
          goldenInputs = parsed
        }
      } catch { goldenInputs = null }
    }
  }

  return {
    ...meta,
    input: parsedInput,
    output: parsedOutput,
    goldenHash,
    goldenInputs,
    raw: content,
  }
}

// ─── Resolve component module ─────────────────────────────────────────────────
//
// Mirrors capture_react.mjs's resolution: try the manifest `file` path as-is,
// then fall back to `.js` if the original was `.tsx`/`.jsx`, then fall back
// to a `js/` mirror directory. Same logic, same precedence — so capture and
// validate always agree on which file represents the component.

function resolveComponentPath(file) {
  const absPath = resolve(process.cwd(), file)
  try {
    readFileSync(absPath)
    return absPath
  } catch { /* fall through */ }

  const jsPath = absPath.replace(/\.(tsx|jsx)$/, '.js')
  try {
    readFileSync(jsPath)
    return jsPath
  } catch { /* fall through */ }

  // Last resort: js/ mirror (matches capture_react.mjs line 78)
  const jsMirror = resolve(process.cwd(), 'js',
    file.replace(/^src\//, '').replace(/\.(tsx|jsx)$/, '.js'))
  return jsMirror
}

// ─── Render a component with props and normalize HTML ─────────────────────────
//
// Same rendering pipeline as capture_react.mjs:
//   React.createElement(Component, props) → renderToStaticMarkup → normalizeHtml
// Returns { rawHtml, html } so verbose mode can show both.

async function renderComponent(Component, props, stripAttrs = []) {
  const element = React.createElement(Component, props)
  const rawHtml = renderToStaticMarkup(element)
  const html = normalizeHtml(rawHtml, stripAttrs)
  return { rawHtml, html }
}

// ─── Compute fingerprint for an input + rendered HTML ─────────────────────────
//
// Mirrors capture_react.mjs's fingerprint logic exactly. Default mode is
// "value" (fingerprint the normalized HTML string). Schema / mixed modes
// are kept for parity with capture, but capture_react.mjs only emits
// fingerprintMode when the manifest sets it, so the common case is value.

function computeFingerprint(input, html, clusterConfig = {}) {
  const {
    normalize: normRules = [],
    ignoreFields = [],
    fingerprintMode,
    valuePaths = [],
  } = clusterConfig

  if (fingerprintMode === 'schema') {
    const schema = extractSchema(html)
    return fingerprint(input, schema, { normalize: normRules, ignoreFields })
  }
  if (fingerprintMode === 'mixed') {
    // capture_react.mjs currently emits an empty `values` map for HTML strings
    // because valuePaths on a string output aren't well-defined. We mirror
    // that exactly so capture and validate stay bit-identical.
    const schema = extractSchema(html)
    const selectedValues = {}
    const combined = { schema, values: selectedValues }
    return fingerprint(input, combined, { normalize: normRules, ignoreFields })
  }
  // Default: value mode — fingerprint the normalized HTML string itself
  return fingerprint(input, html, { normalize: normRules, ignoreFields })
}

// ─── Update a .regret file with a new golden hash + audit.log entry ───────────
//
// Mirrors validate.js's update path (lines ~1320-1482) but simplified for
// React (no callee contracts, no mutationFingerprint). Writes the new hash
// to the .regret, then appends a chain entry to audit.log.

function updateRegret(regretPath, regret, newHash, liveOutput, reason, newInputsLine = null) {
  const oldHash = regret.goldenHash
  const now = new Date().toISOString()
  const safeReason = reason.replace(/[\r\n]+/g, ' ')

  // Rewrite the .regret: update fingerprint, captured, OUTPUT, HASH lines.
  // We avoid a full reserialize to preserve any extra fields the capture
  // wrote (custom metadata, etc.). The "fingerprint:" line lives in meta,
  // "OUTPUT" / "HASH" lines live in data.
  let newContent = regret.raw
  newContent = newContent.replace(/^fingerprint: .+$/m, `fingerprint: ${newHash}`)
  newContent = newContent.replace(/^captured: .+$/m, `captured: ${now}`)
  newContent = newContent.replace(/^OUTPUT .+$/m,
    `OUTPUT ${JSON.stringify(liveOutput)}`)
  newContent = newContent.replace(/^HASH   .+$/m, `HASH   ${newHash}`)

  // Refresh the INPUTS line (multi-input contract, Issue #315).
  // - If newInputsLine is provided, replace any existing INPUTS line (or
  //   append if none existed yet — though in practice update mode is only
  //   reached when there's a mismatch, and a mismatch on a multi-input
  //   cluster usually means the INPUTS line already exists).
  // - If newInputsLine is null but the .regret had an INPUTS line, keep
  //   the old line (we have no new live data for inputs[1+] — e.g., the
  //   update was triggered by the golden input alone).
  if (newInputsLine) {
    if (/^INPUTS /m.test(newContent)) {
      newContent = newContent.replace(/^INPUTS .+$/m, newInputsLine)
    } else {
      // Append INPUTS line at the end (after HASH). Trailing newline is OK.
      newContent = newContent.replace(/\n*$/, '') + '\n' + newInputsLine + '\n'
    }
  }

  writeFileSync(regretPath, newContent, 'utf8')

  // ─── Hash chain ────────────────────────────────────────────────────────────
  // Read previous chain hash from audit.log (or use genesis "0000000").
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

  // Best-effort git/CI provenance — same fields as validate.js (#250).
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

// ─── Discover React clusters + matching .regret files ─────────────────────────

const reactClusters = (manifest.clusters || []).filter(c => c.stack === 'react')
const clusterById = new Map(reactClusters.map(c => [c.id, c]))

// Effective filter: --update takes priority over --cluster
const filterId = updateTarget ?? clusterFilter

// Collect .regret files that match React clusters and the filter (if any).
let regretFiles = []
try {
  const all = readdirSync(regretDir).filter(f => f.endsWith('.regret'))
  for (const f of all) {
    const id = basename(f, '.regret')
    // Only consider .regret files whose id is a known React cluster — this
    // prevents validate_react from accidentally processing a JS/Python
    // cluster's .regret if the user accidentally has mixed stacks in one
    // regrets/ dir.
    if (!clusterById.has(id)) continue
    if (filterId && id !== filterId) continue
    regretFiles.push(f)
  }
} catch (err) {
  if (!jsonOutput && !quiet) {
    console.error(`❌ Could not read regrets/ directory: ${err.message}`)
  }
  process.exit(1)
}

if (!regretFiles.length) {
  if (!jsonOutput) {
    const scope = filterId ? ` for "${filterId}"` : ''
    console.error(`❌ No React .regret files found${scope}.`)
    console.error('   Run `node scripts/capture_react.mjs` first to capture fingerprints.')
  }
  process.exit(1)
}

// ─── Header ───────────────────────────────────────────────────────────────────

if (!jsonOutput && !quiet) {
  if (updateTarget) {
    console.log(`\n🔄 Update mode — cluster: ${updateTarget}`)
    console.log(`   Reason: ${updateReason}\n`)
  } else if (driftMode) {
    console.log(`\n🔍 Drift detection — ${runs} runs per cluster...\n`)
  } else {
    console.log(`\n🔍 Validating ${regretFiles.length} React cluster(s)...\n`)
  }
}

// ─── Validate each .regret ────────────────────────────────────────────────────

const results = []

for (const file of regretFiles) {
  const id = basename(file, '.regret')
  const regretPath = join(regretDir, file)

  let regret
  try {
    regret = parseRegret(readFileSync(regretPath, 'utf8'))
  } catch (err) {
    if (!jsonOutput && !quiet) {
      console.log(`  ❌ ${id.padEnd(35)} PARSE ERROR: ${err.message}`)
    }
    results.push({ id, pass: false, error: `parse: ${err.message}` })
    if (failFast) break
    continue
  }

  const clusterDef = clusterById.get(id)
  if (!clusterDef) {
    // Should be unreachable given the filter above, but guard anyway.
    if (!jsonOutput && !quiet) {
      console.log(`  ⚠️  ${id.padEnd(35)} not in manifest — skipping`)
    }
    continue
  }

  // Resolve and import the component module
  let Component
  try {
    const absPath = resolveComponentPath(clusterDef.file)
    const moduleUrl = pathToFileURL(absPath).href
    const mod = await import(moduleUrl)
    Component = mod[regret.entry] ?? mod.default?.[regret.entry] ?? mod.default
    if (!Component) {
      throw new Error(`Component "${regret.entry}" not found in ${clusterDef.file}`)
    }
  } catch (err) {
    if (!jsonOutput && !quiet) {
      console.log(`  ❌ ${id.padEnd(35)} IMPORT ERROR: ${err.message}`)
    }
    results.push({ id, pass: false, error: `import: ${err.message}` })
    if (failFast) break
    continue
  }

  // Cluster config: merge manifest + .regret metadata (.regret wins for
  // fields that capture wrote, e.g., stripAttrs may have been added
  // post-capture).
  const stripAttrs = regret.stripAttrs ?? clusterDef.stripAttrs ?? []
  const normRules = regret.normalize ?? clusterDef.normalize ?? []
  const ignoreFields = regret.ignoreFields ?? clusterDef.ignoreFields ?? []
  const fingerprintMode = regret.fingerprintMode ?? clusterDef.fingerprintMode
  const valuePaths = regret.valuePaths ?? clusterDef.valuePaths ?? []
  const clusterConfig = { normalize: normRules, ignoreFields, fingerprintMode, valuePaths }

  // Re-render N times for drift detection (or once for normal validate).
  //
  // Multi-input contract (Issue #315 parity): when the .regret has an
  // `INPUTS` line (regret.goldenInputs), validate EVERY stored input's
  // hash — not just the first. A breaking change that only affects
  // inputs[1+] would otherwise be invisible (false GREEN).
  //
  // inputsToValidate = [regret.input] + (manifest inputs that differ from
  // regret.input). The goldenInputs array covers inputs 1+ (the first
  // input is the top-level INPUT/OUTPUT/HASH trio). liveInputs is parallel:
  // liveInputs[0] is the golden, liveInputs[1+] correspond to
  // goldenInputs[0+].
  const allManifestInputs = (clusterDef.inputs && clusterDef.inputs.length > 0)
    ? clusterDef.inputs
    : [regret.input]
  const inputsToValidate = [regret.input]
  for (const inp of allManifestInputs) {
    if (JSON.stringify(inp) !== JSON.stringify(regret.input)) {
      inputsToValidate.push(inp)
    }
  }

  const hashes = []           // flat list of hashes for the golden input (for backward compat)
  const hashesPerInput = new Map()  // inputKey → hash[]
  const liveInputs = []       // parallel to inputsToValidate; each = { input, hash, output }
  let lastOutput = null
  let lastError = null

  try {
    for (let i = 0; i < runs; i++) {
      // For each run, re-render EVERY input (not just the golden).
      for (let inpIdx = 0; inpIdx < inputsToValidate.length; inpIdx++) {
        const currentInput = inputsToValidate[inpIdx]
        const { html } = await renderComponent(Component, currentInput, stripAttrs)
        const fp = computeFingerprint(currentInput, html, clusterConfig)

        // Track hashes for golden input (backward compat with `hashes` array
        // used by drift detection and update mode below)
        if (inpIdx === 0) {
          hashes.push(fp)
          lastOutput = html
        }

        // Per-input drift detection
        const inputKey = JSON.stringify(currentInput)
        if (!hashesPerInput.has(inputKey)) hashesPerInput.set(inputKey, [])
        hashesPerInput.get(inputKey).push(fp)

        // Record live input hash on the LAST run (so update mode + multi-input
        // refresh sees the final state). liveInputs[inpIdx] is overwritten
        // each run; only the final value is used downstream.
        liveInputs[inpIdx] = { input: currentInput, hash: fp, output: html }
      }
    }
  } catch (err) {
    lastError = err
  }

  if (lastError) {
    if (!jsonOutput && !quiet) {
      console.log(`  ❌ ${id.padEnd(35)} RENDER ERROR: ${lastError.message}`)
    }
    results.push({ id, pass: false, error: `render: ${lastError.message}` })
    if (failFast) break
    continue
  }

  const liveHash = hashes[0]
  let isMatch = liveHash === regret.goldenHash

  // ── Multi-input contract check (Issue #315) ──────────────────────────────
  //
  // Compare each goldenInputs[i].hash against the live hash of the matching
  // input (matched by VALUE, not array index — manifest may have evolved).
  // If a golden input is no longer in the manifest, skip with a verbose-only
  // note (user changed inputs). If ANY golden input's live hash differs,
  // the cluster FAILs — even when the first input still matches.
  let multiInputFailures = []
  if (Array.isArray(regret.goldenInputs) && regret.goldenInputs.length > 0) {
    for (const goldenEntry of regret.goldenInputs) {
      if (!goldenEntry || typeof goldenEntry !== 'object') continue
      const goldenInputStr = JSON.stringify(goldenEntry.input)
      const liveEntry = liveInputs.find(li => li && JSON.stringify(li.input) === goldenInputStr)
      if (!liveEntry) {
        // Golden input no longer in manifest — can't re-run. Skip with a
        // verbose-only note (the user changed inputs).
        if (verbose && !jsonOutput && !quiet) {
          console.log(`  │ ⏭️  input ${goldenInputStr} no longer in manifest — skipping (re-capture to refresh)`)
        }
        continue
      }
      if (liveEntry.hash !== goldenEntry.hash) {
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

  // Drift = same input producing different hashes across runs
  const isDrift = driftMode && [...hashesPerInput.values()].some(arr => new Set(arr).size > 1)

  // Verbose: per-cluster detail
  if (verbose && !jsonOutput) {
    console.log(`  ┌─ ${id} ────────────────────────────────────`)
    console.log(`  │ Input:      ${JSON.stringify(regret.input)}`)
    console.log(`  │ Expected:   ${regret.goldenHash}`)
    console.log(`  │ Actual:     ${liveHash}`)
    console.log(`  │ Output:     ${JSON.stringify(lastOutput)?.slice(0, 200)}${JSON.stringify(lastOutput)?.length > 200 ? '…' : ''}`)
    if (stripAttrs.length) console.log(`  │ stripAttrs: ${stripAttrs.join(', ')}`)
    if (normRules.length)  console.log(`  │ normalize:  ${normRules.join(', ')}`)
    if (runs > 1)          console.log(`  │ Hashes:     ${hashes.join(' / ')}`)
    if (liveInputs.length > 1) {
      console.log(`  │ Multi-input (${liveInputs.length} inputs):`)
      for (let li = 0; li < liveInputs.length; li++) {
        const li_entry = liveInputs[li]
        const golden = li === 0 ? regret.goldenHash : regret.goldenInputs?.[li - 1]?.hash
        const ok = li_entry.hash === golden
        console.log(`  │   [${li}] ${ok ? '✓' : '✗'} ${li_entry.hash}  input=${JSON.stringify(li_entry.input)?.slice(0, 80)}`)
      }
    }
    if (multiInputFailures.length > 0) {
      console.log(`  │ ⚠️  ${multiInputFailures.length} multi-input failure(s):`)
      for (const f of multiInputFailures) {
        console.log(`  │   input=${JSON.stringify(f.input)?.slice(0, 80)}`)
        console.log(`  │     golden=${f.goldenHash} live=${f.liveHash}`)
      }
    }
    console.log(`  └────────────────────────────────────────────`)
  }

  const idPadded = id.padEnd(35)

  if (updateTarget) {
    // Update mode: rewrite .regret + audit.log
    if (isMatch) {
      if (!jsonOutput && !quiet) console.log(`  ℹ️  ${idPadded} unchanged — no update needed`)
      results.push({ id, pass: true })
    } else {
      // Refresh BOTH the top-level hash AND the INPUTS line (if multi-input).
      // liveInputs[0] is the golden (already represented by top-level lines);
      // liveInputs[1+] become the new INPUTS payload (mirrors validate.js).
      let newInputsLine = null
      if (liveInputs.length > 1) {
        const payload = liveInputs.slice(1).map(li => ({
          input: li.input,
          output: li.output,
          hash: li.hash,
        }))
        newInputsLine = `INPUTS ${JSON.stringify(payload)}`
      }
      const updateResult = updateRegret(regretPath, regret, liveHash, lastOutput, updateReason, newInputsLine)
      if (!jsonOutput && !quiet) {
        console.log(`  ✅ ${idPadded} ${updateResult.oldHash} → ${updateResult.newHash}  UPDATED`)
      }
      results.push({ id, pass: true, updated: true, oldHash: updateResult.oldHash, newHash: updateResult.newHash })
    }
  } else if (driftMode) {
    if (isDrift) {
      if (!jsonOutput && !quiet) console.log(`  ❌ ${idPadded} DRIFT  [${hashes.join(' / ')}]`)
      results.push({ id, pass: false, drift: true, hashes })
    } else {
      const icon = isMatch ? '✅' : '❌'
      if (!jsonOutput && !quiet) {
        console.log(`  ${icon} ${idPadded} ${liveHash}  × ${runs}  ${isMatch ? 'PASS+STABLE' : 'FAIL'}`)
      }
      results.push({ id, pass: isMatch, golden: regret.goldenHash, live: liveHash, hashes })
    }
  } else {
    // Normal validate
    const icon = isMatch ? '✅' : '❌'
    let hstr
    if (isMatch) {
      hstr = regret.goldenHash
    } else if (multiInputFailures.length > 0) {
      // Multi-input failure: show that the cause is a non-first input
      hstr = `${regret.goldenHash} → ${liveHash} (+${multiInputFailures.length} input fail)`
    } else {
      hstr = `${regret.goldenHash} → ${liveHash}`
    }
    if (!jsonOutput && !quiet) {
      console.log(`  ${icon} ${idPadded} ${hstr.padEnd(22)} ${isMatch ? 'PASS' : 'FAIL'}`)
    }
    results.push({
      id, pass: isMatch,
      golden: regret.goldenHash, live: liveHash,
      multiInputFailures: multiInputFailures.length > 0 ? multiInputFailures : undefined,
    })
  }

  if (failFast && !results.at(-1).pass) {
    if (!jsonOutput && !quiet) console.log(`\n  --fail-fast: stopping.`)
    break
  }
}

// ─── Summary ──────────────────────────────────────────────────────────────────

const passed = results.filter(r => r.pass).length
const failed = results.filter(r => !r.pass).length
const drifted = results.filter(r => r.drift).length

if (jsonOutput) {
  console.log(JSON.stringify({
    stack: 'react',
    total: results.length,
    passed,
    failed,
    drifted,
    results,
  }, null, 2))
} else if (!quiet) {
  console.log(`\n${'─'.repeat(60)}`)
  if (updateTarget) {
    const updated = results.filter(r => r.updated).length
    console.log(`✅ Update complete. ${updated} updated.`)
    console.log(`   Audit: regrets/audit.log`)
  } else if (driftMode && drifted > 0) {
    console.log(`❌ Drift in ${drifted} cluster(s). Add normalize rules and re-capture.`)
  } else if (failed === 0) {
    console.log(`✅ All ${passed} React tests passed${driftMode ? ` (${runs} runs — stable)` : ''}. Refactor is safe.\n`)
  } else {
    console.log(`❌ ${failed}/${results.length} FAILED.\n`)
    for (const r of results.filter(r => !r.pass)) {
      console.log(`  • ${r.id}`)
      if (r.error) {
        console.log(`    ${r.error}`)
      } else if (r.drift) {
        console.log(`    drift: ${r.hashes.join(' / ')}`)
      } else if (r.multiInputFailures && r.multiInputFailures.length > 0) {
        console.log(`    Expected: ${r.golden}  Got: ${r.live}  (golden input still matches)`)
        console.log(`    Multi-input failure(s):`)
        for (const f of r.multiInputFailures) {
          console.log(`      input=${JSON.stringify(f.input).slice(0, 80)}`)
          console.log(`        golden=${f.goldenHash}  live=${f.liveHash}`)
        }
      } else {
        console.log(`    Expected: ${r.golden}  Got: ${r.live}`)
      }
    }
    console.log(`\nFix the CODE — do not edit .regret files.`)
    console.log(`Re-run: node scripts/validate_react.mjs\n`)
  }
}

// Exit code: 0 if all passed (or all updates succeeded), 1 if any failure
process.exit(failed === 0 ? 0 : 1)

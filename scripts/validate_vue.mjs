#!/usr/bin/env node
// validate_vue.mjs — Vue 3 component SSR validator
//
// Mirrors scripts/validate_react.mjs (PR #348) architecture but uses Vue 3 SSR
// (createSSRApp + renderToString from @vue/server-renderer) instead of React's
// renderToStaticMarkup.
//
// This is the Vue-aware counterpart to validate.js. The CLI dispatcher in
// scripts/regret.js routes `stack: "vue"` clusters here for validate / update
// / drift, because validate.js cannot render Vue components — it would import
// the component and call it as a plain function, returning a Vue component
// object whose fingerprint never matches the captured HTML.
//
// Usage:
//   node scripts/validate_vue.mjs
//   node scripts/validate_vue.mjs --cluster invoice-card-render
//   node scripts/validate_vue.mjs --manifest ./regrets/manifest.json
//   node scripts/validate_vue.mjs --update invoice-card-render --reason "..."
//   node scripts/validate_vue.mjs --fail-fast
//   node scripts/validate_vue.mjs --quiet
//   node scripts/validate_vue.mjs --verbose
//   node scripts/validate_vue.mjs --json
//   node scripts/validate_vue.mjs --runs 5    (drift detection)

import { readFileSync, writeFileSync, readdirSync, appendFileSync, existsSync, mkdirSync } from 'fs'
import { resolve, join, basename } from 'path'
import { fileURLToPath, pathToFileURL } from 'url'
import { execSync } from 'child_process'
import { createHash } from 'crypto'
import { fingerprint, normalize as fpNormalize, stableStringify, stripFields, extractSchema } from './fingerprint.js'
import { deepClone, normalizeHtml } from './ghost.js'
import { createSSRApp, h } from 'vue'
import { renderToString } from '@vue/server-renderer'

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
// audit trail carries intent (mirrors validate.js / validate_react.mjs).
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
// Format (produced by capture_vue.mjs):
//   cluster: <id>
//   version: 1
//   fingerprint: <7char>
//   captured: <ISO>
//   watches: [<entry>]
//   entry: <entry>
//   stack: vue
//   renderMode: ssr
//   [normalize: [a, b]]
//   [ignoreFields: [a, b]]
//   [stripAttrs: [a, b]]
//   [fingerprintMode: schema|mixed|value]
//   ---
//   INPUT  <JSON>
//   OUTPUT <JSON>
//   HASH   <7char>
//
// Identical to capture_react.mjs's format (only stack + renderMode values differ).

function parseListLiteral(val) {
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

  let parsedInput = null
  let parsedOutput = null
  let goldenHash = null
  for (const line of dataSection.split('\n')) {
    if (line.startsWith('INPUT ')) {
      const s = line.slice('INPUT '.length)
      parsedInput = s === 'undefined' ? null : JSON.parse(s)
    } else if (line.startsWith('OUTPUT ')) {
      const s = line.slice('OUTPUT '.length)
      parsedOutput = s === 'undefined' ? null : JSON.parse(s)
    } else if (line.startsWith('HASH ')) {
      goldenHash = line.slice('HASH '.length).trim()
    }
  }

  return {
    ...meta,
    input: parsedInput,
    output: parsedOutput,
    goldenHash,
    raw: content,
  }
}

// ─── Resolve component module ─────────────────────────────────────────────────
//
// Mirrors capture_vue.mjs's resolution: try manifest `file` as-is, fall back
// to .js if original was .vue, fall back to js/ mirror. Same logic, same
// precedence — capture and validate always agree on which file represents
// the component.

function resolveComponentPath(file) {
  const absPath = resolve(process.cwd(), file)

  if (absPath.endsWith('.vue')) {
    const jsFallback = absPath.replace(/\.vue$/, '.js')
    try {
      readFileSync(jsFallback)
      return jsFallback
    } catch { /* fall through */ }
    const mjsFallback = absPath.replace(/\.vue$/, '.mjs')
    try {
      readFileSync(mjsFallback)
      return mjsFallback
    } catch { /* fall through */ }
    throw new Error(
      `.vue Single-File Components require a compile step. ` +
      `Either pre-compile to .js (see references/vue.md) or use a render-function ` +
      `component in .js/.mjs. Looked for: ${jsFallback}, ${mjsFallback}`)
  }

  try {
    readFileSync(absPath)
    return absPath
  } catch { /* fall through */ }

  const jsMirror = resolve(process.cwd(), 'js',
    file.replace(/^src\//, '').replace(/\.(vue|tsx|jsx)$/, '.js'))
  return jsMirror
}

// ─── Render a Vue component with props ────────────────────────────────────────

async function renderComponent(Component, props) {
  const app = createSSRApp({
    render: () => h(Component, props),
  })
  const rawHtml = await renderToString(app)
  return rawHtml
}

// ─── Compute fingerprint ──────────────────────────────────────────────────────

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
    const schema = extractSchema(html)
    const selectedValues = {}
    const combined = { schema, values: selectedValues }
    return fingerprint(input, combined, { normalize: normRules, ignoreFields })
  }
  return fingerprint(input, html, { normalize: normRules, ignoreFields })
}

// ─── Update a .regret file with a new golden hash + audit.log entry ───────────
//
// Mirrors validate_react.mjs's update path. Writes the new hash to the .regret
// file, then appends a chain entry to audit.log.

function updateRegret(regretPath, regret, newHash, liveOutput, reason) {
  const oldHash = regret.goldenHash
  const now = new Date().toISOString()
  const safeReason = reason.replace(/[\r\n]+/g, ' ')

  let newContent = regret.raw
  newContent = newContent.replace(/^fingerprint: .+$/m, `fingerprint: ${newHash}`)
  newContent = newContent.replace(/^captured: .+$/m, `captured: ${now}`)
  newContent = newContent.replace(/^OUTPUT .+$/m,
    `OUTPUT ${JSON.stringify(liveOutput)}`)
  newContent = newContent.replace(/^HASH   .+$/m, `HASH   ${newHash}`)

  writeFileSync(regretPath, newContent, 'utf8')

  // ─── Hash chain ────────────────────────────────────────────────────────────
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

// ─── Discover Vue clusters + matching .regret files ───────────────────────────

const vueClusters = (manifest.clusters || []).filter(c => c.stack === 'vue')
const clusterById = new Map(vueClusters.map(c => [c.id, c]))

const filterId = updateTarget ?? clusterFilter

let regretFiles = []
try {
  const all = readdirSync(regretDir).filter(f => f.endsWith('.regret'))
  for (const f of all) {
    const id = basename(f, '.regret')
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
    console.error(`❌ No Vue .regret files found${scope}.`)
    console.error('   Run `node scripts/capture_vue.mjs` first to capture fingerprints.')
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
    console.log(`\n🔍 Validating ${regretFiles.length} Vue cluster(s)...\n`)
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

  const stripAttrs = regret.stripAttrs ?? clusterDef.stripAttrs ?? []
  const normRules = regret.normalize ?? clusterDef.normalize ?? []
  const ignoreFields = regret.ignoreFields ?? clusterDef.ignoreFields ?? []
  const fingerprintMode = regret.fingerprintMode ?? clusterDef.fingerprintMode
  const valuePaths = regret.valuePaths ?? clusterDef.valuePaths ?? []
  const clusterConfig = { normalize: normRules, ignoreFields, fingerprintMode, valuePaths }

  // Re-render N times for drift detection (or once for normal validate)
  const hashes = []
  const hashesPerInput = new Map()
  let lastOutput = null
  let lastError = null

  try {
    for (let i = 0; i < runs; i++) {
      const rawHtml = await renderComponent(Component, regret.input)
      const html = normalizeHtml(rawHtml, stripAttrs)
      lastOutput = html
      const fp = computeFingerprint(regret.input, html, clusterConfig)
      hashes.push(fp)
      const inputKey = JSON.stringify(regret.input)
      if (!hashesPerInput.has(inputKey)) hashesPerInput.set(inputKey, [])
      hashesPerInput.get(inputKey).push(fp)
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
  const isMatch = liveHash === regret.goldenHash
  const isDrift = driftMode && [...hashesPerInput.values()].some(arr => new Set(arr).size > 1)

  if (verbose && !jsonOutput) {
    console.log(`  ┌─ ${id} ────────────────────────────────────`)
    console.log(`  │ Input:      ${JSON.stringify(regret.input)}`)
    console.log(`  │ Expected:   ${regret.goldenHash}`)
    console.log(`  │ Actual:     ${liveHash}`)
    console.log(`  │ Output:     ${JSON.stringify(lastOutput)?.slice(0, 200)}${JSON.stringify(lastOutput)?.length > 200 ? '…' : ''}`)
    if (stripAttrs.length) console.log(`  │ stripAttrs: ${stripAttrs.join(', ')}`)
    if (normRules.length)  console.log(`  │ normalize:  ${normRules.join(', ')}`)
    if (runs > 1)          console.log(`  │ Hashes:     ${hashes.join(' / ')}`)
    console.log(`  └────────────────────────────────────────────`)
  }

  const idPadded = id.padEnd(35)

  if (updateTarget) {
    if (isMatch) {
      if (!jsonOutput && !quiet) console.log(`  ℹ️  ${idPadded} unchanged — no update needed`)
      results.push({ id, pass: true })
    } else {
      const updateResult = updateRegret(regretPath, regret, liveHash, lastOutput, updateReason)
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
    const icon = isMatch ? '✅' : '❌'
    const hstr = isMatch ? regret.goldenHash : `${regret.goldenHash} → ${liveHash}`
    if (!jsonOutput && !quiet) {
      console.log(`  ${icon} ${idPadded} ${hstr.padEnd(22)} ${isMatch ? 'PASS' : 'FAIL'}`)
    }
    results.push({ id, pass: isMatch, golden: regret.goldenHash, live: liveHash })
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
    stack: 'vue',
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
    console.log(`✅ All ${passed} Vue tests passed${driftMode ? ` (${runs} runs — stable)` : ''}. Refactor is safe.\n`)
  } else {
    console.log(`❌ ${failed}/${results.length} FAILED.\n`)
    for (const r of results.filter(r => !r.pass)) {
      console.log(`  • ${r.id}`)
      if (r.error) {
        console.log(`    ${r.error}`)
      } else if (r.drift) {
        console.log(`    drift: ${r.hashes.join(' / ')}`)
      } else {
        console.log(`    Expected: ${r.golden}  Got: ${r.live}`)
      }
    }
    console.log(`\nFix the CODE — do not edit .regret files.`)
    console.log(`Re-run: node scripts/validate_vue.mjs\n`)
  }
}

process.exit(failed === 0 ? 0 : 1)

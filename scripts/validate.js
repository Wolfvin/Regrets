#!/usr/bin/env node
// validate.js — regression validator
// Usage:
//   node scripts/validate.js
//   node scripts/validate.js --runs 5
//   node scripts/validate.js --cluster transform-user-data
//   node scripts/validate.js --update transform-user-data --reason "tax rate changed to 12%"
//   node scripts/validate.js --fail-fast
//   node scripts/validate.js --no-diff
//   node scripts/validate.js --quiet           Only print summary line
//   node scripts/validate.js --verbose         Print extra detail (input, output, calls) + skipped clusters
//   node scripts/validate.js --skip-callees    Do not re-validate .calls.* callee contracts
//   node scripts/validate.js --reporter junit

import { readFileSync, writeFileSync, readdirSync, appendFileSync, existsSync, openSync, closeSync, unlinkSync, statSync } from 'fs'
import { createHash } from 'crypto'
import { resolve, join, basename, dirname, extname } from 'path'
import { pathToFileURL, fileURLToPath } from 'url'
import { fingerprint, fingerprintSequence, extractSchema, getEnvSnapshot, stableStringify, normalize as fpNormalize, stripFields } from './fingerprint.js'
import { createGhost, deepClone, normalizeHtml, consumeIterator } from './ghost.js'
import { mergeCjsModule } from './cjs-merge.js'
import { applyOutputTransformAsync } from './outputTransform.js'
import { constants as _fsConstants } from 'fs'
import { execSync as _execSync } from 'child_process'
import { computeConfidence, parseAuditForDrift } from './confidence.js'
import { isEsmSource, transformEsmForCallees, HOLDER_NAME, registerEsmTempFile, deleteEsmTempFile, generateEsmTempFileName } from './esm-callee-transform.js'
import { isCjsSource, transformCjsForCallees } from './cjs-callee-transform.js'

// ─── Lightweight file locking (lockfile pattern) ────────────────────────────────
// Uses O_EXCL atomic create for lock acquisition.  Retries with exponential
// backoff up to 10 s.  Auto-releases in finally block so orphan locks are rare.

const _O_EXCL = _fsConstants.O_CREAT | _fsConstants.O_EXCL
const _LOCK_TIMEOUT_MS = 10_000
const _LOCK_BASE_DELAY_MS = 50
const _LOCK_MAX_DELAY_MS = 500

function _lockfilePath(filePath) {
  return filePath + '.lock'
}

function _sleepMs(ms) {
  _execSync(`sleep ${Math.max(0, ms / 1000).toFixed(3)}`, { stdio: 'ignore', timeout: ms + 2000 })
}

function acquireLock(filePath) {
  const lockPath = _lockfilePath(filePath)
  const deadline = Date.now() + _LOCK_TIMEOUT_MS
  let delay = _LOCK_BASE_DELAY_MS

  while (Date.now() < deadline) {
    try {
      const st = statSync(lockPath)
      if (Date.now() - st.mtimeMs > _LOCK_TIMEOUT_MS) {
        try { unlinkSync(lockPath) } catch (_) { /* race */ }
        continue
      }
    } catch (_) { /* lock doesn't exist yet */ }

    try {
      const fd = openSync(lockPath, _O_EXCL, 0o600)
      closeSync(fd)
      return lockPath
    } catch (e) {
      if (e.code !== 'EEXIST') throw e
    }

    const sleepMs = Math.min(delay, deadline - Date.now(), _LOCK_MAX_DELAY_MS)
    if (sleepMs <= 0) break
    _sleepMs(sleepMs)
    delay = Math.min(delay * 2, _LOCK_MAX_DELAY_MS)
  }

  throw new Error(`filelock: could not acquire lock on ${filePath} within ${_LOCK_TIMEOUT_MS / 1000}s`)
}

function releaseLock(lockPath) {
  try { unlinkSync(lockPath) } catch (_) { /* already removed */ }
}

// ─── isMainModule guard ────────────────────────────────────────────────────────
// When imported as a module (e.g. from api.js), we only want the function exports,
// not the CLI side effects (process.argv parsing, process.exit, console output).

const __filename = fileURLToPath(import.meta.url)
const isMainModule = process.argv[1] && resolve(process.argv[1]) === __filename

// ─── Helpers ──────────────────────────────────────────────────────────────────

function getArg(args, flag) {
  const i = args.indexOf(flag)
  return i !== -1 ? args[i + 1] ?? null : null
}

// ─── CLI args (only set when run directly) ──────────────────────────────────────

let clusterFilter = null
let failFast      = false
let runs          = 1
let runsExplicit  = false  // whether --runs was explicitly provided via CLI
let driftModeFlag = false  // whether --drift-mode was passed (from regret drift)
let updateTarget  = null
let updateReason  = null
let manifestPath  = resolve(process.cwd(), 'regrets/manifest.json')
let regretDir     = resolve(process.cwd(), 'regrets')
let auditLog      = join(regretDir, 'audit.log')
let jsonOutput    = false
let noDiff        = false
let reporter      = null
let quiet         = false
let verbose       = false
let skipCallees   = false

if (isMainModule) {
  const args          = process.argv.slice(2)
  clusterFilter = getArg(args, '--cluster')
  failFast      = args.includes('--fail-fast')
  const runsArg = getArg(args, '--runs')
  runs          = parseInt(runsArg ?? '1')
  runsExplicit  = runsArg != null
  driftModeFlag = args.includes('--drift-mode')
  // When --drift-mode is set and --runs is not explicit, default to 5 runs
  if (driftModeFlag && !runsExplicit) {
    runs = 5
  }
  updateTarget  = getArg(args, '--update')
  // JS/TS/CSS form: `--update --cluster <id> --reason "..."` — --update is a
  // BARE flag here (the id comes from --cluster). getArg() naively grabs the
  // next token after --update regardless of whether it's itself a flag, so
  // in this form updateTarget ends up holding the literal string "--cluster"
  // instead of the real id. Detect that and fall back to clusterFilter,
  // which IS the real id in this invocation form (#500).
  if (updateTarget && updateTarget.startsWith('-')) {
    updateTarget = clusterFilter
  }
  updateReason  = getArg(args, '--reason')
  manifestPath  = getArg(args, '--manifest') ?? resolve(process.cwd(), 'regrets/manifest.json')
  regretDir     = resolve(process.cwd(), 'regrets')
  auditLog      = join(regretDir, 'audit.log')
  jsonOutput    = args.includes('--json')
  noDiff        = args.includes('--no-diff')
  reporter      = getArg(args, '--reporter') ?? null
  quiet         = args.includes('--quiet')
  verbose       = args.includes('--verbose')
  skipCallees   = args.includes('--skip-callees')

  if (quiet && verbose) {
    console.warn('⚠️  --quiet and --verbose are mutually exclusive; using --quiet')
    verbose = false
  }

  if (updateTarget && !updateReason) {
    if (jsonOutput) {
      console.log(JSON.stringify({ error: '--update requires --reason' }))
    } else {
      console.error(`❌ --update requires --reason`)
      console.error(`   Example: --update ${updateTarget} --reason "describe why behavior changed"`)
    }
    process.exit(1)
  }

  if (updateReason && updateReason.split(' ').length < 4) {
    if (jsonOutput) {
      console.log(JSON.stringify({ error: `--reason is too vague: "${updateReason}"` }))
    } else {
      console.error(`❌ --reason is too vague: "${updateReason}"`)
      console.error(`   Be specific. e.g. "tax rate updated from 11% to 12% per new regulation"`)
    }
    process.exit(1)
  }

  // Bug B (#284): reject direct update of a callee contract.
  // Callee contracts are derived from the parent's inputs — they cannot be
  // updated independently. Point the user to the parent or re-capture instead.
  if (updateTarget && updateTarget.includes('.calls.')) {
    const parentTarget = updateTarget.split('.calls.')[0]
    if (jsonOutput) {
      console.log(JSON.stringify({
        error: `Cannot update callee contract "${updateTarget}" directly. Callee contracts are derived from the parent cluster's inputs. Update the parent instead: regret update ${parentTarget} --reason "..." — or re-capture: regret capture --cluster ${parentTarget}`,
      }))
    } else {
      console.error(`❌ Cannot update callee contract "${updateTarget}" directly.`)
      console.error(`   Callee contracts are derived from the parent cluster's inputs.`)
      console.error(`   Update the parent instead:  regret update ${parentTarget} --reason "..."`)
      console.error(`   Or re-capture:               regret capture --cluster ${parentTarget}`)
    }
    process.exit(1)
  }
}

// ─── Parse a .regret file ─────────────────────────────────────────────────────

export function parseRegret(content) {
  // Normalize CRLF -> LF before splitting on the literal '\n---\n'
  // separator. Git's core.autocrlf=true (the standard Windows git setting)
  // rewrites .regret files to CRLF on checkout, turning the separator into
  // '\r\n---\r\n' -- which does not contain '\n---\n' as a substring, so
  // split() silently fails to find it, breaking every cluster (manifest
  // golden hash reads as undefined) on an otherwise unmodified checkout.
  content = content.replaceAll('\r\n', '\n')
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
    else if (key === 'ignorePaths') meta.ignorePaths = val.slice(1, -1).split(', ').filter(Boolean)
    else if (key === 'fingerprintMode') meta.fingerprintMode = val
    else if (key === 'valuePaths') meta.valuePaths = val.slice(1, -1).split(', ').filter(Boolean)
    else if (key === 'outputTransform') meta.outputTransform = val
    else if (key === 'env') {
      try { meta.env = JSON.parse(val) } catch { meta.env = val }
    }
    else if (key === 'kwargs') meta.kwargs = val === 'true'
    else if (key === 'materializeOutput') meta.materializeOutput = val === 'true'
    else if (key === 'trackMutation') meta.trackMutation = val === 'true'
    else if (key === 'inputMutated') meta.inputMutated = val === 'true'
    else if (key === 'mutationFingerprint') meta.mutationFingerprint = val
    else if (key === 'version') meta.version = Number(val)
    else if (key === 'constructorArgs' || key === 'setup' || key === 'initialState') {
      try { meta[key] = JSON.parse(val) } catch { /* skip malformed JSON in .regret meta */ }
    }
    else if (key === 'instanceMethods') {
      try { meta.instanceMethods = JSON.parse(val) } catch { meta.instanceMethods = {} }
    }
    else if (key === 'singletonMethod') meta.singletonMethod = val
    else if (key === 'singletonName') meta.singletonName = val
    else if (key === 'dispatch') meta.dispatch = val
    else if (key === 'expectThrow') meta.expectThrow = val === 'true'
    else if (key === 'sideEffectWatches') {
      try { meta.sideEffectWatches = JSON.parse(val) } catch { meta.sideEffectWatches = [] }
    }
    else meta[key] = val
  }
  const lines = dataSection?.split('\n') ?? []
  const inputLine  = lines.find(l => l.startsWith('INPUT '))
  const outputLine = lines.find(l => l.startsWith('OUTPUT '))
  const errorContractLine = lines.find(l => l.startsWith('ERROR_CONTRACT '))
  const hashLine   = lines.find(l => l.startsWith('HASH '))
  // Parse INPUT/OUTPUT lines — handle undefined output gracefully
  // (JSON.stringify(undefined) produces the literal string "undefined", not valid JSON)
  let parsedInput = null
  let parsedOutput = null
  if (inputLine) {
    const inputStr = inputLine.replace(/^INPUT\s+/, '')
    try { parsedInput = inputStr === 'undefined' ? undefined : JSON.parse(inputStr) } catch { parsedInput = null }
  }
  if (outputLine) {
    const outputStr = outputLine.replace(/^OUTPUT\s+/, '')
    try { parsedOutput = outputStr === 'undefined' ? undefined : JSON.parse(outputStr) } catch { parsedOutput = null }
  }
  // Parse ERROR_CONTRACT line (expectThrow support)
  let parsedErrorContract = null
  if (errorContractLine) {
    const ecStr = errorContractLine.replace(/^ERROR_CONTRACT\s+/, '')
    try { parsedErrorContract = JSON.parse(ecStr) } catch { parsedErrorContract = null }
  }
  // Parse MUTATION_BEFORE/AFTER lines
  const mutationBeforeLine = lines.find(l => l.startsWith('MUTATION_BEFORE '))
  const mutationAfterLine = lines.find(l => l.startsWith('MUTATION_AFTER '))
  // Parse SIDE_EFFECTS line
  const sideEffectsLine = lines.find(l => l.startsWith('SIDE_EFFECTS '))
  let goldenSideEffects = null
  if (sideEffectsLine) {
    try { goldenSideEffects = JSON.parse(sideEffectsLine.replace(/^SIDE_EFFECTS\s+/, '')) } catch { goldenSideEffects = null }
  }
  // Issue #298: parse the CALLS line (multi-call callee contract).
  // Format: `CALLS   <json-array>` where each element is
  //   { args, result?, error?, threw, hash, construct? }
  // Absent on old .regret files (pre-#298) and on new files where the
  // callee was only called with a single unique arg set (the common case).
  // When present, runCalleeContract re-runs the callee with EACH saved
  // args and FAILs if any call's live hash differs from its golden.
  const callsLine = lines.find(l => l.startsWith('CALLS '))
  let goldenCalls = null
  if (callsLine) {
    try {
      const parsed = JSON.parse(callsLine.replace(/^CALLS\s+/, ''))
      if (Array.isArray(parsed) && parsed.length > 0) {
        goldenCalls = parsed
      }
    } catch { goldenCalls = null }
  }
  // Issue #315: parse the INPUTS line (multi-input parent contract).
  // Format: `INPUTS  <json-array>` where each element is
  //   { input, output, hash, threw?, error? }
  // Absent on old .regret files (pre-#315) and on new files where only
  // one input was captured (the common case). When present, validate.js
  // compares EVERY hash against the live re-run hashes — any mismatch
  // FAILs the cluster even if the first input's hash still matches.
  //
  // The first input is intentionally NOT in this array — it's already
  // represented by the top-level INPUT/OUTPUT/HASH lines. This keeps the
  // format readable and avoids duplicating the golden.
  const inputsLine = lines.find(l => l.startsWith('INPUTS '))
  let goldenInputs = null
  if (inputsLine) {
    try {
      const parsed = JSON.parse(inputsLine.replace(/^INPUTS\s+/, ''))
      if (Array.isArray(parsed) && parsed.length > 0) {
        goldenInputs = parsed
      }
    } catch { goldenInputs = null }
  }
  return {
    ...meta,
    input:      parsedInput,
    output:     parsedOutput,
    errorContract: parsedErrorContract,
    goldenHash: hashLine   ? hashLine.replace(/^HASH\s+/, '').trim()          : null,
    mutationBefore: mutationBeforeLine ? (() => { try { return JSON.parse(mutationBeforeLine.replace(/^MUTATION_BEFORE\s+/, '')) } catch { return null } })() : null,
    mutationAfter:  mutationAfterLine  ? (() => { try { return JSON.parse(mutationAfterLine.replace(/^MUTATION_AFTER\s+/, '')) } catch { return null } })()   : null,
    goldenSideEffects,
    goldenCalls,
    goldenInputs,
    raw:        content
  }
}

// ─── expectThrow helpers ──────────────────────────────────────────────────────
// Shared between runCluster and the main validation loop.
function isExpectThrow(inp) {
  return inp && typeof inp === 'object' && inp.__expectThrow === true
}
function extractInputValue(inp) {
  return isExpectThrow(inp) ? inp.value : inp
}
function normalizeErrorMessage(msg, normalizeRules) {
  if (typeof msg !== 'string') return String(msg)
  let m = msg
  m = m.split('\n')[0]
  if (normalizeRules.includes('timestamps'))  m = m.replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z?/g, '<timestamp>')
  if (normalizeRules.includes('uuids'))        m = m.replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '<uuid>')
  if (normalizeRules.includes('epochs'))        m = m.replace(/\b\d{10,13}\b/g, '<epoch>')
  m = m.replace(/\s*\(.+:\d+:\d+\)/g, '')
  m = m.replace(/\s+at .+$/s, '')
  return m.trim()
}
function buildErrorContract(err, normalizeRules) {
  return {
    type: err.constructor?.name || 'Error',
    message: normalizeErrorMessage(err.message, normalizeRules),
  }
}

// Ghost proxy imported from ghost.js

function clone(v) { return deepClone(v) }

// ─── JSON Diff — recursive comparison of golden vs live output ───────────────
// Returns diff entries with type classification:
//   'changed'      (~) value differs, same type
//   'added'        (+) key/index exists only in live
//   'removed'      (-) key/index exists only in golden
//   'type_changed' (>) same key, different types

export function jsonDiff(golden, live, prefix = '') {
  const diffs = []

  // Both null/undefined
  if (golden == null && live == null) return diffs

  // One is null/undefined, the other is not → added or removed
  if (golden == null && live != null) {
    diffs.push({ path: prefix || '(root)', type: 'added', live })
    return diffs
  }
  if (golden != null && live == null) {
    diffs.push({ path: prefix || '(root)', type: 'removed', golden })
    return diffs
  }

  // Type mismatch → type_changed
  if (typeof golden !== typeof live) {
    diffs.push({ path: prefix || '(root)', type: 'type_changed', golden, live })
    return diffs
  }

  // Primitive comparison
  if (golden === live) return diffs

  // String comparison
  if (typeof golden === 'string') {
    if (golden !== live) {
      diffs.push({ path: prefix || '(root)', type: 'changed', golden, live })
    }
    return diffs
  }

  // Number comparison (handle NaN)
  if (typeof golden === 'number') {
    if (Number.isNaN(golden) !== Number.isNaN(live) || golden !== live) {
      diffs.push({ path: prefix || '(root)', type: 'changed', golden, live })
    }
    return diffs
  }

  // Boolean
  if (typeof golden === 'boolean') {
    if (golden !== live) {
      diffs.push({ path: prefix || '(root)', type: 'changed', golden, live })
    }
    return diffs
  }

  // Array comparison
  if (Array.isArray(golden) || Array.isArray(live)) {
    if (!Array.isArray(golden) || !Array.isArray(live)) {
      diffs.push({ path: prefix || '(root)', type: 'type_changed', golden, live })
      return diffs
    }
    const maxLen = Math.max(golden.length, live.length)
    for (let i = 0; i < maxLen; i++) {
      const subPrefix = prefix ? `${prefix}[${i}]` : `[${i}]`
      if (i >= golden.length) {
        diffs.push({ path: subPrefix, type: 'added', live: live[i] })
      } else if (i >= live.length) {
        diffs.push({ path: subPrefix, type: 'removed', golden: golden[i] })
      } else {
        diffs.push(...jsonDiff(golden[i], live[i], subPrefix))
      }
    }
    return diffs
  }

  // Object comparison
  if (typeof golden === 'object' && typeof live === 'object') {
    const allKeys = new Set([...Object.keys(golden), ...Object.keys(live)])
    for (const key of allKeys) {
      const subPrefix = prefix ? `${prefix}.${key}` : key
      if (!(key in golden)) {
        diffs.push({ path: subPrefix, type: 'added', live: live[key] })
      } else if (!(key in live)) {
        diffs.push({ path: subPrefix, type: 'removed', golden: golden[key] })
      } else {
        diffs.push(...jsonDiff(golden[key], live[key], subPrefix))
      }
    }
    return diffs
  }

  return diffs
}

const DIFF_SYMBOLS = {
  changed:      '~',
  added:        '+',
  removed:      '-',
  type_changed: '>',
}

function truncateDiffValue(val, maxLen) {
  if (val === undefined || val === null) return String(val)
  const str = typeof val === 'string' ? val : JSON.stringify(val)
  if (str.length > maxLen) return str.slice(0, maxLen) + '\u2026'
  return str
}

export function formatDiffOutput(goldenOutput, liveOutput, opts = {}) {
  const maxValLen = opts.verbose ? Infinity : 60

  // Try JSON diff first
  let goldenObj, liveObj
  try {
    goldenObj = typeof goldenOutput === 'string' ? JSON.parse(goldenOutput) : goldenOutput
  } catch { goldenObj = null }
  try {
    liveObj = typeof liveOutput === 'string' ? JSON.parse(liveOutput) : liveOutput
  } catch { liveObj = null }

  // Both parseable as JSON → structured diff
  if (goldenObj !== null && liveObj !== null) {
    const diffs = jsonDiff(goldenObj, liveObj)
    if (diffs.length === 0) return null  // no diff found

    const lines = []
    for (const d of diffs) {
      const sym = DIFF_SYMBOLS[d.type]
      if (d.type === 'added') {
        lines.push(`   ${sym} ${d.path}: ${truncateDiffValue(d.live, maxValLen)}`)
      } else if (d.type === 'removed') {
        lines.push(`   ${sym} ${d.path}: ${truncateDiffValue(d.golden, maxValLen)}`)
      } else {
        // 'changed' or 'type_changed'
        lines.push(`   ${sym} ${d.path}: ${truncateDiffValue(d.golden, maxValLen)} \u2192 ${truncateDiffValue(d.live, maxValLen)}`)
      }
    }
    lines.push('   Legend: ~ = changed, + = added, - = removed, > = type changed')
    return lines.join('\n')
  }

  // Fallback: non-JSON output (string, number, etc.)
  const gStr = truncateDiffValue(goldenOutput, maxValLen)
  const lStr = truncateDiffValue(liveOutput, maxValLen)
  if (gStr === lStr) return null
  return `   ~ (root): ${gStr} \u2192 ${lStr}`
}

// ─── Load manifest ────────────────────────────────────────────────────────────

let manifest
if (isMainModule) {
  try { manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) }
  catch {
    if (jsonOutput) {
      console.log(JSON.stringify({ error: `Could not read manifest: ${manifestPath}` }))
    } else {
      console.error(`❌ Could not read manifest: ${manifestPath}`)
    }
    process.exit(1)
  }
}

// ─── Find .regret files ───────────────────────────────────────────────────────

let regretFiles = []
if (isMainModule) {
  const filterId = clusterFilter ?? updateTarget ?? null
  try {
    regretFiles = readdirSync(regretDir)
      .filter(f => f.endsWith('.regret'))
      .filter(f => {
        if (!filterId) return true
        // Exact match: filterId === "main" → main.regret
        if (f === `${filterId}.regret`) return true
        // Bug C (#284): when filterId is a parent cluster, also include its
        // callee contract files (main.calls.add.regret, main.calls.mul.regret,
        // etc.) so that `regret validate --cluster main` re-validates callee
        // regressions of that cluster too. Previously, the strict equality
        // filter hid callee contracts, producing false GREEN for refactors
        // that changed a callee but preserved the parent's output.
        // We only apply this when filterId itself is NOT a callee (.calls.)
        // — if the user explicitly targets `main.calls.add`, only that one
        // file is loaded (handled by the exact-match branch above).
        if (filterId.includes('.calls.')) return false
        return f.startsWith(`${filterId}.calls.`) && f.endsWith('.regret')
      })
  } catch {
    if (jsonOutput) {
      console.log(JSON.stringify({ error: 'regrets/ not found. Run capture.js first.' }))
    } else {
      console.error(`❌ regrets/ not found. Run capture.js first.`)
    }
    process.exit(1)
  }

  if (!regretFiles.length) {
    if (jsonOutput) {
      console.log(JSON.stringify({ error: `No .regret files found${filterId ? ` for "${filterId}"` : ''}.` }))
    } else {
      console.error(`❌ No .regret files found${filterId ? ` for "${filterId}"` : ''}.`)
    }
    process.exit(1)
  }
}

// ─── React cluster runner ─────────────────────────────────────────────────────

export async function runReactCluster(clusterDef, regret, options = {}) {
  const { runs: runCount = runs } = options
  const { entry, file, normalize: normRules = [], ignoreFields = [],
          stripAttrs = [], fingerprintMode: fpMode = 'value', valuePaths = [] } = clusterDef
  const mode = regret.fingerprintMode || fpMode || 'value'
  const paths = regret.valuePaths || valuePaths || []

  let React, renderToStaticMarkup
  try {
    React = (await import('react')).default
    renderToStaticMarkup = (await import('react-dom/server.js')).renderToStaticMarkup
  } catch {
    throw new Error('React not available. Install react and react-dom for React cluster validation.')
  }

  const absPath = resolve(process.cwd(), file)
  let moduleUrl
  try {
    const { readFileSync } = await import('fs')
    readFileSync(absPath)
    moduleUrl = pathToFileURL(absPath).href
  } catch {
    const jsPath = absPath.replace(/\.(tsx|jsx)$/, '.js')
    moduleUrl = pathToFileURL(jsPath).href
  }

  const mod = await import(moduleUrl)
  const Component = mod[entry] ?? mod.default?.[entry] ?? mod.default
  if (!Component) throw new Error(`Component "${entry}" not found in ${file}`)

  const hashes = []
  let lastOutput = null

  for (let i = 0; i < runCount; i++) {
    const goldenInput = regret.input
    const element = React.createElement(Component, goldenInput)
    const rawHtml = renderToStaticMarkup(element)
    const html = normalizeHtml(rawHtml, stripAttrs)

    let fp
    if (mode === 'schema') {
      const schema = extractSchema(html)
      fp = fingerprint(goldenInput, schema, { normalize: normRules, ignoreFields })
    } else if (mode === 'mixed') {
      const schema = extractSchema(html)
      const selectedValues = {}
      for (const path of paths) {
        const key = path.replace(/^\$\./, '')
        const parts = key.split('.')
        let val = html
        for (const p of parts) { val = val?.[p] }
        if (val !== undefined) selectedValues[path] = val
      }
      const combined = { schema, values: selectedValues }
      fp = fingerprint(goldenInput, combined, { normalize: normRules, ignoreFields })
    } else {
      fp = fingerprint(goldenInput, html, { normalize: normRules, ignoreFields })
    }

    hashes.push(fp)
    lastOutput = html
  }

  return { hashes, lastOutput }
}

// ─── Run cluster N times ──────────────────────────────────────────────────────

export async function runCluster(clusterDef, regret, options = {}) {
  const { runs: runCount = runs } = options
  const { entry, file, normalize = [], ignoreFields = [], ignorePaths = [],
          fingerprintLevel = 'entry',
          multiArgs = false, fingerprintMode = 'value', valuePaths = [], stack,
          classMethod, constructor: constructorName, constructorArgs, setup,
          instanceMethods = {}, outputTransform: manifestOutputTransform = null,
          resetState, deepCloneInput = true, seed, singletonMethod, singletonName,
          storeDispatch, initialState,
          sideEffectWatches = [],
          freezeTime = null, inputTransform = null, isolateGlobals = false } = clusterDef
  const materializeOutputFlag = regret.materializeOutput || clusterDef.materializeOutput || false
  // trackMutation: check from .regret metadata first, then cluster config
  const trackMutation = regret.trackMutation || clusterDef.trackMutation || false
  const goldenMutationFingerprint = regret.mutationFingerprint || null

  // ─── Helper: reduce call sequence to { fn, count } pairs (sorted by fn) ──
  // Used by fingerprintLevel: "calls" — tracks WHO was called and HOW MANY
  // times, without recording args or results per call.
  function reduceToCallCounts(recorder) {
    const counts = {}
    for (const call of recorder) {
      counts[call.fn] = (counts[call.fn] || 0) + 1
    }
    return Object.entries(counts)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([fn, count]) => ({ fn, count }))
  }

  // ─── Fallback: "calls" with empty watches → "entry" ─────────────────────
  const effectiveWatches = regret.watches ?? clusterDef.watches ?? []
  let effectiveFingerprintLevel = fingerprintLevel
  if (fingerprintLevel === 'calls' && (!effectiveWatches || effectiveWatches.length === 0)) {
    console.warn(`  ⚠️  ${clusterDef.id}: fingerprintLevel: "calls" but watches is empty — falling back to "entry"`)
    console.warn(`      Call counts require watched functions. Add watches or use fingerprintLevel: "entry".`)
    effectiveFingerprintLevel = 'entry'
  }

  // Skip stacks not handled by this validator. The env-snapshot comparison
  // (below) is intentionally scoped to this validator's own stack: a Python
  // cluster's `env` block was captured by validate.py using
  // `fingerprint.get_env_snapshot()` (which records `python_version` /
  // `python_impl`), while JS `getEnvSnapshot()` records `node_version` /
  // `platform` / `arch`. Comparing the two produces false "environment
  // changed" warnings for every mixed-stack cluster. Closes #291.
  if (stack === 'python') {
    console.log(`  ⏭️  ${clusterDef.id}: stack=python — use validate.py`)
    return { hashes: [regret.goldenHash], lastOutput: null, skipped: true }
  }
  if (stack === 'rust') {
    console.log(`  ⏭️  ${clusterDef.id}: stack=rust — use capture_rust.sh validate`)
    return { hashes: [regret.goldenHash], lastOutput: null, skipped: true }
  }
  if (stack === 'go') {
    console.log(`  ⏭️  ${clusterDef.id}: stack=go — use capture_go.sh validate`)
    return { hashes: [regret.goldenHash], lastOutput: null, skipped: true }
  }
  if (stack === 'vue') {
    console.log(`  ⏭️  ${clusterDef.id}: stack=vue — use validate_vue.mjs`)
    return { hashes: [regret.goldenHash], lastOutput: null, skipped: true }
  }

  // Check environment snapshot if present in .regret file — but ONLY for
  // clusters this validator actually runs (js/react). The stack-skip block
  // above has already returned for python/rust/go, so by this point we know
  // the regret was captured by a JS-stack validator. Closes #291.
  if (regret.env && typeof regret.env === 'object') {
    const currentEnv = getEnvSnapshot()
    for (const [k, v] of Object.entries(regret.env)) {
      if (currentEnv[k] !== v) {
        console.warn(`  ⚠️  ${clusterDef.id}: environment changed: ${k} was ${v}, now ${currentEnv[k]}`)
      }
    }
  }

  // React stack: re-render component and compare
  if (stack === 'react') {
    return await runReactCluster(clusterDef, regret)
  }

  let mod
  try {
    mod = await import(pathToFileURL(resolve(process.cwd(), file)).href)
  } catch (err) {
    if (err.code === 'ERR_MODULE_NOT_FOUND' || err.code === 'ENOENT') {
      throw new Error(`Cluster file not found at ${file} (cluster "${clusterDef.id}"). Compile the project or fix the 'file' field in manifest.json.`)
    }
    throw new Error(`Failed to import ${file} (cluster "${clusterDef.id}"): ${err.message}`)
  }

  // Handle CJS modules — merge default exports for consistent access
  mod = mergeCjsModule(mod)

  // ─── sideEffectWatches: wrap side-effect methods with Proxy recorder ──────
  // Same logic as capture.js — must be applied in both places for consistent fingerprinting
  const seWatchPaths = regret.sideEffectWatches || sideEffectWatches
  const sideEffectRecorder = []
  const sideEffectRestores = []

  for (const sePath of seWatchPaths) {
    const parts = sePath.split('.')
    if (parts.length > 2) continue  // v1: only 2-level paths
    const [objName, methodName] = parts
    const parentObj = mod[objName]
    if (!parentObj || typeof parentObj !== 'object') {
      console.warn(`  ⚠️  sideEffectWatch "${sePath}": object "${objName}" not found — skipping`)
      continue
    }
    if (methodName) {
      const original = parentObj[methodName]
      if (typeof original !== 'function') {
        console.warn(`  ⚠️  sideEffectWatch "${sePath}": "${methodName}" is not a function — skipping`)
        continue
      }
      sideEffectRestores.push({ obj: parentObj, key: methodName, original })
      parentObj[methodName] = new Proxy(original, {
        apply(target, thisArg, args) {
          let result
          try { result = target.apply(thisArg, args) } catch (err) {
            sideEffectRecorder.push({ fn: sePath, args: deepClone(args), error: String(err) })
            throw err
          }
          if (result && typeof result.then === 'function') {
            return result.then(resolved => {
              sideEffectRecorder.push({ fn: sePath, args: deepClone(args), result: deepClone(resolved) })
              return resolved
            }).catch(err => {
              sideEffectRecorder.push({ fn: sePath, args: deepClone(args), error: String(err) })
              throw err
            })
          }
          sideEffectRecorder.push({ fn: sePath, args: deepClone(args), result: deepClone(result) })
          return result
        }
      })
    } else {
      const original = mod[objName]
      if (typeof original !== 'function') continue
      sideEffectRestores.push({ obj: mod, key: objName, original })
      mod[objName] = new Proxy(original, {
        apply(target, thisArg, args) {
          let result
          try { result = target.apply(thisArg, args) } catch (err) {
            sideEffectRecorder.push({ fn: sePath, args: deepClone(args), error: String(err) })
            throw err
          }
          if (result && typeof result.then === 'function') {
            return result.then(resolved => {
              sideEffectRecorder.push({ fn: sePath, args: deepClone(args), result: deepClone(resolved) })
              return resolved
            }).catch(err => {
              sideEffectRecorder.push({ fn: sePath, args: deepClone(args), error: String(err) })
              throw err
            })
          }
          sideEffectRecorder.push({ fn: sePath, args: deepClone(args), result: deepClone(result) })
          return result
        }
      })
    }
  }

  /**
   * Compute side-effect signature and merge into output for fingerprint computation.
   * Same logic as capture.js for consistent fingerprinting.
   */
  function computeSideEffectSignature(seRecorder) {
    if (!seRecorder || seRecorder.length === 0) return null
    const normalized = seRecorder.map((call, idx) => ({
      fn: call.fn,
      args: stripFields(fpNormalize(deepClone(call.args), normalize), ignoreFields, ignorePaths),
      callIndex: idx,
    }))
    normalized.sort((a, b) => a.fn.localeCompare(b.fn) || a.callIndex - b.callIndex)
    return { sideEffects: normalized }
  }

  function maybeMergeSideEffects(outputVal) {
    const seSig = computeSideEffectSignature(sideEffectRecorder)
    if (!seSig) return outputVal
    return { output: outputVal, sideEffects: seSig.sideEffects }
  }

  const hashes = []           // flat list of all hashes (for backward compat)
  const hashesPerInput = {}   // { inputKey: [hash_run1, hash_run2, ...] } for per-input drift
  // Issue #315: per-input live hashes, parallel to the golden INPUTS array.
  // For each input in inputsToValidate (golden first, then manifest inputs),
  // we record the live hash from the LAST run. The first element corresponds
  // to the golden input (matches `regret.goldenHash`), and elements 1+ match
  // `regret.goldenInputs` (when present). Order is preserved so validate
  // can compare goldenInputs[i].hash against liveInputs[i+1].
  const liveInputs = []
  let lastOutput = null
  let lastErrorContract = null  // expectThrow: error contract from last run
  let lastSideEffectRecording = []  // side effect calls from last run (for diff display)
  // trackMutation: collect mutation fingerprints across all runs/inputs
  let mutationMatch = true
  let mutationDetected = false
  let liveMutationFingerprint = null

  // Issue #556: only validate inputs that are recorded in the .regret contract.
  // The .regret file is the golden contract — it only contains inputs that were
  // successfully captured. Inputs that threw during capture are NOT in the
  // contract and must NOT be re-validated (they would cause false FAILs).
  // Previously, validate read ALL inputs from the manifest (clusterDef.inputs),
  // including inputs that capture had already excluded due to throws — causing
  // ~30% false FAIL clusters on first validation with no code change.
  //
  // Source of truth for inputs to validate:
  //   1. regret.input  (golden, always present)
  //   2. regret.goldenInputs  (INPUTS line, inputs 1+ that were captured)
  //
  // Inputs in the manifest but NOT in the contract are reported as
  // "uncovered" (informational) — the user should run capture to include them.
  const inputsToValidate = [regret.input]  // Always validate golden first
  if (Array.isArray(regret.goldenInputs) && regret.goldenInputs.length > 0) {
    for (const goldenEntry of regret.goldenInputs) {
      if (goldenEntry && typeof goldenEntry === 'object' && 'input' in goldenEntry) {
        const inp = goldenEntry.input
        if (JSON.stringify(inp) !== JSON.stringify(regret.input)) {
          inputsToValidate.push(inp)
        }
      }
    }
  }

  // Detect uncovered inputs: in manifest but not in .regret contract.
  // Reported as informational — NOT a FAIL. The user should re-capture
  // to include them in the contract.
  let uncoveredInputCount = 0
  if (clusterDef.inputs && clusterDef.inputs.length > 0) {
    const contractInputStrs = new Set(inputsToValidate.map(i => JSON.stringify(i)))
    for (const manifestInput of clusterDef.inputs) {
      if (!contractInputStrs.has(JSON.stringify(manifestInput))) {
        uncoveredInputCount++
      }
    }
  }

  for (let i = 0; i < runCount; i++) {
    for (const currentInput of inputsToValidate) {
      const recorder = []
      sideEffectRecorder.length = 0  // clear side effect recordings for each input
      let output
      let fpInput

      // trackMutation: snapshot input state BEFORE call to detect mutations
      let inputSnapshotBefore = null
      let inputForArgsRef = null  // reference to the actual args object passed to the function
      if (trackMutation) {
        inputSnapshotBefore = deepClone(deepCloneInput ? deepClone(currentInput) : currentInput)
      }

      // Determine fingerprint mode (from .regret or manifest)
      const mode = regret.fingerprintMode || fingerprintMode || 'value'
      const paths = regret.valuePaths || valuePaths || []

      if (storeDispatch) {
        // ── storeDispatch mode ──────────────────────────────────────────────
        const storeExport = mod[storeDispatch.store] ?? mod.default?.[storeDispatch.store]
        if (!storeExport) throw new Error(`Store "${storeDispatch.store}" not found in ${file}`)

        let dispatchFn, getStateFn, storeType
        if (typeof storeExport.dispatch === 'function' && typeof storeExport.value !== 'undefined') {
          dispatchFn = storeExport.dispatch.bind(storeExport)
          getStateFn = () => storeExport.value
          storeType = 'dispatching'
        } else if (typeof storeExport.dispatch === 'function' && typeof storeExport.getState === 'function') {
          dispatchFn = storeExport.dispatch.bind(storeExport)
          getStateFn = storeExport.getState
          storeType = 'redux'
        } else if (typeof storeExport.setState === 'function') {
          dispatchFn = storeExport.setState.bind(storeExport)
          getStateFn = () => storeExport.getState()
          storeType = 'zustand'
        } else {
          throw new Error(`Store "${storeDispatch.store}" does not match any known store pattern.`)
        }

        // Reset to initialState if provided
        const stateInit = regret.initialState || initialState
        if (stateInit) {
          if (storeType === 'dispatching' && typeof storeExport.subject?.next === 'function') {
            storeExport.subject.next(deepClone(stateInit))
          } else if (storeType === 'zustand') {
            storeExport.setState(deepClone(stateInit), true)
          }
        }

        const inputForFp = deepClone(currentInput)
        const inputForArgs = deepClone(currentInput)
        inputForArgsRef = inputForArgs  // trackMutation: keep reference for post-call snapshot

        if (storeType === 'redux') {
          dispatchFn({ type: storeDispatch.action, payload: inputForArgs })
        } else if (storeType === 'dispatching') {
          dispatchFn(storeDispatch.action, inputForArgs)
        } else if (storeType === 'zustand') {
          dispatchFn(inputForArgs)
        }

        const rawOutput = getStateFn()
        const { result: consumedOutput } = await consumeIterator(rawOutput)

        const outputTransform = regret.outputTransform || manifestOutputTransform || null
        const transformedOutput = await applyOutputTransformAsync(consumedOutput, outputTransform, process.cwd())

        output = deepClone(transformedOutput)
        lastOutput = output
        fpInput = inputForFp
      } else if (classMethod) {
        // ── Class-based entry ─────────────────────────────────────────────
        const Cls = mod[constructorName ?? entry] ?? mod.default?.[constructorName ?? entry]
        if (typeof Cls !== 'function') throw new Error(`Constructor "${constructorName ?? entry}" not found in ${file}`)
        const cArgs = constructorArgs ? deepClone(constructorArgs) : []
        const instance = new Cls(...cArgs)

        // Apply ghost proxy to instance methods
        for (const watchFn of (regret.watches ?? clusterDef.watches)) {
          if (typeof instance[watchFn] === 'function') {
            const original = instance[watchFn].bind(instance)
            instance[watchFn] = new Proxy(original, {
              apply(target, thisArg, args) {
                const result = target(...args)
                recorder.push({ fn: watchFn, args: deepClone(args), result: deepClone(result) })
                return result
              }
            })
          }
        }

        // Run setup methods
        if (setup && setup.length > 0) {
          for (const step of setup) {
            instance[step.method](...(step.args ? deepClone(step.args) : []))
          }
        }

        // Call target method
        const inputForFp = deepClone(currentInput)
        const inputForArgs = deepClone(currentInput)
        inputForArgsRef = inputForArgs  // trackMutation: keep reference for post-call snapshot
        const args_ = multiArgs && Array.isArray(inputForArgs) ? [...inputForArgs] : [inputForArgs]
        const rawOutput = await instance[classMethod](...args_)

        // Materialize generator/iterator output if configured
        const { result: consumedOutput } = await consumeIterator(rawOutput, null, { materialize: materializeOutputFlag })

        // Apply outputTransform if specified (from .regret or manifest)
        const outputTransform = regret.outputTransform || manifestOutputTransform || null
        const transformedOutput = await applyOutputTransformAsync(consumedOutput, outputTransform, process.cwd())

        output = deepClone(transformedOutput)
        lastOutput = output
        fpInput = multiArgs && Array.isArray(inputForFp) ? inputForFp : inputForFp
      } else if (singletonMethod || regret.singletonMethod) {
        // ── Singleton method entry ────────────────────────────────────────────
        // For CJS modules that export a singleton object with methods.
        // Example: module.exports = new Stemmer() → PorterStemmer.stem("running")
        const sMethod = regret.singletonMethod || singletonMethod
        const sName = regret.singletonName || singletonName || entry
        let singleton = mod[sName] ?? mod.default?.[sName]
        // CJS fallback: when module.exports = new Constructor(), the singleton IS the default export
        if (!singleton && mod.default && typeof mod.default === 'object' && typeof mod.default[sMethod] === 'function') {
          singleton = mod.default
        }
        if (!singleton || typeof singleton !== 'object') {
          throw new Error(`Singleton "${sName}" not found or not an object in ${file}`)
        }
        if (typeof singleton[sMethod] !== 'function') {
          throw new Error(`Method "${sMethod}" not found on singleton "${sName}" in ${file}`)
        }
        const inputForFp = deepClone(currentInput)
        const inputForArgs = deepClone(currentInput)
        inputForArgsRef = inputForArgs  // trackMutation: keep reference for post-call snapshot
        const args_ = multiArgs && Array.isArray(inputForArgs) ? [...inputForArgs] : [inputForArgs]
        const rawOutput = await singleton[sMethod](...args_)

        // Consume generators/iterators
        const { result: consumedOutput } = await consumeIterator(rawOutput)

        // Apply outputTransform
        const outputTransform = regret.outputTransform || manifestOutputTransform || null
        const transformedOutput = await applyOutputTransformAsync(consumedOutput, outputTransform, process.cwd())

        output = deepClone(transformedOutput)
        lastOutput = output
        fpInput = multiArgs && Array.isArray(inputForFp) ? inputForFp : inputForFp
      } else {
        // ── Function-based entry (original behavior) ──────────────────────

        // ─── freezeTime: freeze Date during validation run ──────────────────
        const OriginalDate = globalThis.Date
        let dateFrozen = false
        if (freezeTime) {
          const frozenMs = new OriginalDate(freezeTime).getTime()
          globalThis.Date = class extends OriginalDate {
            constructor(...args) {
              if (args.length > 0) return new OriginalDate(...args)
              return new OriginalDate(frozenMs)
            }
            static now() { return frozenMs }
            static parse(...a) { return OriginalDate.parse(...a) }
            static UTC(...a) { return OriginalDate.UTC(...a) }
          }
          dateFrozen = true
        }

        // ─── inputTransform: transform inputs before calling entry ──────────
        function applyInputTransformVal(inputVal, transform) {
          if (!transform) return inputVal
          if (transform === 'str') {
            if (Array.isArray(inputVal)) return inputVal.map(v => String(v))
            return String(inputVal)
          }
          if (transform === 'hex_to_bytes') {
            if (typeof inputVal === 'string') return Buffer.from(inputVal, 'hex')
            if (Array.isArray(inputVal)) return inputVal.map(v => typeof v === 'string' ? Buffer.from(v, 'hex') : v)
            return inputVal
          }
          if (transform === 'list_to_bytes') {
            if (Array.isArray(inputVal) && inputVal.every(v => typeof v === 'number')) return Buffer.from(inputVal)
            if (Array.isArray(inputVal)) return inputVal.map(v => Array.isArray(v) && v.every(x => typeof x === 'number') ? Buffer.from(v) : v)
            return inputVal
          }
          return inputVal
        }

        // ─── isolateGlobals: re-import module with cache-busting ────────────
        if (isolateGlobals) {
          const reimportUrl = pathToFileURL(resolve(process.cwd(), file)).href + `?_t=${Date.now()}`
          const freshModule = await import(reimportUrl)
          const freshMerged = mergeCjsModule(freshModule)
          mod = freshMerged
        }

        // ─── Seed random number generator for deterministic output ────────
        const origRandom = Math.random
        if (seed != null) {
          let s = seed | 0
          Math.random = () => {
            s |= 0; s = s + 0x6D2B79F5 | 0
            let t = Math.imul(s ^ s >>> 15, 1 | s)
            t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t
            return ((t ^ t >>> 14) >>> 0) / 4294967296
          }
        }

        // ─── resetState: reset module-level mutable state before each run ───
        if (resetState) {
          const resetFn = mod[resetState] ?? mod.default?.[resetState]
          if (typeof resetFn === 'function') resetFn()
        }

        const ghost    = createGhost(mod, regret.watches ?? clusterDef.watches, recorder, regret.instanceMethods || instanceMethods)
        // Resolve entry function with CJS module.exports = function support
        const entryFn  = ghost[entry]
          ?? mod[entry]
          ?? mod.default?.[entry]
          ?? ((entry === 'default' || entry === 'module.exports') && typeof mod.default === 'function' ? mod.default : null)
        if (typeof entryFn !== 'function') throw new Error(`Entry "${entry}" not found in ${file}`)
        const inputForFp = deepCloneInput ? deepClone(currentInput) : currentInput
        const actualInput = extractInputValue(currentInput)
        const inputForArgs = deepCloneInput ? deepClone(actualInput) : actualInput
        inputForArgsRef = inputForArgs  // trackMutation: keep reference for post-call snapshot
        // ─── inputTransform: apply transform before calling entry ──────────
        let transformedInputForArgs = inputForArgs
        if (inputTransform) {
          transformedInputForArgs = applyInputTransformVal(inputForArgs, inputTransform)
        }
        const args_ = multiArgs && Array.isArray(transformedInputForArgs) ? [...transformedInputForArgs] : [transformedInputForArgs]
        const expectThrow = isExpectThrow(currentInput)

        // ─── expectThrow: catch error and build error contract ────────────
        if (expectThrow) {
          let caughtError = null
          try {
            await entryFn(...args_)
          } catch (err) {
            caughtError = err
          }
          if (seed != null) Math.random = origRandom
          if (dateFrozen) globalThis.Date = OriginalDate
          if (!caughtError) {
            // Function did NOT throw when it should have — this is a FAIL
            lastOutput = null
            lastErrorContract = null
            fpInput = inputForFp
            // Use a sentinel hash that won't match the golden
            const fpConfig = { normalize, ignoreFields, ignorePaths }
            const errHash = fingerprint(inputForFp, { expectThrowViolated: true }, fpConfig)
            hashes.push(errHash)
            const inputKey = JSON.stringify(currentInput)
            if (!hashesPerInput[inputKey]) hashesPerInput[inputKey] = []
            hashesPerInput[inputKey].push(errHash)
            continue
          }
          const errorContract = buildErrorContract(caughtError, normalize)
          lastErrorContract = errorContract
          lastOutput = null
          fpInput = inputForFp
          if (seed != null) Math.random = origRandom
          if (dateFrozen) globalThis.Date = OriginalDate
          // Fingerprint the error contract (same as capture)
          const fpConfig = { normalize, ignoreFields, ignorePaths }
          const fp = fingerprint(fpInput, errorContract, fpConfig)
          hashes.push(fp)
          const inputKey = JSON.stringify(currentInput)
          if (!hashesPerInput[inputKey]) hashesPerInput[inputKey] = []
          hashesPerInput[inputKey].push(fp)
          continue
        }

        const rawOutput = await entryFn(...args_)

        // Restore original Math.random and Date after the call
        if (seed != null) Math.random = origRandom
        if (dateFrozen) globalThis.Date = OriginalDate

        // Materialize generator/iterator output if configured
        const { result: consumedOutput } = await consumeIterator(rawOutput, null, { materialize: materializeOutputFlag })

        // Apply outputTransform if specified (from .regret or manifest)
        const outputTransform = regret.outputTransform || manifestOutputTransform || null
        const transformedOutput = await applyOutputTransformAsync(consumedOutput, outputTransform, process.cwd())

        output = deepClone(transformedOutput)
        lastOutput = output
        lastErrorContract = null  // normal output, no error contract
        fpInput = multiArgs && Array.isArray(inputForFp) ? inputForFp : inputForFp
      }

      // ── trackMutation: snapshot input state AFTER call to detect mutations ──
      if (trackMutation && inputSnapshotBefore !== null && inputForArgsRef !== null) {
        // Snapshot the actual args object after the function call
        // inputForArgsRef points to the same object that was passed to the entry function,
        // so if the function mutated it in-place, we'll detect the difference.
        const inputSnapshotAfter = deepClone(inputForArgsRef)
        const beforeStr = stableStringify(inputSnapshotBefore)
        const afterStr = stableStringify(inputSnapshotAfter)
        const isMutated = beforeStr !== afterStr

        if (isMutated) {
          mutationDetected = true
        }

        // Compute mutation fingerprint (same method as capture.js)
        const mutFpConfig = { normalize, ignoreFields, ignorePaths: regret.ignorePaths || ignorePaths }
        liveMutationFingerprint = fingerprint(inputSnapshotBefore, inputSnapshotAfter, mutFpConfig)

        // Compare with golden mutation fingerprint from .regret file
        if (goldenMutationFingerprint) {
          if (liveMutationFingerprint !== goldenMutationFingerprint) {
            mutationMatch = false
          }
        } else {
          // .regret file has no mutation fingerprint (old capture) → skip mutation check, print warning
          // Only warn once (first run, first input)
          if (i === 0 && currentInput === inputsToValidate[0]) {
            console.warn(`  ⚠️  ${clusterDef.id}: trackMutation enabled but .regret file has no mutationFingerprint — skipping mutation comparison`)
            console.warn(`      Re-run capture.js to generate mutation fingerprint`)
          }
        }
      }

      // Compute fingerprint
      const fpConfig = { normalize, ignoreFields, ignorePaths }
      let fp
      if (mode === 'schema') {
        const schema = extractSchema(output)
        fp = fingerprint(fpInput, schema, fpConfig)
      } else if (mode === 'mixed') {
        const schema = extractSchema(output)
        const selectedValues = {}
        for (const path of paths) {
          const key = path.replace(/^\$\./, '')
          const parts = key.split('.')
          let val = output
          for (const p of parts) {
            val = val?.[p]
          }
          if (val !== undefined) selectedValues[path] = val
        }
        const combined = { schema, values: selectedValues }
        fp = fingerprint(fpInput, combined, fpConfig)
      } else if (effectiveFingerprintLevel === 'calls') {
        const callCounts = reduceToCallCounts(recorder)
        fp = fingerprint(fpInput, callCounts, fpConfig)
      } else {
        fp = fingerprintLevel === 'entry'
          ? fingerprint(fpInput, maybeMergeSideEffects(output), fpConfig)
          : fingerprintSequence(recorder, fpConfig)
      }
      hashes.push(fp)

      // Save side effect recording for diff display on FAIL
      lastSideEffectRecording = [...sideEffectRecorder]

      // Track per-input hashes for drift detection
      const inputKey = JSON.stringify(currentInput)
      if (!hashesPerInput[inputKey]) hashesPerInput[inputKey] = []
      hashesPerInput[inputKey].push(fp)

      // Issue #315: record the live hash for this input on the LAST run.
      // We overwrite on each run so the array ends up with the final-run
      // hash for each input, parallel to inputsToValidate order. The first
      // element matches `regret.goldenHash` (the top-level INPUT/OUTPUT/HASH
      // trio); elements 1+ match `regret.goldenInputs` (when present).
      const inputIndex = inputsToValidate.indexOf(currentInput)
      if (inputIndex !== -1) {
        liveInputs[inputIndex] = {
          input: currentInput,
          output,
          hash: fp,
          threw: lastErrorContract != null,
          error: lastErrorContract,
        }
      }
    } // end for each input
  } // end for each run
  // Restore original side-effect-watched methods
  for (const { obj, key, original } of sideEffectRestores) {
    obj[key] = original
  }

  return { hashes, hashesPerInput, liveInputs, lastOutput, lastErrorContract, mutationMatch, mutationDetected, liveMutationFingerprint, lastSideEffectRecording, goldenSideEffects: regret.goldenSideEffects, uncoveredInputCount }
}

// ─── Update a .regret ─────────────────────────────────────────────────────────

/**
 * Parse a .regret file into structured sections for targeted field updates.
 *
 * The file format is:
 *   <metadata lines>     — key: value pairs, one per line
 *   ---                  — separator
 *   INPUT  <json>
 *   OUTPUT <json>        ← may span multiple lines (pretty-printed JSON)
 *   HASH   <hash>
 *
 * The line-by-line parser avoids regex .replace() which has two bugs:
 *   1. /^OUTPUT .+$/m only matches the FIRST line of multiline OUTPUT,
 *      silently dropping subsequent lines.
 *   2. /^fingerprint: .+$/m can match a line inside OUTPUT data that
 *      happens to start with "fingerprint:", corrupting the file.
 */
function parseRegretStructure(raw) {
  const lines = raw.split('\n')
  const metaLines = []
  const dataLines = []
  let pastSeparator = false
  let outputStartIdx = -1  // index within dataLines where OUTPUT begins
  let hashIdx = -1         // index within dataLines where HASH begins

  for (const line of lines) {
    if (line === '---') {
      pastSeparator = true
      continue
    }
    if (!pastSeparator) {
      metaLines.push(line)
    } else {
      if (line.startsWith('OUTPUT ') && outputStartIdx === -1) {
        outputStartIdx = dataLines.length
      }
      if (line.startsWith('HASH ') && hashIdx === -1) {
        hashIdx = dataLines.length
      }
      dataLines.push(line)
    }
  }

  return { metaLines, dataLines, outputStartIdx, hashIdx }
}

/**
 * Reconstruct a .regret file from its parsed structure,
 * applying targeted field updates.
 *
 * Updates are applied by key matching on metadata lines (startsWith check)
 * and by section-boundary-aware replacement for OUTPUT (which may be multiline).
 */
function reconstructRegret(structure, updates) {
  const { metaLines, dataLines, outputStartIdx, hashIdx } = structure

  // Update metadata lines — only replace lines whose key STARTS WITH the target
  const updatedMeta = metaLines.map(line => {
    for (const [key, value] of Object.entries(updates.meta)) {
      // Match "fingerprint: " at the start of the line (not inside data body)
      if (line.startsWith(key + ': ')) {
        return `${key}: ${value}`
      }
    }
    return line
  })

  // Update data lines
  const updatedData = [...dataLines]

  // Replace OUTPUT section: from the OUTPUT line to (but not including) the HASH line
  if (outputStartIdx !== -1 && 'output' in updates) {
    const endIdx = hashIdx !== -1 ? hashIdx : dataLines.length
    // Remove all lines from OUTPUT start up to HASH
    updatedData.splice(outputStartIdx, endIdx - outputStartIdx)
    // Insert the new OUTPUT line(s) at the same position
    updatedData.splice(outputStartIdx, 0, updates.output)
  }

  // Replace HASH line
  if (hashIdx !== -1 && 'hash' in updates) {
    // Recalculate hashIdx in case OUTPUT changed the array length
    const adjustedHashIdx = updatedData.findIndex(l => l.startsWith('HASH '))
    if (adjustedHashIdx !== -1) {
      updatedData[adjustedHashIdx] = updates.hash
    }
  }

  return [...updatedMeta, '---', ...updatedData].join('\n')
}

/**
 * Compute side effect signature for use in updateRegret.
 * Shared logic with the same function in runCluster.
 */
function computeSideEffectSignatureForUpdate(seRecorder, normalizeRules = [], ignoreFieldsList = [], ignorePathsList = []) {
  if (!seRecorder || seRecorder.length === 0) return { sideEffects: [] }
  const normalized = seRecorder.map((call, idx) => ({
    fn: call.fn,
    args: stripFields(fpNormalize(deepClone(call.args), normalizeRules), ignoreFieldsList, ignorePathsList),
    callIndex: idx,
  }))
  normalized.sort((a, b) => a.fn.localeCompare(b.fn) || a.callIndex - b.callIndex)
  return { sideEffects: normalized }
}

function updateRegret(regretPath, regret, newHash, liveOutput, reason, liveSideEffects = null, liveInputs = null) {
  const oldHash = regret.goldenHash
  const now = new Date().toISOString()
  // Sanitize reason: replace newlines to prevent audit.log corruption
  const safeReason = reason.replace(/[\r\n]+/g, ' ')
  // Convert TypedArrays to regular arrays for JSON serialization
  const serializableOutput = ArrayBuffer.isView(liveOutput) && !(liveOutput instanceof DataView)
    ? Array.from(liveOutput)
    : liveOutput

  const structure = parseRegretStructure(regret.raw)

  // Issue #298: when --update is invoked on a callee .regret file that has
  // a multi-call CALLS line, the per-call hashes in that line become stale
  // (we only re-ran the FIRST call's args to compute `newHash`).
  // Rather than silently leaving stale data that would cause the next
  // `validate` to FAIL on multi-call entries (confusing the user, who just
  // explicitly accepted the new behavior), we drop the CALLS line entirely.
  // The next `validate` then falls back to the single-call contract (from
  // INPUT/OUTPUT/HASH), which `--update` just refreshed. The user can
  // re-capture (`regret capture --cluster <parent>`) to regenerate the
  // full multi-call contract.
  //
  // This is a no-op for parent cluster .regret files (they never have a
  // CALLS line) and for callee files without multi-call contracts.
  structure.dataLines = structure.dataLines.filter(l => !l.startsWith('CALLS '))

  // Build update object
  const updates = {
    meta: {
      fingerprint: newHash,
      captured: now,
    },
    output: `OUTPUT ${JSON.stringify(serializableOutput)}`,
    hash: `HASH   ${newHash}`,
  }

  // Issue #315: refresh the INPUTS line with the new per-input hashes.
  //
  // When a parent cluster has multiple inputs and the user runs
  // `regret update`, the top-level INPUT/OUTPUT/HASH (for input[0]) gets
  // refreshed by the lines above. But the INPUTS line (for inputs 1+)
  // would otherwise stay stale — its stored hashes reflect the OLD
  // behavior, so the next `validate` would FAIL on those inputs even
  // though the user just accepted the new behavior.
  //
  // We rebuild the INPUTS line from `liveInputs` (passed in by the main
  // loop). liveInputs[0] is the golden (already represented by the
  // top-level lines), so we take liveInputs.slice(1) — matching the
  // capture.js convention. We only include inputs that have a hash;
  // inputs that weren't re-run (e.g. no longer in manifest) are dropped,
  // which is correct (re-capture to add them back).
  //
  // If liveInputs is null (callee update path) or has <= 1 entries, we
  // DROP any existing INPUTS line — same rationale as the CALLS line
  // above (stale multi-input data is worse than no multi-input data).
  if (Array.isArray(liveInputs) && liveInputs.length > 1) {
    const inputsPayload = liveInputs.slice(1)
      .filter(li => li && typeof li === 'object' && li.hash != null)
      .map(li => {
        const entry = { input: li.input, output: li.output, hash: li.hash }
        if (li.threw) entry.threw = true
        if (li.error != null) entry.error = li.error
        return entry
      })
    const newInputsLine = `INPUTS ${JSON.stringify(inputsPayload)}`
    const inputsIdx = structure.dataLines.findIndex(l => l.startsWith('INPUTS '))
    if (inputsIdx !== -1) {
      structure.dataLines[inputsIdx] = newInputsLine
    } else {
      // Insert INPUTS line right after the HASH line (matches capture.js order)
      const hashIdx = structure.dataLines.findIndex(l => l.startsWith('HASH '))
      if (hashIdx !== -1) {
        structure.dataLines.splice(hashIdx + 1, 0, newInputsLine)
      } else {
        structure.dataLines.push(newInputsLine)
      }
    }
  } else {
    // No live multi-input data — drop any stale INPUTS line so the next
    // validate doesn't FAIL on inputs we can't re-run.
    structure.dataLines = structure.dataLines.filter(l => !l.startsWith('INPUTS '))
  }

  // Update SIDE_EFFECTS line if the .regret file has one and we have new side effects
  if (regret.goldenSideEffects && liveSideEffects !== null) {
    // Find and replace the SIDE_EFFECTS line in dataLines
    const seIdx = structure.dataLines.findIndex(l => l.startsWith('SIDE_EFFECTS '))
    if (seIdx !== -1) {
      // Compute new side effect signature from live recording
      const seSig = liveSideEffects.length > 0
        ? computeSideEffectSignatureForUpdate(liveSideEffects, regret.normalize ?? [], regret.ignoreFields ?? [], regret.ignorePaths ?? [])
        : { sideEffects: [] }
      structure.dataLines[seIdx] = `SIDE_EFFECTS ${JSON.stringify(seSig)}`
    }
  }

  const newContent = reconstructRegret(structure, updates)
  const _regretLock = acquireLock(regretPath)
  try {
    writeFileSync(regretPath, newContent, 'utf8')
  } finally {
    releaseLock(_regretLock)
  }

  // ─── Hash chain ────────────────────────────────────────────────────────────
  let prevChain = '0000000'  // genesis
  if (existsSync(auditLog)) {
    const logContent = readFileSync(auditLog, 'utf8').trim()
    if (logContent) {
      const lines = logContent.split('\n')
      // Walk backwards to find the last chain hash
      for (let i = lines.length - 1; i >= 0; i--) {
        const m = lines[i].match(/^\s*chain:\s*(\S+)/)
        if (m) { prevChain = m[1]; break }
      }
    }
  }

  const clusterId = basename(regretPath, '.regret')

  // ─── Git / CI provenance metadata (#250) ──────────────────────────────────
  // Capture author, git commit SHA, and CI run id at update time so the
  // audit trail answers "who/what/when" — accessible via `regret history`.
  // All lookups are best-effort: failures fall back to null and we still
  // write the entry. The legacy `by: AI refactor session` line is kept for
  // backward compatibility with older parsers; the richer `gitAuthor`,
  // `gitSha`, and `ciRunId` fields are added alongside it.
  let gitAuthor = null
  let gitSha = null
  const ciRunId = process.env.GITHUB_RUN_ID || process.env.CI_RUN_ID || null
  try {
    const gitName = _execSync('git config user.name', { stdio: ['ignore', 'pipe', 'ignore'], cwd: process.cwd() }).toString().trim()
    const gitEmail = _execSync('git config user.email', { stdio: ['ignore', 'pipe', 'ignore'], cwd: process.cwd() }).toString().trim()
    if (gitName) gitAuthor = gitEmail ? `${gitName} <${gitEmail}>` : gitName
  } catch { /* not a git repo, or git missing — leave gitAuthor null */ }
  try {
    // Short SHA is enough for human-readable audit; full SHA is recoverable
    // from the short form via `git rev-parse <short>`.
    gitSha = _execSync('git rev-parse --short HEAD', { stdio: ['ignore', 'pipe', 'ignore'], cwd: process.cwd() }).toString().trim()
  } catch { /* no commits yet, or not a git repo — leave gitSha null */ }

  // Build the entry content. New fields (gitAuthor, gitSha, ciRunId) are
  // added BEFORE the chain hash is computed so the chain covers them too.
  // Legacy `by:` line stays for backward compat with old parsers/tools.
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
  const chainHash = createHash('sha256').update(prevChain + newEntryContent).digest('hex').slice(0, 7)

  const entry = `\n${newEntryContent}\n  chain: ${chainHash}`
  const _auditLock = acquireLock(auditLog)
  try {
    appendFileSync(auditLog, entry, 'utf8')
  } finally {
    releaseLock(_auditLock)
  }
  return { oldHash, newHash }
}

// ─── JUnit XML output ─────────────────────────────────────────────────────────

function escapeXml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
}

export function generateJUnitXml(results) {
  const activeResults = results.filter(r => !r.skipped)
  const tests = activeResults.length
  const failures = activeResults.filter(r => !r.pass).length
  const time = (Date.now() - (globalThis._validateStartTime ?? Date.now())) / 1000

  let xml = '<?xml version="1.0" encoding="UTF-8"?>\n'
  xml += `<testsuite name="regrets" tests="${tests}" failures="${failures}" time="${time.toFixed(3)}">\n`

  for (const r of activeResults) {
    xml += `  <testcase classname="regrets" name="${escapeXml(r.id)}" time="0.000">`
    if (!r.pass) {
      const message = r.error
        ? escapeXml(r.error)
        : r.drift
          ? `Drift detected: hashes vary across runs`
          : `Fingerprint mismatch: expected ${r.expected ?? 'unknown'}, got ${r.actual ?? 'unknown'}`
      xml += `\n    <failure message="${escapeXml(message)}">${escapeXml(message)}</failure>\n  `
    }
    xml += `</testcase>\n`
  }

  xml += '</testsuite>\n'
  return xml
}

// ─── Side Effect Diff formatting ──────────────────────────────────────────────

/**
 * Format a side effect diff between golden and live recordings.
 * Shows dropped side effects, added side effects, and changed args.
 */
export function formatSideEffectDiff(goldenSideEffects, liveSERecording, normalizeRules = [], ignoreFieldsList = [], ignorePathsList = []) {
  if (!goldenSideEffects && (!liveSERecording || liveSERecording.length === 0)) return ''

  const golden = goldenSideEffects?.sideEffects ?? []
  const live = liveSERecording ?? []

  // Build call counts by function name
  const goldenCallsByFn = {}
  for (const call of golden) {
    goldenCallsByFn[call.fn] = goldenCallsByFn[call.fn] || []
    goldenCallsByFn[call.fn].push(call)
  }
  const liveCallsByFn = {}
  for (const call of live) {
    liveCallsByFn[call.fn] = liveCallsByFn[call.fn] || []
    liveCallsByFn[call.fn].push(call)
  }

  const allFns = new Set([...Object.keys(goldenCallsByFn), ...Object.keys(liveCallsByFn)])
  const lines = []

  for (const fn of [...allFns].sort()) {
    const goldenCalls = goldenCallsByFn[fn] || []
    const liveCalls = liveCallsByFn[fn] || []

    if (goldenCalls.length > 0 && liveCalls.length === 0) {
      // Side effect dropped entirely
      lines.push(`    side effect dropped: ${fn} (was called ${goldenCalls.length}x, now 0x)`)
    } else if (goldenCalls.length === 0 && liveCalls.length > 0) {
      // New side effect appeared
      lines.push(`    side effect added: ${fn} (was 0x, now called ${liveCalls.length}x)`)
    } else if (goldenCalls.length !== liveCalls.length) {
      // Call count changed
      lines.push(`    side effect count changed: ${fn} (${goldenCalls.length}x → ${liveCalls.length}x)`)
    }

    // Compare args for matching calls
    const minLen = Math.min(goldenCalls.length, liveCalls.length)
    for (let idx = 0; idx < minLen; idx++) {
      const gArgs = stripFields(fpNormalize(goldenCalls[idx].args, normalizeRules), ignoreFieldsList, ignorePathsList)
      const lArgs = stripFields(fpNormalize(deepClone(liveCalls[idx].args), normalizeRules), ignoreFieldsList, ignorePathsList)
      const gStr = stableStringify(gArgs)
      const lStr = stableStringify(lArgs)
      if (gStr !== lStr) {
        const diffs = jsonDiff(gArgs, lArgs)
        for (const d of diffs) {
          const truncate = (v, max = 60) => {
            const s = JSON.stringify(v)
            return s && s.length > max ? s.slice(0, max) + '…' : s
          }
          lines.push(`    side effect args changed: ${fn} call[${idx}].${d.path}: ${truncate(d.golden)} → ${truncate(d.live)}`)
        }
      }
    }
  }

  return lines.length > 0 ? lines.join('\n') : ''
}

// ─── Callee contract re-validation ──────────────────────────────────────────
//
// `.calls.*` regret files are written by capture.js for each declared callee
// of a parent cluster. Each file records:
//   - parent cluster id (so we can look up the parent's `file` and fp config)
//   - callee name (= entry function name in the parent's module)
//   - saved args (INPUT line, already an array)
//   - saved result OR error contract (OUTPUT / ERROR_CONTRACT line)
//   - golden fingerprint (HASH line)
//   - optional `threw: true` flag indicating the callee was expected to throw
//
// Re-validation re-runs the callee function with the saved args and computes
// a fresh fingerprint, then compares it to the golden. This detects callee
// regressions that would otherwise be invisible (the parent cluster's
// fingerprint only captures the parent's output, not the callee's individual
// behavior — a callee that returns a wrong intermediate value but somehow
// preserves the parent's final output would silently slip through).

export async function runCalleeContract(calleeRegret, parentClusterDef, options = {}) {
  const {
    normalize = [],
    ignoreFields = [],
    ignorePaths = [],
  } = options

  // ── Resolve parent module + callee function ─────────────────────────────
  const parentFile = parentClusterDef.file
  if (!parentFile) {
    return {
      pass: false,
      error: `parent cluster "${parentClusterDef.id}" has no 'file' field — cannot locate callee`,
      liveHash: null,
    }
  }

  // Skip non-JS stacks — they have their own validators (validate.py, etc.)
  const parentStack = parentClusterDef.stack ?? 'js'
  if (parentStack === 'python' || parentStack === 'rust' || parentStack === 'go') {
    return {
      pass: false,
      skipped: true,
      error: `parent stack=${parentStack} — use the matching validator`,
      liveHash: calleeRegret.goldenHash,
    }
  }

  // Resolve entry/callee names — prefer the callee .regret's `entry` field,
  // fall back to its `callee` field, then to the callee name embedded in the
  // cluster id (`<parent>.calls.<callee>`).
  const calleeName =
    calleeRegret.entry ??
    calleeRegret.callee ??
    calleeRegret.cluster?.split('.calls.').pop() ??
    null

  if (!calleeName) {
    return {
      pass: false,
      error: 'callee .regret has no entry/callee/cluster field — cannot determine which function to call',
      liveHash: null,
    }
  }

  // ── Import parent module (with CJS merge) ───────────────────────────────
  let mod
  try {
    mod = await import(pathToFileURL(resolve(process.cwd(), parentFile)).href)
  } catch (err) {
    if (err.code === 'ERR_MODULE_NOT_FOUND' || err.code === 'ENOENT') {
      return {
        pass: false,
        error: `parent file not found at ${parentFile} (cluster "${parentClusterDef.id}"). Compile the project or fix the 'file' field in manifest.json.`,
        liveHash: null,
      }
    }
    return {
      pass: false,
      error: `failed to import parent file ${parentFile}: ${err.message}`,
      liveHash: null,
    }
  }
  mod = mergeCjsModule(mod)

  // Resolve the callee function — check mod, mod.default, then `module.exports = function` shape
  let entryFn =
    mod[calleeName] ??
    mod.default?.[calleeName] ??
    ((calleeName === 'default' || calleeName === 'module.exports') && typeof mod.default === 'function' ? mod.default : null)

  // ── #299: ESM/CJS transform fallback ───────────────────────────────────
  // For non-exported top-level function callees (e.g. `function _add() {}`
  // without a corresponding `export { _add }`), capture.js applies the same
  // ESM/CJS source transform (esm-callee-transform.js / cjs-callee-transform.js)
  // to expose the callee via a mutable `__regretsHolder` object. Without that
  // transform, `mod[calleeName]` is undefined here, and re-validation
  // produces a false FAIL for a pattern capture.js handled fine.
  //
  // We mirror capture.js: when the direct lookup fails AND the parent
  // declares `callees` AND the file is ESM/CJS, apply the same transform,
  // load the transformed source from a temp file in the same directory
  // (so relative imports still resolve), and look up the callee via the
  // holder. Original source file is never modified. Temp file is deleted
  // in the finally block below.
  //
  // Closes #299.
  let esmTransformTempPath = null
  if (typeof entryFn !== 'function' &&
      Array.isArray(parentClusterDef.callees) && parentClusterDef.callees.length > 0) {
    const absPath = resolve(process.cwd(), parentFile)
    const fileExt = extname(absPath).toLowerCase()
    if (['.mjs', '.cjs', '.js', '.ts', '.tsx'].includes(fileExt)) {
      try {
        const source = readFileSync(absPath, 'utf8')
        const isEsm = isEsmSource(source, fileExt)
        const isCjs = !isEsm && isCjsSource(source, fileExt)
        let transformResult = null
        let holderName = HOLDER_NAME
        if (isEsm) {
          transformResult = await transformEsmForCallees(source, parentClusterDef.callees, fileExt)
        } else if (isCjs) {
          transformResult = await transformCjsForCallees(source, parentClusterDef.callees, fileExt)
        }
        if (transformResult) {
          const dir = dirname(absPath)
          const tempExt = isCjs ? '.cjs' : '.mjs'
          const tempName = generateEsmTempFileName().replace(/\.mjs$/, tempExt)
          esmTransformTempPath = join(dir, tempName)
          registerEsmTempFile(esmTransformTempPath)
          writeFileSync(esmTransformTempPath, transformResult.transformedSource, 'utf8')
          const transformedMod = mergeCjsModule(await import(pathToFileURL(esmTransformTempPath).href))
          // Look up the callee on the holder first (the canonical place
          // capture.js populates), then fall back to the transformed module
          // namespace + default export for symmetry with the direct path.
          entryFn =
            (transformedMod[holderName] && typeof transformedMod[holderName][calleeName] === 'function'
              ? transformedMod[holderName][calleeName]
              : null) ??
            transformedMod[calleeName] ??
            transformedMod.default?.[calleeName] ??
            ((calleeName === 'default' || calleeName === 'module.exports') && typeof transformedMod.default === 'function' ? transformedMod.default : null)
        }
      } catch {
        // Transform or transformed-import failed — fall through to the
        // "not found" error below. We deliberately swallow the error to
        // keep the user-facing message focused on the callee lookup.
      } finally {
        if (esmTransformTempPath) {
          try { deleteEsmTempFile(esmTransformTempPath) } catch { /* best-effort cleanup */ }
          esmTransformTempPath = null
        }
      }
    }
  }

  if (typeof entryFn !== 'function') {
    return {
      pass: false,
      error: `callee "${calleeName}" not found (or not a function) in ${parentFile}`,
      liveHash: null,
    }
  }

  // ── Re-run the callee with saved args ───────────────────────────────────
  // INPUT line in the callee .regret is the args array (e.g. [5, 1]).
  // If it's not an array, wrap it as a single-arg call.
  const savedArgs = Array.isArray(calleeRegret.input)
    ? deepClone(calleeRegret.input)
    : [deepClone(calleeRegret.input)]

  const expectThrow = calleeRegret.threw === true || calleeRegret.threw === 'true'
  const fpConfig = { normalize, ignoreFields, ignorePaths }

  let liveResult
  let liveError = null
  try {
    liveResult = await entryFn(...savedArgs)
  } catch (err) {
    liveError = err
  }

  // ── Compute live fingerprint ────────────────────────────────────────────
  // Match capture.js semantics: error → { __error: message }, else result.
  let liveFpOutput
  let liveErrorContract = null
  if (liveError != null) {
    // Use the same error-contract builder as the main validator so messages
    // are normalized the same way (timestamps/uuids/epochs/stack stripped).
    liveErrorContract = buildErrorContract(liveError, normalize)
    liveFpOutput = { __error: String(liveError) }
  } else {
    liveFpOutput = liveResult ?? null
  }

  const liveHash = fingerprint(deepClone(savedArgs), liveFpOutput, fpConfig)

  // ── Compare against golden ──────────────────────────────────────────────
  const goldenHash = calleeRegret.goldenHash
  const isMatch = liveHash === goldenHash

  // expectThrow mismatch takes priority — it's a behavioral change in the
  // callee's contract (was throwing, now doesn't, or vice versa).
  let expectThrowViolated = false
  if (expectThrow && liveError == null) {
    expectThrowViolated = true
  } else if (!expectThrow && liveError != null) {
    expectThrowViolated = true
  }

  // ── Issue #298: multi-call re-validation ────────────────────────────────
  // When the .regret file has a CALLS line, the callee was captured with
  // multiple unique arg sets. Re-run EACH saved args and FAIL if any call's
  // live hash differs from its golden. This catches refactors that break
  // the callee for args that weren't the first call's args — previously
  // such refactors PASSed as false negatives.
  //
  // The first call's hash always equals `goldenHash` (backward compat with
  // the top-level HASH line), so we skip re-running it here — `liveHash`
  // above already covers it. We only re-run calls 2..N.
  //
  // Backward compat: when `goldenCalls` is null (old .regret files without
  // a CALLS line, OR new files where the callee was only called once), this
  // block is skipped entirely and behavior is identical to the old
  // single-call contract.
  const multiCallFailures = []
  if (Array.isArray(calleeRegret.goldenCalls) && calleeRegret.goldenCalls.length > 1) {
    for (let i = 1; i < calleeRegret.goldenCalls.length; i++) {
      const callEntry = calleeRegret.goldenCalls[i]
      if (!callEntry || !Array.isArray(callEntry.args)) continue

      const callArgs = deepClone(callEntry.args)
      let callResult
      let callError = null
      try {
        // Use Reflect.apply for construct-aware dispatch — if the original
        // call was a `new` invocation, the saved args are constructor args
        // and we should re-invoke with `new` to match the semantics.
        if (callEntry.construct === true) {
          callResult = Reflect.construct(entryFn, callArgs)
        } else {
          callResult = await entryFn(...callArgs)
        }
      } catch (err) {
        callError = err
      }

      let callFpOutput
      if (callError != null) {
        callFpOutput = { __error: String(callError) }
      } else {
        callFpOutput = callResult ?? null
      }
      const callLiveHash = fingerprint(deepClone(callArgs), callFpOutput, fpConfig)
      const callGoldenHash = callEntry.hash
      if (callLiveHash !== callGoldenHash) {
        multiCallFailures.push({
          callIndex: i,
          args: callArgs,
          goldenHash: callGoldenHash,
          liveHash: callLiveHash,
          // Track expectThrow mismatch per-call too — a call that previously
          // returned a value and now throws (or vice versa) is a behavioral
          // change worth surfacing.
          expectThrowViolated:
            (callEntry.threw === true && callError == null) ||
            (callEntry.threw !== true && callError != null),
        })
      }
    }
  }

  // If any multi-call entry failed, the overall callee contract FAILs.
  // Preserve the first-call's liveHash/goldenHash for the top-level result
  // (so existing tooling that reads `liveHash`/`goldenHash` continues to
  // work), but also report the multi-call failures so the user can see
  // WHICH args broke.
  const multiCallFailed = multiCallFailures.length > 0

  return {
    pass: isMatch && !expectThrowViolated && !multiCallFailed,
    liveHash,
    goldenHash,
    expectThrowViolated,
    expectedThrow: expectThrow,
    liveError: liveError ? String(liveError) : null,
    liveErrorContract,
    liveOutput: liveError == null ? liveResult : null,
    goldenOutput: calleeRegret.output ?? null,
    goldenErrorContract: calleeRegret.errorContract ?? null,
    // Issue #298: expose multi-call failure details for the caller to render.
    // Empty array when no multi-call contract existed or all calls matched.
    multiCallFailures,
  }
}

// ─── Main (CLI only) ──────────────────────────────────────────────────────────

if (isMainModule) {
const updateMode = !!updateTarget
const driftMode  = runs > 1 && !updateMode

if (jsonOutput) {
  // silent in JSON mode
} else if (quiet) {
  // quiet mode: no per-cluster output, only summary at the end
} else if (updateMode)     console.log(`\n🔄 Update mode — cluster: ${updateTarget}\n   Reason: ${updateReason}\n`)
else if (driftMode) console.log(`\n🔍 Drift detection — ${runs} runs${!runsExplicit && manifest.clusters?.some(c => c.driftRuns) ? ' (default, per-cluster driftRuns may override)' : ''} per cluster...\n`)
else                console.log(`\n🔍 Validating ${regretFiles.length} cluster(s)...\n`)

const results = []

// ─── Confidence pre-computation ──────────────────────────────────────────────────
// Build input-count map from manifest, parse audit.log for drift history,
// then compute confidence per cluster for inclusion in JSON output.
const _inputCountMap = {}
for (const c of manifest.clusters || []) {
  _inputCountMap[c.id] = (c.inputs || []).length
}
const _driftMap = parseAuditForDrift(auditLog)
const _now = Date.now()

function _confidenceForCluster(id, regretMeta) {
  const inputCount = _inputCountMap[id] ?? 0
  const captured = regretMeta.captured ? new Date(regretMeta.captured).getTime() : _now
  const ageDays = Math.floor((_now - captured) / (1000 * 60 * 60 * 24))
  const hasDriftOrUpdate = !!_driftMap[id]
  return computeConfidence({ inputCount, ageDays, hasDriftOrUpdate })
}

// Track start time for JUnit XML time field
globalThis._validateStartTime = Date.now()

for (const file of regretFiles) {
  const id         = basename(file, '.regret')
  const regretPath = join(regretDir, file)
  const regret     = parseRegret(readFileSync(regretPath, 'utf8'))
  const def        = manifest.clusters.find(c => c.id === id)
  if (!def) {
    // Phase 2 callee clusters (`<parent>.calls.<callee>`) are intentionally
    // not declared in the manifest — they are emitted by capture.js as
    // behavioral sub-contracts of their parent cluster. Validate skips
    // them silently here; they are re-validated explicitly in the callee
    // re-validation phase below (unless --skip-callees is set), so callee
    // regressions are now detected instead of silently missed.
    if (id.includes('.calls.')) {
      if (verbose && !jsonOutput && !quiet) {
        console.log(`  ⏭  ${id.padEnd(35)} [skipped: callee contract — not in manifest]`)
      }
      continue
    }
    if (!quiet && !jsonOutput) console.warn(`  ⚠️  ${id}: not in manifest — skipping`)
    continue
  }

  // Compute effective runs for this cluster:
  // Priority: --runs CLI (explicit) > manifest driftRuns > default runs (5 in drift-mode, 1 otherwise)
  const effectiveRuns = runsExplicit ? runs : (def.driftRuns ?? runs)

  // Compute confidence for this cluster (used in JSON output)
  const clusterConfidence = _confidenceForCluster(id, regret)

  try {
    const { hashes, hashesPerInput, liveInputs, lastOutput, lastErrorContract, skipped,
            mutationMatch: clusterMutationMatch,
            mutationDetected: clusterMutationDetected,
            liveMutationFingerprint: clusterLiveMutationFp,
            lastSideEffectRecording: clusterLastSERecording,
            goldenSideEffects: clusterGoldenSE,
            uncoveredInputCount: clusterUncoveredInputCount } = await runCluster(def, regret, { runs: effectiveRuns })
    if (skipped) { results.push({ id, pass: true, skipped: true, confidence: clusterConfidence.label }); continue }

    // ── trackMutation check: mutation mismatch takes priority over fingerprint match ──
    // If the .regret file has a mutationFingerprint and the live one differs, FAIL immediately.
    // This catches the case where a refactoring introduces a mutation that wasn't there before.
    const trackMutationFlag = regret.trackMutation || def.trackMutation || false
    const goldenMutationFp = regret.mutationFingerprint || null
    if (trackMutationFlag && goldenMutationFp && !clusterMutationMatch) {
      if (!jsonOutput) {
        if (!regret.inputMutated && clusterMutationDetected) {
          console.log(`  ❌ ${id.padEnd(35)} INPUT MUTATION DETECTED — function now mutates argument (was pure)`)
        } else {
          console.log(`  ❌ ${id.padEnd(35)} MUTATION MISMATCH  golden=${goldenMutationFp} live=${clusterLiveMutationFp}`)
        }
      }
      results.push({ id, pass: false, mutationMismatch: true, mutationDetected: clusterMutationDetected, confidence: clusterConfidence.label })
      if (failFast) {
        if (!jsonOutput) console.log(`\n  --fail-fast: stopping.`)
        break
      }
      continue
    }

    const liveHash = hashes[0]
    let isMatch  = liveHash === regret.goldenHash

    // ── Issue #315: multi-input contract check ───────────────────────────────
    //
    // When the .regret file has an `INPUTS` line (regret.goldenInputs),
    // validate EVERY stored input's hash against the live re-run — not
    // just the first. A breaking change that only affects inputs[1+]
    // would otherwise be invisible (false GREEN).
    //
    // The goldenInputs array covers inputs 1+ (the first input is the
    // top-level INPUT/OUTPUT/HASH trio). liveInputs is parallel:
    // liveInputs[0] is the golden, liveInputs[1+] correspond to
    // goldenInputs[0+].
    //
    // We match by INPUT VALUE (JSON.stringify) rather than by array index
    // because the manifest may have evolved since capture (inputs added/
    // removed/reordered). If a golden input is no longer in the manifest,
    // we can't re-run it — skip with a warning (the user explicitly
    // changed the input set, so the old contract is moot). If a manifest
    // input has no golden, it's a new input — skip (no golden to compare
    // against; re-capture to add it).
    //
    // If ANY golden input's live hash differs from its stored hash, the
    // cluster FAILs — even when the first input still matches.
    let multiInputFailures = []  // { input, goldenHash, liveHash, output? }
    if (Array.isArray(regret.goldenInputs) && regret.goldenInputs.length > 0) {
      for (const goldenEntry of regret.goldenInputs) {
        if (!goldenEntry || typeof goldenEntry !== 'object') continue
        const goldenInputStr = JSON.stringify(goldenEntry.input)
        // Find the matching live input by value
        const liveEntry = liveInputs?.find(li => li && JSON.stringify(li.input) === goldenInputStr)
        if (!liveEntry) {
          // Golden input is no longer in the manifest — can't re-run.
          // Skip with a verbose-only note (the user changed inputs).
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

    const isDrift  = driftMode && Object.values(hashesPerInput).some(inputHashes => new Set(inputHashes).size > 1)

    // ── expectThrow: special output for error contract validation ──────────
    const goldenErrorContract = regret.errorContract || null
    if (goldenErrorContract) {
      // This .regret was captured with expectThrow — compare error contracts
      if (!isMatch) {
        if (!jsonOutput && !quiet) {
          console.log(`  ❌ ${id.padEnd(35)} ${regret.goldenHash} → ${liveHash}  FAIL`)
          if (lastErrorContract) {
            console.log(`    Expected error: ${goldenErrorContract.type}: ${goldenErrorContract.message}`)
            console.log(`    Actual error:   ${lastErrorContract.type}: ${lastErrorContract.message}`)
          } else {
            console.log(`    Expected error: ${goldenErrorContract.type}: ${goldenErrorContract.message}`)
            console.log(`    Actual: function did NOT throw (error path removed)`)
          }
        }
        results.push({
          id, pass: false,
          expected: regret.goldenHash, actual: liveHash,
          expectedError: goldenErrorContract,
          actualError: lastErrorContract,
          expectThrowViolated: !lastErrorContract,
          confidence: clusterConfidence.label,
        })
      } else {
        if (!jsonOutput && !quiet) {
          console.log(`  ✅ ${id.padEnd(35)} ${regret.goldenHash}  PASS`)
        }
        results.push({ id, pass: true, expected: regret.goldenHash, actual: liveHash, confidence: clusterConfidence.label })
      }
      if (!results.at(-1).pass && failFast) {
        if (!jsonOutput && !quiet) console.log(`\n  --fail-fast: stopping.`)
        break
      }
      continue  // skip normal output path for expectThrow clusters
    }

    // ─── Verbose: print extra detail before status line ────────────────────
    if (verbose && !jsonOutput) {
      console.log(`  ┌─ ${id} ────────────────────────────────────`)
      console.log(`  │ Input:      ${JSON.stringify(regret.input)}`)
      console.log(`  │ Expected:   ${regret.goldenHash}`)
      console.log(`  │ Actual:     ${liveHash}`)
      console.log(`  │ Output:     ${JSON.stringify(lastOutput)?.slice(0, 200)}${JSON.stringify(lastOutput)?.length > 200 ? '…' : ''}`)
      if (regret.watches?.length) {
        console.log(`  │ Watches:    ${regret.watches.join(', ')}`)
      }
      if (driftMode && hashesPerInput && Object.keys(hashesPerInput).length > 0) {
        console.log(`  │ Per-input:  ${JSON.stringify(hashesPerInput)}`)
      }
      console.log(`  └────────────────────────────────────────────`)
    }

    if (updateMode) {
      if (isMatch) {
        if (!jsonOutput && !quiet) console.log(`  ℹ️  ${id.padEnd(35)} unchanged — no update needed`)
        results.push({ id, pass: true, confidence: clusterConfidence.label })
      } else {
        const { oldHash, newHash } = updateRegret(regretPath, regret, liveHash, lastOutput, updateReason, clusterLastSERecording, liveInputs)
        if (!jsonOutput && !quiet) console.log(`  ✅ ${id.padEnd(35)} ${oldHash} → ${newHash}  UPDATED`)
        results.push({ id, pass: true, updated: true, confidence: clusterConfidence.label })

        // Bug A (#284): re-capture and update callee .regret files for this parent.
        // When a parent's behavior changes (and the user confirmed via --reason),
        // the callee contracts derived from that parent's inputs must also be
        // refreshed — otherwise the next `regret validate` will report callee
        // FAIL (golden callee hash vs new live callee behavior).
        //
        // For each declared callee:
        //   - If `<parent>.calls.<callee>.regret` exists: re-run the callee with
        //     the saved INPUT args, compute the new hash, and write it back.
        //   - If the callee .regret file is MISSING: warn the user — we cannot
        //     re-update a contract that doesn't exist. They should run
        //     `regret capture --cluster <parent>` to generate it.
        //   - If the callee was never declared in the manifest: nothing to do.
        if (Array.isArray(def.callees) && def.callees.length > 0) {
          let updatedCallees = 0
          let missingCallees = 0
          let failedCallees = 0
          for (const calleeName of def.callees) {
            if (typeof calleeName !== 'string' || calleeName.length === 0) continue
            const calleeClusterId = `${id}.calls.${calleeName}`
            const calleeRegretPath = join(regretDir, `${calleeClusterId}.regret`)
            if (!existsSync(calleeRegretPath)) {
              missingCallees++
              if (!jsonOutput && !quiet) {
                console.log(`  ⚠️  ${calleeClusterId.padEnd(33)} missing — run \`regret capture --cluster ${id}\` to generate`)
              }
              continue
            }
            try {
              const calleeRegret = parseRegret(readFileSync(calleeRegretPath, 'utf8'))
              // Re-run the callee with the saved args (same logic as
              // runCalleeContract, but we want the live hash + output regardless
              // of whether it matches the golden).
              const calleeRun = await runCalleeContract(calleeRegret, def, {
                normalize: def.normalize ?? [],
                ignoreFields: def.ignoreFields ?? [],
                ignorePaths: def.ignorePaths ?? [],
              })
              if (calleeRun.liveHash == null) {
                // runCalleeContract returns liveHash=null when the parent file
                // can't be imported or the callee isn't found — can't update.
                failedCallees++
                if (!jsonOutput && !quiet) {
                  console.log(`  ❌ ${calleeClusterId.padEnd(33)} could not re-capture: ${calleeRun.error}`)
                }
                continue
              }
              // Only write if the hash actually changed — avoids needless
              // audit.log churn when callee behavior is unchanged.
              if (calleeRun.liveHash === calleeRegret.goldenHash) {
                if (verbose && !jsonOutput && !quiet) {
                  console.log(`  ℹ️  ${calleeClusterId.padEnd(33)} unchanged — no update needed`)
                }
                continue
              }
              const calleeLiveOutput = calleeRun.liveError != null ? null : calleeRun.liveOutput
              const { oldHash: calleeOld, newHash: calleeNew } = updateRegret(
                calleeRegretPath,
                calleeRegret,
                calleeRun.liveHash,
                calleeLiveOutput,
                updateReason,
              )
              updatedCallees++
              if (!jsonOutput && !quiet) {
                console.log(`  ✅ ${calleeClusterId.padEnd(33)} ${calleeOld} → ${calleeNew}  UPDATED (callee)`)
              }
            } catch (err) {
              failedCallees++
              if (!jsonOutput && !quiet) {
                console.log(`  ❌ ${calleeClusterId.padEnd(33)} ERROR during re-capture: ${err.message}`)
              }
            }
          }
          // Track callee update stats on the parent's result entry so the
          // summary line can mention how many callees were also updated.
          const lastIdx = results.length - 1
          if (lastIdx >= 0 && results[lastIdx].id === id) {
            results[lastIdx].calleesUpdated = updatedCallees
            results[lastIdx].calleesMissing = missingCallees
            results[lastIdx].calleesFailed = failedCallees
          }
        }
      }
    } else if (driftMode) {
      if (isDrift) {
        if (!jsonOutput && !quiet) {
          console.log(`  ❌ ${id.padEnd(35)} DRIFT  [${hashes.join(' / ')}]`)
          if (!noDiff && regret.output != null && lastOutput != null) {
            const diff = formatDiffOutput(regret.output, lastOutput, { verbose })
            if (diff) console.log(diff)
          }
        }
        results.push({ id, pass: false, drift: true, goldenOutput: regret.output, liveOutput: lastOutput, confidence: clusterConfidence.label })
      } else {
        if (!jsonOutput && !quiet) {
          const icon = isMatch ? '✅' : '❌'
          console.log(`  ${icon} ${id.padEnd(35)} ${liveHash}  × ${effectiveRuns}  ${isMatch ? 'PASS+STABLE' : 'FAIL'}`)
          if (!isMatch && !noDiff && regret.output != null && lastOutput != null) {
            const diff = formatDiffOutput(regret.output, lastOutput, { verbose })
            if (diff) console.log(diff)
          }
          if (!isMatch && clusterGoldenSE) {
            const seDiff = formatSideEffectDiff(clusterGoldenSE, clusterLastSERecording, regret.normalize ?? [], regret.ignoreFields ?? [], regret.ignorePaths ?? [])
            if (seDiff) console.log(seDiff)
          }
        }
        results.push({ id, pass: isMatch, goldenOutput: regret.output, liveOutput: lastOutput, confidence: clusterConfidence.label })
      }
    } else {
      if (!jsonOutput && !quiet) {
        const icon = isMatch ? '✅' : '❌'
        const hstr = isMatch ? regret.goldenHash : `${regret.goldenHash} → ${liveHash}`
        console.log(`  ${icon} ${id.padEnd(35)} ${hstr.padEnd(22)} ${isMatch ? 'PASS' : 'FAIL'}`)
        if (!isMatch && !noDiff && regret.output != null && lastOutput != null) {
          const diff = formatDiffOutput(regret.output, lastOutput, { verbose })
          if (diff) console.log(diff)
        }
        // Show side effect diff if applicable
        if (!isMatch && clusterGoldenSE) {
          const seDiff = formatSideEffectDiff(clusterGoldenSE, clusterLastSERecording, regret.normalize ?? [], regret.ignoreFields ?? [], regret.ignorePaths ?? [])
          if (seDiff) console.log(seDiff)
        }
        // Issue #315: when the first input matches but a later input
        // mismatches, the top-level hash line above shows PASS — that's
        // misleading. Print a clear per-input failure breakdown so the
        // user knows WHICH input broke and what its output became.
        if (multiInputFailures.length > 0) {
          console.log(`    ⚠️  ${multiInputFailures.length} additional input(s) changed behavior:`)
          for (const f of multiInputFailures) {
            const inputStr = JSON.stringify(f.input)
            const inputDisplay = inputStr.length > 60 ? inputStr.slice(0, 57) + '…' : inputStr
            console.log(`      input ${inputDisplay}`)
            console.log(`        golden: ${f.goldenHash}  →  live: ${f.liveHash}`)
          }
        }
      }
      results.push({
        id, pass: isMatch,
        expected: regret.goldenHash, actual: liveHash,
        goldenOutput: regret.output, liveOutput: lastOutput,
        confidence: clusterConfidence.label,
        // Issue #315: include per-input failures in JSON output so CI
        // tooling can attribute the FAIL to the specific input that broke.
        ...(multiInputFailures.length > 0 ? { multiInputFailures } : {}),
        // Issue #556: include uncovered input count so CI tooling knows
        // some manifest inputs are not yet in the contract.
        ...(clusterUncoveredInputCount > 0 ? { uncoveredInputs: clusterUncoveredInputCount } : {}),
      })
      // Issue #556: informational message for uncovered inputs.
      // These are manifest inputs not in the .regret contract (e.g. inputs
      // that threw during capture). NOT a FAIL — just a hint to re-capture.
      if (clusterUncoveredInputCount > 0 && !quiet && !jsonOutput) {
        console.log(`    ℹ️  ${clusterUncoveredInputCount} input(s) in manifest not covered by contract — run capture to include them`)
      }
    }

  } catch (err) {
    if (!jsonOutput && !quiet) console.log(`  ❌ ${id.padEnd(35)} ERROR: ${err.message}`)
    results.push({ id, pass: false, error: err.message, confidence: clusterConfidence.label })
  }

  // ── #288: missing callee contract detection ──────────────────────────────
  // If the parent cluster declares `callees` in the manifest, the user
  // expects each declared callee to have a corresponding `.calls.<callee>.regret`
  // file that gets re-validated in the callee phase. If any of those files
  // are missing (e.g. capture was never run, or callee wrapping silently
  // failed), validate used to silently PASS — false sense of security.
  //
  // We now FAIL the parent cluster with a clear message listing the missing
  // callee contracts and pointing the user to `regret capture --cluster <id>`.
  //
  // Skipped when --skip-callees is set (user explicitly opted out of callee
  // contract re-validation entirely).
  //
  // Skipped when --update mode is active (we are updating, not validating).
  //
  // Skipped for `.calls.*` ids themselves (they are callee files, not parents).
  if (!skipCallees && !updateMode && !id.includes('.calls.') && Array.isArray(def.callees) && def.callees.length > 0) {
    const missingCallees = []
    for (const calleeName of def.callees) {
      if (typeof calleeName !== 'string' || calleeName.length === 0) continue
      const calleePath = join(regretDir, `${id}.calls.${calleeName}.regret`)
      if (!existsSync(calleePath)) {
        missingCallees.push(calleeName)
      }
    }
    if (missingCallees.length > 0) {
      const missingList = missingCallees.map(c => `${id}.calls.${c}.regret`).join(', ')
      const errMsg = `callee contract missing for: ${missingList} — run \`regret capture --cluster ${id}\` to generate`
      if (!jsonOutput && !quiet) {
        console.log(`  ❌ ${id.padEnd(35)} CALLEE CONTRACT MISSING`)
        console.log(`    Missing: ${missingList}`)
        console.log(`    Run: regret capture --cluster ${id}`)
      }
      // Override the parent's previous result (which may have been PASS)
      // — the callee regression detection is INACTIVE for this cluster,
      // which is a real gap that the user must fix.
      const lastIdx = results.length - 1
      if (lastIdx >= 0 && results[lastIdx].id === id) {
        results[lastIdx] = {
          id,
          pass: false,
          error: errMsg,
          missingCallees,
          confidence: clusterConfidence.label,
        }
      } else {
        results.push({ id, pass: false, error: errMsg, missingCallees, confidence: clusterConfidence.label })
      }
    }
  }

  if (!results.at(-1).pass && failFast) {
    if (!jsonOutput && !quiet) console.log(`\n  --fail-fast: stopping.`)
    break
  }
}

// ─── Callee contract re-validation phase ─────────────────────────────────────
//
// After the main loop, we re-validate each `.calls.*` regret file by
// re-running its callee function with the saved args and comparing the
// fingerprint to the golden. This catches callee regressions that the
// parent cluster's fingerprint cannot detect (e.g. a callee that returns
// a wrong intermediate value but happens to preserve the parent's output).
//
// Skipped when:
//   - --skip-callees is set (user explicitly opts out)
//   - --update mode is active (we're updating a single cluster, not validating)
//     NOTE: --update DOES re-capture callees via a separate path
//     (see `updateCalleeContractsForParent` below) — this phase is for
//     the validate path only.
//   - --drift-mode is active (drift detection is for non-determinism in the
//     parent cluster's output across multiple runs; callee re-validation
//     only runs once and isn't meaningful in drift mode)
//
// Bug C (#284): --cluster filter NO LONGER skips this phase. The
// regretFiles filter (above) now includes the matching parent's
// `<parent>.calls.*.regret` files when --cluster <parent> is set, so
// re-validating them gives the user accurate callee regression status
// for the cluster they explicitly asked about.

const calleeResults = []

const runCalleePhase = !skipCallees && !updateMode && !driftMode

if (runCalleePhase) {
  // Build a quick lookup of parent cluster defs by id.
  const parentDefById = new Map()
  for (const c of manifest.clusters || []) {
    parentDefById.set(c.id, c)
  }

  // Only iterate over `.calls.*` files — the main loop already handled the
  // parent clusters.
  // When --cluster <parent> is set, regretFiles already contains only that
  // parent's .regret plus its `.calls.*` children, so this filter naturally
  // scopes to the requested cluster's callees.
  const calleeRegretFiles = regretFiles.filter(f => basename(f, '.regret').includes('.calls.'))

  if (calleeRegretFiles.length > 0 && !jsonOutput && !quiet) {
    console.log(`\n🔍 Re-validating ${calleeRegretFiles.length} callee contract(s)...\n`)
  }

  for (const file of calleeRegretFiles) {
    const calleeId     = basename(file, '.regret')
    const calleeRegret = parseRegret(readFileSync(join(regretDir, file), 'utf8'))
    const parentId     = calleeRegret.parent ?? calleeId.split('.calls.').slice(0, -1).join('.calls.')
    const parentDef    = parentDefById.get(parentId)

    if (!parentDef) {
      if (!jsonOutput && !quiet) {
        console.log(`  ⚠️  ${calleeId.padEnd(35)} parent "${parentId}" not in manifest — skipping`)
      }
      calleeResults.push({
        id: calleeId,
        pass: false,
        skipped: true,
        error: `parent cluster "${parentId}" not in manifest`,
      })
      continue
    }

    try {
      const result = await runCalleeContract(calleeRegret, parentDef, {
        normalize: parentDef.normalize ?? [],
        ignoreFields: parentDef.ignoreFields ?? [],
        ignorePaths: parentDef.ignorePaths ?? [],
      })

      if (result.skipped) {
        if (!jsonOutput && !quiet) {
          console.log(`  ⏭  ${calleeId.padEnd(35)} ${result.error}`)
        }
        calleeResults.push({
          id: calleeId,
          pass: true,
          skipped: true,
          error: result.error,
        })
        continue
      }

      if (result.pass) {
        if (!jsonOutput && !quiet) {
          console.log(`  ✅ ${calleeId.padEnd(35)} ${result.goldenHash}  PASS (callee)`)
        }
        calleeResults.push({
          id: calleeId,
          pass: true,
          expected: result.goldenHash,
          actual: result.liveHash,
        })
      } else {
        if (!jsonOutput && !quiet) {
          const hstr = result.expectThrowViolated
            ? `(expectThrow violated: ${result.expectedThrow ? 'expected throw, none thrown' : 'unexpected throw'})`
            : `${result.goldenHash} → ${result.liveHash}`
          console.log(`  ❌ ${calleeId.padEnd(35)} ${hstr}  FAIL (callee)`)
          if (result.liveError) {
            console.log(`    Actual error:   ${result.liveError}`)
          } else if (result.goldenErrorContract) {
            console.log(`    Expected error: ${result.goldenErrorContract.type}: ${result.goldenErrorContract.message}`)
            console.log(`    Actual:         callee did NOT throw (error path removed)`)
          } else if (!noDiff && result.goldenOutput != null && result.liveOutput != null) {
            const diff = formatDiffOutput(result.goldenOutput, result.liveOutput, { verbose })
            if (diff) console.log(diff)
          }
          // Issue #298: when the callee has a multi-call contract and one
          // of the non-first calls failed, surface which args broke so the
          // user can reproduce the failure locally. The first call's status
          // is already covered by the line above.
          if (result.multiCallFailures && result.multiCallFailures.length > 0) {
            console.log(`    Multi-call contract failures (issue #298):`)
            for (const f of result.multiCallFailures) {
              const argsStr = JSON.stringify(f.args)
              const truncated = argsStr.length > 80 ? argsStr.slice(0, 77) + '...' : argsStr
              // Display 1-based call index (call #1 = first call, validated
              // via the top-level HASH line above; call #2 = first multi-call
              // entry, etc.) so the user can correlate with their mental model
              // of "the Nth time the callee was invoked".
              const humanCallNum = f.callIndex + 1
              console.log(`      call #${humanCallNum} args=${truncated}`)
              console.log(`        expected: ${f.goldenHash}  got: ${f.liveHash}`)
              if (f.expectThrowViolated) {
                console.log(`        (expectThrow violated for this call's args)`)
              }
            }
          }
        }
        calleeResults.push({
          id: calleeId,
          pass: false,
          expected: result.goldenHash,
          actual: result.liveHash,
          expectThrowViolated: result.expectThrowViolated,
          goldenOutput: result.goldenOutput,
          liveOutput: result.liveOutput,
          liveError: result.liveError,
          goldenErrorContract: result.goldenErrorContract,
          multiCallFailures: result.multiCallFailures ?? [],
        })
      }
    } catch (err) {
      if (!jsonOutput && !quiet) {
        console.log(`  ❌ ${calleeId.padEnd(35)} ERROR: ${err.message}`)
      }
      calleeResults.push({
        id: calleeId,
        pass: false,
        error: err.message,
      })
    }

    if (!calleeResults.at(-1).pass && failFast) {
      if (!jsonOutput && !quiet) console.log(`\n  --fail-fast: stopping.`)
      break
    }
  }
}

const calleePassed = calleeResults.filter(r => r.pass && !r.skipped).length
const calleeFailed = calleeResults.filter(r => !r.pass && !r.skipped).length
const calleeSkipped = calleeResults.filter(r => r.skipped).length

// ─── Summary ──────────────────────────────────────────────────────────────────

const passed  = results.filter(r => r.pass).length
const failed  = results.filter(r => !r.pass).length
const drifted = results.filter(r => r.drift).length

// Helper: build the callee-summary suffix appended to the main summary line.
// Empty when callee re-validation didn't run at all (no .calls.* files,
// --skip-callees flag set, --update, --drift-mode, or --cluster filter).
//   ""                                    → callees not considered
//   ", 3 callee contracts verified"       → all callees passed
//   ", 1 callee contract failed"          → at least one callee failed
function calleeSummarySuffix() {
  if (calleeResults.length === 0) return ''
  if (calleeFailed > 0) {
    return `, ${calleeFailed} callee contract${calleeFailed === 1 ? '' : 's'} failed`
  }
  if (calleePassed === 0) return ''  // all skipped, nothing to report
  return `, ${calleePassed} callee contract${calleePassed === 1 ? '' : 's'} verified`
}

// Helper: build a failure summary line that mentions BOTH cluster failures
// and callee failures, and — when only callees fail — names the failing
// callee ids in the summary line itself (per the spec:
//   "❌ 1 callee contract failed: main.calls.add"
// ).
function formatFailureSummaryLine() {
  const failedCalleeIds = calleeResults
    .filter(r => !r.pass && !r.skipped)
    .map(r => r.id)

  if (failed > 0 && calleeFailed > 0) {
    // Both clusters and callees failed — mention counts, list IDs in detail block.
    return `❌ ${failed} cluster${failed === 1 ? '' : 's'} FAILED, ${calleeFailed} callee contract${calleeFailed === 1 ? '' : 's'} failed.`
  }
  if (failed > 0) {
    // Only clusters failed — original format.
    return `❌ ${failed}/${results.length} FAILED.`
  }
  // Only callees failed — use the spec's exact format with id list.
  return `❌ ${calleeFailed} callee contract${calleeFailed === 1 ? '' : 's'} failed: ${failedCalleeIds.join(', ')}`
}

// Exit code considers BOTH cluster failures and callee failures.
const totalFailed = failed + calleeFailed

if (reporter === 'junit') {
  // Merge cluster results + callee results into a single JUnit testsuite
  // so callee regressions show up as failed testcases in CI dashboards.
  const junitXml = generateJUnitXml([...results, ...calleeResults])
  const resultsPath = join(regretDir, 'results.xml')
  try {
    writeFileSync(resultsPath, junitXml, 'utf8')
  } catch (err) {
    console.error(`❌ Failed to write JUnit XML: ${err.message}`)
    process.exit(1)
  }
  // Still show console output
  console.log(`\n${'─'.repeat(60)}`)
  if (totalFailed === 0) {
    console.log(`✅ All ${passed} tests passed${calleeSummarySuffix()}. Refactor is safe.`)
  } else {
    console.log(formatFailureSummaryLine())
  }
  console.log(`\n📊 JUnit XML written to: ${resultsPath}`)
  process.exit(totalFailed > 0 ? 1 : 0)
} else if (jsonOutput) {
  // JSON output mode — include callee results as a separate top-level field
  // so programmatic consumers can distinguish cluster passes from callee passes.
  //
  // Issue #266: enrich the per-cluster entry with the fields the MCP
  // regrets_validate tool needs to preserve its existing output contract
  // (pass, expected, actual, diff, error, skipped) while ALSO surfacing the
  // richer validate.js metadata (status, confidence, drift, calleesMissing,
  // etc.) as additive fields. Skipped clusters are NO LONGER filtered out
  // so consumers can see "cluster X was skipped" rather than wondering why
  // it's missing from the array.
  const jsonResult = {
    passed,
    failed,
    clusters: results.map(r => {
      // Compute diff string (same logic as the human-output path) so MCP
      // consumers don't have to call formatDiffOutput themselves.
      let diffStr
      if (!noDiff && !r.pass && r.goldenOutput != null && r.liveOutput != null) {
        try {
          diffStr = formatDiffOutput(r.goldenOutput, r.liveOutput, { verbose: false }) || undefined
        } catch { diffStr = undefined }
      }
      // Compute side-effect diff if applicable
      let sideEffectDiffStr
      if (!noDiff && !r.pass && r.goldenSideEffects != null) {
        try {
          sideEffectDiffStr = formatSideEffectDiff(
            r.goldenSideEffects,
            r.lastSideEffectRecording,
            r.normalize ?? [],
            r.ignoreFields ?? [],
            r.ignorePaths ?? []
          ) || undefined
        } catch { sideEffectDiffStr = undefined }
      }
      return {
        id: r.id,
        // Direct boolean — MCP contract field (kept stable for backward compat)
        pass: !!r.pass,
        // Machine-readable status string — additive, richer than `pass`
        status: r.skipped
          ? 'skipped'
          : (r.pass ? (r.drift ? 'drift' : 'pass') : (r.expectThrowViolated ? 'expect_throw_violated' : (r.mutationMismatch ? 'mutation_mismatch' : (r.error ? 'error' : 'fail')))),
        confidence: r.confidence || 'LOW',
        ...(r.skipped ? { skipped: true } : {}),
        ...(r.expected ? { expected: r.expected } : {}),
        ...(r.actual ? { actual: r.actual } : {}),
        ...(r.error ? { error: r.error } : {}),
        ...(diffStr ? { diff: diffStr } : {}),
        ...(sideEffectDiffStr ? { sideEffectDiff: sideEffectDiffStr } : {}),
        ...(r.drift ? { drift: true } : {}),
        ...(r.updated ? { updated: true } : {}),
        ...(r.mutationMismatch ? { mutationMismatch: true, mutationDetected: r.mutationDetected } : {}),
        ...(r.expectedError ? { expectedError: r.expectedError } : {}),
        ...(r.actualError ? { actualError: r.actualError } : {}),
        ...(r.expectThrowViolated ? { expectThrowViolated: true } : {}),
        ...(r.missingCallees ? { missingCallees: r.missingCallees } : {}),
        // Issue #315: per-input failure breakdown so CI/MCP consumers can
        // attribute the FAIL to the specific input that broke (not just
        // "the cluster failed").
        ...(r.multiInputFailures && r.multiInputFailures.length > 0
          ? { multiInputFailures: r.multiInputFailures }
          : {}),
        // Issue #556: uncovered inputs (in manifest but not in .regret contract).
        // Informational — NOT a FAIL. Signals that capture should be re-run.
        ...(r.uncoveredInputs ? { uncoveredInputs: r.uncoveredInputs } : {}),
      }
    }),
    callees: {
      passed: calleePassed,
      failed: calleeFailed,
      skipped: calleeSkipped,
      considered: calleeResults.length,
      contracts: calleeResults.map(r => ({
        id: r.id,
        // Direct boolean — MCP contract field
        pass: !!r.pass,
        status: r.skipped ? 'skipped' : (r.pass ? 'pass' : (r.expectThrowViolated ? 'expect_throw_violated' : (r.error ? 'error' : 'fail'))),
        ...(r.skipped ? { skipped: true } : {}),
        ...(r.expected ? { expected: r.expected } : {}),
        ...(r.actual ? { actual: r.actual } : {}),
        ...(r.error ? { error: r.error } : {}),
        ...(r.liveError ? { liveError: r.liveError } : {}),
        ...(r.expectThrowViolated ? { expectThrowViolated: true } : {}),
      })),
    },
  }
  console.log(JSON.stringify(jsonResult, null, 0))
  process.exit(totalFailed > 0 ? 1 : 0)
} else if (quiet) {
  // ─── Quiet summary: only one line ─────────────────────────────────────────
  const failedIds = results.filter(r => !r.pass).map(r => r.id)
  const calleeFailedIds = calleeResults.filter(r => !r.pass && !r.skipped).map(r => r.id)
  if (updateMode) {
    const updatedCount = results.filter(r => r.updated).length
    const totalCalleesUpdated = results.reduce((sum, r) => sum + (r.calleesUpdated || 0), 0)
    const totalCalleesMissing = results.reduce((sum, r) => sum + (r.calleesMissing || 0), 0)
    const totalCalleesFailed = results.reduce((sum, r) => sum + (r.calleesFailed || 0), 0)
    let line = `✅ Update complete. ${updatedCount} updated`
    if (totalCalleesUpdated > 0) line += `, ${totalCalleesUpdated} callee contract${totalCalleesUpdated === 1 ? '' : 's'} updated`
    if (totalCalleesMissing > 0) line += `, ${totalCalleesMissing} callee contract${totalCalleesMissing === 1 ? '' : 's'} missing`
    if (totalCalleesFailed > 0) line += `, ${totalCalleesFailed} callee re-capture${totalCalleesFailed === 1 ? '' : 's'} failed`
    console.log(line + '.')
    process.exit(0)
  }
  if (driftMode && drifted > 0) {
    console.log(`❌ ${drifted}/${results.length} drifted: [${failedIds.join(', ')}]`)
    process.exit(1)
  }
  if (totalFailed === 0) {
    console.log(`✅ ${passed}/${results.length} passed${calleeSummarySuffix()}`)
    process.exit(0)
  }
  // Mix cluster failures and callee failures in the bracketed list so a single
  // quiet line still surfaces all failing ids.
  const allFailedIds = [...failedIds, ...calleeFailedIds]
  console.log(`❌ ${totalFailed} failed: [${allFailedIds.join(', ')}]`)
  process.exit(1)
} else {
  console.log(`\n${'─'.repeat(60)}`)

  if (updateMode) {
    const updatedCount = results.filter(r => r.updated).length
    const totalCalleesUpdated = results.reduce((sum, r) => sum + (r.calleesUpdated || 0), 0)
    const totalCalleesMissing = results.reduce((sum, r) => sum + (r.calleesMissing || 0), 0)
    const totalCalleesFailed = results.reduce((sum, r) => sum + (r.calleesFailed || 0), 0)
    let line = `✅ Update complete. ${updatedCount} updated.`
    if (totalCalleesUpdated > 0) line += `\n   ${totalCalleesUpdated} callee contract${totalCalleesUpdated === 1 ? '' : 's'} also updated.`
    if (totalCalleesMissing > 0) line += `\n   ⚠️  ${totalCalleesMissing} callee contract${totalCalleesMissing === 1 ? '' : 's'} missing — run \`regret capture\` to generate.`
    if (totalCalleesFailed > 0) line += `\n   ⚠️  ${totalCalleesFailed} callee re-capture${totalCalleesFailed === 1 ? '' : 's'} failed — see output above.`
    line += `\n   Audit: regrets/audit.log`
    console.log(line)
    process.exit(0)
  }
  if (driftMode && drifted > 0) {
    console.log(`❌ Drift in ${drifted} cluster(s). Add normalize rules and re-capture.`)
    process.exit(1)
  }
  if (totalFailed === 0) {
    console.log(`✅ All ${passed} tests passed${driftMode ? ` (${runs} runs — stable)` : ''}${calleeSummarySuffix()}. Refactor is safe.\n`)
    process.exit(0)
  }
  console.log(formatFailureSummaryLine() + '\n')
  results.filter(r => !r.pass).forEach(r => {
    console.log(`  • ${r.id}`)
    if (r.expectThrowViolated) console.log(`    Expected error: ${r.expectedError?.type}: ${r.expectedError?.message} — function did NOT throw`)
    else if (r.error) console.log(`    ${r.error}`)
    else if (r.mutationMismatch) console.log(`    Mutation fingerprint mismatch — function's input mutation behavior changed`)
    else if (r.expectedError && r.actualError) console.log(`    Error contract changed: expected ${r.expectedError.type}: ${r.expectedError.message}, got ${r.actualError.type}: ${r.actualError.message}`)
    else if (r.expected && r.actual) console.log(`    Expected: ${r.expected}  Got: ${r.actual}`)
    else if (r.drift) console.log(`    Drift detected — hashes vary across runs`)
    if (!noDiff && r.goldenOutput != null && r.liveOutput != null) {
      const diff = formatDiffOutput(r.goldenOutput, r.liveOutput, { verbose })
      if (diff) console.log(diff)
    }
  })
  // Callee failures — listed after cluster failures, prefixed with `[callee]`
  // so users can immediately see which failures are callee regressions vs
  // parent cluster regressions.
  calleeResults.filter(r => !r.pass && !r.skipped).forEach(r => {
    console.log(`  • ${r.id}  [callee]`)
    if (r.expectThrowViolated) console.log(`    Expect-throw contract violated — callee's throw behavior changed`)
    else if (r.error) console.log(`    ${r.error}`)
    else if (r.liveError) console.log(`    Callee threw unexpectedly: ${r.liveError}`)
    else if (r.goldenErrorContract) console.log(`    Expected error: ${r.goldenErrorContract.type}: ${r.goldenErrorContract.message} — callee did NOT throw`)
    else if (r.expected && r.actual) console.log(`    Expected: ${r.expected}  Got: ${r.actual}`)
    if (!noDiff && r.goldenOutput != null && r.liveOutput != null) {
      const diff = formatDiffOutput(r.goldenOutput, r.liveOutput, { verbose })
      if (diff) console.log(diff)
    }
  })
  console.log(`\nFix the CODE — do not edit .regret files.\nRe-run: node scripts/validate.js`)
  process.exit(1)
}

} // end isMainModule

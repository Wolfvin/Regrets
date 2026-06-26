// validate_sql.mjs — validate regret contracts for SQL clusters.
//
// Reads .regret files for SQL clusters, re-executes the SQL query,
// compares the hash, and reports PASS/FAIL.
//
// Issue #315 parity: validates ALL inputs from the INPUTS line, not just
// the first. A breaking change that only affects inputs[1+] is detected.
//
// Usage:
//   node scripts/validate_sql.mjs                        # validate all SQL clusters
//   node scripts/validate_sql.mjs --cluster <id>
//   node scripts/validate_sql.mjs --manifest <path>
//   node scripts/validate_sql.mjs --fail-fast            # stop on first FAIL
//   node scripts/validate_sql.mjs --update <id> --reason "..."  # re-capture
//
// Requirements: Node.js 16+, Python 3 with sqlite3 module.

import { readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs'
import { resolve, dirname, join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fingerprint, stableStringify } from './fingerprint.js'

// Re-use the executor from capture (duplicated here to avoid dynamic import complexity)
function executeSql(sql, bindParams = [], database = ':memory:', setupSql = '', customFunctions = []) {
  const request = JSON.stringify({ sql, bind_params: bindParams, database, setup_sql: setupSql, custom_functions: customFunctions })
  const pythonScript = `
import sys, json, sqlite3
try:
    req = json.loads(sys.stdin.read())
    db = sqlite3.connect(req.get('database', ':memory:'))
    db.row_factory = sqlite3.Row
    setup = req.get('setup_sql', '')
    if setup: db.executescript(setup)
    for cf in req.get('custom_functions', []):
        ns = {}
        exec(f'_func = {cf["func_body"]}', ns)
        db.create_function(cf['name'], cf['num_params'], ns['_func'])
    params = req.get('bind_params', [])
    cursor = db.execute(req['sql'], params)
    rows = cursor.fetchall()
    col_names = [desc[0] for desc in cursor.description] if cursor.description else []
    result = [dict(zip(col_names, row)) for row in rows]
    if len(col_names) == 1 and len(result) == 1:
        result = result[0][col_names[0]]
    db.close()
    print(json.dumps(result, default=str))
except Exception as e:
    print(json.dumps({"__error__": str(e)}))
`
  const result = spawnSync('python3', ['-c', pythonScript], { input: request, encoding: 'utf8', timeout: 30_000, env: { ...process.env } })
  if (result.status !== 0) return { output: null, error: result.stderr || `python3 exited with code ${result.status}` }
  try {
    const parsed = JSON.parse(result.stdout.trim())
    if (parsed && typeof parsed === 'object' && '__error__' in parsed) return { output: null, error: parsed['__error__'] }
    return { output: parsed, error: null }
  } catch (e) { return { output: null, error: `failed to parse: ${e.message}` } }
}

// ─── CLI args ─────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const args = argv.slice(2)
  let clusterFilter = null, manifestPath = null, failFast = false, updateMode = false, updateReason = null
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--cluster' && i + 1 < args.length) clusterFilter = args[++i]
    else if (args[i] === '--manifest' && i + 1 < args.length) manifestPath = args[++i]
    else if (args[i] === '--fail-fast') failFast = true
    else if (args[i] === '--update' && i + 1 < args.length) { updateMode = true; clusterFilter = args[++i] }
    else if (args[i] === '--reason' && i + 1 < args.length) updateReason = args[++i]
  }
  if (!manifestPath) manifestPath = resolve(process.cwd(), 'regrets', 'manifest.json')
  return { clusterFilter, manifestPath, failFast, updateMode, updateReason }
}

// ─── Parse .regret file ──────────────────────────────────────────────────

function parseRegret(content) {
  // CRLF -> LF guard, see scripts/validate.js's parseRegret() for the
  // full explanation (git core.autocrlf=true breaks line === '---' checks
  // otherwise, since the line keeps a trailing '\r').
  const lines = content.replaceAll('\r\n', '\n').split('\n')
  const header = {}
  const body = {}
  let inBody = false
  let extraInputs = []

  for (const line of lines) {
    if (line === '---') { inBody = true; continue }
    if (line.trim() === '') continue
    const match = line.match(/^(\S+)\s+(.*)$/)
    if (!match) continue
    const [, key, value] = match
    if (!inBody) {
      const kvMatch = line.match(/^(\S+):\s*(.*)$/)
      if (kvMatch) header[kvMatch[1]] = kvMatch[2]
    } else {
      if (key === 'INPUTS') {
        try { extraInputs = JSON.parse(value) } catch {}
      } else {
        body[key] = value
      }
    }
  }
  return { header, body, extraInputs }
}

// ─── Main ─────────────────────────────────────────────────────────────────

const { clusterFilter, manifestPath, failFast, updateMode, updateReason } = parseArgs(process.argv)

if (updateMode) {
  if (!updateReason || updateReason.split(/\s+/).length < 4) {
    console.error('ERROR: --update requires --reason with at least 4 words')
    console.error('Example: --update my-cluster --reason "query now uses LEFT JOIN for better performance"')
    process.exit(2)
  }
  console.log(`🔄 Update mode — cluster: ${clusterFilter}`)
  console.log(`   Reason: ${updateReason}`)
}

if (!existsSync(manifestPath)) {
  console.error(`❌ Manifest not found: ${manifestPath}`)
  process.exit(1)
}

const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
const clusters = (manifest.clusters || []).filter(c => c.stack === 'sql')

if (clusters.length === 0) {
  console.log('No SQL clusters found in manifest.')
  process.exit(0)
}

const regretDir = resolve(dirname(manifestPath))
let passed = 0, failed = 0, missing = 0

console.log(`🔍 Validating SQL clusters...`)

for (const cluster of clusters) {
  const cid = cluster.id
  if (clusterFilter && cid !== clusterFilter) continue

  const sql = cluster.query || cluster.sql
  const database = cluster.database || ':memory:'
  const setupSql = cluster.setup || cluster.setupSql || ''
  const customFunctions = cluster.customFunctions || []
  const inputs = cluster.inputs || [null]

  const regretPath = join(regretDir, `${cid}.regret`)

  if (!existsSync(regretPath)) {
    console.log(`❌ ${cid} — .regret file not found`)
    missing++
    if (failFast) break
    continue
  }

  const regretContent = readFileSync(regretPath, 'utf8')
  const { header, body, extraInputs } = parseRegret(regretContent)

  const goldenHash = body.HASH
  const goldenInput = JSON.parse(body.INPUT)
  const goldenOutput = JSON.parse(body.OUTPUT)

  // Validate first input
  const bindParams0 = Array.isArray(goldenInput) ? goldenInput : (goldenInput != null ? [goldenInput] : [])
  const { output: liveOutput0, error: err0 } = executeSql(sql, bindParams0, database, setupSql, customFunctions)
  const liveHash0 = fingerprint(goldenInput, liveOutput0)

  let clusterPass = true
  let inputResults = []

  if (err0) {
    console.log(`❌ ${cid} — execution error: ${err0}`)
    clusterPass = false
    inputResults.push({ input: goldenInput, expected: goldenHash, got: 'ERROR', error: err0 })
  } else if (liveHash0 !== goldenHash) {
    clusterPass = false
    inputResults.push({ input: goldenInput, expected: goldenHash, got: liveHash0 })
  } else {
    inputResults.push({ input: goldenInput, hash: liveHash0, pass: true })
  }

  // Validate extra inputs (INPUTS line)
  for (const ei of extraInputs) {
    const bindParams = Array.isArray(ei.input) ? ei.input : (ei.input != null ? [ei.input] : [])
    const { output: liveOutput, error: err } = executeSql(sql, bindParams, database, setupSql, customFunctions)
    const liveHash = fingerprint(ei.input, liveOutput)

    if (err) {
      clusterPass = false
      inputResults.push({ input: ei.input, expected: ei.hash, got: 'ERROR', error: err })
    } else if (liveHash !== ei.hash) {
      clusterPass = false
      inputResults.push({ input: ei.input, expected: ei.hash, got: liveHash })
    } else {
      inputResults.push({ input: ei.input, hash: liveHash, pass: true })
    }
  }

  const totalInputs = inputResults.length
  if (clusterPass) {
    console.log(`  ✅ ${cid} — ${goldenHash} — PASS (${totalInputs} input${totalInputs > 1 ? 's' : ''})`)
    passed++

    if (updateMode) {
      // Re-capture: update .regret file with fresh hashes
      const timestamp = new Date().toISOString().replace(/\.\d+Z$/, 'Z')
      const lines = [
        `cluster: ${cid}`,
        `version: 1`,
        `fingerprint: ${liveHash0}`,
        `captured: ${timestamp}`,
        `watches: [${(cluster.watches || []).join(', ')}]`,
        `entry: ${cluster.entry || cid}`,
        `stack: sql`,
        `fingerprintLevel: entry`,
      ]
      if (cluster.file) lines.push(`file: ${cluster.file}`)
      if (cluster.database) lines.push(`database: ${cluster.database}`)
      lines.push(`---`)
      lines.push(`INPUT  ${stableStringify(goldenInput)}`)
      lines.push(`OUTPUT ${stableStringify(liveOutput0)}`)
      lines.push(`HASH   ${liveHash0}`)

      const newExtra = inputResults.slice(1).map(r => ({ input: r.input, output: r.output || liveOutput0, hash: r.hash }))
      if (newExtra.length > 0) lines.push(`INPUTS ${JSON.stringify(newExtra)}`)

      writeFileSync(regretPath, lines.join('\n') + '\n')
      console.log(`     🔄 Updated: ${goldenHash} → ${liveHash0}`)
    }
  } else {
    for (const r of inputResults) {
      if (r.pass) continue
      if (r.error) {
        console.log(`  ❌ ${cid} (input error): ${r.error}`)
      } else {
        console.log(`  ❌ ${cid} (input #${inputResults.indexOf(r)}) — expected ${r.expected} got ${r.got}`)
      }
    }
    failed++
    if (failFast) break
  }
}

console.log(``)
console.log(`Validate: ${passed} passed, ${failed} failed${missing > 0 ? `, ${missing} missing` : ''}`)
process.exit(failed > 0 || missing > 0 ? 1 : 0)

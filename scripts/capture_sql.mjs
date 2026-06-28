// capture_sql.mjs — capture regret contracts for SQL clusters.
//
// Reads regrets/manifest.json, filters clusters with `stack: "sql"`,
// executes each cluster's SQL query against a SQLite database (via Python3's
// built-in sqlite3 module), captures the result set as JSON, computes the
// 7-char base36 fingerprint (identical to fingerprint.js), and writes
// `.regret` files in the standard format.
//
// Model: "Query-result contract"
//   - The SQL query IS the "function" — input is bind params + DB state,
//     output is the result set (JSON-serialized rows).
//   - This matches how SQL is used in practice: deterministic queries
//     against known data produce known results.
//   - Cross-stack parity: same fingerprint algorithm as JS/Python/awk/C.
//
// Issue #315 parity (multi-input contract):
//   When a cluster has more than one entry in `inputs[]`, capture writes an
//   `INPUTS` line in the .regret file containing a JSON array of
//   `{ input, output, hash }` entries for inputs[1+].
//
// Usage:
//   node scripts/capture_sql.mjs                       # capture all SQL clusters
//   node scripts/capture_sql.mjs --cluster <id>
//   node scripts/capture_sql.mjs --manifest <path>
//
// Requirements: Node.js 16+, Python 3 with sqlite3 module (built-in on most systems).

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
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

// ─── Python3 SQL executor ────────────────────────────────────────────────

/**
 * Execute a SQL query against a SQLite database using Python3's built-in
 * sqlite3 module. Returns the result set as a JSON-serializable value.
 *
 * @param {string} sql - The SQL query to execute
 * @param {Array} bindParams - Bind parameters for the query (?)
 * @param {string} database - Database path (default ":memory:")
 * @param {string} setupSql - Optional SQL to run before the query (CREATE TABLE, INSERT, etc.)
 * @param {Array} customFunctions - Optional array of {name, num_params, func_body} for CREATE FUNCTION
 * @returns {Object} - { output: any, error: string|null }
 */
function executeSql(sql, bindParams = [], database = ':memory:', setupSql = '', customFunctions = []) {
  // Serialize the execution request as JSON for the Python script
  const request = JSON.stringify({
    sql,
    bind_params: bindParams,
    database,
    setup_sql: setupSql,
    custom_functions: customFunctions,
  })

  // Python script that reads JSON from stdin, executes the SQL, and prints JSON result
  const pythonScript = `
import sys, json, sqlite3

try:
    req = json.loads(sys.stdin.read())
    db = sqlite3.connect(req.get('database', ':memory:'))
    db.row_factory = sqlite3.Row

    # Run setup SQL if provided
    setup = req.get('setup_sql', '')
    if setup:
        db.executescript(setup)

    # Register custom functions if provided
    for cf in req.get('custom_functions', []):
        # Evaluate the function body in a sandboxed namespace
        # The body must be a Python expression that returns a function
        # e.g. "lambda x: x * 2"
        ns = {}
        exec(f'_func = {cf["func_body"]}', ns)
        db.create_function(cf['name'], cf['num_params'], ns['_func'])

    # Execute the query with bind params
    params = req.get('bind_params', [])
    cursor = db.execute(req['sql'], params)
    rows = cursor.fetchall()
    col_names = [desc[0] for desc in cursor.description] if cursor.description else []

    # Convert rows to list of dicts
    result = [dict(zip(col_names, row)) for row in rows]

    # If single column + single row, unwrap to scalar
    if len(col_names) == 1 and len(result) == 1:
        result = result[0][col_names[0]]

    db.close()
    print(json.dumps(result, default=str))
except Exception as e:
    print(json.dumps({"__error__": str(e)}))
`

  const result = spawnSync('python3', ['-c', pythonScript], {
    input: request,
    encoding: 'utf8',
    timeout: 30_000,
    // #521: PYTHONIOENCODING=utf-8 forces UTF-8 for the Python child's
    // stdin/stdout/stderr. Without this, Windows native Python defaults
    // to cp1252, and json.loads(sys.stdin.read()) crashes with
    // UnicodeDecodeError when the SQL request JSON contains UTF-8
    // multi-byte chars (e.g., unicode strings in bind_params or setup_sql).
    // No-op on Linux/Mac (UTF-8 is already the default there).
    env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
  })

  if (result.status !== 0) {
    return { output: null, error: result.stderr || `python3 exited with code ${result.status}` }
  }

  try {
    const parsed = JSON.parse(result.stdout.trim())
    if (parsed && typeof parsed === 'object' && '__error__' in parsed) {
      return { output: null, error: parsed['__error__'] }
    }
    return { output: parsed, error: null }
  } catch (e) {
    return { output: null, error: `failed to parse python output: ${e.message}` }
  }
}

// ─── Main capture loop ───────────────────────────────────────────────────

const { clusterFilter, manifestPath } = parseArgs(process.argv)

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
let captured = 0, skipped = 0, failed = 0

console.log(`📡 Capturing SQL clusters...`)

for (const cluster of clusters) {
  const cid = cluster.id
  const sql = cluster.query || cluster.sql
  const database = cluster.database || ':memory:'
  const setupSql = cluster.setup || cluster.setupSql || ''
  const customFunctions = cluster.customFunctions || []
  const inputs = cluster.inputs || [null]

  if (clusterFilter && cid !== clusterFilter) continue

  console.log(`  📦 Cluster: ${cid}`)

  if (!sql) {
    console.log(`     ❌ No 'query' field — skipping`)
    failed++
    continue
  }

  const results = []
  let clusterFailed = false

  for (let j = 0; j < inputs.length; j++) {
    const input = inputs[j]
    const bindParams = Array.isArray(input) ? input : (input != null ? [input] : [])

    const { output, error } = executeSql(sql, bindParams, database, setupSql, customFunctions)

    if (error) {
      console.log(`     ❌ Failed to execute (input #${j}): ${error}`)
      clusterFailed = true
      break
    }

    const inputJson = stableStringify(input)
    const outputJson = stableStringify(output)
    const fp = fingerprint(input, output)

    results.push({ input, output, hash: fp })
  }

  if (clusterFailed) {
    failed++
    continue
  }

  // Trivial Input Guard (first input only)
  const firstOutput = results[0]?.output
  if (firstOutput === null || firstOutput === undefined) {
    console.log(`     ⏭️  Skipped: trivial output on first input`)
    skipped++
    continue
  }

  // Write .regret file
  const timestamp = new Date().toISOString().replace(/\.\d+Z$/, 'Z')
  const regretPath = join(regretDir, `${cid}.regret`)
  const first = results[0]
  const extraInputs = results.slice(1)

  const watches = cluster.watches || []
  const lines = [
    `cluster: ${cid}`,
    `version: 1`,
    `fingerprint: ${first.hash}`,
    `captured: ${timestamp}`,
    `watches: [${watches.join(', ')}]`,
    `entry: ${cluster.entry || cid}`,
    `stack: sql`,
    `fingerprintLevel: entry`,
  ]
  if (cluster.file) lines.push(`file: ${cluster.file}`)
  if (cluster.database) lines.push(`database: ${cluster.database}`)

  lines.push(`---`)
  lines.push(`INPUT  ${stableStringify(first.input)}`)
  lines.push(`OUTPUT ${stableStringify(first.output)}`)
  lines.push(`HASH   ${first.hash}`)

  if (extraInputs.length > 0) {
    lines.push(`INPUTS ${JSON.stringify(extraInputs.map(r => ({ input: r.input, output: r.output, hash: r.hash })))}`)
  }

  writeFileSync(regretPath, lines.join('\n') + '\n')

  console.log(`     ✅ Fingerprint: ${first.hash} (${results.length} input${results.length > 1 ? 's' : ''})`)
  console.log(`     📄 Saved: ${regretPath}`)
  captured++
}

console.log(``)
console.log(`Capture complete: ${captured} captured, ${skipped} skipped, ${failed} failed`)

#!/usr/bin/env node
// contest.mjs — Chain testing MVP for regret-based regression
// Executes multi-step flows (chains) and fingerprints the combined output.
//
// Usage:
//   node scripts/contest.mjs --capture [--chain <id>] [--skip-callees]
//   node scripts/contest.mjs --validate [--chain <id>] [--skip-callees]

import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync } from 'fs'
import { resolve, dirname, join, basename } from 'path'
import { fileURLToPath, pathToFileURL } from 'url'
import { fingerprint, extractSchema, stableStringify } from './fingerprint.js'
import { createGhost, deepClone } from './ghost.js'
import { mergeCjsModule } from './cjs-merge.js'
import { createHash } from 'crypto'
import { execFileSync } from 'child_process'
// Shared with validate.js — keeps callee re-validation logic consistent
// between the cluster validator and the chain runner. Closes #272.
import { parseRegret, runCalleeContract } from './validate.js'

const __dirname = dirname(fileURLToPath(import.meta.url))

// ─── CLI args ───────────────────────────────────────────────────────────────

function getArg(args, flag) {
  const i = args.indexOf(flag)
  return i !== -1 ? args[i + 1] ?? null : null
}

const args = process.argv.slice(2)
const captureMode = args.includes('--capture')
const validateMode = args.includes('--validate') || !captureMode
const chainFilter = getArg(args, '--chain')
// --skip-callees: opt out of callee contract re-validation. Mirrors the
// same flag on validate.js so chain validation can be run in environments
// where callee .regret files are not yet captured (or where the user
// explicitly only cares about the top-level chain hash). Closes #272.
const skipCallees = args.includes('--skip-callees')

// ─── Paths ──────────────────────────────────────────────────────────────────

const CWD = process.cwd()
const CHAINS_DIR = resolve(CWD, 'regrets', 'chains')
const CHAIN_FILE = resolve(CWD, 'regrets', 'chains.json')
const MANIFEST_PATH = resolve(CWD, 'regrets', 'manifest.json')
const REGRET_DIR = resolve(CWD, 'regrets')

// ─── Fingerprint config helpers (#283) ──────────────────────────────────────
//
// capture.js / validate.js read a broad set of cluster config fields that
// affect the resulting fingerprint: `ignorePaths`, `fingerprintLevel`,
// `fingerprintMode`, `valuePaths`. contest.mjs used to pass ONLY `normalize`
// + `ignoreFields` to `fingerprint()`, which meant chain hashes diverged
// from capture.js hashes for the same cluster + input — chains would
// falsely MISMATCH (or falsely Match) when the cluster relied on any of
// the ignored config. These helpers centralise the config reading so all
// three step-execution paths (classMethod / singletonMethod / plain entry)
// produce fingerprints consistent with capture.js. Closes #283.

/**
 * Build the `fingerprint()` options object from a cluster definition.
 * Mirrors the field set used by capture.js / validate.js.
 */
function buildFingerprintOptions(cluster) {
  return {
    normalize: cluster.normalize || [],
    ignoreFields: cluster.ignoreFields || [],
    ignorePaths: cluster.ignorePaths || [],
  }
}

/**
 * Reduce a call recorder (array of { fn, args, result }) to sorted
 * { fn, count } pairs — mirrors capture.js's reduceToCallCounts() so
 * `fingerprintLevel: "calls"` produces the same hash in chain steps as
 * in capture.js. Closes #283.
 */
function reduceToCallCounts(recorder) {
  const counts = {}
  for (const call of recorder) {
    counts[call.fn] = (counts[call.fn] || 0) + 1
  }
  return Object.entries(counts)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([fn, count]) => ({ fn, count }))
}

/**
 * Compute a fingerprint for a (input, output, recorder) triple using the
 * cluster's `fingerprintLevel` / `fingerprintMode` / `valuePaths` config.
 *
 * This mirrors the dispatch logic in capture.js (lines ~1143-1170) so a
 * chain step's fingerprint matches what `regret capture` would have
 * produced for the same input on the same cluster. Without this parity,
 * `fingerprintMode: "schema"` / `fingerprintLevel: "calls"` clusters
 * would always mismatch in chain validation. Closes #283.
 */
function computeStepFingerprint(cluster, input, output, recorder) {
  const fpConfig = buildFingerprintOptions(cluster)
  const fingerprintLevel = cluster.fingerprintLevel || 'entry'
  const fingerprintMode = cluster.fingerprintMode || 'value'
  const valuePaths = cluster.valuePaths || []

  if (fingerprintMode === 'schema') {
    const schema = extractSchema(output)
    return fingerprint(input, schema, fpConfig)
  }
  if (fingerprintMode === 'mixed') {
    const schema = extractSchema(output)
    const selectedValues = {}
    for (const p of valuePaths) {
      const key = p.replace(/^\$\./, '')
      const parts = key.split('.')
      let val = output
      for (const part of parts) { val = val?.[part] }
      if (val !== undefined) selectedValues[p] = val
    }
    return fingerprint(input, { schema, values: selectedValues }, fpConfig)
  }
  if (fingerprintLevel === 'calls') {
    const callCounts = reduceToCallCounts(recorder)
    return fingerprint(input, callCounts, fpConfig)
  }
  return fingerprint(input, output, fpConfig)
}

// ─── Callee re-validation (#272) ────────────────────────────────────────────
//
// validate.js (post PR #258/#303) re-validates each `.calls.*` callee
// contract after running the parent cluster. contest.mjs used to skip this
// step entirely, which meant a chain could pass while a callee had
// regressed — inconsistent with `regret validate`. We now run the same
// `runCalleeContract` (imported from validate.js) against every declared
// callee of every step's cluster, and surface per-callee PASS/FAIL. A
// failing callee fails the chain (mirrors validate.js exit-code semantics).
//
// `--skip-callees` disables this phase entirely, matching validate.js.
// Closes #272.

/**
 * Re-validate every declared callee for a step's cluster.
 *
 * @param {object} cluster - Cluster definition from the manifest.
 * @returns {Promise<Array<{id: string, pass: boolean, expected?: string, actual?: string, error?: string, skipped?: boolean}>>}
 *   Per-callee results. Empty array when the cluster has no `callees`, when
 *   `--skip-callees` is set, or when the cluster's stack is not JS (Python
 *   clusters have their own callee validator inside validate.py).
 */
async function revalidateStepCallees(cluster) {
  if (skipCallees) return []
  if (!Array.isArray(cluster.callees) || cluster.callees.length === 0) return []
  // Callee re-validation in validate.js is JS-only — Python/Rust/Go clusters
  // return skipped:true from runCalleeContract. We mirror that here and
  // don't even attempt to look up callee .regret files for non-JS stacks.
  const stack = cluster.stack || 'js'
  if (stack === 'python' || stack === 'rust' || stack === 'go') return []

  const calleeResults = []
  for (const calleeName of cluster.callees) {
    if (typeof calleeName !== 'string' || calleeName.length === 0) continue
    const calleeId = `${cluster.id}.calls.${calleeName}`
    const calleeRegretPath = join(REGRET_DIR, `${calleeId}.regret`)
    if (!existsSync(calleeRegretPath)) {
      // Missing callee contract — surface as a failure so the user knows
      // they need to run `regret capture --cluster <id>` to generate it.
      // Mirrors validate.js's #288 missing-callee detection.
      calleeResults.push({
        id: calleeId,
        pass: false,
        error: `callee contract missing — run \`regret capture --cluster ${cluster.id}\` to generate`,
      })
      continue
    }
    try {
      const calleeRegret = parseRegret(readFileSync(calleeRegretPath, 'utf8'))
      const result = await runCalleeContract(calleeRegret, cluster, {
        normalize: cluster.normalize ?? [],
        ignoreFields: cluster.ignoreFields ?? [],
        ignorePaths: cluster.ignorePaths ?? [],
      })
      if (result.skipped) {
        calleeResults.push({
          id: calleeId,
          pass: true,
          skipped: true,
          error: result.error,
        })
      } else if (result.pass) {
        calleeResults.push({
          id: calleeId,
          pass: true,
          expected: result.goldenHash,
          actual: result.liveHash,
        })
      } else {
        calleeResults.push({
          id: calleeId,
          pass: false,
          expected: result.goldenHash,
          actual: result.liveHash,
          error: result.error,
          expectThrowViolated: result.expectThrowViolated,
          liveError: result.liveError,
        })
      }
    } catch (err) {
      calleeResults.push({
        id: calleeId,
        pass: false,
        error: err.message,
      })
    }
  }
  return calleeResults
}

// ─── ContestRunner ──────────────────────────────────────────────────────────

class ContestRunner {
  constructor() { this.manifest = null; this.chains = [] }

  loadChains(chainFile) {
    let raw
    try {
      raw = readFileSync(chainFile, 'utf8')
    } catch (e) {
      if (e.code === 'ENOENT') throw new Error(`chains.json not found at ${chainFile}. Create regrets/chains.json to define chain flows.`)
      throw new Error(`Cannot read ${chainFile}: ${e.message}`)
    }
    try {
      this.chains = JSON.parse(raw).chains || []
    } catch (e) {
      throw new Error(`Invalid JSON in ${chainFile}: ${e.message}. Fix the syntax and retry.`)
    }
    // ── Validate: detect duplicate chain IDs ──
    const seen = new Map()
    for (const chain of this.chains) {
      if (seen.has(chain.id)) {
        console.warn(`⚠️  Duplicate chain id "${chain.id}" — second occurrence at index ${this.chains.indexOf(chain)} will shadow the first`)
      }
      seen.set(chain.id, chain)
    }
    return this
  }

  loadManifest(manifestPath) {
    let raw
    try {
      raw = readFileSync(manifestPath, 'utf8')
    } catch (e) {
      if (e.code === 'ENOENT') throw new Error(`manifest.json not found at ${manifestPath}. Run 'regret init' first.`)
      throw new Error(`Cannot read ${manifestPath}: ${e.message}`)
    }
    try {
      this.manifest = JSON.parse(raw)
    } catch (e) {
      throw new Error(`Invalid JSON in ${manifestPath}: ${e.message}. Fix the syntax and retry.`)
    }
    // ── Validate: ensure manifest has clusters array ──
    if (!this.manifest.clusters || !Array.isArray(this.manifest.clusters)) {
      console.error('❌ regrets/manifest.json has no "clusters" array (or it is empty). Add clusters before running chains.')
      this.manifest.clusters = []
    }
    return this
  }

  findCluster(clusterId) {
    const cluster = (this.manifest.clusters || []).find(c => c.id === clusterId)
    return cluster || null
  }

  async runStep(step, stepIndex, chainId) {
    if (!step.cluster) {
      throw new Error(`Step ${stepIndex + 1} in chain "${chainId}" is missing a "cluster" field`)
    }
    const cluster = this.findCluster(step.cluster)
    if (!cluster) {
      throw new Error(`Step ${stepIndex + 1} in chain "${chainId}" references cluster "${step.cluster}" which does not exist in manifest. Available: [${(this.manifest.clusters || []).map(c => c.id).join(', ')}]`)
    }

    // Python stack: delegate to a Python subprocess for chain step execution
    if (cluster.stack === 'python') {
      const pyResult = await this.runPythonStep(step, cluster, stepIndex, chainId)
      // Callee re-validation for Python clusters happens inside the Python
      // subprocess (validate.py owns the Python callee contract logic).
      // We attach an empty callees array so the step result shape stays
      // consistent across stacks.
      pyResult.callees = []
      return pyResult
    }

    // JS/TS stack: use dynamic import + Ghost Proxy
    const absPath = resolve(CWD, cluster.file)
    let rawModule
    try {
      rawModule = await import(pathToFileURL(absPath).href)
    } catch (err) {
      if (err.code === 'ERR_MODULE_NOT_FOUND' || err.code === 'ENOENT') {
        throw new Error(`Cluster file not found at ${cluster.file} (resolved: ${absPath}). Compile the project or fix the 'file' field in manifest.json.`)
      }
      throw new Error(`Failed to import cluster file ${cluster.file}: ${err.message}`)
    }

    // Handle CJS modules — merge default exports for consistent access
    rawModule = mergeCjsModule(rawModule)

    // Support classMethod clusters in chains
    if (cluster.classMethod) {
      const Cls = rawModule[cluster.constructor ?? cluster.entry] ?? rawModule.default?.[cluster.constructor ?? cluster.entry]
      if (typeof Cls !== 'function') throw new Error(`Constructor "${cluster.constructor ?? cluster.entry}" not found in ${cluster.file}`)
      const cArgs = cluster.constructorArgs ? JSON.parse(JSON.stringify(cluster.constructorArgs)) : []
      const instance = new Cls(...cArgs)
      if (cluster.setup && cluster.setup.length > 0) {
        for (const step of cluster.setup) {
          instance[step.method](...(step.args ? JSON.parse(JSON.stringify(step.args)) : []))
        }
      }
      const input = step.input
      const args_ = cluster.multiArgs && Array.isArray(input) ? input : [input]
      const output = await instance[cluster.classMethod](...args_)
      // #283: route through computeStepFingerprint so fingerprintLevel /
      // fingerprintMode / valuePaths / ignorePaths are honoured.
      const fp = computeStepFingerprint(cluster, input, output, [])
      const callees = await revalidateStepCallees(cluster)
      return { cluster: step.cluster, input, output, fingerprint: fp, calls: [], callees }
    }

    // Support singletonMethod clusters in chains
    if (cluster.singletonMethod) {
      const singletonExportName = cluster.singletonName || cluster.entry
      let singleton = rawModule[singletonExportName] ?? rawModule.default?.[singletonExportName]
      // CJS fallback
      if (!singleton && rawModule.default && typeof rawModule.default === 'object' && typeof rawModule.default[cluster.singletonMethod] === 'function') {
        singleton = rawModule.default
      }
      if (!singleton || typeof singleton !== 'object') {
        throw new Error(`Singleton "${singletonExportName}" not found in ${cluster.file}`)
      }
      if (typeof singleton[cluster.singletonMethod] !== 'function') {
        throw new Error(`Method "${cluster.singletonMethod}" not found on singleton "${singletonExportName}"`)
      }
      const input = step.input
      const args_ = cluster.multiArgs && Array.isArray(input) ? input : [input]
      const output = await singleton[cluster.singletonMethod](...args_)
      const fp = computeStepFingerprint(cluster, input, output, [])
      const callees = await revalidateStepCallees(cluster)
      return { cluster: step.cluster, input, output, fingerprint: fp, calls: [], callees }
    }

    const recorder = []
    const ghostModule = createGhost(rawModule, cluster.watches || [], recorder, cluster.instanceMethods || {})
    const entryFn = ghostModule[cluster.entry] ?? rawModule[cluster.entry]
    if (typeof entryFn !== 'function') throw new Error(`Entry "${cluster.entry}" not found in ${cluster.file}`)

    const input = step.input
    const args_ = cluster.multiArgs && Array.isArray(input) ? input : [input]
    const output = await entryFn(...args_)
    const fp = computeStepFingerprint(cluster, input, output, recorder)
    const callees = await revalidateStepCallees(cluster)
    return { cluster: step.cluster, input, output, fingerprint: fp, calls: [...recorder], callees }
  }

  async runPythonStep(step, cluster, stepIndex, chainId) {
    /** Run a single chain step for a Python cluster by invoking a Python subprocess. */
    const scriptPath = join(__dirname, '_chain_step.py')
    const payload = JSON.stringify({
      cluster_id: step.cluster,
      entry: cluster.entry,
      module: cluster.module || cluster.file || '',
      python_path: cluster.pythonPath || '',
      multi_args: cluster.multiArgs || false,
      input: step.input,
      normalize: cluster.normalize || [],
      ignore_fields: cluster.ignoreFields || [],
      ignore_paths: cluster.ignorePaths || [],
      fingerprint_level: cluster.fingerprintLevel || 'entry',
      fingerprint_mode: cluster.fingerprintMode || 'value',
      value_paths: cluster.valuePaths || [],
      class_method: cluster.classMethod || null,
      constructor: cluster.constructor || cluster.entry,
      constructor_args: cluster.constructorArgs || [],
      setup: cluster.setup || [],
      kwargs: cluster.kwargs || false,
      output_transform: cluster.outputTransform || null,
    })
    try {
      const result = execFileSync('python3', [scriptPath, payload], {
        encoding: 'utf8',
        cwd: CWD,
        maxBuffer: 10 * 1024 * 1024,
      })
      const parsed = JSON.parse(result.trim())
      return {
        cluster: step.cluster,
        input: step.input,
        output: parsed.output,
        fingerprint: parsed.fingerprint,
        calls: [],
      }
    } catch (err) {
      if (err.code === 'ENOENT' || /spawn python3 ENOENT/i.test(err.message)) {
        throw new Error(
          `Python (python3) is not installed or not in PATH, but cluster "${step.cluster}" has stack=python. ` +
          `Install Python 3 or remove the Python cluster from manifest.json.`
        )
      }
      throw new Error(`Python chain step ${stepIndex + 1} ("${step.cluster}") in chain "${chainId}" failed: ${err.message}`)
    }
  }

  async runChain(chainId) {
    const chain = this.chains.find(c => c.id === chainId)
    if (!chain) throw new Error(`Chain "${chainId}" not found in chains.json`)
    // ── Validate: reject chains with empty steps ──
    if (!chain.steps || !Array.isArray(chain.steps) || chain.steps.length === 0) {
      throw new Error(`Chain "${chainId}" has no steps (empty or missing "steps" array). A chain must have at least one step.`)
    }
    const stepResults = []
    for (let i = 0; i < chain.steps.length; i++) {
      const step = chain.steps[i]
      try {
        const stepResult = await this.runStep(step, i, chainId)
        stepResults.push(stepResult)
        // ── #272: callee failure fails the chain ──
        // A failing callee means the cluster's behavioral sub-contract has
        // drifted. We DON'T throw here — we let runChain finish collecting
        // all step results (so main() can print the full per-step +
        // per-callee breakdown for the user), and instead mark the chain
        // as failed via the `calleeFailures` field. main() then exits 1
        // if any callee failure is present. Throwing here would skip the
        // per-callee PASS/FAIL printing in main(), leaving the user with
        // an opaque "Chain failed" message and no idea WHICH callee
        // regressed.
      } catch (err) {
        // ── Mid-chain failure: do NOT produce a chain hash — re-throw with context ──
        throw new Error(
          `Chain "${chainId}" failed at step ${i + 1}/${chain.steps.length} (cluster "${step.cluster}"): ${err.message}` +
          (i > 0 ? ` — ${i} preceding step(s) completed OK.` : '')
        )
      }
    }
    // Collect any callee failures across all steps so main() can both
    // print them AND exit non-zero. Closes #272.
    const calleeFailures = []
    for (const r of stepResults) {
      for (const c of (r.callees || [])) {
        if (!c.pass && !c.skipped) calleeFailures.push({ step: r.cluster, ...c })
      }
    }
    return { id: chainId, steps: stepResults, chainHash: this.computeChainHash(stepResults, chain.steps), calleeFailures }
  }

  computeChainHash(stepResults, expectedSteps = null) {
    // #254 — Determinism guarantee: stepResults MUST be in the same order as
    // the `steps` array in chains.json. The chain hash is computed by
    // joining `${cluster}:${fingerprint}` for each step IN THAT ORDER. If
    // stepResults ever arrives here in a different order (e.g. because a
    // future refactor parallelizes step execution with Promise.all), the
    // hash becomes nondeterministic — same code + same inputs would
    // produce different .chain files, causing false REDs in CI.
    //
    // This assertion is the runtime enforcement of the sort-key spec
    // documented in references/contest.md. It catches parallelization
    // refactors that forget to re-sort stepResults back into steps-array
    // order before hashing.
    if (!Array.isArray(stepResults)) {
      throw new Error(`computeChainHash: expected array, got ${typeof stepResults}`)
    }
    if (expectedSteps && Array.isArray(expectedSteps)) {
      if (stepResults.length !== expectedSteps.length) {
        throw new Error(
          `computeChainHash: stepResults length (${stepResults.length}) does not match ` +
          `expected steps length (${expectedSteps.length}) — order may have been corrupted ` +
          `by a parallelization refactor. See references/contest.md (#254).`
        )
      }
      for (let i = 0; i < stepResults.length; i++) {
        if (stepResults[i].cluster !== expectedSteps[i].cluster) {
          throw new Error(
            `computeChainHash: stepResults[${i}].cluster="${stepResults[i].cluster}" does not ` +
            `match expectedSteps[${i}].cluster="${expectedSteps[i].cluster}". Step order must ` +
            `match the steps array in chains.json — see references/contest.md (#254).`
          )
        }
      }
    }
    const combined = stepResults.map(r => `${r.cluster}:${r.fingerprint}`).join('|')
    return BigInt('0x' + createHash('sha256').update(combined, 'utf8').digest('hex')).toString(36).slice(0, 7)
  }

  compareChains(chainId, result) {
    const goldenPath = join(CHAINS_DIR, `${chainId}.chain`)
    if (!existsSync(goldenPath)) return { match: false, reason: 'no golden file' }
    const storedHash = readFileSync(goldenPath, 'utf8').match(/^chain_hash:\s+(\S+)/m)?.[1]
    if (!storedHash) return { match: false, reason: 'malformed golden file (no chain_hash)' }
    return { match: result.chainHash === storedHash, expected: storedHash, got: result.chainHash }
  }

  writeChainFile(result) {
    mkdirSync(CHAINS_DIR, { recursive: true })
    const lines = [`chain: ${result.id}`, `chain_hash: ${result.chainHash}`, `captured: ${new Date().toISOString()}`, 'steps:']
    result.steps.forEach((s, i) => { lines.push(`  ${i + 1}. cluster: ${s.cluster}`); lines.push(`     fingerprint: ${s.fingerprint}`) })
    lines.push('---')
    result.steps.forEach((s, i) => {
      lines.push(`STEP ${i + 1}  ${s.cluster}`, `  INPUT  ${stableStringify(s.input)}`, `  OUTPUT ${stableStringify(s.output)}`, `  HASH   ${s.fingerprint}`)
    })
    const outPath = join(CHAINS_DIR, `${result.id}.chain`)
    writeFileSync(outPath, lines.join('\n'), 'utf8')
    return outPath
  }
}

// ─── Main ───────────────────────────────────────────────────────────────────

async function main() {
  // Load manifest
  if (!existsSync(MANIFEST_PATH)) {
    console.error('❌ regrets/manifest.json not found. Run `regret init` first.')
    process.exit(1)
  }

  // Load chains
  if (!existsSync(CHAIN_FILE)) {
    console.error('❌ regrets/chains.json not found. Create it to define chain flows.')
    process.exit(1)
  }

  const runner = new ContestRunner()
  try {
    runner.loadManifest(MANIFEST_PATH).loadChains(CHAIN_FILE)
  } catch (err) {
    console.error(`❌ ${err.message}`)
    process.exit(1)
  }

  // ── Validate: warn if manifest has no clusters ──
  if (!runner.manifest.clusters || runner.manifest.clusters.length === 0) {
    console.warn('⚠️  regrets/manifest.json has no clusters defined. No chain steps can run.')
  }

  const chainsToRun = chainFilter
    ? runner.chains.filter(c => c.id === chainFilter)
    : runner.chains

  if (!chainsToRun.length) {
    console.log('No chains to run.')
    process.exit(0)
  }

  console.log(captureMode ? '📡 CHAIN CAPTURE MODE\n' : '🔍 CHAIN VALIDATE MODE\n')
  if (skipCallees) console.log('⏭️  --skip-callees: callee contract re-validation disabled\n')

  let passed = 0
  let failed = 0

  for (const chainDef of chainsToRun) {
    console.log(`\n⛓  Chain: ${chainDef.id} (${chainDef.steps ? chainDef.steps.length : 0} steps)`)

    try {
      const result = await runner.runChain(chainDef.id)

      for (let i = 0; i < result.steps.length; i++) {
        const s = result.steps[i]
        console.log(`   Step ${i + 1}: ${s.cluster} → ${s.fingerprint}`)
        // Print per-step callee re-validation results so users see WHICH
        // callee contracts were verified (mirrors validate.js's per-callee
        // PASS lines). When --skip-callees is set, s.callees is empty and
        // nothing is printed.
        for (const c of (s.callees || [])) {
          if (c.skipped) {
            console.log(`     ⏭  ${c.id} skipped${c.error ? ` — ${c.error}` : ''}`)
          } else if (c.pass) {
            console.log(`     ✅ ${c.id}  PASS (callee)`)
          } else {
            console.log(`     ❌ ${c.id}  FAIL (callee)`)
          }
        }
      }
      console.log(`   Chain hash: ${result.chainHash}`)

      if (captureMode) {
        const outPath = runner.writeChainFile(result)
        console.log(`   ✅ Captured → ${outPath}`)
        // #272: even in capture mode, a callee regression means the chain
        // is being captured against a drifted sub-contract — surface it
        // as a failure so the user knows to re-capture the callee before
        // treating this chain file as golden.
        if (result.calleeFailures && result.calleeFailures.length > 0) {
          console.log(`   ❌ ${result.calleeFailures.length} callee contract regression(s) detected — see FAIL lines above`)
          failed++
        } else {
          passed++
        }
      } else {
        const comparison = runner.compareChains(chainDef.id, result)
        const hasCalleeFailures = result.calleeFailures && result.calleeFailures.length > 0
        // Always print the chain match/mismatch line so the user knows
        // whether the top-level chain hash aligned — independent of
        // whether any callee contract regressed.
        if (comparison.match) {
          console.log('   ✅ Match')
        } else {
          console.log(`   ❌ Mismatch — ${comparison.reason || `expected ${comparison.expected}, got ${comparison.got}`}`)
        }
        if (hasCalleeFailures) {
          const ids = result.calleeFailures.map(c => c.id).join(', ')
          console.log(`   ❌ Callee contract regression: ${ids}`)
        }
        if (comparison.match && !hasCalleeFailures) {
          passed++
        } else {
          failed++
        }
      }
    } catch (err) {
      console.error(`   ❌ Chain failed: ${err.message}`)
      failed++
    }
  }

  console.log(`\n${'─'.repeat(50)}`)
  console.log(`Chain ${captureMode ? 'capture' : 'validate'}: ${passed} passed, ${failed} failed`)
  process.exit(failed > 0 ? 1 : 0)
}

main().catch(err => {
  console.error('Fatal:', err)
  process.exit(1)
})

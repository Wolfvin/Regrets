#!/usr/bin/env node
// contest.mjs — Chain testing MVP for regret-based regression
// Executes multi-step flows (chains) and fingerprints the combined output.
//
// Usage:
//   node scripts/contest.mjs --capture [--chain <id>]
//   node scripts/contest.mjs --validate [--chain <id>]

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs'
import { resolve, dirname, join } from 'path'
import { fileURLToPath, pathToFileURL } from 'url'
import { fingerprint, stableStringify, normalize, stripFields } from './fingerprint.js'
import { createGhost, deepClone } from './ghost.js'
import { mergeCjsModule } from './cjs-merge.js'
import { createHash } from 'crypto'
import { execFileSync } from 'child_process'

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

// ─── Paths ──────────────────────────────────────────────────────────────────

const CWD = process.cwd()
const CHAINS_DIR = resolve(CWD, 'regrets', 'chains')
const CHAIN_FILE = resolve(CWD, 'regrets', 'chains.json')
const MANIFEST_PATH = resolve(CWD, 'regrets', 'manifest.json')

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
      return await this.runPythonStep(step, cluster, stepIndex, chainId)
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
      const fp = fingerprint(input, output, {
        normalize: cluster.normalize || [], ignoreFields: cluster.ignoreFields || []
      })
      return { cluster: step.cluster, input, output, fingerprint: fp, calls: [] }
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
      const fp = fingerprint(input, output, {
        normalize: cluster.normalize || [], ignoreFields: cluster.ignoreFields || []
      })
      return { cluster: step.cluster, input, output, fingerprint: fp, calls: [] }
    }

    const recorder = []
    const ghostModule = createGhost(rawModule, cluster.watches || [], recorder, cluster.instanceMethods || {})
    const entryFn = ghostModule[cluster.entry] ?? rawModule[cluster.entry]
    if (typeof entryFn !== 'function') throw new Error(`Entry "${cluster.entry}" not found in ${cluster.file}`)

    const input = step.input
    const args_ = cluster.multiArgs && Array.isArray(input) ? input : [input]
    const output = await entryFn(...args_)
    const fp = fingerprint(input, output, {
      normalize: cluster.normalize || [], ignoreFields: cluster.ignoreFields || []
    })
    return { cluster: step.cluster, input, output, fingerprint: fp, calls: [...recorder] }
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
        stepResults.push(await this.runStep(step, i, chainId))
      } catch (err) {
        // ── Mid-chain failure: do NOT produce a chain hash — re-throw with context ──
        throw new Error(
          `Chain "${chainId}" failed at step ${i + 1}/${chain.steps.length} (cluster "${step.cluster}"): ${err.message}` +
          (i > 0 ? ` — ${i} preceding step(s) completed OK.` : '')
        )
      }      }
    }
    return { id: chainId, steps: stepResults, chainHash: this.computeChainHash(stepResults) }
  }

  computeChainHash(stepResults) {
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

  let passed = 0
  let failed = 0

  for (const chainDef of chainsToRun) {
    console.log(`\n⛓  Chain: ${chainDef.id} (${chainDef.steps ? chainDef.steps.length : 0} steps)`)

    try {
      const result = await runner.runChain(chainDef.id)

      for (let i = 0; i < result.steps.length; i++) {
        const s = result.steps[i]
        console.log(`   Step ${i + 1}: ${s.cluster} → ${s.fingerprint}`)
      }
      console.log(`   Chain hash: ${result.chainHash}`)

      if (captureMode) {
        const outPath = runner.writeChainFile(result)
        console.log(`   ✅ Captured → ${outPath}`)
        passed++
      } else {
        const comparison = runner.compareChains(chainDef.id, result)
        if (comparison.match) {
          console.log('   ✅ Match')
          passed++
        } else {
          console.log(`   ❌ Mismatch — ${comparison.reason || `expected ${comparison.expected}, got ${comparison.got}`}`)
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

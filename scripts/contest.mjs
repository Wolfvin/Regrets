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
    this.chains = JSON.parse(readFileSync(chainFile, 'utf8')).chains || []
    return this
  }

  loadManifest(manifestPath) {
    this.manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
    return this
  }

  findCluster(clusterId) {
    return this.manifest.clusters.find(c => c.id === clusterId)
  }

  async runStep(step) {
    const cluster = this.findCluster(step.cluster)
    if (!cluster) throw new Error(`Cluster "${step.cluster}" not found in manifest`)

    // Python stack: delegate to a Python subprocess for chain step execution
    if (cluster.stack === 'python') {
      return await this.runPythonStep(step, cluster)
    }

    // JS/TS stack: use dynamic import + Ghost Proxy
    const absPath = resolve(CWD, cluster.file)
    let rawModule = await import(pathToFileURL(absPath).href)

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

  async runPythonStep(step, cluster) {
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
      throw new Error(`Python chain step failed for "${step.cluster}": ${err.message}`)
    }
  }

  async runChain(chainId) {
    const chain = this.chains.find(c => c.id === chainId)
    if (!chain) throw new Error(`Chain "${chainId}" not found in chains.json`)
    const stepResults = []
    for (const step of chain.steps) stepResults.push(await this.runStep(step))
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
  runner.loadManifest(MANIFEST_PATH).loadChains(CHAIN_FILE)

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
    console.log(`\n⛓  Chain: ${chainDef.id} (${chainDef.steps.length} steps)`)

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

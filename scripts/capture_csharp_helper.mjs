#!/usr/bin/env node
// capture_csharp_helper.mjs — helper for capture_csharp.sh
// Reads manifest + pre-computed outputs, writes .regret files.
// Usage: node scripts/capture_csharp_helper.mjs <manifest> <regret_dir> <pre_computed_file>

import { readFileSync, writeFileSync, existsSync } from 'fs'
import { resolve, join } from 'path'
import { fingerprint } from './fingerprint.js'

const [,, manifestPath, regretDir, preComputedPath] = process.argv

if (!manifestPath || !regretDir || !preComputedPath) {
  console.error('Usage: node capture_csharp_helper.mjs <manifest> <regret_dir> <pre_computed_file>')
  process.exit(1)
}

const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
const preComputed = JSON.parse(readFileSync(preComputedPath, 'utf8'))

const csharpClusters = manifest.clusters.filter(c => c.stack === 'csharp')

if (csharpClusters.length === 0) {
  console.log('No C# clusters found in manifest.')
  process.exit(0)
}

let captured = 0
let skipped = 0

for (const cluster of csharpClusters) {
  const { id, entry, file } = cluster
  const preCompEntry = preComputed[id]
  if (!preCompEntry) {
    console.error(`⚠️  No pre-computed output for cluster: ${id}`)
    skipped++
    continue
  }

  // Use the first pre-computed input/output pair
  const pair = Array.isArray(preCompEntry) ? preCompEntry[0] : preCompEntry
  const inputVal = pair.input
  const outputVal = pair.output

  // Compute fingerprint via JS module (cross-stack consistent)
  const fp = fingerprint(inputVal, outputVal)

  // Write .regret file
  const regretPath = join(regretDir, `${id}.regret`)
  const timestamp = new Date().toISOString()
  const content = [
    `cluster: ${id}`,
    `version: 1`,
    `fingerprint: ${fp}`,
    `captured: ${timestamp}`,
    `watches: []`,
    `entry: ${entry}`,
    `stack: csharp`,
    `fingerprintLevel: entry`,
    `file: ${file || ''}`,
    `---`,
    `INPUT  ${JSON.stringify(inputVal)}`,
    `OUTPUT ${JSON.stringify(outputVal)}`,
    `HASH   ${fp}`,
  ].join('\n') + '\n'

  writeFileSync(regretPath, content, 'utf8')
  console.log(`   ✅ Fingerprint: ${fp}`)
  console.log(`   📄 Saved: ${regretPath}`)
  captured++
}

console.log('')
console.log(`─── Capture Summary ───`)
console.log(`  Captured: ${captured}`)
console.log(`  Skipped:  ${skipped}`)

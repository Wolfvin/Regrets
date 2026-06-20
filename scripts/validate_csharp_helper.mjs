#!/usr/bin/env node
// validate_csharp_helper.mjs — helper for validate_csharp.sh
// Reads .regret files, re-computes fingerprints, reports PASS/FAIL.
// Usage: node scripts/validate_csharp_helper.mjs <manifest> <regret_dir> [pre_computed_file] [fail_fast]

import { readFileSync, existsSync } from 'fs'
import { join } from 'path'
import { fingerprint } from './fingerprint.js'

const [,, manifestPath, regretDir, preComputedPath, failFastStr] = process.argv
const failFast = failFastStr === 'true'

if (!manifestPath || !regretDir) {
  console.error('Usage: node validate_csharp_helper.mjs <manifest> <regret_dir> [pre_computed_file] [fail_fast]')
  process.exit(1)
}

const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
const csharpClusters = manifest.clusters.filter(c => c.stack === 'csharp')

let preComputed = null
if (preComputedPath) {
  preComputed = JSON.parse(readFileSync(preComputedPath, 'utf8'))
}

if (csharpClusters.length === 0) {
  console.log('No C# clusters found in manifest.')
  process.exit(0)
}

let pass = 0, fail = 0, skip = 0

for (const cluster of csharpClusters) {
  const { id } = cluster
  const regretPath = join(regretDir, `${id}.regret`)

  if (!existsSync(regretPath)) {
    console.log(`   ⏭️  SKIP ${id} — no .regret file`)
    skip++
    continue
  }

  // Parse .regret file
  const content = readFileSync(regretPath, 'utf8')
  const lines = content.split('\n')
  let inHeader = true
  const header = {}
  const body = {}
  for (const line of lines) {
    if (line === '---') { inHeader = false; continue }
    if (inHeader) {
      const idx = line.indexOf(':')
      if (idx > 0) header[line.substring(0, idx).trim()] = line.substring(idx + 1).trim()
    } else {
      const m = line.match(/^(INPUT|OUTPUT|HASH)\s+(.*)$/)
      if (m) body[m[1]] = m[2]
    }
  }

  const goldenHash = body.HASH || header.fingerprint
  const inputStr = body.INPUT || ''
  const outputStr = body.OUTPUT || ''

  // Parse input and output as JSON
  let inputVal, outputVal
  try { inputVal = inputStr === 'undefined' ? undefined : JSON.parse(inputStr) }
  catch { inputVal = inputStr }
  try { outputVal = outputStr === 'undefined' ? undefined : JSON.parse(outputStr) }
  catch { outputVal = outputStr }

  // Step 1: Verify the golden hash matches the golden input+output
  // (this catches corrupted .regret files)
  const computedFp = fingerprint(inputVal, outputVal)

  if (computedFp !== goldenHash) {
    console.log(`   ❌ FAIL ${id} — .regret file hash mismatch (corrupted file)`)
    console.log(`      Golden hash:    ${goldenHash}`)
    console.log(`      Computed hash:  ${computedFp}`)
    fail++
    if (failFast) { console.log('\n--fail-fast: stopping on first failure.'); process.exit(1) }
    continue
  }

  // Step 2: If pre-computed outputs are provided, re-invoke the function
  // and compare the new output's fingerprint against the golden hash.
  if (preComputed) {
    const liveEntry = preComputed[id]
    if (!liveEntry) {
      console.log(`   ⏭️  SKIP ${id} — no pre-computed output for re-validation`)
      skip++
      continue
    }
    const liveOutputVal = Array.isArray(liveEntry) ? liveEntry[0].output : liveEntry.output
    const liveFp = fingerprint(inputVal, liveOutputVal)

    if (liveFp !== goldenHash) {
      console.log(`   ❌ FAIL ${id} — fingerprint changed (regression detected)`)
      console.log(`      Golden hash:    ${goldenHash}`)
      console.log(`      Live hash:      ${liveFp}`)
      console.log(`      Input:          ${JSON.stringify(inputVal)}`)
      console.log(`      Golden output:  ${JSON.stringify(outputVal)}`)
      console.log(`      Live output:    ${JSON.stringify(liveOutputVal)}`)
      fail++
      if (failFast) { console.log('\n--fail-fast: stopping on first failure.'); process.exit(1) }
      continue
    }
  }

  console.log(`   ✅ PASS ${id} — ${goldenHash}`)
  pass++
}

console.log('')
console.log('─── Summary ───')
console.log(`  PASS: ${pass}`)
console.log(`  FAIL: ${fail}`)
console.log(`  SKIP: ${skip}`)

if (fail > 0) process.exit(1)

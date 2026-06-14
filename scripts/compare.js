#!/usr/bin/env node
// compare.js — Compare pre-refactor and post-refactor truth baselines
//
// After running `regret truth --outdir proof-pre` before refactoring and
// `regret truth --outdir proof-post` after refactoring, this command
// compares the two baselines to verify that no behavioral change occurred.
//
// Usage:
//   node scripts/compare.js --pre regrets/proof --post regrets/proof-post
//   node scripts/compare.js --pre regrets/proof --post regrets/proof-post --strict
//
// This addresses the gap where agents had to write custom scripts to compare
// pre vs post baselines. The existing `verify_kebenaran.js` only checks
// internal consistency (K1 vs K2), not pre vs post comparison.
//
// Born from real experience: During the Coretax-Auto-Downloader refactoring,
// I changed `exportInterXLSX` from 9 positional parameters to an options
// object, and had to manually write a Node.js one-liner to compare the
// KEBENARAN 1 JSON files. This should be a built-in Regrets command.

import { readFileSync, existsSync } from 'fs'
import { resolve } from 'path'

const args = process.argv.slice(2)

function getArg(flag) {
  const i = args.indexOf(flag)
  return i !== -1 ? args[i + 1] ?? null : null
}

const preDir = getArg('--pre')
const postDir = getArg('--post')
const strict = args.includes('--strict')

if (!preDir || !postDir) {
  console.error('Usage: node scripts/compare.js --pre <dir> --post <dir> [--strict]')
  console.error('')
  console.error('Compare pre-refactor and post-refactor truth baselines.')
  console.error('')
  console.error('Options:')
  console.error('  --pre <dir>    Directory containing pre-refactor KEBENARAN files')
  console.error('  --post <dir>   Directory containing post-refactor KEBENARAN files')
  console.error('  --strict       Exit 1 on any difference (for CI)')
  process.exit(1)
}

// ─── Load baselines ──────────────────────────────────────────────────────────

function loadJson(path) {
  if (!existsSync(path)) {
    console.error(`❌ File not found: ${path}`)
    process.exit(1)
  }
  return JSON.parse(readFileSync(path, 'utf8'))
}

const preK1 = loadJson(resolve(preDir, 'KEBENARAN_1_raw_output.json'))
const postK1 = loadJson(resolve(postDir, 'KEBENARAN_1_raw_output.json'))
const preK2 = loadJson(resolve(preDir, 'KEBENARAN_2_fingerprints.json'))
const postK2 = loadJson(resolve(postDir, 'KEBENARAN_2_fingerprints.json'))

console.log('\n🔍 Comparing pre-refactor vs post-refactor baselines...\n')

// ─── Compare KEBENARAN 1 (raw output) ────────────────────────────────────────

console.log('📋 KEBENARAN 1 — Raw Output Comparison\n')

let k1Match = true
const preK1Keys = new Set(Object.keys(preK1))
const postK1Keys = new Set(Object.keys(postK1))

const inPreNotPost = [...preK1Keys].filter(k => !postK1Keys.has(k))
const inPostNotPre = [...postK1Keys].filter(k => !preK1Keys.has(k))

if (inPreNotPost.length > 0) {
  console.log(`  ❌ Clusters in pre but not post: ${inPreNotPost.join(', ')}`)
  k1Match = false
}
if (inPostNotPre.length > 0) {
  console.log(`  ⚠️  New clusters in post (not an error): ${inPostNotPre.join(', ')}`)
}

let k1Passed = 0
let k1Failed = 0

for (const key of preK1Keys) {
  if (!postK1Keys.has(key)) continue
  const preStr = JSON.stringify(preK1[key])
  const postStr = JSON.stringify(postK1[key])
  if (preStr === postStr) {
    console.log(`  ✅ ${key}`)
    k1Passed++
  } else {
    console.log(`  ❌ ${key} — OUTPUT CHANGED`)
    // Show first difference
    const preOutputs = preK1[key]
    const postOutputs = postK1[key]
    if (Array.isArray(preOutputs) && Array.isArray(postOutputs)) {
      for (let i = 0; i < Math.min(preOutputs.length, postOutputs.length); i++) {
        if (JSON.stringify(preOutputs[i]) !== JSON.stringify(postOutputs[i])) {
          const preSnippet = JSON.stringify(preOutputs[i].output || preOutputs[i]).slice(0, 100)
          const postSnippet = JSON.stringify(postOutputs[i].output || postOutputs[i]).slice(0, 100)
          console.log(`     Input #${i + 1}: pre=${preSnippet}... → post=${postSnippet}...`)
        }
      }
    }
    k1Failed++
    k1Match = false
  }
}

console.log(`\n  K1 Summary: ${k1Passed} identical, ${k1Failed} changed`)

// ─── Compare KEBENARAN 2 (fingerprints) ─────────────────────────────────────

console.log('\n📋 KEBENARAN 2 — Fingerprint Comparison\n')

let k2Match = true
const preFPs = preK2.fingerprints || {}
const postFPs = postK2.fingerprints || {}

let fpPassed = 0
let fpFailed = 0

for (const key of Object.keys(preFPs)) {
  if (!postFPs[key]) {
    console.log(`  ❌ ${key} — fingerprint missing in post`)
    fpFailed++
    k2Match = false
    continue
  }
  const preFP = preFPs[key].fingerprint
  const postFP = postFPs[key].fingerprint
  if (preFP === postFP) {
    console.log(`  ✅ ${key}: ${preFP}`)
    fpPassed++
  } else {
    console.log(`  ❌ ${key}: ${preFP} → ${postFP} (CHANGED)`)
    fpFailed++
    k2Match = false
  }
}

console.log(`\n  K2 Summary: ${fpPassed} match, ${fpFailed} changed`)

// ─── Compare chain hashes ────────────────────────────────────────────────────

const preChains = preK2.chains || {}
const postChains = postK2.chains || {}

if (Object.keys(preChains).length > 0) {
  console.log('\n⛓  Chain Hash Comparison\n')
  let chainPassed = 0
  let chainFailed = 0

  for (const key of Object.keys(preChains)) {
    if (!postChains[key]) {
      console.log(`  ❌ ${key}: chain missing in post`)
      chainFailed++
      continue
    }
    const preHash = preChains[key].chainHash
    const postHash = postChains[key].chainHash
    if (preHash === postHash) {
      console.log(`  ✅ ${key}: ${preHash}`)
      chainPassed++
    } else {
      console.log(`  ❌ ${key}: ${preHash} → ${postHash} (CHANGED)`)
      chainFailed++
    }
  }
  console.log(`\n  Chain Summary: ${chainPassed} match, ${chainFailed} changed`)
}

// ─── Final verdict ───────────────────────────────────────────────────────────

console.log('\n' + '─'.repeat(50))

if (k1Match && k2Match) {
  console.log('✅ COMPARISON PASSED — Pre and post baselines are IDENTICAL.')
  console.log('   Refactor is proven safe — no behavioral changes detected.')
} else {
  console.log('❌ COMPARISON FAILED — Differences detected between baselines.')
  if (!k1Match) console.log('   Raw output (K1) has changes — refactor altered behavior.')
  if (!k2Match) console.log('   Fingerprints (K2) have changes — contracts were broken.')
}

console.log()

if (strict && (!k1Match || !k2Match)) {
  process.exit(1)
}

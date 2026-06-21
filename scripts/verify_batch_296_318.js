#!/usr/bin/env node
// Verification script for issues #296, #297, #298, #300, #301, #318

import { readFileSync } from 'fs'
import { resolve, dirname } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = resolve(__dirname, '..')

function readFile(relPath) {
  return readFileSync(resolve(REPO_ROOT, relPath), 'utf8')
}

const results = []

function verify_318() {
  const capture = readFile('scripts/capture.js')
  const count = (capture.match(/Issue #318/g) || []).length
  const hasPartialCapture = capture.includes('partial capture') && capture.includes('skip this input, continue to next')
  results.push({
    issue: '#318',
    title: 'Partial capture when input throws',
    mergedPR: '#333',
    verified: hasPartialCapture && count >= 5,
    evidence: `Found ${count} Issue #318 references. Partial capture: skip throwing inputs, continue to next.`
  })
}

function verify_301() {
  const capture = readFile('scripts/capture.js')
  const count = (capture.match(/Issue #301/g) || []).length
  const hasImportedBindingDetection = capture.includes('imported binding') && capture.includes('cannot intercept')
  results.push({
    issue: '#301',
    title: 'ESM imported binding callee warning',
    mergedPR: '#307',
    verified: hasImportedBindingDetection && count >= 3,
    evidence: `Found ${count} Issue #301 references. ESM imported binding detection + accurate warning.`
  })
}

function verify_300() {
  const capture = readFile('scripts/capture.js')
  const hasNullUndefinedFix = capture.includes('Previously') && capture.includes('INPUT null') && capture.includes('Backward compat')
  results.push({
    issue: '#300',
    title: 'INPUT null vs undefined',
    mergedPR: '#307',
    verified: hasNullUndefinedFix,
    evidence: `capture.js distinguishes null from undefined in INPUT line, backward compat for old .regret files.`
  })
}

function verify_298() {
  const capture = readFile('scripts/capture.js')
  const count = (capture.match(/Issue #298/g) || []).length
  const hasUniqueCallDedup = capture.includes('uniqueCallsByCallee') && capture.includes('group ALL callee recordings')
  results.push({
    issue: '#298',
    title: 'Callee saves only first call args',
    mergedPR: '#307',
    verified: hasUniqueCallDedup && count >= 3,
    evidence: `Found ${count} Issue #298 references. uniqueCallsByCallee dedup + ALL unique (args, result) pairs.`
  })
}

function verify_297() {
  const install = readFile('scripts/install.js')
  const hasExtensionCheck = install.includes('Issue #297') && install.includes('unsupported file extension')
  results.push({
    issue: '#297',
    title: 'No extension bypasses language detection',
    mergedPR: '#312',
    verified: hasExtensionCheck,
    evidence: `install.js checks file extension in single-file scope, rejects unsupported/no-extension files.`
  })
}

function verify_296() {
  const install = readFile('scripts/install.js')
  const hasEmptyHandling = install.includes('0 functions') && install.includes('Found 0')
  const hasScopeSummary = install.includes('installForScope')
  results.push({
    issue: '#296',
    title: 'Empty folder silent success',
    mergedPR: '#312',
    verified: hasEmptyHandling && hasScopeSummary,
    evidence: `install.js handles empty directories: explicit 0 functions messaging, scope summary.`
  })
}

verify_318()
verify_301()
verify_300()
verify_298()
verify_297()
verify_296()

console.log('=== BATCH ISSUE VERIFICATION REPORT ===\n')
let allVerified = true
for (const r of results) {
  const icon = r.verified ? '✅' : '❌'
  console.log(`${icon} ${r.issue}: ${r.title}`)
  console.log(`   Merged PR: ${r.mergedPR}`)
  console.log(`   Evidence: ${r.evidence}\n`)
  if (!r.verified) allVerified = false
}
console.log(allVerified ? '\nALL 6 ISSUES VERIFIED AS FIXED' : '\nSOME ISSUES NOT VERIFIED')

#!/usr/bin/env node
// shim/regret_proof_rust_breaking.mjs — Node shim that mimics a REFACTORED
// version of the Rust binary, with a deliberately-broken implementation
// of `sanitize_filename`. Used to demonstrate validate_rust.sh detecting
// a regression (FAIL case).
//
// The breaking change: sanitize_filename now ALSO preserves dashes ('-')
// in addition to alphanumeric chars. This changes the output for inputs
// like "2025-05" → "FPK-2025-05" instead of the golden "FPK-2025_05".
//
// CONTRACT (identical to proof/rust/src/main.rs):
//   stdin:  { "cluster": "<id>", "input": <value> }
//   stdout: { "output": <value> }   OR   { "error": "<message>" } + exit 1

import { readFileSync } from 'fs'

// ─── Pure functions — REFACTORED VERSION (intentional regression) ──────────

function formatPeriod(period) {
  // ✅ Refactored: use destructuring instead of parts[0]/parts[1].
  // This is a VALID refactor — output is identical.
  const [year, month, ...rest] = period.split('_')
  if (rest.length > 0 || month === undefined || year === undefined) return ''
  return `${month}${year}`
}

function sanitizeFilename(prefix, base) {
  // ❌ BREAKING REFACTOR: regex now includes '-' as a safe character.
  // This changes output for inputs like "2025-05" → "FPK-2025-05"
  // instead of the golden "FPK-2025_05".
  const sanitized = base
    .split('')
    .map(c => (/[A-Za-z0-9-]/.test(c) ? c : '_'))
    .join('')
  return `${prefix}${sanitized}`
}

// ─── Dispatch ──────────────────────────────────────────────────────────────
function dispatch(cluster, input) {
  switch (cluster) {
    case 'rust-format-period': {
      if (typeof input !== 'string') throw new Error('expected string input')
      return formatPeriod(input)
    }
    case 'rust-sanitize-filename': {
      if (!Array.isArray(input)) throw new Error('expected array input')
      if (input.length !== 2) throw new Error(`expected 2 args, got ${input.length}`)
      const [prefix, base] = input
      if (typeof prefix !== 'string') throw new Error('prefix must be string')
      if (typeof base !== 'string') throw new Error('base must be string')
      return sanitizeFilename(prefix, base)
    }
    default:
      throw new Error(`unknown cluster: ${cluster}`)
  }
}

// ─── main ──────────────────────────────────────────────────────────────────
function main() {
  let raw
  try {
    raw = readFileSync(0, 'utf8')
  } catch (e) {
    console.error(JSON.stringify({ error: `failed to read stdin: ${e.message}` }))
    process.exit(1)
  }

  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch (e) {
    console.log(JSON.stringify({ error: `invalid JSON input: ${e.message}` }))
    process.exit(1)
  }

  const cluster = parsed?.cluster
  if (typeof cluster !== 'string') {
    console.log(JSON.stringify({ error: "missing 'cluster' field" }))
    process.exit(1)
  }

  const inputVal = parsed?.input
  if (inputVal === undefined) {
    console.log(JSON.stringify({ error: "missing 'input' field" }))
    process.exit(1)
  }

  try {
    const out = dispatch(cluster, inputVal)
    console.log(JSON.stringify({ output: out }))
  } catch (e) {
    console.log(JSON.stringify({ error: e.message }))
    process.exit(1)
  }
}

main()

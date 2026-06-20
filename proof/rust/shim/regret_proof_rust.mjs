#!/usr/bin/env node
// shim/regret_proof_rust.mjs — Node shim that implements the same CLI contract
// as proof/rust/src/main.rs. Used by run_demo.sh when the Rust toolchain
// (cargo/rustc) is not available, so the validate_rust.sh end-to-end demo
// can run on any machine with Node installed.
//
// CONTRACT (identical to proof/rust/src/main.rs):
//   stdin:  { "cluster": "<id>", "input": <value> }
//   stdout: { "output": <value> }   OR   { "error": "<message>" } + exit 1
//
// This shim mirrors the Rust binary's behavior 1:1 — including the SAME pure
// function implementations — so that swapping the binary for the shim (or
// vice versa) produces identical fingerprints. In a real-world setup you
// would NEVER ship this shim; you'd build the Rust binary with
// `cargo build` and point validate_rust.sh at it via `--bin` or
// `cargoBin` in manifest.json.

import { readFileSync } from 'fs'

// ─── Pure functions — 1:1 mirrors of proof/rust/src/main.rs ────────────────
// If you edit these, edit the Rust source too. They MUST produce identical
// output for identical input, or the cross-stack fingerprint parity claim
// is broken.

function formatPeriod(period) {
  const parts = period.split('_')
  if (parts.length !== 2) return ''
  const [year, month] = parts
  return `${month}${year}`
}

function sanitizeFilename(prefix, base) {
  const sanitized = base
    .split('')
    .map(c => (/[A-Za-z0-9]/.test(c) ? c : '_'))
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

// ─── main: stdin → stdout JSON bridge ──────────────────────────────────────
function main() {
  let raw
  try {
    raw = readFileSync(0, 'utf8')  // fd 0 = stdin
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

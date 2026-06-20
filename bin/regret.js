#!/usr/bin/env node
// regret — CLI for regret-based regression testing
// Install globally: npm link (from the regret-testing package dir)
// Or use: npx regret capture
import { resolve, dirname } from 'path'
import { fileURLToPath } from 'url'
import { spawn } from 'child_process'
import { constants as osConstants } from 'os'

const __dirname = dirname(fileURLToPath(import.meta.url))
const SCRIPTS_DIR = resolve(__dirname, '..')

// Parse command
const args = process.argv.slice(2)
const command = args[0] ?? 'help'
const passThroughArgs = args.slice(1)

// Convert a signal name (e.g. 'SIGINT') to its numeric value.
// Node's os.constants.signals provides the mapping.
function signalNumber(sig) {
  const signals = osConstants.signals
  for (const [name, num] of Object.entries(signals)) {
    if (name === sig) return num
  }
  return 0
}

// Delegate to regret.js unified runner.
//
// #302: We use async `spawn` (not `execFileSync`) so SIGINT/SIGTERM from the
// terminal reach this parent process's event loop and can be forwarded to
// the child. With `execFileSync`, the parent's event loop is blocked for the
// entire duration of the child run; the parent exits on SIGINT but the child
// is orphaned and keeps running (no signal propagation, no cleanup).
// Using `spawn` + explicit signal handlers keeps the parent alive long
// enough to forward the signal and wait for the child's cleanup handlers
// (e.g. esm-callee-transform.js's temp-file cleanup) to run.
const child = spawn('node', [resolve(SCRIPTS_DIR, 'scripts', 'regret.js'), command, ...passThroughArgs], {
  stdio: 'inherit',
  cwd: process.cwd(),
})

// Forward SIGINT / SIGTERM to the child so its cleanup handlers run.
// Without this, killing the parent orphans the child (issue #302).
let signalReceived = null
function forwardSignal(sig) {
  if (signalReceived) return  // only forward once
  signalReceived = sig
  try { child.kill(sig) } catch { /* child already exited */ }
}
process.on('SIGINT', () => forwardSignal('SIGINT'))
process.on('SIGTERM', () => forwardSignal('SIGTERM'))

// SIGHUP (terminal closed) — also forward so child cleans up.
process.on('SIGHUP', () => forwardSignal('SIGHUP'))

child.on('exit', (code, signal) => {
  // If the child was killed by a signal, exit with the conventional 128+signal
  // code (130 for SIGINT, 143 for SIGTERM, etc.). Otherwise propagate the
  // child's exit code.
  if (signal) {
    process.exit(128 + signalNumber(signal))
  }
  // If the child exited with a 128+signum code (e.g. 130 for SIGINT), it
  // means the child's own signal handler ran process.exit(130). Propagate
  // that code so CI runners see the correct exit status.
  if (code !== null && code >= 128 && code < 256) {
    process.exit(code)
  }
  process.exit(code ?? 0)
})

// If the child fails to spawn (e.g. node binary missing), 'error' fires.
child.on('error', (err) => {
  console.error(`❌ Failed to spawn regret runner: ${err.message}`)
  process.exit(1)
})


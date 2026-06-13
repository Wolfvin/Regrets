// befunge-runner.mjs — ESM adapter for Regrets fingerprinting
// Wraps the Befunge93 class into pure-function exports
// that Regrets' capture.js can import and ghost-proxy.

import Befunge93 from './befunge93.mjs'

/**
 * Run a Befunge-93 program and return its output string.
 * Pure contract: same program → same output (for deterministic programs without ?).
 * @param {string} program - Befunge source code, lines separated by \n
 * @returns {Promise<string>} The program's output
 */
export function runProgram(program) {
  const bf = new Befunge93()
  return bf.run(program)
}

/**
 * Validate a Befunge-93 program without executing it.
 * Returns an object describing whether the program loaded successfully.
 * @param {string} program - Befunge source code
 * @returns {{ valid: boolean, error: string|null }}
 */
export function validateProgram(program) {
  const bf = new Befunge93()
  try {
    bf.loadProgram(program)
    return { valid: true, error: null }
  } catch (e) {
    return { valid: false, error: e.message }
  }
}

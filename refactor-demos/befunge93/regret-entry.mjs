// regret-entry.mjs — ESM wrapper for Befunge93 regression testing
// Exposes behavioral contracts as standalone exported functions
// that can be fingerprinted by Regrets' capture/validate scripts.

import { createRequire } from 'module'
const require = createRequire(import.meta.url)
const Befunge93 = require('./lib/befunge93.js')

/**
 * Run a Befunge-93 program and return its output string.
 * Pure function: creates a fresh instance each time.
 * @param {string} program - Befunge-93 source code (lines separated by \n)
 * @returns {Promise<string>} The output produced by the program
 */
export async function runProgram(program) {
  const instance = new Befunge93()
  return instance.run(program)
}

/**
 * Run a Befunge-93 program that requires integer input.
 * Provides fixed inputs from the inputs array in order.
 * @param {object} params - { program: string, inputs: number[] }
 * @returns {Promise<string>} The output produced by the program
 */
export async function runProgramWithInput(params) {
  const { program, inputs: inputValues } = params
  let inputIndex = 0
  const instance = new Befunge93(
    null, // onStackChange
    null, // onOutput
    null, // onCellChange
    null, // onStep
    (msg) => { return inputValues[inputIndex++].toString() } // onInput - returns fixed values
  )
  return instance.run(program)
}

/**
 * Run a Befunge-93 program and return the output plus final stack state.
 * Useful for verifying internal state consistency.
 * @param {string} program - Befunge-93 source code
 * @returns {Promise<{output: string, stack: number[]}>}
 */
export async function runProgramCaptureState(program) {
  let capturedStack = []
  const instance = new Befunge93(
    (stack) => { capturedStack = [...stack] }, // onStackChange - capture final stack
    null, null, null, null
  )
  const output = await instance.run(program)
  return { output, stack: capturedStack }
}

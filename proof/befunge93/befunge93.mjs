// befunge93.mjs — Befunge-93 interpreter (ESM refactor)
// A 2D esoteric programming language where the instruction pointer
// moves on an 80×25 grid and code can modify itself at runtime.
//
// This is a refactored version of the original befunge93.js:
// - ES module instead of CommonJS
// - Extracted grid utilities into grid.mjs
// - Options object instead of positional constructor params
// - Named constants instead of magic numbers
// - Simplified control flow

import { GRID_WIDTH, GRID_HEIGHT, EMPTY_CELL, createEmptyGrid, loadProgramIntoGrid, wrapPosition, isInBounds } from './grid.mjs'

/**
 * Check if a single character is a valid hex digit (0-9, a-f).
 * Befunge-93 uses hex digits 0–9 and a–f as push instructions.
 * @param {string} ch
 * @returns {boolean}
 */
function isHexDigit(ch) {
  const parsed = parseInt(ch, 16)
  return parsed.toString(16) === ch.toLowerCase()
}

/**
 * Befunge-93 interpreter.
 *
 * Executes programs written in the Befunge-93 esoteric programming language.
 * The instruction pointer moves on an 80×25 grid and can change direction,
 * modify the program at runtime, and perform stack operations.
 */
class Befunge93 {
  /**
   * @param {object} [callbacks={}]
   * @param {function(array): void} [callbacks.onStackChange] - Called when stack is modified
   * @param {function(string): void} [callbacks.onOutput] - Called on output (. or , commands)
   * @param {function(number, number, string): void} [callbacks.onCellChange] - Called on self-modification (p command)
   * @param {function(number, number): void} [callbacks.onStep] - Called when cursor moves
   * @param {function(string): string} [callbacks.onInput] - Called when input is needed (~ or & commands)
   */
  constructor({
    onStackChange = null,
    onOutput = null,
    onCellChange = null,
    onStep = null,
    onInput = null,
  } = {}) {
    this.callbacks = { onStackChange, onOutput, onCellChange, onStep, onInput }
    this.ignoreCallbacks = false
    this._resetState()
  }

  // ─── State management ─────────────────────────────────────────────

  /** @private Reset all execution state to initial values */
  _resetState() {
    this.hasNext = false
    this.output = ''
    this.cursor = { x: 0, y: 0 }
    this.direction = { dx: 1, dy: 0 } // default: move right
    this.stack = []
    this.stringMode = false
    this.programLoaded = false
    this.grid = createEmptyGrid()
  }

  // ─── Callback dispatchers ─────────────────────────────────────────

  /** @private */
  _emitStackChange() {
    if (!this.ignoreCallbacks && this.callbacks.onStackChange) {
      this.callbacks.onStackChange(this.stack)
    }
  }

  /** @private Accumulate output and optionally notify listener */
  _emitOutput(value) {
    this.output += value
    if (!this.ignoreCallbacks && this.callbacks.onOutput) {
      this.callbacks.onOutput(value)
    }
  }

  /** @private Request input from the user */
  _requestInput(message) {
    if (this.callbacks.onInput === null) {
      throw new Error('You must supply an onInput callback if your code needs input! Else it will never work.')
    }
    return this.callbacks.onInput(message)
  }

  /** @private */
  _emitCellChange(x, y, newValue) {
    if (!this.ignoreCallbacks && this.callbacks.onCellChange) {
      this.callbacks.onCellChange(x, y, newValue)
    }
  }

  /** @private */
  _emitStep() {
    if (!this.ignoreCallbacks && this.callbacks.onStep) {
      this.callbacks.onStep(this.cursor.x, this.cursor.y)
    }
  }

  // ─── Stack operations ─────────────────────────────────────────────

  /** @private Pop from stack; returns 0 on underflow */
  _pop() {
    const value = this.stack.pop() ?? 0
    this._emitStackChange()
    return value
  }

  /** @private Push to stack */
  _push(value) {
    this.stack.push(value)
    this._emitStackChange()
  }

  // ─── Cursor movement ──────────────────────────────────────────────

  /** @private Advance cursor and wrap around grid edges */
  _advanceCursor(doCallback = true) {
    const wrapped = wrapPosition(
      this.cursor.x + this.direction.dx,
      this.cursor.y + this.direction.dy
    )
    this.cursor.x = wrapped.x
    this.cursor.y = wrapped.y
    if (doCallback) this._emitStep()
  }

  // ─── Direction setters ────────────────────────────────────────────

  _setDirectionRight()  { this.direction = { dx:  1, dy: 0 } }
  _setDirectionLeft()   { this.direction = { dx: -1, dy: 0 } }
  _setDirectionUp()     { this.direction = { dx: 0,  dy: -1 } }
  _setDirectionDown()   { this.direction = { dx: 0,  dy:  1 } }

  /** @private Pick a random direction (the ? command) */
  _randomDirection() {
    const r = Math.random()
    if (r <= 0.25)      this._setDirectionLeft()
    else if (r <= 0.50) this._setDirectionRight()
    else if (r <= 0.75) this._setDirectionUp()
    else                this._setDirectionDown()
  }

  // ─── Arithmetic operations ────────────────────────────────────────

  _add()        { const b = this._pop(), a = this._pop(); this._push(a + b) }
  _subtract()   { const b = this._pop(), a = this._pop(); this._push(a - b) }
  _multiply()   { const b = this._pop(), a = this._pop(); this._push(a * b) }

  _divide() {
    const b = this._pop(), a = this._pop()
    this._push(b !== 0 ? Math.trunc(a / b) : 0)
  }

  _modulo() {
    const b = this._pop(), a = this._pop()
    this._push(b !== 0 ? a % b : 0)
  }

  _not() {
    this._push(this._pop() ? 0 : 1)
  }

  _greaterThan() {
    const b = this._pop(), a = this._pop()
    this._push(a > b ? 1 : 0)
  }

  // ─── Stack manipulation ───────────────────────────────────────────

  _duplicate() {
    const a = this._pop()
    this._push(a)
    this._push(a)
  }

  _swap() {
    const b = this._pop(), a = this._pop()
    this._push(b)
    this._push(a)
  }

  _discard() {
    this._pop()
  }

  // ─── I/O ──────────────────────────────────────────────────────────

  _outInt() {
    this._emitOutput(this._pop().toString() + ' ')
  }

  _outAscii() {
    this._emitOutput(String.fromCharCode(this._pop()))
  }

  _inInt() {
    this._push(parseInt(this._requestInput('Enter integer: ')))
  }

  _inAscii() {
    this._push(parseInt(this._requestInput('Enter ASCII character: ').charCodeAt(0)))
  }

  // ─── Self-modification ────────────────────────────────────────────

  _put() {
    const y = this._pop()
    const x = this._pop()
    const v = String.fromCharCode(this._pop() % 256)
    if (isInBounds(x, y)) {
      this.grid[y][x] = v
      this._emitCellChange(x, y, v)
    }
  }

  _get() {
    const y = this._pop()
    const x = this._pop()
    if (isInBounds(x, y)) {
      this._push(this.grid[y][x].charCodeAt(0))
    } else {
      this._push(0)
    }
  }

  // ─── Control flow ─────────────────────────────────────────────────

  _horizontalIf() { this._pop() ? this._setDirectionLeft() : this._setDirectionRight() }
  _verticalIf()   { this._pop() ? this._setDirectionUp()   : this._setDirectionDown() }

  _toggleStringMode() { this.stringMode = !this.stringMode }

  _bridge() { this._advanceCursor() }

  _terminate() { this.hasNext = false }

  // ─── Token dispatch ───────────────────────────────────────────────

  /** @private Dispatch a single token */
  _parseToken(token) {
    if (this.stringMode) {
      const charCode = token.charCodeAt(0)
      if (charCode === 34) { // double-quote "
        this._toggleStringMode()
      } else if (charCode <= 255) {
        this._push(charCode)
      }
      return
    }

    // Hex digit push (0-9, a-f)
    if (isHexDigit(token)) {
      this._push(parseInt(token, 16))
      return
    }

    // Command dispatch table
    const commands = {
      '>': () => this._setDirectionRight(),
      '<': () => this._setDirectionLeft(),
      '^': () => this._setDirectionUp(),
      'v': () => this._setDirectionDown(),
      '?': () => this._randomDirection(),
      '+': () => this._add(),
      '-': () => this._subtract(),
      '*': () => this._multiply(),
      '/': () => this._divide(),
      '%': () => this._modulo(),
      '`': () => this._greaterThan(),
      '!': () => this._not(),
      '_': () => this._horizontalIf(),
      '|': () => this._verticalIf(),
      ':': () => this._duplicate(),
      '\\': () => this._swap(),
      '$': () => this._discard(),
      '.': () => this._outInt(),
      ',': () => this._outAscii(),
      '#': () => this._bridge(),
      'g': () => this._get(),
      'p': () => this._put(),
      '&': () => this._inInt(),
      '~': () => this._inAscii(),
      '"': () => this._toggleStringMode(),
      '@': () => this._terminate(),
    }

    const handler = commands[token]
    if (handler) handler()
  }

  // ─── Public API ───────────────────────────────────────────────────

  /**
   * Load a program into the interpreter grid.
   * @param {string} source - Befunge source code, lines separated by \n
   * @returns {boolean} true if loaded successfully
   * @throws {Error} If program exceeds grid dimensions
   */
  loadProgram(source) {
    this.grid = loadProgramIntoGrid(source)
    this.programLoaded = true
    this.hasNext = true
    return true
  }

  /** @private Execute a single step of the interpreter */
  stepInto() {
    const token = this.grid[this.cursor.y][this.cursor.x]

    if (this.stringMode) {
      this._parseToken(token)
      this._advanceCursor()
    } else {
      if (token !== EMPTY_CELL) {
        this._parseToken(token)
      }
      this._advanceCursor()
      // Skip consecutive whitespace cells
      if (this.grid[this.cursor.y][this.cursor.x] === EMPTY_CELL) {
        this.stepInto()
      }
    }
  }

  /** Stop program execution */
  pause() { this.hasNext = false }

  /** Resume program execution */
  resume() { this.hasNext = true }

  /**
   * Run a Befunge-93 program to completion.
   * @param {string} program - Source code to execute
   * @param {boolean} [reset=false] - Reset state before running
   * @param {function} [onTick] - Called every tick (for benchmarking)
   * @returns {Promise<string>} The program's output
   */
  run(program, reset = false, onTick = null) {
    return new Promise((resolve) => {
      if (reset) this.reset()
      this.grid = loadProgramIntoGrid(program)
      this.hasNext = true
      this.programLoaded = true

      while (this.hasNext) {
        if (onTick) onTick()
        this.stepInto()
      }
      resolve(this.output)
    })
  }

  /** Reset the interpreter to its initial state */
  reset() {
    this._resetState()
    this._setDirectionRight()
  }
}

export default Befunge93
export { Befunge93 }

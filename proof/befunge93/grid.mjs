// grid.mjs — Pure grid utilities for the Befunge-93 interpreter
// Befunge-93 uses an 80×25 character grid per the language specification.

/** Grid dimensions per Befunge-93 spec */
export const GRID_WIDTH = 80
export const GRID_HEIGHT = 25
export const EMPTY_CELL = ' '

/**
 * Create a new empty 80×25 grid filled with spaces.
 * @returns {string[][]}
 */
export function createEmptyGrid() {
  return Array.from({ length: GRID_HEIGHT }, () =>
    new Array(GRID_WIDTH).fill(EMPTY_CELL)
  )
}

/**
 * Load a program string into a grid.
 * Lines are split by any newline convention (\r\n, \r, or \n).
 * Throws if the program exceeds grid dimensions.
 *
 * @param {string} source - Befunge source code
 * @param {string[][]} [grid] - Target grid (creates a new one if omitted)
 * @returns {string[][]} The grid with the program loaded
 * @throws {Error} If program exceeds 80 chars/line or 25 lines
 */
export function loadProgramIntoGrid(source, grid = createEmptyGrid()) {
  const lines = source.split(/\r\n|\r|\n/)
  if (lines.length > GRID_HEIGHT) {
    throw new Error('Program height exceeds 25 lines')
  }
  for (let y = 0; y < lines.length; y++) {
    if (lines[y].length > GRID_WIDTH) {
      throw new Error('Program width exceeds 80 characters')
    }
    for (let x = 0; x < lines[y].length; x++) {
      grid[y][x] = lines[y][x]
    }
  }
  return grid
}

/**
 * Wrap a coordinate value around the grid boundaries.
 * @param {number} x
 * @param {number} y
 * @returns {{ x: number, y: number }}
 */
export function wrapPosition(x, y) {
  return {
    x: ((x % GRID_WIDTH) + GRID_WIDTH) % GRID_WIDTH,
    y: ((y % GRID_HEIGHT) + GRID_HEIGHT) % GRID_HEIGHT,
  }
}

/**
 * Check if a position is within grid bounds.
 * @param {number} x
 * @param {number} y
 * @returns {boolean}
 */
export function isInBounds(x, y) {
  return x >= 0 && x < GRID_WIDTH && y >= 0 && y < GRID_HEIGHT
}

/**
 * Befunge-93 Esoteric Language Interpreter
 * 
 * Interprets Befunge-93 programs — a 2D, self-modifying esoteric
 * programming language where code execution moves in cardinal
 * directions on an 80×25 grid.
 * 
 * @class
 */

// ─── Grid Constants ────────────────────────────────────────────────────────────
const GRID_WIDTH = 80;
const GRID_HEIGHT = 25;
const MAX_CHAR_CODE = 255;
const QUOTE_CHAR_CODE = 34; // Char code for "

// ─── Blank Grid Factory ────────────────────────────────────────────────────────
function createBlankGrid() {
    return Array.from({ length: GRID_HEIGHT }, () => new Array(GRID_WIDTH).fill(" "));
}

// ─── Token Dispatch Table ──────────────────────────────────────────────────────
// Maps each non-hex token to its handler method name.
// Extracted from the original switch statement for maintainability.
const TOKEN_DISPATCH = {
    '>': 'right',
    '<': 'left',
    '^': 'up',
    'v': 'down',
    '?': 'randomDirection',
    '+': 'add',
    '-': 'subtract',
    '*': 'multiply',
    '/': 'divide',
    '%': 'modulo',
    '`': 'greaterThan',
    '!': 'not',
    '_': 'horizontalIf',
    '|': 'verticalIf',
    ':': 'duplicate',
    '\\': 'swap',
    '$': 'discard',
    '.': 'outInt',
    ',': 'outAscii',
    '#': 'bridge',
    'g': 'get',
    'p': 'put',
    '&': 'inInt',
    '~': 'inAscii',
    '"': 'toggleStringMode',
    '@': 'terminateProgram',
};

class Befunge93 {

    /**
     * @constructor
     * @param {Befunge93~onStackChange} [onStackChange] - Called when the stack is updated (pushed or popped). Supplies
     *     1 arg, current stack
     * @param {Befunge93~onOutput} [onOutput] - Called when output happens (, or . commands). Supplies 1 arg, the
     *     generated output
     * @param {Befunge93~onCellChange} [onCellChange] - Called when program is changed (p command) Supplies 3 args,
     *     current x, current y, and the new value of the cell
     * @param {Befunge93~onStep} [onStep] - Called when the interpreter makes a step (changing program cursor).
     *     Supplies 2 args the current X and Y values
     * @param {Befunge93~onInput} [onInput] - Called when the interpreter needs user input. Supplies 1 arg, prompt
     *     message
     */
    constructor(onStackChange = null, onOutput = null, onCellChange = null, onStep = null, onInput = null) {
        this.onStackChange = onStackChange;
        this.onOutput = onOutput;
        this.onCellChange = onCellChange;
        this.onStep = onStep;
        this.onInput = onInput;
        this.hasNext = false;
        this.ignoreCallbacks = false;
        this.output = "";
        this.x = 0;
        this.y = 0;
        this.dX = 1;
        this.dY = 0;
        this.stack = [];
        this.stringMode = false;
        this.programLoaded = false;
        this.program = createBlankGrid();
    }

    /**
     * Called when the stack is changed
     * @callback Befunge93~onStackChange
     * @param {array} stack - The current stack
     * */

    /**
     * Called when the interpreter parses "." or ","
     * @callback Befunge93~onOutput
     * @param {string} value - The value that was output from interpreter
     */

    /**
     * @callback Befunge93~onCellChange
     * @param {number} x - The changed cell's x position
     * @param {number} y - The changed cell's y position
     * @param {string} newValue - The changed cell's new value
     */

    /**
     * Called when the interpreter's cursor position is changed
     * @callback Befunge93~onStep
     * @param {number} x - Cursor's current X position
     * @param {number} y - Cursor's current y position
     */

    /**
     * Called when the interpreter parses "~" or "&".
     * @callback Befunge93~onInput
     * @param {string} message - The message that will be displayed to the user; can be replaced by whatever you want
     * @returns {string} Input from the user.
     */

    /**
     * Called every tick of the interpreter. Only useful for benchmarking
     * @callback Befunge93~onTick
     */

    /** @private
     *  @static */
    static isHexDigit(value) {
        const parsed = parseInt(value, 16);
        return (parsed.toString(16) === value.toLowerCase());
    }

    /** @private */
    _onStackChange() {
        if (this.ignoreCallbacks) return null;
        return this.onStackChange ? this.onStackChange(this.stack) : null;
    }

    /** @private */
    _onOutput(value) {
        this.output += value;
        if (this.ignoreCallbacks) return null;
        return this.onOutput ? this.onOutput(value) : null;
    }

    /** @private */
    _onInput(message) {
        if (this.onInput === null) {
            throw new Error("You must supply an On Input callback if your code needs input! Else it will never work.");
        }
        return this.onInput(message);
    }

    /** @private */
    _onCellChange(x, y, newValue) {
        if (this.ignoreCallbacks) return null;
        this.onCellChange ? this.onCellChange(x, y, newValue) : null;
    }

    /** @private */
    _onStep() {
        if (this.ignoreCallbacks) return null;
        this.onStep ? this.onStep(this.x, this.y) : null;
    }

    /** @private */
    pop() {
        const v = this.stack.pop();
        this._onStackChange();
        return v === undefined ? 0 : v;
    }

    /** @private */
    push(value) {
        this.stack.push(value);
        this._onStackChange();
    }

    /** @private */
    step(doCallback = true) {
        this.x += this.dX;
        this.y += this.dY;
        if (this.x >= GRID_WIDTH) this.x = 0;
        if (this.x < 0) this.x = GRID_WIDTH - 1;
        if (this.y >= GRID_HEIGHT) this.y = 0;
        if (this.y < 0) this.y = GRID_HEIGHT - 1;
        if (doCallback) {
            this._onStep();
        }
    }

    /**
     * Parse a single token and execute the corresponding instruction.
     * Uses a dispatch table (TOKEN_DISPATCH) instead of a switch statement
     * for better maintainability and extensibility.
     * @private
     */
    parseToken(token) {
        if (this.stringMode) {
            const charCode = token.charCodeAt(0);
            if (charCode === QUOTE_CHAR_CODE) {
                this.toggleStringMode();
            } else if (charCode <= MAX_CHAR_CODE) {
                this.push(charCode);
            }
        } else {
            if (Befunge93.isHexDigit(token)) {
                this.pushHexValueToStack(token);
            } else if (token === " ") {
                return null;
            } else {
                const handler = TOKEN_DISPATCH[token];
                if (handler) {
                    this[handler]();
                }
            }
        }
    }

    /** @private */
    pushHexValueToStack(token) {
        this.push(parseInt(token, 16));
    }

    /** @private */
    add() {
        const b = this.pop();
        const a = this.pop();
        this.push(a + b);
    }

    /** @private */
    subtract() {
        const b = this.pop();
        const a = this.pop();
        this.push(a - b);
    }

    /** @private */
    multiply() {
        const b = this.pop();
        const a = this.pop();
        this.push(a * b);
    }

    /** @private */
    divide() {
        const b = this.pop();
        const a = this.pop();
        this.push(b !== 0 ? Math.trunc(a / b) : 0);
    }

    /** @private */
    modulo() {
        const b = this.pop();
        const a = this.pop();
        this.push(b !== 0 ? a % b : 0);
    }

    /** @private */
    not() {
        this.push(this.pop() ? 0 : 1);
    }

    /** @private */
    greaterThan() {
        const b = this.pop();
        const a = this.pop();
        this.push(a > b ? 1 : 0);
    }

    /** @private */
    right() {
        this.dY = 0;
        this.dX = 1;
    }

    /** @private */
    left() {
        this.dY = 0;
        this.dX = -1;
    }

    /** @private */
    up() {
        this.dY = -1;
        this.dX = 0;
    }

    /** @private */
    down() {
        this.dY = 1;
        this.dX = 0;
    }

    /** @private */
    randomDirection() {
        const r = Math.random();
        if (r <= 0.25) {
            this.left();
        } else if (r <= 0.50) {
            this.right();
        } else if (r <= 0.75) {
            this.up();
        } else {
            this.down();
        }
    }

    /** @private */
    horizontalIf() {
        this.pop() ? this.left() : this.right();
    }

    /** @private */
    verticalIf() {
        this.pop() ? this.up() : this.down();
    }

    /** @private */
    toggleStringMode() {
        this.stringMode = !this.stringMode;
    }

    /** @private */
    duplicate() {
        const a = this.pop();
        this.push(a);
        this.push(a);
    }

    /** @private */
    swap() {
        const b = this.pop();
        const a = this.pop();
        this.push(b);
        this.push(a);
    }

    /** @private */
    discard() {
        this.pop();
    }

    /** @private */
    put() {
        const y = this.pop();
        const x = this.pop();
        const v = String.fromCharCode(this.pop() % (MAX_CHAR_CODE + 1));
        if ((0 <= x && x < GRID_WIDTH) && (0 <= y && y < GRID_HEIGHT)) {
            this.program[y][x] = v;
            this._onCellChange(x, y, v);
        }
    }

    /** @private */
    get() {
        const y = this.pop();
        const x = this.pop();
        if ((0 <= x && x < GRID_WIDTH) && (0 <= y && y < GRID_HEIGHT)) {
            this.push(this.program[y][x].charCodeAt(0));
        } else {
            this.push(0);
        }
    }

    /** @private */
    bridge() {
        this.step();
    }

    /** @private */
    outInt() {
        return this._onOutput(this.pop().toString() + " ");
    }

    /** @private */
    outAscii() {
        return this._onOutput(String.fromCharCode(this.pop()));
    }

    /** @private */
    inInt() {
        this.push(parseInt(this._onInput("Enter integer: ")));
    }

    /**
     * Converts user entry to char code and pushes to stack. If more than one character entered, only the first is used
     * @private */
    inAscii() {
        this.push(parseInt(this._onInput("Enter ASCII character: ").charCodeAt(0)));
    }

    /** @private */
    terminateProgram() {
        this.hasNext = false;
    }

    loadProgram(data) {
        const lines = data.split(/\r\n|\r|\n/);
        if (lines.length > GRID_HEIGHT) {
            throw new Error('Program height exceeds ' + GRID_HEIGHT + ' lines');
        }
        for (let y = 0; y < lines.length; y++) {
            if (lines[y].length > GRID_WIDTH) {
                throw new Error('Program width exceeds ' + GRID_WIDTH + ' characters');
            }
            for (let x = 0; x < lines[y].length; x++) {
                this.program[y][x] = lines[y][x];
            }
        }
        this.programLoaded = true;
        this.hasNext = true;
        return true;
    }

    /** @private */
    getToken(x, y) {
        return this.program[y][x];
    }

    /** @private */
    init(program) {
        if (this.loadProgram(program)) {
            this.hasNext = true;
            this.programLoaded = true;
        }
    }

    /**
     * Execute a single step of the interpreter.
     * 
     * Refactored from recursive to iterative to prevent stack overflow
     * on programs with long sequences of whitespace. The original
     * implementation called stepInto() recursively when landing on a
     * space, which could exceed the call stack for programs with many
     * consecutive spaces.
     * 
     * @public
     */
    stepInto() {
        // Iterative loop replaces the original recursive approach.
        // After executing a token and stepping, if we land on a space,
        // we continue stepping instead of recursing.
        while (true) {
            const token = this.getToken(this.x, this.y);
            
            if (this.stringMode) {
                this.parseToken(token);
                this.step();
            } else {
                if (token !== " ") {
                    this.parseToken(token);
                }
                this.step();
                
                // If we landed on a space, keep stepping (was recursive before)
                if (this.getToken(this.x, this.y) !== " ") {
                    return;
                }
                // Otherwise continue the loop (step over the space)
            }
        }
    }

    /**
     * Stops executing of the program
     * @public */
    pause() {
        this.hasNext = false;
    }

    /**
     *  Allows execution of the program to continue. Does NOT actually proceed with execution
     * @public */
    resume() {
        this.hasNext = true;
    }

    /**
     *
     * @param {string} program - The program to be run. Lines separated with \n, \r, or \n\r
     * @param {boolean} [reset] - Reset interpreter to default before running?
     * @param {function} [onTick] - Called every tick. Useful for benchmarking programs
     * */
    run(program, reset = false, onTick = null) {
        return new Promise((resolve, reject) => {
            if (reset) {
                this.reset();
            }
            this.init(program);
            while (this.hasNext) {
                if (onTick) {
                    onTick();
                }
                this.stepInto();
            }
            resolve(this.output);
        });
    }

    /**
     * Resets the interpreter to default state
     * @public */
    reset() {
        this.program = createBlankGrid();
        this.stack = [];
        this.output = '';
        this.x = 0;
        this.y = 0;
        this.right();
        this.stringMode = false;
    }
}

try {
    module.exports = Befunge93;
} catch (Error) {

}

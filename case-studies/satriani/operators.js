/**
 * operators.js — Rockstar binary operation logic
 * Extracted from environment.js for clarity and testability.
 *
 * Handles the four basic arithmetic operations in Rockstar:
 * addition (+), subtraction (-), multiplication (*), division (/)
 */

function binary(b, evaluate, env) {
    let l = evaluate(b.left, env);
    let r = evaluate(b.right, env);
    switch (b.op) {
        case '+':
            return l + r;
        case '-':
            return l - r;
        case '/':
            return l / r;
        case '*':
            return l * r;
    }
}

module.exports = { binary };

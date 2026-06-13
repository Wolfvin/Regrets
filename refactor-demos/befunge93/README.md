# Befunge-93 Refactor — Proven Safe by Regrets Regression Testing

This directory contains the refactored Befunge-93 interpreter code and all verification artifacts from a real-world test of the Regrets regression testing skill.

## Target Repository

**[amicloud/befunge93](https://github.com/amicloud/befunge93)** — A Befunge-93 esoteric language interpreter. Selected as the test case because it's one of the most unlikely candidates for regression testing: an interpreter for a 2D, self-modifying esoteric programming language where code execution moves in cardinal directions on a grid.

## What Was Refactored

The single-file `Befunge93` class (565 lines) was restructured with the following changes:

### 1. Named Constants Replace Magic Numbers
- `GRID_WIDTH = 80` replaces hardcoded `80`
- `GRID_HEIGHT = 25` replaces hardcoded `25`
- `MAX_CHAR_CODE = 255` replaces hardcoded `256`/`255`
- `QUOTE_CHAR_CODE = 34` replaces hardcoded `34`

### 2. Dispatch Table Replaces Switch Statement
- `TOKEN_DISPATCH` lookup table maps tokens to handler method names
- More maintainable and extensible than a 30-case switch
- Easier to add new instructions or debug specific token handling

### 3. Iterative stepInto() Replaces Recursive
- The original `stepInto()` called itself recursively when landing on spaces
- Long whitespace sequences could cause stack overflow
- Refactored to a `while(true)` loop with early return

### 4. Extracted Factory Function
- `createBlankGrid()` extracted from constructor and `reset()`
- Eliminates duplicated grid initialization logic

### 5. Simplified Conditional Logic
- `if/else` blocks simplified to ternary expressions where clearer
- `divide()` and `modulo()` use single-line conditionals
- `not()`, `greaterThan()`, `horizontalIf()`, `verticalIf()` simplified

## Verification Results

All 3 verifications passed, proving the refactor is behavior-preserving:

### VERIFICATION 1 — Regrets Clusters (All GREEN)
| Cluster | Fingerprint | Status |
|---------|-------------|--------|
| arithmetic-ops | 1gbi171 | ✅ PASS |
| stack-ops | 441nn99 | ✅ PASS |
| direction-and-conditional | 4buy70s | ✅ PASS |
| self-modify | 2cpjb9w | ✅ PASS |
| string-mode | 1r2rwct | ✅ PASS |
| integer-input | tuuy7vr | ✅ PASS |
| state-capture | 45ohksw | ✅ PASS |

### VERIFICATION 2 — Direct Output vs KEBENARAN 1
All 24 outputs across 7 clusters match the pre-refactor ground truth exactly.

### VERIFICATION 3 — Fingerprint Cross-Check vs KEBENARAN 2
All 7 fingerprints match the pre-refactor fingerprint contracts.

### Additional Verification
- Existing test suite: 116 passing, 0 failing
- Drift detection: 5-run and 10-run stability checks all PASS+STABLE

## Files

| File | Description |
|------|-------------|
| `befunge93-refactored.js` | The refactored interpreter (replacement for `lib/befunge93.js`) |
| `regret-entry.mjs` | ESM wrapper exposing behavioral contracts for Regrets |
| `manifest.json` | Regrets cluster definitions (7 clusters, 24 test inputs) |
| `KEBENARAN_1_raw_output.json` | Pre-refactor raw output (ground truth) |
| `KEBENARAN_2_fingerprints.json` | Pre-refactor fingerprint contracts |

## Regrets Skill Improvement

This real-world test uncovered a bug in Regrets' drift detection: clusters with multiple inputs were falsely flagged as drifting because `new Set(hashes).size > 1` compared fingerprints across different inputs. Fixed with per-input drift tracking in `validate.js`.

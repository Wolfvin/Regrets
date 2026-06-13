# Case Study: dylanbeattie/satriani

## What is Satriani?

Satriani is the reference JavaScript interpreter for the [Rockstar programming language](https://codewithrockstar.com/) — an esoteric programming language whose syntax is inspired by the lyrics to 80s hard rock and heavy metal songs.

Example Rockstar code:
```
Tommy is a rockstar
Shout Tommy
```

This assigns the value 18 (word length of "rockstar") to the variable Tommy, then outputs it.

## Why This Test Case?

1. **Nobody would think to regression-test a joke language interpreter** — the most unlikely choice
2. **Uses CommonJS modules** — tests Regrets' compatibility with non-ESM projects
3. **Has pure functions** — parser, equality, evaluator are perfect for fingerprinting
4. **Revealed real bugs** — undefined output handling and multi-input drift detection

## Bugs Found in Regrets

### Bug 1: Undefined Output Breaks .regret File Parsing

When `new Environment()` is called without `new`, or a constructor returns `undefined`, the `.regret` file contains `OUTPUT undefined` which `JSON.parse()` cannot read back.

**Fix**: `capture.js` now writes `null` for undefined values. `validate.js` gracefully handles the literal string "undefined".

### Bug 2: Multi-Input Drift Detection False Positives

With multiple inputs per cluster, drift detection aggregated ALL hashes into a single Set, always flagging drift because different inputs naturally produce different hashes.

**Fix**: Per-input hash tracking using a Map. Only flag drift when the same input produces different hashes across runs.

## Refactor Performed

### What Changed

1. **Extracted `equality.js`** — `eq()`, `eq_number()`, `eq_boolean()` moved from environment.js
2. **Extracted `operators.js`** — `binary()` moved from environment.js
3. **Removed debug `console.log` statements** from the evaluator (5 instances)
4. **environment.js** now imports from extracted modules

### What Did NOT Change

- All function signatures preserved
- All output values identical
- No behavior changes

## Verification Results

### VERIFIKASI 1 — Regrets Fingerprint Validation
```
✅ rockstar-env-run     3egsenr   PASS
✅ rockstar-equality    28tmu3r   PASS
✅ rockstar-parse       3b4whb2   PASS
```

### VERIFIKASI 2 — Direct Output vs KEBENARAN 1

| Cluster | Input | Expected Output | Actual Output | Match |
|---------|-------|----------------|---------------|-------|
| rockstar-parse | "Tommy is a rockstar\n" | {"list":[{"assign":...}]} | {"list":[{"assign":...}]} | ✅ |
| rockstar-equality | [1,1] | true | true | ✅ |
| rockstar-equality | [0,false] | true | true | ✅ |
| rockstar-equality | [null,false] | true | true | ✅ |
| rockstar-env-run | "Tommy is 5\nShout Tommy\n" | [5] | [5] | ✅ |
| rockstar-env-run | "X is 10\nY is 3\nShout X plus Y\n" | [13] | [13] | ✅ |
| rockstar-env-run | "My world is nothing\nShout my world\n" | [null] | [null] | ✅ |

### VERIFIKASI 3 — Cross-Check Fingerprints

| Cluster | KEBENARAN 2 | Post-Refactor | Match |
|---------|-------------|---------------|-------|
| rockstar-parse | 3b4whb2 | 3b4whb2 | ✅ |
| rockstar-equality | 28tmu3r | 28tmu3r | ✅ |
| rockstar-env-run | 3egsenr | 3egsenr | ✅ |

All 3 verifications GREEN. Refactor proven safe.

## Drift Stability

5 consecutive runs with no drift detected:

```
✅ rockstar-env-run     3egsenr  × 5  PASS+STABLE
✅ rockstar-equality    28tmu3r  × 5  PASS+STABLE
✅ rockstar-parse       3b4whb2  × 5  PASS+STABLE
```

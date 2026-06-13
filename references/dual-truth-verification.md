# Dual-Truth Verification Pattern

## Overview

The Dual-Truth Verification pattern is a rigorous pre/post refactoring verification method that uses two independent sources of truth to confirm a refactoring is behavior-preserving.

## The Two Truths

### KEBENARAN 1 — Raw Actual Output

Run all entry functions **directly** (without Regrets involvement) and save the raw return values. This is the ground truth that cannot be disputed — it's what the code actually produces.

```json
{
  "cluster-id": {
    "entry": "myFunction",
    "outputs": [
      { "input": "test-input-1", "output": "actual-raw-output-1" },
      { "input": "test-input-2", "output": "actual-raw-output-2" }
    ]
  }
}
```

### KEBENARAN 2 — Regrets Fingerprint Contract

Save all `.regret` files (fingerprints + golden input/output pairs) as captured by Regrets during Phase 1. This is the behavioral contract.

```
cluster: my-cluster
fingerprint: abc1234
---
INPUT  "test-input-1"
OUTPUT "actual-raw-output-1"
HASH   abc1234
```

## Why Two Truths?

- **KEBENARAN 1** proves the code produces correct output **independently of any testing framework**
- **KEBENARAN 2** proves the Regrets fingerprint accurately captures the behavior
- If they disagree, there's a false negative — Regrets is capturing something incorrectly

## Verification Steps

### Before Refactoring

1. Capture KEBENARAN 1 (raw outputs)
2. Capture KEBENARAN 2 (Regrets fingerprints)
3. Verify they are semantically identical
4. If mismatch → STOP. Fix Regrets first.

### After Refactoring — Triple Verification

| # | Method | What it checks |
|---|--------|---------------|
| 1 | Regrets validate | All `.regret` fingerprints still match (GREEN) |
| 2 | Direct output comparison | Current raw output == KEBENARAN 1 |
| 3 | Fingerprint cross-check | Fingerprint of current output == KEBENARAN 2 fingerprint |

All 3 must pass. If any fails:
- VERIFICATION 1 fails → the refactoring changed behavior. Fix code, NOT .regret files.
- VERIFICATION 2 fails → the output genuinely changed. This is a real regression.
- VERIFICATION 3 fails → the fingerprint algorithm is inconsistent. This should never happen if KEBENARAN 1 and 2 were verified before refactoring.

## Implementation

```javascript
// Capture KEBENARAN 1
const rawOutput = myFunction(testInput)
saveJSON('kebenaran-1.json', { input: testInput, output: rawOutput })

// Capture KEBENARAN 2 (via Regrets)
// node scripts/capture.js → generates .regret files

// Verify identity
const k1 = loadJSON('kebenaran-1.json')
const k2 = parseRegret('my-cluster.regret')
assert(k1.output === JSON.parse(k2.output))  // Must be identical
```

## Case Study

This pattern was successfully applied to the [riimut](./case-study-riimut.md) project (runic alphabet translator). All 9 clusters passed all 3 verifications after a refactoring that optimized the transform function and added mapping memoization.

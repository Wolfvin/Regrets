# Test Report: pyfuck (tomasbedrich/pyfuck)

## Target Repository

**Repo:** [tomasbedrich/pyfuck](https://github.com/tomasbedrich/pyfuck)
**Description:** Interpreter and converter for Brainfuck, Brainloller, and Braincopter esoteric programming languages.
**Why chosen:** This is the least likely repository anyone would choose for regression testing. It's an esoteric language interpreter that converts programs into PNG images and vice versa. The intersection of people who know what Braincopter is AND write regression testing tools is approximately zero.

## Issues Found

### 1. Python Drift Detection False Positive (CRITICAL)

**Severity:** Critical — causes 100% false positive rate for multi-input clusters

**Description:** The Python `validate.py` drift detection was comparing fingerprints from **DIFFERENT inputs** against each other. When a cluster has multiple inputs (which is common and expected), each input naturally produces a different fingerprint. The old logic `len(set(hashes)) > 1` would always report drift for multi-input clusters.

**Example:**
- Cluster with inputs `["a", "b"]` produces fingerprints `[hash_a, hash_b, hash_a, hash_b, ...]` over 5 runs
- Old logic: "set has 2 values → DRIFT!" (false positive)
- Correct: "each input produces consistent hash across runs → STABLE"

**Discovery:** Testing against pyfuck with 7 clusters. 6 out of 7 clusters (all with multiple inputs) falsely reported drift. The only cluster that passed (`bf-eval-hello`) had a single input.

**Fix:** Port the JS `validate.js` per-input drift detection to Python:
```python
# Before (BROKEN):
is_drift = drift_mode and len(set(hashes)) > 1

# After (FIXED):
is_drift = drift_mode and any(
    len(set(input_hashes)) > 1
    for input_hashes in hashes_per_input.values()
)
```

**Verification:** After fix, all 7 clusters show PASS+STABLE with 5-run drift detection.

### 2. Python Ghost Decorator Doesn't Handle Instance Methods

**Severity:** Medium — limits Python stack to module-level functions

**Description:** The Python `create_ghost()` in `capture.py` uses `getattr(module, fn_name)` to find watch targets. This only works for module-level functions, not instance methods or class methods. For class-based Python projects (which is the common pattern in Python), you must first extract pure logic into standalone modules.

**Workaround:** Pure Logic Extraction pattern (already documented for Chrome extensions in `references/extension.md`) — extract pure functions from classes into separate `*_logic.py` modules.

**Recommendation:** Consider adding native support for class methods in the Python ghost decorator, or at minimum add a reference document for Python class-based projects (similar to `references/extension.md`).

## Test Results

### Phase 1 — Regrets on pyfuck

| Cluster | Entry | Fingerprint | Status |
|---------|-------|-------------|--------|
| bf-preprocess | preprocess | e7nmf22 | ✅ SOLID |
| bf-compile | compile_program | 1z5zsrf | ✅ SOLID |
| bf-eval-hello | eval_to_output | 3j0mtg5 | ✅ SOLID |
| bf-eval-input | eval_to_output | x0nxf38 | ✅ SOLID |
| bl-to-brainloller | to_brainloller | 10j1ws9 | ✅ SOLID |
| bc-decode-pixel | decode_pixel | 1t8rnsz | ✅ SOLID |
| bc-find-similar | find_similar | 42jpqct | ✅ SOLID |

All clusters: 7 captured, 7 validated, 7 STABLE (5-run drift detection)

### Phase 2 — KEBENARAN Verification

- KEBENARAN 1 (raw output): All outputs match directly executed results
- KEBENARAN 2 (fingerprints): All fingerprints match captured .regret files
- Cross-verification: KEBENARAN 1 and KEBENARAN 2 are semantically identical

### Phase 3 — Refactor Verification

Refactoring performed:
1. Extracted pure logic from `Brainfuck`, `Brainloller`, `Braincopter` classes into `*_logic.py` modules
2. Fixed `is` → `==` string comparisons in `brainfuck.py` (eliminates Python 3.8+ SyntaxWarnings)
3. Class shells now delegate to pure logic modules while keeping same external API

Three verifications after refactor:
- ✅ VERIFIKASI 1 — Regrets: All 7 clusters GREEN, fingerprints unchanged
- ✅ VERIFIKASI 2 — Direct Output: All outputs identical to KEBENARAN 1
- ✅ VERIFIKASI 3 — Cross: All fingerprints match KEBENARAN 2

All existing unit tests (10/10 passing) continue to pass after refactor.

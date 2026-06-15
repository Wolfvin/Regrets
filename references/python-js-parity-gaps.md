# Python/JS Parity Gap Analysis — Regrets Runner

This document tracks known parity gaps between the JavaScript (`capture.js`/`validate.js`)
and Python (`capture.py`/`validate.py`) runners. Gaps are categorized by feature and
marked as FIXED, DOCUMENTED, or OPEN.

Last updated: 2025-06-15

## Gap Table

| # | Feature | JS (capture.js/validate.js) | Python (capture.py/validate.py) | Status | Notes |
|---|---------|----------------------------|--------------------------------|--------|-------|
| 1 | `expectThrow` | Full support: `{__expectThrow: true, value: ...}`, error contract fingerprinting, ERROR_CONTRACT in .regret | **Added**: `is_expect_throw()`, `build_error_contract()`, error contract validation in validate.py | FIXED | Mirrors JS error contract format for cross-stack consistency |
| 2 | `fingerprintLevel: "calls"` | `reduceToCallCounts()` → `[{fn, count}]` pairs, fallback to 'entry' if no watches | **Added**: `reduce_to_call_counts()` in capture.py/validate.py, same algorithm | FIXED | Uses Counter sorted by fn name, matching JS `reduceToCallCounts` |
| 3 | Diff output on failure | `jsonDiff()` → structured `changed/added/removed/type_changed` entries, displayed with `--verbose` or on FAIL | **Added**: `json_diff()` function, displays top 10 diffs on FAIL | FIXED | Algorithm matches JS `jsonDiff()` recursive logic |
| 4 | `confidence` scoring | `computeConfidence()` from confidence.js — LOW/MEDIUM/HIGH labels based on input count, age, drift history | Not implemented | OPEN | Requires porting confidence.js → confidence.py; tracked as issue |
| 5 | `isolateGlobals` in classMethod/singletonMethod | Applies only in function-entry path | Same limitation in Python | DOCUMENTED | Both runners limit isolateGlobals to function-entry; not a gap but a design choice |
| 6 | `inputTransform` in classMethod | Not applied in classMethod path in JS | Not applied in classMethod path in Python | DOCUMENTED | Consistent limitation across both stacks |
| 7 | `resetState` function | Calls module-level reset function before each input run | Not implemented | OPEN | Requires adding reset_state support in Python runner |
| 8 | `deepCloneInput` toggle | `cluster.deepCloneInput` (default true) — skips clone for perf | Not implemented (always deep-clones) | DOCUMENTED | Python always deep-clones; less of a gap, more of a safe default |
| 9 | `storeDispatch` in validate | Full Redux/Zustand/DispatchingStore support | Full support added previously | N/A | Already at parity |
| 10 | `--reporter junit` | Generates JUnit XML to `regrets/results.xml` | Not implemented | OPEN | Requires XML generation; tracked as issue |
| 11 | `sideEffectWatches` | Proxy wrapping of `object.method` paths with call recording | Not implemented (only `watches` via ghost proxy) | OPEN | Requires adding sideEffectWatches proxy logic to Python ghost |
| 12 | Cross-stack chain `kwargs` | `_chain_step.py` now passes `kwargs` to Python subprocess | **Added**: kwargs support in `_chain_step.py` | FIXED | Ensures fingerprint consistency for cross-stack chains |
| 13 | Cross-stack chain `outputTransform` | `_chain_step.py` now passes `outputTransform` to Python subprocess | **Added**: outputTransform support in `_chain_step.py` | FIXED | Ensures fingerprint consistency for cross-stack chains |

## Summary

- **FIXED**: 5 gaps (#1, #2, #3, #12, #13)
- **DOCUMENTED** (design choice): 3 gaps (#5, #6, #8)
- **OPEN** (future work): 4 gaps (#4, #7, #10, #11)

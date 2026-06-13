# Regrets Real-World Proof: checkdigit (harens/checkdigit)

## Target Repo

**Repo:** https://github.com/harens/checkdigit
**Why chosen:** A pure Python library for check digit validation (Luhn, ISBN, Verhoeff, GS1, CRC, Parity). Nobody would think to regression-test obscure numerical validation algorithms. The Verhoeff algorithm uses Cayley dihedral group tables — deeply niche math. All functions are pure (no I/O, no network, no side effects). ~865 lines across 7 modules.

---

## Phase 1 — Make Regrets Trustworthy

### Setup
- Created `regrets/manifest.json` with 13 clusters across 6 modules
- Each cluster has 2-4 inputs covering happy path + edge cases

### Bug Found: Multi-Input Drift Detection False Positive

**All 13 clusters were falsely flagged as having drift.**

**Root Cause:** When a cluster has multiple inputs, `validate.js` and `validate.py` collect fingerprints from ALL inputs across all runs into a single `hashes` array. Different inputs naturally produce different outputs and thus different fingerprints. The drift detection check (`new Set(hashes).size > 1`) sees different hashes and incorrectly reports drift — even though the function is completely deterministic.

**Fix:** Added `goldenHashes` / `golden_hashes` array that only tracks fingerprints from the golden (first) input across all runs. Drift detection now uses this array instead of the full hashes array.

### After Fix
```
✅ luhn-calculate        51gm84l  × 5  PASS+STABLE
✅ isbn-calculate        3r1uv28  × 5  PASS+STABLE
✅ verhoeff-calculate    2975zr4  × 5  PASS+STABLE
... (all 13 clusters PASS+STABLE)
```

---

## Phase 2 — Save 2 Truths

### KEBENARAN 1 — Raw Actual Output
See `KEBENARAN_1_raw_output.json` for the complete ground truth.

### KEBENARAN 2 — Regrets Fingerprints
See `KEBENARAN_2_fingerprints.json` for all stored contracts.

### Verification: Both truths are semantically identical
Re-computing fingerprints from raw output produces identical hashes to stored contracts.

---

## Phase 3 — Refactor as Proof

### Refactoring Changes

| Module | Change |
|--------|--------|
| `luhn.py` | Extract `_double_and_sum()` helper; simplify `calculate()` with clearer digit processing |
| `gs1.py` | Replace `math.ceil` + tuple multiplication with `itertools.cycle` for weight generation |
| `isbn.py` | Extract `_calculate_isbn10()` and `_calculate_isbn13()` helpers from monolithic `calculate()` |
| `verhoeff.py` | Extract `_dihedral_multiply()` and `_permute()` helpers from monolithic `calculate()` |
| `crc.py` | Extract `_xor_divide()` helper for core CRC division algorithm |
| `parity.py` | Extract `_parity_bit()` helper for cleaner parity calculation |

### 3 Verifications — All GREEN

**VERIFICATION 1 — Regrets:**
```
✅ All 13 clusters GREEN, PASS+STABLE (5 runs drift detection)
```

**VERIFICATION 2 — Raw Output vs KEBENARAN 1:**
```
✅ All 13 clusters IDENTICAL — refactored code produces exactly the same results
```

**VERIFICATION 3 — Fingerprint Cross-Match vs KEBENARAN 2:**
```
✅ All 13 fingerprints MATCH — computed from output matches stored contracts
```

### Conclusion

The refactored code is **provably safe**. Despite significant internal restructuring (6 files, 164 insertions, 53 deletions), every function produces identical output for every input tested. The Regrets fingerprint contract held.

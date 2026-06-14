# Case Study: mhostetter/sdr — Software-Defined Radio in Python

**Repository**: https://github.com/mhostetter/sdr
**Description**: A Python package for software-defined radio — tools to design, analyze, build, and test digital communication systems
**Language**: Python (22,936 lines, 70+ files)
**Dependencies**: numpy, scipy, numba, matplotlib, galois

## Why sdr?

Who regression-tests software-defined radio code? Nobody. That's exactly why it's the perfect edge case. The sdr library combines pure mathematical functions (decibel conversion, Q function) with class-based DSP objects (PSK modulation, FIR filters, NCO oscillators) and returns numpy arrays — including complex128 arrays for I/Q signal samples. This stresses Regrets in ways no previous case study has.

## Challenges for Regrets

### 1. Large numpy array outputs

DSP functions return arrays with hundreds or thousands of samples. `sdr.sinusoid(1.0, freq=10, sample_rate=1000)` returns 1000 complex128 elements. Without `array_summary`, each `.regret` file would be 16KB for a single input. A manifest with 20 clusters would produce 320KB of golden files.

**Solution**: `"outputTransform": "array_summary"` — fingerprints array shape, dtype, mean, std, min, max, and head/tail elements. Compact (~200 bytes vs 16KB) yet sensitive enough to catch algorithm changes.

### 2. Complex number outputs

SDR uses I/Q (In-phase/Quadrature) samples which are complex numbers. `sdr.sinusoid()` returns `numpy.complex128` arrays. `json.dumps()` cannot serialize Python `complex` objects — it throws `TypeError`.

**Solution**: Regrets' `fingerprint.py` now handles complex numbers at three levels:
- `_numpy_to_native()` converts `numpy.complex128` → Python `complex`
- `_complex_to_json()` converts Python `complex` → JSON-serializable dict
- `normalize()` supports `floatTolerance` for complex numbers (rounds real and imag parts separately)

### 3. Floating-point precision across platforms

DSP computations produce slightly different results depending on NumPy version, BLAS implementation, and CPU architecture. A function returning `0.70710678` on one system might return `0.70710679` on another — not a regression, just floating-point noise.

**Solution**: `"normalize": ["floatTolerance:6"]` rounds floats to 6 decimal places before hashing. This eliminates false positives while still catching real regressions (a 1% error would change the 2nd decimal place).

### 4. Adapter pattern for class-based APIs

The sdr library exposes class-based APIs like `sdr.PSK(4).modulate(symbols)`. Regrets needs module-level functions. We created thin adapter functions that instantiate classes and delegate:

```python
def psk4_map_symbols(symbols):
    psk = sdr.PSK(4, phase_offset=45, pulse_shape="srrc")
    return psk.map_symbols(symbols)
```

### 5. "Watches never called" with adapter pattern

When using adapter functions, the ghost decorator wraps the adapter function itself, not the underlying `sdr.*` calls. This means the `watches` list is effectively meaningless — the ghost can only observe the adapter, not the library functions it calls.

**Impact**: `fingerprintLevel: "full"` mode is useless with the adapter pattern. Use `fingerprintLevel: "entry"` (default) instead.

## Clusters Created

| Cluster ID | Entry Function | Transform | Normalize | Fingerprint |
|---|---|---|---|---|
| db-value | db_value | — | — | 4co4vzr |
| db-power | db_power | — | — | 3ouxwzm |
| db-voltage | db_voltage | — | — | 1v2q2rf |
| linear-value | linear_value | — | — | 1z5so9v |
| linear-power | linear_power | — | — | 1z5so9v |
| ebn0-to-esn0 | ebn0_to_esn0 | — | — | 2pl0i1o |
| esn0-to-ebn0 | esn0_to_ebn0 | — | — | 3otv6fj |
| snr-to-esn0 | snr_to_esn0 | — | — | 1m8j005 |
| esn0-to-snr | esn0_to_snr | — | — | 1m8j005 |
| q-function | q_function | — | floatTolerance:6 | tdrqkuk |
| sinusoid-complex | sinusoid_complex | array_summary | floatTolerance:6 | 4wlke2l |
| sinusoid-real | sinusoid_real | array_summary | floatTolerance:6 | 1ep1sc9 |
| upsample-signal | upsample_signal | array_summary | — | 1lwtkbs |
| downsample-signal | downsample_signal | array_summary | — | 3rhmrgd |
| nco-exp | nco_exp_100_steps | array_summary | floatTolerance:6 | 1kmao7c |
| psk4-map-symbols | psk4_map_symbols | array_summary | floatTolerance:6 | 25cv2z3 |
| pack-bits | pack_bits | — | — | 4jwqpkm |
| unpack-symbols | unpack_symbols | — | — | 5folmdh |

## Chains Created

| Chain ID | Steps | Chain Hash |
|---|---|---|
| snr-conversion-roundtrip | ebn0-to-esn0 → esn0-to-snr | 4lit8qj |
| snr-inverse-roundtrip | snr-to-esn0 → esn0-to-ebn0 | 16mtwcv |
| db-linear-roundtrip | db-value → linear-value | 2wz09x5 |
| signal-pipeline | pack-bits → psk4-map-symbols | 3py95sc |

## Results

- **Capture**: 18/18 clusters captured successfully
- **Validate**: 18/18 GREEN
- **Drift Detection**: 18/18 STABLE across 5 runs
- **Health**: 18/18 SOLID
- **Chain Capture**: 4/4 chains captured
- **Chain Validate**: 4/4 chains MATCH
- **False Positives**: ZERO

## Refactoring Performed

### _conversion.py → _conversion/ package (DECOMPOSITION)

Split the 444-line `_conversion.py` into a package:
- `_conversion/_decibels.py` — `db()`, `linear()` (decibel conversions)
- `_conversion/_snr.py` — All 6 SNR conversion functions
- `_conversion/__init__.py` — Re-exports via `from ._decibels import *` + `from ._snr import *`

### _helper.py naming improvements (NAMING)

- `_argument_names()` → `_extract_caller_argument_names()` — explains what it extracts and from where
- `verify_scalar()` → `verify_and_validate_scalar()` — it both type-checks AND validates constraints
- `verify_arraylike()` → `verify_and_validate_arraylike()` — same reason
- `convert_output()` → `normalize_output_type()` — "convert" is vague; "normalize type" is precise
- `convert_to_scalar()` → `demote_numpy_scalar_to_native()` — describes exactly what it does

All renamed functions have backward-compatible aliases.

### _signal.py docstring improvements

Changed module docstring from "A module containing functions for signal manipulation" to "Signal generation and transformation functions for creating, mixing, and converting baseband/passband signals".

## 4-Way Verification Proof

### VERIFICATION 1 — Regrets Fingerprint
All 18 clusters GREEN after refactor.

### VERIFICATION 2 — Raw Output vs KEBENARAN 1
All scalar outputs IDENTICAL to pre-refactor baseline.

### VERIFICATION 3 — Fingerprint Cross-Check
All 18 fingerprints match KEBENARAN 2 exactly.

### VERIFICATION 4 — Chain Validation
All 4 chain hashes MATCH pre-refactor chain hashes.

## Key Insights

1. **`array_summary` is essential for DSP libraries.** Without it, `.regret` files would be impractically large. The summary (shape + dtype + statistics + head/tail) is compact yet catches any algorithm change.

2. **Complex number support is non-negotiable for SDR.** Every SDR function returns complex-valued I/Q samples. Without `_complex_to_json()` and `_numpy_to_native()` handling complex types, Regrets would crash on capture.

3. **The adapter pattern makes watches meaningless.** When the entry function is a thin wrapper that delegates to `sdr.*`, the ghost decorator can only observe the wrapper, not the underlying library calls. `fingerprintLevel: "entry"` is the right choice.

4. **`floatTolerance:6` is the sweet spot for DSP.** Lower values (like 2) cause false positives from platform-dependent floating-point. Higher values (like 10) would miss small but real regressions.

5. **Python-native KEBENARAN verification was missing.** The existing `verify_kebenaran.js` only works for JS clusters. A Python version was needed for scientific computing repos with numpy arrays and complex numbers.

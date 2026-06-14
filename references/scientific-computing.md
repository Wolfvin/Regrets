# Scientific Computing / DSP Library Integration

## When to Use This Pattern

This pattern applies when the target repo is a **scientific computing** or **digital signal processing (DSP)** library that:

- Returns **NumPy arrays** as primary outputs (often 100+ elements)
- Uses **complex numbers** (`complex128`, `numpy.complex128`) extensively
- Has **class-based APIs** with internal state (e.g., modulators, filters, oscillators)
- Involves **floating-point math** with inherent precision differences across platforms
- Has **pure mathematical functions** alongside **stateful signal processing objects**

Examples: `mhostetter/sdr` (software-defined radio), `scipy/signal`, audio processing libraries, radar simulation tools.

## Key Challenges

### 1. Large Array Outputs

DSP functions typically return arrays with hundreds or thousands of samples. For example, `sdr.sinusoid(1.0, freq=10, sample_rate=1000)` returns a 1000-element complex128 array. Serializing every element into the `.regret` file creates massive files and slow comparisons.

**Solution**: Use `"outputTransform": "array_summary"` in the manifest. This computes a compact summary (shape, dtype, mean, std, min, max, head/tail elements) instead of serializing every element. The summary is deterministic — if the algorithm changes, at least one statistic will change.

```json
{
  "id": "sinusoid-complex",
  "entry": "sinusoid_complex",
  "watches": ["sinusoid_complex"],
  "module": "regret_adapters",
  "stack": "python",
  "outputTransform": "array_summary",
  "normalize": ["floatTolerance"],
  "inputs": [
    {"duration": 0.1, "freq": 10, "sample_rate": 1000}
  ]
}
```

### 2. Complex Number Outputs

Many DSP functions return complex-valued arrays (e.g., I/Q samples in SDR). Python's `json.dumps()` cannot serialize `complex` objects natively.

**Solution**: Regrets' `fingerprint.py` now handles complex numbers at three levels:
- `_numpy_to_native()`: Converts `numpy.complex128` → Python `complex`
- `_complex_to_json()`: Converts Python `complex` → `{"__complex__": true, "real": ..., "imag": ...}`
- `normalize()`: Supports `floatTolerance` and `floatPrecision` for complex numbers

You don't need to do anything special — just use the manifest as normal.

### 3. Floating-Point Precision Differences

DSP computations often produce slightly different results depending on:
- NumPy version
- BLAS/LAPACK implementation
- CPU architecture (AVX vs SSE)
- Python version

A function that returns `[0.70710678, 0.70710677]` on one run might return `[0.70710678, 0.70710679]` on another. These are **not regressions** — they're floating-point noise.

**Solution**: Use `"normalize": ["floatTolerance:6"]` to round floats to 6 decimal places before hashing. This eliminates false positives from floating-point noise while still catching real regressions.

```json
{
  "normalize": ["floatTolerance:6"]
}
```

For integer-valued outputs (e.g., symbol decisions, bit arrays), no normalization is needed.

### 4. Class-Based APIs with State

DSP libraries often expose class-based APIs like:

```python
psk = sdr.PSK(4, phase_offset=45, pulse_shape="srrc")
tx_samples = psk.modulate(symbols)
rx_symbols = psk.demodulate(rx_samples)
```

These require the **adapter pattern** — thin wrapper functions that instantiate classes and call methods.

**Adapter example:**

```python
# regret_adapters.py
import sdr
import numpy as np

# For pure functions — just re-export
def db_value(x):
    return sdr.db(x, type="value")

def db_power(x):
    return sdr.db(x, type="power")

def linear_value(x):
    return sdr.linear(x, type="value")

# For class-based APIs — instantiate and call
def psk4_modulate(symbols):
    """Adapter: QPSK modulation with SRRC pulse shape."""
    psk = sdr.PSK(4, phase_offset=45, pulse_shape="srrc")
    return psk.modulate(symbols)

def psk4_demodulate(noisy_samples):
    """Adapter: QPSK demodulation."""
    psk = sdr.PSK(4, phase_offset=45, pulse_shape="srrc")
    return psk.demodulate(noisy_samples)
```

### 5. Non-Deterministic Functions

Some DSP functions involve randomness (e.g., noise generation, channel simulation). These require normalization or input fixing.

```python
# Non-deterministic: sdr.awgn(x, snr=10) adds random noise
# Solution: Don't test noise generators directly. Test deterministic processing
# that operates on noisy signals by providing fixed input arrays.
```

## Adapter Module Template

```python
# regret_adapters.py — Adapter for scientific computing / DSP libraries
import sys
import os
sys.path.insert(0, os.path.join(os.path.dirname(__file__), 'src'))

import numpy as np
import sdr

# ─── Pure function adapters ─────────────────────────────────────────────

def db_value(x):
    """Convert linear value to decibels."""
    return sdr.db(x, type="value")

def db_power(x):
    """Convert linear power to decibels."""
    return sdr.db(x, type="power")

def linear_value(x):
    """Convert decibels to linear value."""
    return sdr.linear(x, type="value")

# ─── Class-based API adapters ───────────────────────────────────────────

def nco_exp_increment(increment_str):
    """NCO with constant increment, exponential output."""
    nco = sdr.NCO(increment=float(increment_str))
    return nco.step(100)

def psk4_map_symbols(symbols):
    """Map QPSK decimal symbols to complex symbols."""
    psk = sdr.PSK(4, phase_offset=45, pulse_shape="srrc")
    return psk.map_symbols(symbols)
```

## Manifest Template

```json
{
  "clusters": [
    {
      "id": "db-value",
      "entry": "db_value",
      "watches": ["db_value"],
      "module": "regret_adapters",
      "pythonPath": ".",
      "stack": "python",
      "fingerprintLevel": "entry",
      "inputs": [50, 100, 0.001]
    },
    {
      "id": "sinusoid-complex",
      "entry": "sinusoid_complex",
      "watches": ["sinusoid_complex"],
      "module": "regret_adapters",
      "pythonPath": ".",
      "stack": "python",
      "fingerprintLevel": "entry",
      "outputTransform": "array_summary",
      "normalize": ["floatTolerance:6"],
      "inputs": [
        {"duration": 0.01, "freq": 10, "sample_rate": 1000}
      ]
    }
  ]
}
```

## outputTransform Options for DSP

| Transform | Use Case | What It Fingerprints |
|-----------|----------|---------------------|
| `"array_summary"` | Large numpy arrays (100+ elements) | Shape, dtype, mean, std, min, max, head/tail samples |
| `"len"` | Only care about output size | Array length |
| `"repr"` | Complex objects without `.to_dict()` | String representation |
| Custom `"module.fn"` | Domain-specific summary | Whatever your function returns |

## floatTolerance Recommendations by Domain

| Domain | Recommended Tolerance | Rationale |
|--------|----------------------|-----------|
| Financial (IDR amounts) | `floatTolerance:0` | Rounding to integers |
| OCR/parsing | `floatPrecision` | 1500000.0 vs 1500000 |
| DSP/signal processing | `floatTolerance:6` | Platform-dependent floating-point |
| Scientific computing | `floatTolerance:10` | Numerical methods with accumulated error |
| Pure math/encoding | No tolerance needed | Results must be exact |

## Chain Testing for DSP Pipelines

DSP systems often have multi-step processing pipelines:

```
Bits → Pack → Modulate → Pulse Shape → Channel → Filter → Demodulate → Unpack → Bits
```

Define chains in `regrets/chains.json`:

```json
{
  "chains": [
    {
      "id": "qpsk-roundtrip",
      "steps": [
        {"cluster": "pack-bits", "input": [1, 0, 1, 1, 0, 0, 1, 0]},
        {"cluster": "psk4-modulate", "input": [5, 2]},
        {"cluster": "psk4-demodulate", "input": null}
      ]
    }
  ]
}
```

Note: For chain steps where the input depends on the previous step's output (like demodulate), use `null` as input and implement the piping in a custom adapter.

## Common Pitfalls

1. **Don't fingerprint noise generators** — `sdr.awgn()` is non-deterministic. Test the deterministic functions that process noisy signals instead.

2. **Use `array_summary` for large outputs** — A 1000-element float64 array is 8KB. With `array_summary`, it's ~200 bytes.

3. **Complex numbers need `floatTolerance`** — Complex arithmetic accumulates more floating-point error than real arithmetic.

4. **Stateful objects need fresh instances** — Always create a new class instance in the adapter function, not a module-level singleton. Singleton state can leak between test runs.

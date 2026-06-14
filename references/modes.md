# Modes — Testing Behavioral Variants of a Single Function

## The Problem

Many functions have behavioral modes controlled by keyword arguments. For example:

- `french_republican.to_jd(year, month, day, method='equinox')` — the `method` kwarg completely changes the algorithm
- `holidays.christmas(year, observed=True)` — the `observed` kwarg changes the output
- `holidays.hanukkah(year, eve=True)` — the `eve` kwarg shifts the date by one day

Without modes, an agent using Regrets must create **separate clusters** for each behavioral variant. This is verbose and doesn't express the relationship: "these are all the same function, just called differently."

## The Solution: `modes` in manifest.json

Add a `modes` array to your cluster definition. Each mode has its own name, kwargs, and inputs. All modes are tested together, and a combined `modesFingerprint` ensures that every mode produces the same output after refactoring.

### Example

```json
{
  "clusters": [
    {
      "id": "french-republican-to-jd",
      "entry": "to_jd",
      "watches": ["to_jd"],
      "module": "convertdate.french_republican",
      "stack": "python",
      "fingerprintLevel": "entry",
      "inputs": [2024],
      "modes": [
        {
          "name": "equinox",
          "kwargs": {"method": "equinox"},
          "inputs": [[214, 1, 1]]
        },
        {
          "name": "romme",
          "kwargs": {"method": "romme"},
          "inputs": [[20, 1, 1]]
        },
        {
          "name": "continuous",
          "kwargs": {"method": "continuous"},
          "inputs": [[20, 1, 1]]
        },
        {
          "name": "madler",
          "kwargs": {"method": "madler"},
          "inputs": [[20, 1, 1]]
        }
      ]
    },
    {
      "id": "christmas",
      "entry": "christmas",
      "watches": ["christmas"],
      "module": "convertdate.holidays",
      "stack": "python",
      "fingerprintLevel": "entry",
      "inputs": [2024],
      "modes": [
        {
          "name": "standard",
          "inputs": [2024]
        },
        {
          "name": "observed",
          "kwargs": {"observed": true},
          "inputs": [2024]
        }
      ]
    }
  ]
}
```

## How It Works

### Capture

When `modes` is present, `regret capture`:

1. Runs the cluster's standard `inputs` first (producing the golden fingerprint)
2. Then runs each mode's inputs with the mode's kwargs
3. Computes a per-mode fingerprint for each mode
4. Computes a combined `modesFingerprint` from all mode fingerprints
5. Stores all mode data in the `.regret` file

### Validate

When `regret validate` finds mode data in a `.regret` file:

1. Validates the golden fingerprint as usual
2. Re-runs each mode with its stored kwargs and inputs
3. Compares each mode's live fingerprint against the stored one
4. Compares the combined `modesFingerprint` against the stored one
5. If any mode's fingerprint differs: `MODES MISMATCH` → cluster goes RED

### .regret File Format

Modes data is stored in both the metadata and data sections:

```
cluster: french-republican-to-jd
fingerprint: abc1234
modes: 4
modesFingerprint: xyz5678
mode: equinox=fp001
mode: romme=fp002
mode: continuous=fp003
mode: madler=fp004
---
INPUT  [214, 1, 1]
OUTPUT [2024, 9, 22]
HASH   abc1234
MODES_FINGERPRINT xyz5678
MODE equinox
  INPUT  [214, 1, 1]
  OUTPUT [2024, 9, 22]
  HASH   fp001
  KWARGS {"method": "equinox"}
MODE romme
  INPUT  [20, 1, 1]
  OUTPUT [1811, 9, 23]
  HASH   fp002
  KWARGS {"method": "romme"}
```

## When to Use Modes vs Separate Clusters

**Use modes when:**
- The function is the same, only kwargs differ (behavioral variants)
- You want one cluster to represent "all the ways this function can be called"
- A change to the function should affect ALL modes

**Use separate clusters when:**
- The functions are fundamentally different
- You want independent control over each cluster's update history
- The modes have completely different file/module sources

## Origin

This feature was born from analyzing the `convertdate` library (fitnr/convertdate),
which has 13+ calendar systems with functions that accept `method`, `eve`, and
`observed` kwargs. Without modes, covering all behavioral variants required
creating 3-4x more clusters than necessary, and the relationship between
variants of the same function was lost.

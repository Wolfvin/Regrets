# Branch Coverage & Cluster Scanning

## The Problem Regrets Didn't Solve

Regrets captures ONE execution path per input. If a function has `if/else`, early returns, exception paths, or `match` statements, only the path triggered by the given input is fingerprinted. The rest are invisible.

**Example of the danger:**

```python
def compute(value):
    if value > 0:
        return process_positive(value)
    elif value < 0:
        return process_negative(value)
    else:
        return zero_special_case()
```

With input `[5]`, only the `value > 0` branch is fingerprinted. A refactor that breaks `process_negative()` or `zero_special_case()` would pass all GREEN — because those branches were never tested.

## Solution 1: `regret scan` — Discover What to Test

Before writing a manifest, scan the source code to discover which functions are good cluster candidates:

```bash
python scripts/scan.py src/my_module.py
python scripts/scan.py src/ --recursive
python scripts/scan.py src/ --manifest > regrets/manifest.json
```

`scan` analyzes Python files using AST and reports:

| Output | Description |
|--------|-------------|
| Function name | All defined functions |
| Purity | Whether the function is pure (no IO, random, global state) |
| Branch count | Estimated number of branches (if/match/try) |
| Call graph | Which other functions this one calls (→ watch candidates) |
| Suggested cluster | Auto-generated cluster ID, entry, watches |

### Purity Heuristic

Functions are marked "pure" if they contain no:
- `global` or `nonlocal` statements
- `open()`, `print()`, `input()`, `exec()`, `eval()` calls
- `random.*()` calls
- Network calls (`urllib`, `requests`, `http`, `socket`)

Pure functions are the best cluster candidates because they produce deterministic output.

### Generating a Manifest

```bash
python scripts/scan.py src/ --recursive --manifest > regrets/manifest.json
```

This generates a ready-to-use manifest.json with only pure functions suggested as clusters. Review and adjust before running `regret capture`.

## Solution 2: `regret coverage` — Know What You're Missing

After writing a manifest and capturing fingerprints, check branch coverage:

```bash
python scripts/coverage.py
python scripts/coverage.py --cluster my-cluster
python scripts/coverage.py --detailed
```

`coverage` reads the manifest, finds the source files, and uses static analysis to estimate:

| Metric | Description |
|--------|-------------|
| Branches | Number of `if`, `match`, `try` in the entry function |
| Min paths | Minimum number of execution paths (2^n for n independent branches) |
| Inputs | Number of inputs defined in the manifest |
| Coverage | Estimated: FULL, LIKELY FULL, PARTIAL, or LOW |

### Coverage Interpretation

| Label | Meaning |
|-------|---------|
| ✅ FULL | No branches — single input covers everything |
| ✅ LIKELY FULL | Number of inputs ≥ estimated minimum paths |
| 🟡 PARTIAL | Some branches likely uncovered (50-99%) |
| 🔴 LOW | Most branches uncovered (<50%) |

### What to Do with Partial/Low Coverage

1. Read the `--detailed` output to see exactly which lines have branches
2. Add inputs that trigger the uncovered branches
3. Re-capture and re-validate
4. Re-run coverage to verify improvement

### Example

```
BRANCH COVERAGE REPORT
────────────────────────────────────────────────────────────────────────
cluster                               branches  min_paths  inputs  coverage
────────────────────────────────────────────────────────────────────────
  sexagenary-cycle-from-int                 1          2       1     🟡 PARTIAL ~50%
  four-pillars-from-datetime                5         32       1     🔴 LOW ~3%
  hexagram-from-binary                      1          2       2     ✅ LIKELY FULL
  earthly-branch-phase                      0          1       1     ✅ FULL
────────────────────────────────────────────────────────────────────────

⚠️  2/4 cluster(s) may have uncovered branches.
   These clusters could pass all GREEN but miss execution paths.
   Add more inputs to cover all branches.
```

## Integration with Regrets Workflow

The scan and coverage commands fit into the existing workflow:

```
1. regret scan src/ --manifest   → Generate initial manifest
2. Edit manifest (adjust inputs, add normalization rules)
3. regret coverage               → Check coverage before capture
4. Add inputs for uncovered branches
5. regret capture                → Capture fingerprints
6. regret drift                  → Ensure stability
7. regret coverage               → Final coverage check
8. regret health                 → All clusters SOLID?
9. [GATE] All GREEN + FULL coverage → proceed to refactor
```

## Limitations

- **Static analysis only** — coverage estimates are based on AST, not runtime tracing
- **Path explosion** — for functions with many independent branches, the minimum path count can be very high. In practice, test the most important branches, not all combinations
- **Python only** — scan and coverage currently support Python source files only. JS/TS support would require a different AST parser
- **No dynamic branch tracking** — we don't instrument code to track which branches were actually hit at runtime. This would require code coverage tools (e.g., `coverage.py`) integration

# Branch Coverage & Cluster Scanning

## The Problem Regrets Didn't Solve

Regrets captures ONE execution path per input. If a function has `if/else`, early returns, exception paths, or `match` statements, only the path triggered by the given input is fingerprinted. The rest are invisible.

**Example of the danger (JavaScript):**

```javascript
function validateAge(age) {
  if (age < 0) return "invalid: negative"    // Branch 1
  if (age === 0) return "invalid: zero"       // Branch 2
  if (age < 18) return "minor"                // Branch 3
  if (age >= 65) return "senior"              // Branch 4
  return "adult"                               // Branch 5
}
```

**Example of the danger (Python):**

```python
def compute(value):
    if value > 0:
        return process_positive(value)
    elif value < 0:
        return process_negative(value)
    else:
        return zero_special_case()
```

With input `[25]` (JS) or `[5]` (Python), only one branch is fingerprinted. A refactor that breaks the other branches would pass all GREEN — because those branches were never tested.

## Branch Coverage Report

Run `regret coverage` to see how well your inputs cover all branches:

```bash
# Auto-detects stack from manifest
node scripts/regret.js coverage
node scripts/regret.js coverage --cluster validate-age --verbose

# Direct Python invocation
python scripts/coverage.py
python scripts/coverage.py --cluster my-cluster
python scripts/coverage.py --detailed
```

Output:

```
BRANCH COVERAGE REPORT
────────────────────────────────────────────────────────────────────────────────
cluster                          inputs  branches   coverage   status
────────────────────────────────────────────────────────────────────────────────
validate-age                     1       5          20%        🔴 UNDER-COVERED
format-currency                  3       3          100%       ✅ WELL-COVERED
sanitize-input                   2       4          50%        🟡 PARTIAL
────────────────────────────────────────────────────────────────────────────────

⚠️  Coverage Recommendations:
  validate-age                   → add at least 4 more input(s) to cover branches
  sanitize-input                 → consider adding inputs for edge cases and error paths
```

## How Branch Counting Works

The coverage tool uses static analysis to count decision points:

**JS (regex-based heuristics):**

| Pattern | What it counts | Example |
|---------|---------------|---------|
| `if (cond)` | Conditional branch | `if (x > 0)` |
| `else { }` | Alternative branch | `else { return -1 }` |
| `cond ? a : b` | Ternary branch | `x ? x : default` |
| `case X:` | Switch case | `switch(type) { case "A": ... }` |
| Early `return` | Exit before end | `if (!valid) return null` |
| `catch { }` | Error path | `try { ... } catch { ... }` |
| `&&` / `||` | Short-circuit path | `a && b`, `x || default` |

**Python (AST-based):**

| Metric | Description |
|--------|-------------|
| Branches | Number of `if`, `match`, `try` in the entry function |
| Min paths | Minimum number of execution paths (2^n for n independent branches) |
| Inputs | Number of inputs defined in the manifest |
| Coverage | Estimated: FULL, LIKELY FULL, PARTIAL, or LOW |

### Coverage Interpretation

| Label | Meaning |
|-------|---------|
| ✅ FULL / WELL-COVERED (≥80%) | No branches — single input covers everything, or inputs ≥ branches |
| ✅ LIKELY FULL | Number of inputs ≥ estimated minimum paths |
| 🟡 PARTIAL (50-79%) | Some branches likely uncovered |
| 🔴 LOW / UNDER-COVERED (<50%) | Most branches uncovered — CI gate fails |

**Note:** This is an approximation. The actual number of reachable paths may differ due to:
- Unreachable code
- Mutually exclusive conditions
- Exception-based control flow

## Minimum Input Rule

For each cluster, the number of inputs should be **at least equal to** the number of branches. This doesn't guarantee full coverage (combinatorial explosion for nested branches), but it's the minimum required to exercise each path at least once.

```
inputs >= branches  →  MINIMUM requirement
inputs >= branches * 1.5  →  GOOD coverage
inputs >= branches * 2  →  THOROUGH coverage
```

The `regret coverage` command exits with code 1 if any cluster is under-covered (score < 50%), making it suitable as a CI gate.

## The Branch Map Pattern

For rigorous refactoring, create a `regrets/branch-map.md` file before writing the manifest:

```markdown
# Branch Map

## validateAge(age)
- Branch 1: age < 0 → "invalid: negative"
  - Input needed: -1
- Branch 2: age === 0 → "invalid: zero"
  - Input needed: 0
- Branch 3: age < 18 → "minor"
  - Input needed: 10
- Branch 4: age >= 65 → "senior"
  - Input needed: 70
- Branch 5: else → "adult"
  - Input needed: 25

## calculateDiscount(type, amount)
- Branch 1: type === "vip" → amount * 0.3
  - Input needed: ["vip", 100]
- Branch 2: type === "member" → amount * 0.1
  - Input needed: ["member", 100]
- Branch 3: type === "guest" → amount * 0
  - Input needed: ["guest", 100]
- Branch 4: amount > 1000 → bonus 5%
  - Input needed: ["vip", 1500]
```

This manual analysis is more thorough than automated branch counting, and forces the agent to think about what each branch does and what input exercises it.

## Scan Command — Discover What to Test

Before writing a manifest, scan the source code to discover which functions are good cluster candidates:

```bash
# Auto-detects stack from manifest
node scripts/regret.js scan
node scripts/regret.js scan --dir src/lib/
node scripts/regret.js scan --stack python
node scripts/regret.js scan --format manifest > regrets/manifest.json

# Direct Python invocation
python scripts/scan.py src/my_module.py
python scripts/scan.py src/ --recursive
python scripts/scan.py src/ --manifest > regrets/manifest.json
```

The scan command:
1. Walks the project directory
2. Identifies exported functions
3. Estimates cyclomatic complexity / purity
4. Suggests clusters prioritized by complexity
5. Can output a manifest.json starting point with `--format manifest`

### Purity Heuristic (Python)

Functions are marked "pure" if they contain no:
- `global` or `nonlocal` statements
- `open()`, `print()`, `input()`, `exec()`, `eval()` calls
- `random.*()` calls
- Network calls (`urllib`, `requests`, `http`, `socket`)

Pure functions are the best cluster candidates because they produce deterministic output.

## Integration with Regrets Workflow

The scan and coverage commands fit into the existing workflow:

```
1. regret scan src/ --manifest   → Generate initial manifest
2. Edit manifest (adjust inputs, add normalization rules)
3. regret capture                → Capture fingerprints
4. regret coverage               → Check coverage (add inputs if UNDER-COVERED)
5. regret drift                  → Ensure stability
6. regret health                 → All clusters SOLID?
7. [GATE] All GREEN + FULL coverage → proceed to refactor
```

### Relationship to Health Score

| Report | Measures | When to check |
|--------|----------|--------------|
| `regret health` | Update/drift history | After multiple refactor cycles |
| `regret coverage` | Input-to-branch ratio | Before first refactor |
| `regret drift` | Non-determinism | Before and after refactor |

A cluster that is SOLID in health but UNDER-COVERED in coverage is a **false sense of security** — it has never changed, but only because no input exercises the code that would break.

## What to Do with Partial/Low Coverage

1. Read the `--verbose` / `--detailed` output to see exactly which lines have branches
2. Add inputs that trigger the uncovered branches
3. Re-capture and re-validate
4. Re-run coverage to verify improvement

## Limitations

- **Static analysis only** — coverage estimates are based on regex heuristics (JS) or AST (Python), not runtime tracing
- **Path explosion** — for functions with many independent branches, the minimum path count can be very high. In practice, test the most important branches, not all combinations
- **No dynamic branch tracking** — we don't instrument code to track which branches were actually hit at runtime. This would require code coverage tools (e.g., `coverage.py`, Istanbul/nyc) integration

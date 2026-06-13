# Branch Coverage Analysis

## The Problem

Regrets fingerprints are based on **output** — for a given input, the fingerprint captures what the function returns. But most functions have **multiple execution paths** (branches), and each input only exercises one path.

```
function validateAge(age) {
  if (age < 0) return "invalid: negative"    // Branch 1
  if (age === 0) return "invalid: zero"       // Branch 2
  if (age < 18) return "minor"                // Branch 3
  if (age >= 65) return "senior"              // Branch 4
  return "adult"                               // Branch 5
}
```

If you create a cluster with only `inputs: [25]`, the fingerprint only protects Branch 5. A refactor that breaks Branch 1 (negative ages) or Branch 4 (senior ages) will **still show GREEN** — because the fingerprint was never tested with those inputs.

## Branch Coverage Report

Run `regret coverage` to see how well your inputs cover all branches:

```bash
node scripts/regret.js coverage
node scripts/regret.js coverage --cluster validate-age --verbose
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

The coverage tool uses static analysis (regex-based heuristics) to count decision points:

| Pattern | What it counts | Example |
|---------|---------------|---------|
| `if (cond)` | Conditional branch | `if (x > 0)` |
| `else { }` | Alternative branch | `else { return -1 }` |
| `cond ? a : b` | Ternary branch | `x ? x : default` |
| `case X:` | Switch case | `switch(type) { case "A": ... }` |
| Early `return` | Exit before end | `if (!valid) return null` |
| `catch { }` | Error path | `try { ... } catch { ... }` |
| `&&` / `||` | Short-circuit path | `a && b`, `x || default` |

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

## Integration with Workflow

Add coverage check to your pre-refactor gate:

```
[ ] 1. npm run regret:capture
[ ] 2. npm run regret:coverage  ← NEW: verify sufficient inputs
[ ] 3. If UNDER-COVERED → add inputs to manifest, re-capture
[ ] 4. npm run regret:drift
[ ] 5. npm run regret:health
```

The `regret coverage` command exits with code 1 if any cluster is under-covered (score < 50%), making it suitable as a CI gate.

## Relationship to Health Score

The health report (`regret health`) measures cluster stability over time. The coverage report measures cluster completeness at a point in time. Together:

| Report | Measures | When to check |
|--------|----------|--------------|
| `regret health` | Update/drift history | After multiple refactor cycles |
| `regret coverage` | Input-to-branch ratio | Before first refactor |
| `regret drift` | Non-determinism | Before and after refactor |

A cluster that is SOLID in health but UNDER-COVERED in coverage is a **false sense of security** — it has never changed, but only because no input exercises the code that would break.

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

## Scan Command

Use `regret scan` to discover candidate functions in a new project:

```bash
node scripts/regret.js scan
node scripts/regret.js scan --dir src/lib/
node scripts/regret.js scan --stack python
node scripts/regret.js scan --format manifest  > regrets/manifest.json
```

The scan command:
1. Walks the project directory
2. Identifies exported functions
3. Estimates cyclomatic complexity
4. Suggests clusters prioritized by complexity
5. Can output a manifest.json starting point with `--format manifest`

This is especially useful when approaching an unfamiliar codebase — it gives the agent a map of where the most complex (and therefore most refactoring-critical) functions live.

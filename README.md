# Regrets

Output-based regression testing for AI-driven refactoring — capture what code *produces*, refactor freely, validate that outputs still match.

## Quick-Start (5 min)

```bash
# 1. Install alongside your project
npm install regret-testing

# 2. Scan your project to discover clusters
node scripts/regret.js scan --dir src/ --stack js

# 3. Create regrets/manifest.json (one cluster per behavioral contract)
#    See "Manifest example" below

# 4. Capture fingerprints before refactoring
node scripts/regret.js capture

# 5. Validate after every change
node scripts/regret.js validate
```

All green? Ship it. Any red? Fix your code, not the `.regret` files.

### Manifest example

```json
{
  "clusters": [
    {
      "id": "hira2kata",
      "entry": "hira2kata",
      "watches": ["hira2kata", "_translate", "_convert"],
      "module": "jaconv.jaconv",
      "pythonPath": ".",
      "stack": "python",
      "description": "Convert Hiragana to Full-width Katakana",
      "inputs": ["ともえまみ", "あいうえお", ""]
    }
  ]
}
```

> Real manifest in action: [`proof/jaconv/manifest.json`](proof/jaconv/manifest.json) — 14 clusters covering Japanese character conversion.

## Three Phases

### Phase 1 — AUDIT (capture truth)

Analyze the codebase and identify clusters of functions that produce distinct outputs. Write `regrets/manifest.json` with one entry per behavioral contract. Run `capture` to ghost-record inputs/outputs and compute fingerprints. Validate immediately — all clusters must be green before proceeding.

```bash
node scripts/regret.js scan --dir src/       # discover clusters
node scripts/regret.js capture                # ghost-capture fingerprints
node scripts/regret.js validate               # gate: all must pass
```

### Phase 2 — REFACTOR (restructure freely)

Now you have a safety net. Split god objects, extract pure functions, rename for intent, isolate side effects. **Never edit files inside `regrets/`** — they are your contract. Never remove watched functions without replacing their contract.

### Phase 3 — VALIDATE (prove nothing broke)

After each refactor batch, run `validate` and compare every fingerprint against the captured baseline. If any cluster is red, trace the diff, fix the code, and re-validate. **Never edit `.regret` files to make a test pass** — that means the refactor changed behavior, which is a bug.

```bash
node scripts/regret.js validate               # all clusters: PASS / FAIL
node scripts/regret.js diff --cluster my-cls  # see what changed
```

## Command Reference

| Command | Description | When to use |
|---------|-------------|-------------|
| `install` | Auto-discover + capture entire project in one command | Phase 1 — one-shot setup |
| `capture` | Ghost-capture fingerprints for all clusters | Phase 1 — before refactoring |
| `validate` | Compare current fingerprints against saved `.regret` files | Phase 3 — after every refactor batch |
| `scan` | Scan project for cluster candidates (optional `--decompose`) | Phase 1 — discover clusters automatically |
| `check` | Pre-flight manifest validation — verify exports exist | Before `capture`, catch typos early |
| `audit` | Pre-refactor readiness audit (optional `--strict`) | Phase 1 — ensure your setup is solid |
| `health` | Health report of all clusters (optional `--sort fragile`) | Ongoing — check which clusters are fragile |
| `drift` | Drift detection — 5 validation runs to catch non-determinism | When outputs may vary across runs |
| `diff` | Show output diff for a failing cluster | Phase 3 — debug a red cluster |
| `list` | List all clusters with status | Quick overview |
| `update <id> --reason "..."` | Safe update with audit trail | When a contract legitimately changed |
| `rollback <id>` | Re-capture + validate a single cluster | When a cluster needs a fresh baseline |
| `truth` | Save dual truth baselines (KEBENARAN 1 + 2) | Before critical refactors — extra safety |
| `verify-kebenaran` | Verify KEBENARAN 1 vs KEBENARAN 2 cross-check | Confirm 3-way verification |
| `chain` | Chain testing for multi-step flows | Validate across sequential function calls |
| `coverage` | Branch coverage analysis (optional `--suggest-inputs`) | Find under-tested branches |
| `branch-map` | Generate branch-map.md with input suggestions | Plan additional test inputs |
| `ci` | CI mode — validate with `--fail-fast` | In CI pipelines |
| `guard` | Pre-build gate — fail-fast validation | Pre-commit hooks / CI gates |
| `diagnose <file>` | Diagnose module exports & recommend capture mode | Debug capture issues |
| `compare --pre <dir> --post <dir>` | Compare pre vs post truth baselines | After refactoring with truth baselines |
| `analyze [dir]` | Deep structural analysis (god functions, duplicates) | Phase 1 — understand codebase structure |
| `mutate-audit <path>` | Detect functions that mutate input args | Catch hidden side effects |
| `structure` | Show structural overview of watched code | Visualize cluster architecture |

All commands: `node scripts/regret.js <cmd> [options]`

Global flag: `--skip-build` — skip the `preBuild` step when project is already compiled.

## Supported Stacks

The runner auto-detects the stack from `regrets/manifest.json` and dispatches to the right handler.

| Stack | Manifest value | Capture | Validate | Notes |
|-------|---------------|---------|----------|-------|
| **JavaScript / TypeScript** | `js` or `ts` | `capture.js` | `validate.js` | CJS, ESM, React components. TS projects: add `"preBuild": "npm run build"` to manifest |
| **Python** | `python` | `capture.py` | `validate.py` | Pure functions, class methods, multi-module. See [`references/python.md`](references/python.md) |
| **PHP** | `php` | `capture_php.php` | `validate_php.php` | Pure functions, class-based output |
| **Ruby** | `ruby` | `capture_ruby.rb` | `validate_ruby.rb` | Top-level functions, class methods, instance methods. See [`references/ruby.md`](references/ruby.md) and [`proof/ruby_slugify/`](proof/ruby_slugify/) |
| **C# (.NET 8+)** | `csharp` | `capture_csharp.sh` | `validate_csharp.sh` | Reflection-based; public static methods. See [`references/csharp.md`](references/csharp.md) and [`proof/csharp-demo/`](proof/csharp-demo/) |
| **Go** | `go` | `capture_go.sh` | `capture_go.sh validate` | Working |
| **Go** | `go` | `capture_go.sh` | `capture_go.sh validate` | Community Preview |
| **Lua** | `lua` | `capture_lua.lua` | `validate_lua.lua` | Pure-Lua SHA-256, no deps. Lua 5.3+. See [`references/lua.md`](references/lua.md) |
| **Rust** | `rust` | `capture_rust.sh` | `capture_rust.sh validate` | Community Preview |
| **Kotlin** | `kotlin` | `capture_kotlin.sh` | `validate_kotlin.sh` | Community Preview. Top-level functions only (callee wrapping + class methods on roadmap). See [`references/kotlin.md`](references/kotlin.md) |
| **Ruby** | `ruby` | `capture_ruby.rb` | `validate_ruby.rb` | Pure functions, class methods. See [`references/ruby.md`](references/ruby.md) |
| **Nim** | `nim` | `capture_nim.sh` | `validate_nim.sh` | Top-level `proc` with `*` export. See [`references/nim.md`](references/nim.md) |
| **Julia** | `julia` | `capture_julia.sh` | `validate_julia.sh` | Top-level functions, JIT-compiled. Julia 1.11+. See [`references/julia.md`](references/julia.md) and [`proof/julia_slugify/`](proof/julia_slugify/) |
| **React** | `react` | `capture_react.mjs` | `validate.js` | Component rendering tests |
| **Bash** | `bash` | `capture_bash.sh` | `validate_bash.sh` | Community Preview. See [`references/bash.md`](references/bash.md) |
| **Make** | `make` | `capture_make.sh` | `validate_make.sh` | GNU Make 4.x `define`/`endef` functions via `$(call ...)`. See [`references/make.md`](references/make.md) |
| **SQL** | `sql` | `capture_sql.mjs` | `validate_sql.mjs` | SQLite queries via Python3. Scalar functions, table queries, aggregates, custom functions. Community Preview |

### Stack-specific examples

```bash
# Python — jaconv (14 clusters, pure string transforms)
node scripts/regret.js capture    # auto-detects python from manifest

# JS/React — component rendering
node scripts/regret.js capture    # stack: "react" in manifest

# Ruby — slugify (2 clusters, pure string transforms)
ruby scripts/capture_ruby.rb      # or: node scripts/regret.js capture (auto-detects ruby)
# C# (.NET 8+) — Calculator demo (5 clusters, multi-input, issue #315 pattern)
bash scripts/capture_csharp.sh    # or: node scripts/regret.js capture (auto-detects csharp)

# Go
node scripts/regret.js capture    # stack: "go" → dispatches to capture_go.sh

# Nim
node scripts/regret.js capture    # stack: "nim" → dispatches to capture_nim.sh
# Bash
node scripts/regret.js capture    # stack: "bash" → dispatches to capture_bash.sh
```

> Proof: [`proof/jaconv/`](proof/jaconv/) — 14 Python clusters for Japanese character conversion, all green after decomposing a 959-line monolith into 6 modules. [`proof/pyluach/`](proof/pyluach/) — 7 Python clusters for Hebrew calendar math, all green after refactoring with renamed variables and extracted functions. [`proof/ruby_slugify/`](proof/ruby_slugify/) — 2 Ruby clusters for URL slug generation, all green; demo script walks through baseline → valid refactor (still PASS) → breaking refactor (FAIL).
> Proof: [`proof/jaconv/`](proof/jaconv/) — 14 Python clusters for Japanese character conversion, all green after decomposing a 959-line monolith into 6 modules. [`proof/pyluach/`](proof/pyluach/) — 7 Python clusters for Hebrew calendar math, all green after refactoring with renamed variables and extracted functions. [`proof/csharp-demo/`](proof/csharp-demo/) — 5 C# clusters for a Calculator library, all green; demo script walks through baseline → valid refactor (PASS) → breaking refactor (FAIL) → restore (PASS).

## The `.regret` File

Each `.regret` file captures one behavioral contract — human-readable, AI-readable, git-diffable:

```
cluster: hira2kata
fingerprint: 3elv23o
entry: hira2kata
stack: python
---
INPUT  ともえまみ
OUTPUT トモエマミ
HASH   3elv23o
```

The `regrets/` folder is **sacred** — never edit `.regret` files after they are green. They are your source of truth.

### Callee Wrapping (Phase 2 — opt-in)

When a cluster declares `"callees": ["a", "b"]` in the manifest, capture also writes a separate `.regret` file for each callee that was actually called, using the cluster id `<parent>.calls.<callee>`. This makes inner-function contracts explicit — a refactor that changes a callee's behavior can no longer hide behind a compensating change in a sibling callee that preserves the parent's output.

```json
{
  "id": "main",
  "entry": "main",
  "watches": ["main"],
  "file": "src/api.cjs",
  "callees": ["add", "mul"]
}
```

Produces three files: `regrets/main.regret`, `regrets/main.calls.add.regret`, `regrets/main.calls.mul.regret`.

Opt-in, depth 1, backward compatible. Callees must be reachable via `module.exports.foo(...)` (CJS) — closure-private functions are skipped with a warning. See [`SKILL.md`](SKILL.md#callee-wrapping-phase-2--opt-in) for full details.

## Links

- **[SKILL.md](SKILL.md)** — full skill specification (ghost proxy pattern, fingerprint algorithm, manifest schema, all rules)
- **[references/phases.md](references/phases.md)** — detailed phase instructions (AUDIT → REFACTOR → VALIDATE)
- **[references/fingerprint-spec.md](references/fingerprint-spec.md)** — fingerprint algorithm, collision analysis, normalization rules
- **[references/TROUBLESHOOTING.md](references/TROUBLESHOOTING.md)** — common issues and fixes
- **[references/WALKTHROUGH.md](references/WALKTHROUGH.md)** — step-by-step walkthrough with a real project
- **[proof/](proof/)** — real-world case studies with full verification results

## License

MIT

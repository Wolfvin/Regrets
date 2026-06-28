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
| `setup` | Initial setup helper — installs scripts, prints next steps | Phase 1 — first run |
| `init` | Scaffold `regrets/` directory with empty manifest template | Phase 1 — before writing the manifest by hand |
| `install` | Auto-discover + capture entire project in one command | Phase 1 — one-shot setup |
| `capture` | Ghost-capture fingerprints for all clusters | Phase 1 — before refactoring |
| `validate` | Compare current fingerprints against saved `.regret` files | Phase 3 — after every refactor batch |
| `check` | Pre-flight manifest validation — verify exports exist | Before `capture`, catch typos early |
| `status` | Snapshot of current state — safe to refactor? | Phase 1 — pre-refactor readiness check |
| `list` | List all clusters with status | Quick overview |
| `health` | Health report of all clusters (optional `--sort fragile`) | Ongoing — check which clusters are fragile |
| `drift` | Drift detection — 5 validation runs to catch non-determinism | When outputs may vary across runs |
| `diff` | Show output diff for a failing cluster | Phase 3 — debug a red cluster |
| `update <id> --reason "..."` | Safe update with audit trail | When a contract legitimately changed |
| `rollback <id>` | Re-capture + validate a single cluster | When a cluster needs a fresh baseline |
| `history <id>` | Show audit log history for a cluster | Review when/why a contract was updated |
| `truth` | Save dual truth baselines (KEBENARAN 1 + 2) | Before critical refactors — extra safety |
| `verify-kebenaran` | Verify KEBENARAN 1 vs KEBENARAN 2 cross-check | Confirm 3-way verification |
| `chain` | Chain testing for multi-step flows | Validate across sequential function calls |
| `coverage` | Branch coverage analysis (optional `--suggest-inputs`) | Find under-tested branches |
| `compare --pre <dir> --post <dir>` | Compare pre vs post truth baselines | After refactoring with truth baselines |
| `analyze [dir]` | Deep structural analysis (god functions, duplicates) | Phase 1 — understand codebase structure |
| `mutate-audit <path>` | Detect functions that mutate input args | Catch hidden side effects |
| `discover --entry <fn> --file <path>` | Single-function discovery via runtime call graph tracing | Phase 1 — pin down one entry point |
| `risk --since HEAD~1` | Pre-refactor risk signal — which clusters a commit touches | Before refactor — gauge blast radius |
| `watch` | Watch mode — re-validate on file change | Phase 3 — continuous validation |
| `uninstall` | Remove Regrets safety net (optional `--keep-manifest`) | Cleanup — keep manifest, drop captures |
| `help` | Show help for all commands | Whenever you forget the syntax |

All commands: `node scripts/regret.js <cmd> [options]`

Global flag: `--skip-build` — skip the `preBuild` step when project is already compiled.

### Deprecated commands

These still work but print a warning — migrate to the replacement.

| Old | Use instead |
|-----|-------------|
| `ci` | `validate --fail-fast` |
| `scan` | `install --dry-run` |
| `structure` | `analyze` (Python) |
| `branch-map` | `coverage --suggest-inputs` |
| `audit` | `status` |
| `diagnose <file>` | `discover --entry <fn> --file <path>` |
| `guard` | `validate --fail-fast` |
| `branches` | `coverage` |

## Supported Stacks

The runner auto-detects the stack from `regrets/manifest.json` and dispatches to the right handler.

| Stack | Manifest value | Capture | Validate | Notes |
|-------|---------------|---------|----------|-------|
| **JavaScript / TypeScript** | `js` or `ts` | `capture.js` | `validate.js` | CJS, ESM, React components. TS projects: add `"preBuild": "npm run build"` to manifest |
| **Python** | `python` | `capture.py` | `validate.py` | Pure functions, class methods, multi-module. See [`references/python.md`](references/python.md) |
| **PHP** | `php` | `capture_php.php` | `validate_php.php` | Pure functions, class-based output. See [`references/php.md`](references/php.md) |
| **Ruby** | `ruby` | `capture_ruby.rb` | `validate_ruby.rb` | Top-level functions, class methods, instance methods. See [`references/ruby.md`](references/ruby.md) and [`proof/ruby_slugify/`](proof/ruby_slugify/) |
| **C# (.NET 8+)** | `csharp` | `capture_csharp.sh` | `validate_csharp.sh` | Reflection-based; public static methods. See [`references/csharp.md`](references/csharp.md) and [`proof/csharp-demo/`](proof/csharp-demo/) |
| **Go** | `go` | `capture_go.sh` | `capture_go.sh validate` | Working. See [`references/go.md`](references/go.md) and [`proof/go_verify/`](proof/go_verify/) |
| **Lua** | `lua` | `capture_lua.lua` | `validate_lua.lua` | Pure-Lua SHA-256, no deps. Lua 5.3+. See [`references/lua.md`](references/lua.md) |
| **Rust** | `rust` | `capture_rust.sh` | `validate_rust.sh` | Community Preview. See [`references/rust.md`](references/rust.md) and [`proof/rust_verify/`](proof/rust_verify/) |
| **Kotlin** | `kotlin` | `capture_kotlin.sh` | `validate_kotlin.sh` | Community Preview. Top-level functions only (callee wrapping + class methods on roadmap). See [`references/kotlin.md`](references/kotlin.md) and [`proof/kotlin/`](proof/kotlin/) |
| **Nim** | `nim` | `capture_nim.sh` | `validate_nim.sh` | Top-level `proc` with `*` export. See [`references/nim.md`](references/nim.md) |
| **Julia** | `julia` | `capture_julia.sh` | `validate_julia.sh` | Top-level functions, JIT-compiled. Julia 1.11+. See [`references/julia.md`](references/julia.md) and [`proof/julia_slugify/`](proof/julia_slugify/) |
| **React** | `react` | `capture_react.mjs` | `validate_react.mjs` | Component rendering tests. See [`references/react.md`](references/react.md) and [`proof/react_demo/`](proof/react_demo/) |
| **Vue** | `vue` | `capture_vue.mjs` | `validate_vue.mjs` | Community Preview. See [`references/vue.md`](references/vue.md) and [`proof/vue_demo/`](proof/vue_demo/) |
| **Bash** | `bash` | `capture_bash.sh` | `validate_bash.sh` | Community Preview. See [`references/bash.md`](references/bash.md) and [`proof/bash_slugify/`](proof/bash_slugify/) |
| **Make** | `make` | `capture_make.sh` | `validate_make.sh` | GNU Make 4.x `define`/`endef` functions via `$(call ...)`. See [`references/make.md`](references/make.md) |
| **SQL** | `sql` | `capture_sql.mjs` | `validate_sql.mjs` | SQLite queries via Python3. Scalar functions, table queries, aggregates, custom functions. Community Preview |
| **Awk** | `awk` | `capture_awk.mjs` | `validate_awk.mjs` | Community Preview. See [`references/awk.md`](references/awk.md) and [`proof/awk/`](proof/awk/) |
| **C** | `c` | `capture_c.sh` | `validate_c.sh` | Community Preview. See [`proof/c/`](proof/c/) |
| **C++** | `cpp` | `capture_cpp.sh` | `validate_cpp.sh` | Community Preview. See [`references/cpp.md`](references/cpp.md) and [`proof/cpp/`](proof/cpp/) |
| **Crystal** | `crystal` | `capture_crystal.sh` | `validate_crystal.sh` | Community Preview. See [`references/crystal.md`](references/crystal.md) and [`proof/crystal_demo/`](proof/crystal_demo/) |
| **CSS** | `css` | `capture_css.mjs` | `validate_css.mjs` | Community Preview. See [`references/css.md`](references/css.md) and [`proofs/css_demo/`](proofs/css_demo/) |
| **Dart** | `dart` | `capture_dart.sh` | `validate_dart.sh` | Community Preview. See [`proof/dart_stack/`](proof/dart_stack/) |
| **F#** | `fsharp` | `capture_fsharp.sh` | `validate_fsharp.sh` | Community Preview. See [`proofs/fsharp_demo/`](proofs/fsharp_demo/) |
| **Haskell** | `haskell` | `capture_haskell.sh` | `validate_haskell.sh` | Community Preview. See [`proof/haskell_indep/`](proof/haskell_indep/) |
| **Java** | `java` | `capture_java.sh` | `validate_java.sh` | Community Preview. See [`references/java.md`](references/java.md) and [`proof/java/`](proof/java/) |
| **jq** | `jq` | `capture_jq.sh` | `validate_jq.sh` | Community Preview. See [`references/jq.md`](references/jq.md) and [`proof/jq_slugify/`](proof/jq_slugify/) |
| **Perl** | `perl` | `capture_perl.pl` | `validate_perl.pl` | Community Preview. See [`references/perl.md`](references/perl.md) and [`proof/perl_independent/`](proof/perl_independent/) |
| **Scala** | `scala` | `capture_scala.sh` | `validate_scala.sh` | Community Preview. See [`references/scala.md`](references/scala.md) and [`proof/scala_slugify/`](proof/scala_slugify/) |
| **Swift** | `swift` | `capture_swift.sh` | `validate_swift.sh` | Community Preview |
| **Tcl** | `tcl` | `capture_tcl.sh` | `validate_tcl.sh` | Community Preview |
| **Zig** | `zig` | `capture_zig.sh` | `validate_zig.sh` | Community Preview. See [`references/zig.md`](references/zig.md) and [`proof/zig/`](proof/zig/) |

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

> Proof: [`proof/jaconv/`](proof/jaconv/) — 14 Python clusters for Japanese character conversion, all green after decomposing a 959-line monolith into 6 modules. [`proof/pyluach/`](proof/pyluach/) — 7 Python clusters for Hebrew calendar math, all green after refactoring with renamed variables and extracted functions. [`proof/ruby_slugify/`](proof/ruby_slugify/) — 2 Ruby clusters for URL slug generation, all green; demo walks baseline → valid refactor (PASS) → breaking refactor (FAIL). [`proof/csharp-demo/`](proof/csharp-demo/) — 5 C# clusters for a Calculator library, all green; demo walks baseline → valid refactor (PASS) → breaking refactor (FAIL) → restore (PASS). More case studies under [`proof/`](proof/) (Awk, C, C++, Crystal, Dart, Go, Haskell, Java, jq, Julia, Kotlin, Make, Nim, Perl, React, Rust, Scala, Vue, Zig) and [`proofs/`](proofs/) (CSS, F#).

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

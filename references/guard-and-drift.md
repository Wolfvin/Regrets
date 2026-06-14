# Guard and Drift Commands

## Overview

`guard` and `drift` are two high-level commands in `regret.js` that serve as quality gates at different stages of the refactoring workflow. Both are thin wrappers around `validate` — they delegate to the same validation engine but with different flags and purposes.

| Command | Purpose | When to Use |
|---------|---------|-------------|
| `guard` | Pre-deployment gate — fail-fast validation | Before merging, deploying, or shipping |
| `drift` | Non-determinism detection — multi-run consistency check | After initial capture, before trusting fingerprints |

---

## `guard` — Pre-Build Gate

### What It Does

`guard` runs `validate` with the `--fail-fast` flag across all stacks detected in the manifest. It validates every cluster's fingerprint against the golden `.regret` file, but stops immediately on the **first failure** instead of continuing to check remaining clusters. After validation completes, it prints a clear pass/fail verdict:

- **Pass:** `✅ Regret guard passed — all clusters green.`
- **Fail:** `❌ Regret guard FAILED — some clusters are red.`

### When an Agent Should Use Guard

- **Before merging a PR or deploying:** Guard acts as a final checkpoint. If any cluster is red, the change is not safe to ship.
- **In CI/CD pipelines on push to main:** The SKILL.md CI/CD section recommends running `regret:guard` on push to main to block deployments when regrets fail.
- **After refactoring, before committing:** A quick guard run confirms nothing broke. The `--fail-fast` behavior saves time — you find out about the first problem immediately rather than waiting for every cluster to be checked.

### How It Differs from `ci`

Both `guard` and `ci` run validate with `--fail-fast`. The difference is semantic and conventional:

- `ci` is designed for **CI pull-request checks** — it's the fast validation gate run on every PR.
- `guard` is the **deployment gate** — it's run on push to main and has an explicit pass/fail summary message. Use `guard` when you want a clear binary answer: "is it safe to deploy?"

In terms of implementation, both currently call the same validate logic with `--fail-fast`. The distinction exists for workflow clarity and may diverge in future versions (e.g., guard could enforce stricter policies).

### Input

No required arguments. Optional pass-through flags:

- `--cluster <id>` — validate only a specific cluster
- `--skip-build` — skip the `preBuild` step if the project is already compiled

### Output Examples

**All clusters green:**

```
🔍 Validating 3 cluster(s)...

  ✅ transform-user-data              9jadb                   PASS
  ✅ fetch-invoice                    x7k2m                   PASS
  ✅ compute-total                    p4n8q                   PASS

────────────────────────────────────────────────────────────────
✅ All 3 tests passed. Refactor is safe.

✅ Regret guard passed — all clusters green.
```

**First cluster fails (fail-fast stops immediately):**

```
🔍 Validating 3 cluster(s)...

  ✅ transform-user-data              9jadb                   PASS
  ❌ fetch-invoice                    x7k2m → ff3z            FAIL

  --fail-fast: stopping.

────────────────────────────────────────────────────────────────
❌ 1/2 FAILED.

Fix the CODE — do not edit .regret files.
Re-run: node scripts/validate.js

❌ Regret guard FAILED — some clusters are red.
```

### Exit Code

- `0` — all clusters pass
- `1` — any cluster fails

---

## `drift` — Non-Determinism Detection

### What It Does

`drift` runs `validate` with `--runs 5` across all stacks detected in the manifest. It executes each cluster **5 times** and checks whether the fingerprint is **consistent across all runs** for each input. If the same input produces different hashes across runs, that cluster has **drift** — meaning the output is non-deterministic (caused by timestamps, random IDs, race conditions, global state leaks, etc.).

After running, each cluster is reported as one of:

- `PASS+STABLE` — fingerprint matches the golden AND all 5 runs produced identical hashes
- `FAIL` — fingerprint does not match the golden (but is consistent across runs)
- `DRIFT` — the same input produced different hashes across runs (non-deterministic output)

### When an Agent Should Use Drift

- **After initial capture, before trusting the fingerprints:** Run drift to confirm that captured fingerprints are deterministic. If a cluster drifts, its golden fingerprint is unreliable — a future validate might fail even with no code changes.
- **When a cluster unexpectedly goes RED with no code changes:** Drift detection helps diagnose whether the failure is due to non-determinism in the code rather than an actual behavior change.
- **Before the GATE in the refactoring workflow:** Step 6 of the Quick Reference workflow is `regret:drift` — all clusters must be green AND stable before proceeding to refactor.
- **After adding `normalize` or `ignoreFields` rules:** Re-run drift to verify that the normalization rules successfully eliminated the non-determinism.

### How Drift Detection Works Internally

The validate script runs each cluster's entry function with each input, `--runs` times (default 5). For each input, it collects the fingerprint from every run and checks if they are all identical. If any input produces different fingerprints across runs, the cluster is marked as DRIFT.

The per-input check is important: it compares each input's hashes **against itself across runs**, not against other inputs. This avoids false drift reports from inputs that legitimately produce different outputs.

### Input

No required arguments. Optional pass-through flags:

- `--cluster <id>` — detect drift for only a specific cluster
- `--skip-build` — skip the `preBuild` step if the project is already compiled

### Output Examples

**All clusters stable:**

```
🔍 Drift detection — 5 runs per cluster...

  ✅ transform-user-data              9jadb  × 5  PASS+STABLE
  ✅ compute-total                    p4n8q  × 5  PASS+STABLE

────────────────────────────────────────────────────────────────
✅ All 2 tests passed (5 runs — stable). Refactor is safe.
```

**Drift detected:**

```
🔍 Drift detection — 5 runs per cluster...

  ✅ transform-user-data              9jadb  × 5  PASS+STABLE
  ❌ fetch-invoice                    DRIFT  [x7k2m / ff3z / x7k2m / x7k2m / x7k2m]

────────────────────────────────────────────────────────────────
❌ Drift in 1 cluster(s). Add normalize rules and re-capture.
```

**Cluster fails fingerprint but is stable (no drift):**

```
🔍 Drift detection — 5 runs per cluster...

  ✅ transform-user-data              9jadb  × 5  PASS+STABLE
  ❌ fetch-invoice                    ff3z   × 5  FAIL

────────────────────────────────────────────────────────────────
❌ 1/2 FAILED.
```

### What to Do When Drift Is Detected

1. **Identify the source of non-determinism** — common causes: timestamps, random values, UUIDs, `Date.now()`, `Math.random()`, global mutable state, or race conditions in async code.
2. **Check `references/fingerprint-spec.md`** — it documents edge cases and normalization strategies for non-deterministic values.
3. **Add `normalize` rules to the cluster in manifest.json** — for example, `"normalize": ["dynamicDates"]` to stabilize date-containing outputs.
4. **Or add `ignoreFields`** — to strip non-deterministic fields before fingerprinting.
5. **Re-capture** with `regret capture` after adding normalization.
6. **Re-run drift** with `regret drift` to confirm all runs produce identical hashes.

**Drift is a code smell, not a test problem.** Fix the non-determinism in the source code when possible. Only use `normalize`/`ignoreFields` as a last resort when the non-determinism is inherent to the output (e.g., timestamps in log messages).

### Exit Code

- `0` — all clusters pass and are stable
- `1` — any cluster fails or drifts

---

## Quick Comparison

| | `guard` | `drift` |
|---|---------|---------|
| **Flag** | `--fail-fast` | `--runs 5` |
| **Runs per cluster** | 1 | 5 |
| **Stops on first failure** | Yes | No (checks all clusters) |
| **Detects non-determinism** | No | Yes |
| **Use case** | "Is it safe to deploy?" | "Are my fingerprints deterministic?" |
| **Typical workflow position** | After refactor, before merge/deploy | After capture, before trusting fingerprints |
| **CI role** | Deployment gate (push to main) | Pre-refactor confidence check |

---

## Implementation Notes

Both commands are thin dispatchers in `scripts/regret.js`. They auto-detect stacks from `regrets/manifest.json` and delegate to the appropriate validate script:

- **JS/TS/React** → `scripts/validate.js`
- **Python** → `scripts/validate.py`
- **PHP** → `scripts/validate_php.php`
- **Go** → `scripts/capture_go.sh` (validate mode)

Both commands also trigger the `preBuild` hook if the manifest has a `preBuild` field (e.g., `npm run build` for TypeScript projects). Use `--skip-build` to bypass this if the project is already compiled.

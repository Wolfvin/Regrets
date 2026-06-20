# Chain Testing (Contest) — Multi-Step Flow Regression

## What Is Chain Testing?

Regular regret testing fingerprints **individual clusters** — single functions
with known inputs and outputs. Chain testing extends this to **multi-step
flows**: sequences of cluster calls that must produce consistent results end to
end.

Think of it as:
- **Cluster** = unit test (one function, one fingerprint)
- **Chain** = integration test (multiple functions, combined fingerprint)

## The chains.json Format

Define chains in `regrets/chains.json`:

```json
{
  "chains": [
    {
      "id": "login-flow",
      "steps": [
        { "cluster": "validate-credentials", "input": {"user": "test", "pass": "123"} },
        { "cluster": "build-session", "input": {"userId": 1} },
        { "cluster": "generate-token", "input": {"sessionId": "abc"} }
      ]
    }
  ]
}
```

Each **step** references an existing cluster in `manifest.json` by its `id` and
provides the input to pass to that cluster's entry function. The step output is
captured and fingerprinted automatically.

## How Chain Fingerprints Work

1. Each step runs its cluster's entry function with the given input
2. A per-step fingerprint is computed (same algorithm as cluster fingerprinting)
3. All step fingerprints are combined: `"cluster:hash|cluster:hash|..."`
4. A SHA-256 hash of that combined string produces the **chain hash** (7-char base36)

If any step's output changes, the chain hash changes — catching regressions
across the entire flow.

### Sort Key / Ordering Guarantee (determinism spec — issue #254)

The chain hash is **only** reproducible across runs if the order of steps in
the combined string is deterministic. The sort key is:

> **Steps appear in the combined string in the exact order they are listed
> in the `steps` array of the chain definition in `chains.json`.**

There is no alphabetical sorting, no sort by cluster id, no sort by
fingerprint. The user-defined `steps` array order IS the canonical order.

Concretely, given:

```json
{
  "chains": [{
    "id": "login-flow",
    "steps": [
      {"cluster": "validate-credentials", "input": {"user": "test"}},
      {"cluster": "build-session",        "input": {"userId": 1}},
      {"cluster": "generate-token",       "input": {"sessionId": "abc"}}
    ]
  }]
}
```

The combined string is always:

```
validate-credentials:<hash1>|build-session:<hash2>|generate-token:<hash3>
```

— never any permutation. Reordering the `steps` array in `chains.json`
changes the chain hash, which is the intended behavior (a reordered flow
is a different behavioral contract).

**Runtime enforcement.** `contest.mjs` and `contest.py` both iterate the
`steps` array sequentially (no `Promise.all`, no parallel execution) so
the order in `stepResults` always matches the order in `chains.json`. If
you refactor either runner to parallelize step execution, you MUST sort
`stepResults` back into `steps`-array order before calling
`computeChainHash` — otherwise the hash becomes nondeterministic.

**Why this matters.** A nondeterministic chain hash means the same code
with the same inputs produces different `.chain` files on different runs,
causing false REDs in CI. Documenting the sort key here makes the
determinism guarantee explicit and testable.

## Capturing Chains

```bash
# Capture all chains
node scripts/regret.js chain --capture

# Capture a specific chain
node scripts/regret.js chain --capture --chain login-flow
```

This writes `.chain` files to `regrets/chains/`:

```
chain: login-flow
chain_hash: a1b2c3d
captured: 2025-01-15T10:30:00.000Z
steps:
  1. cluster: validate-credentials
     fingerprint: x7y8z9a
  2. cluster: build-session
     fingerprint: b4c5d6e
  3. cluster: generate-token
     fingerprint: f1g2h3i
---
STEP 1  validate-credentials
  INPUT  {"user":"test","pass":"123"}
  OUTPUT {"valid":true,"userId":1}
  HASH   x7y8z9a
...
```

## Validating Chains

```bash
# Validate all chains against stored golden
node scripts/regret.js chain --validate

# Validate a specific chain
node scripts/regret.js chain --validate --chain login-flow
```

Each chain's computed hash is compared against the stored `.chain` file.
A mismatch means something in the flow changed — investigate before deploying.

## Example: Login Flow

Given `regrets/manifest.json` with clusters `validate-credentials`,
`build-session`, and `generate-token` already defined:

1. Create `regrets/chains.json` with the chain definition above
2. Run: `node scripts/regret.js chain --capture`
3. Commit `regrets/chains/login-flow.chain` to version control
4. After refactoring: `node scripts/regret.js chain --validate`
5. If green → the login flow contract is intact
6. If red → a step's output changed, check the diff

## CLI Summary

| Command | Description |
|---------|-------------|
| `regret chain --capture` | Capture chain fingerprints |
| `regret chain --capture --chain <id>` | Capture a specific chain |
| `regret chain --validate` | Validate all chains |
| `regret chain --validate --chain <id>` | Validate a specific chain |

## Difference from Cluster Testing

| Aspect | Cluster | Chain |
|--------|---------|-------|
| Scope | Single function | Multi-step flow |
| Input | From manifest `inputs` | From chains.json `steps[].input` |
| Fingerprint | Per cluster | Combined across steps |
| Golden file | `.regret` | `.chain` |
| Purpose | Unit regression | Integration regression |

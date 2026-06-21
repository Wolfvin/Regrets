# Nim Red-Team Fixture — `proof/nim_redteam/`

This fixture exercises patterns **NOT covered by `proof/nim_slugify/`** to
guard against confirmation bias (per `CONTEXT.md` → Lesson Learned: "JALANKAN
test nyata dengan pattern yang berbeda dari yang dipakai untuk implementasi").

## Patterns verified

| Cluster | Entry proc | Input type | Output type | Notes |
|---------|------------|------------|-------------|-------|
| `fibonacci` | `fibonacci(n: int): int` | `int` | `int` | Raises `ValueError` on `n < 0`. Verifies the trivial-input guard / error path doesn't crash the harness. |
| `sum-squares` | `sumSquares(xs: seq[int]): int` | `seq[int]` | `int` | Verifies `seq[int]` input dispatch (different from `seq[string]` in slugify demo). |
| `max-pair` | `maxPair(xs: seq[int]): tuple[a: int, b: int]` | `seq[int]` | `tuple` | Verifies the tuple `%` overload in `scripts/fingerprint_nim.nim`. Without that overload, the harness fails to compile with "ambiguous call" because Nim's `std/json` has no `%` for tuples. |
| `safe-divide-by-two` | `safeDivideByTwo(n: int): int` | `int` | `int` | Raises `DivByZeroError` on `n == 0` (edge case). |

## Why these patterns

The slugify demo only exercises `string → string` and `seq[string] → seq[string]`.
The harness generator's `compiles()` dispatch tree has 9 branches (string, int,
float, bool, seq[string], seq[int], seq[float], seq[bool], JsonNode fallback),
but only 2 were exercised by the original demo. The red-team fixture exercises
4 more branches (int, seq[int], tuple output via the new `%` overload, raise
on edge case) to verify they actually work.

## Running

```bash
# From repo root, with Nim 2.x on PATH
bash proof/nim_redteam/run_demo.sh
```

The demo walks through three phases:

1. **Phase 0 — Baseline**: capture + validate all 4 clusters. Must PASS.
2. **Phase 1 — VALID refactor**: rename internal vars only (`a→prev`, `b→cur`,
   `sorted→ordered`). Output for every input is unchanged. Must PASS.
3. **Phase 2 — BREAKING refactor**: change `fibonacci` to return `n*2` instead
   of the proper Fibonacci number. The fingerprint for `fibonacci` changes;
   `max-pair`, `sum-squares`, and `safe-divide-by-two` stay green. Must FAIL
   on `fibonacci` only.

## Cross-stack parity

The `fibonacci` cluster's fingerprint (`587q30m` for input `10` → output `55`)
is computable on any Regrets-supported stack. The same input/output pair on
Python/Ruby/JS/PHP would produce the same hash, because the fingerprint
algorithm is `sha256(stableStringify(input) + "|" + stableStringify(output))`
→ base36 → first 7 chars, and the JSON serialization is identical.

The `max-pair` cluster's output is `{"a":9,"b":6}` — a JSON object. On stacks
where tuples are represented as hashes/dicts (Ruby, Python), the equivalent
output produces the same JSON, so the fingerprint matches.

## Files

- `lib/redteam.nim` — source file with 4 exported procs.
- `manifest.json` — 4 cluster definitions, one per proc.
- `regrets/` — generated `.regret` files (golden contracts).
- `run_demo.sh` — orchestrates the 3-phase verification.

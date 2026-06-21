# php-fixture — PHP Regrets verification fixture

> **Purpose:** This is a self-contained PHP codebase for verifying that the PHP stack
> (`scripts/capture_php.php`, `scripts/validate_php.php`, `scripts/fingerprint_php.php`)
> actually works end-to-end on real PHP code. The PHP scripts existed prior to this
> PR but had **never been tested on a real codebase** (per `references/php.md`).

## What this verifies

| Pattern | Cluster | Demonstrates |
|---|---|---|
| Standalone function | `php-slugify`, `php-count-words` | `entry: "functionName"` — function loaded via `require_once` from global namespace |
| Class instance method | `php-invoice-calculate` | `entry: "ClassName::methodName"` with `constructorArgs: [0.11]` and `multiArgs: true` |
| Non-deterministic output | `php-format-post` | `normalize: ["timestamps"]` rule — `date('c')` output is masked to `<TIMESTAMP>` before hashing |

All 4 clusters exercise `fingerprintLevel: "entry"` (the recommended mode for PHP, since
PHP lacks JS's `Proxy` for automatic callee wrapping — see `references/php.md`).

## How to reproduce

> **PHP requirement:** PHP ≥ 8.0 with the GMP extension (used for SHA-256 → base36
> conversion in `scripts/fingerprint_php.php`).

```bash
# From the repo root:
cd proof/php-fixture

# 1. Capture golden contracts — reads regrets/manifest.json, writes regrets/*.regret
php ../../scripts/capture_php.php

# 2. Validate (no code changes) — all clusters should PASS
php ../../scripts/validate_php.php

# 3. Make a refactor that PRESERVES output → validate still PASSes
#    (try rewriting slugify() as a char-by-char loop instead of preg_replace)
#    See ../../scripts/demo-refactor-workflow.sh for a worked example.

# 4. Make a refactor that CHANGES output → validate FAILs
#    (e.g. add a 'p-' prefix to slugify() return)
#    See demo script — exit code 1, shows the cluster that failed.

# 5. Intentional contract change → use --update with a --reason (≥ 4 words)
php ../../scripts/validate_php.php --update php-slugify --reason "describe why behavior changed"

# 6. Drift detection — run each cluster N times, fail if any produces different hashes
php ../../scripts/validate_php.php --runs 5
```

## Cross-stack fingerprint parity

`references/php.md` claims that PHP, JS, and Python fingerprints produce identical
output for the same input/output pair. This fixture verifies that claim for the
string-only cases — see `scripts/parity-check.{mjs,py,php}` (in the worker's scratch
directory, not committed):

| Case | JS | Python | PHP | Match |
|---|---|---|---|---|
| string in/out (`references/php.md` claim) | `yju9g9g` | `yju9g9g` | `yju9g9g` | ✅ |
| `slugify("Hello World!")` → `"hello-world"` | `2o600q3` | `2o600q3` | `2o600q3` | ✅ |
| `count_words("hello world")` → `2` | `1na8qrz` | `1na8qrz` | `1na8qrz` | ✅ |
| invoice (float edge case) | `5cc8oyq` | `n450495` | `5cc8oyq` | ❌ Python differs |
| `10` vs `"x"` (int) | `1fvu1e3` | `1fvu1e3` | `1fvu1e3` | ✅ |
| `10.0` vs `"x"` (float) | `1fvu1e3` | `5pk1b5j` | `1fvu1e3` | ❌ Python differs |

**Finding:** PHP matches JS exactly. Python diverges for float-valued inputs because
`json.dumps(10.0)` = `"10.0"` while JS `JSON.stringify(10.0)` = `"10"` and PHP
`json_encode(10.0)` (without `JSON_PRESERVE_ZERO_FRACTION`) = `"10"`. This is a
**pre-existing Python bug** (out of scope for this PR — file separately if needed).

## Bugs found and fixed in this PR

### 1. `validate_php.php --update` wrote LAST input's output to .regret, not FIRST

**Symptom:** After `--update`, the `.regret` file's `OUTPUT` field showed the **last**
input's output, even though `INPUT` and `HASH` reflected the **first** (golden) input.
Result: an internally inconsistent `.regret` file (`INPUT="first"` + `OUTPUT="last's output"`
+ `HASH="first's hash"`).

**Root cause:** `run_cluster()` returned only `$lastOutput`; the `--update` path passed
that to `update_regret()` even though `$liveHash = $hashes[0]` (first input's hash) was
being used to overwrite the `HASH` field.

**Fix:** `run_cluster()` now also tracks `$firstOutput` (the output that produced
`$hashes[0]`); `update_regret()` is called with `$firstOutput` instead of `$lastOutput`.

See `scripts/demo-update-bugfix.sh` (worker scratch) for a focused reproduction.

## Known limitations (not fixed in this PR — out of scope)

1. **No per-input contracts.** The JS validator was extended in Issue #315 to write
   per-input contracts (an `INPUTS` line with one hash per input), so a refactor that
   breaks input #2 but not input #1 is detected. The PHP validator (like the Python
   validator — see Issue #330) only checks `$hashes[0]`. Filing a separate issue is
   recommended.

2. **No automatic ghost proxy.** PHP lacks `Proxy` (JS) or monkey-patching (Python),
   so `fingerprintLevel: "full"` is not supported — only `fingerprintLevel: "entry"`
   works automatically. This is documented in `references/php.md` and is a deliberate
   design choice, not a bug.

3. **No namespace support in `entry`.** The `entry: "ClassName::methodName"` resolver
   uses `class_exists($className)` which works for global-namespace classes. For
   namespaced classes (`Foo\Bar\Baz::method`), the backslashes need to be escaped in
   JSON (`"Foo\\Bar\\Baz::method"`) and have not been tested in this fixture. A
   future fixture should add a namespaced example.

## Files

```
proof/php-fixture/
├── README.md                       ← this file
├── regrets/
│   ├── manifest.json               ← 4 PHP clusters
│   ├── php-slugify.regret          ← golden contract
│   ├── php-count-words.regret
│   ├── php-invoice-calculate.regret
│   └── php-format-post.regret
└── src/
    ├── TextUtils.php               ← standalone functions (slugify, count_words)
    ├── Invoice.php                 ← class-based (instance method, multiArgs)
    └── PostFormatter.php           ← function with non-deterministic output (timestamps)
```

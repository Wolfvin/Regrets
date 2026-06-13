# PHP Stack Variant — Regrets Integration

The ghost proxy pattern maps to PHP's method wrapping and dynamic class loading. This implementation produces `.regret` files identical to the JS and Python stacks.

## Quick Start

1. Add `"stack": "php"` clusters to `regrets/manifest.json`
2. Create `regrets/` folder in your PHP project root
3. Run `php scripts/capture_php.php` to capture fingerprints
4. Run `php scripts/validate_php.php` to validate (all clusters)
5. Run `php scripts/validate_php.php --runs 5` for drift detection

### Fingerprint Mode Support

The PHP stack supports all three fingerprint modes:

| Mode | Manifest Field | Supported | Notes |
|------|---------------|-----------|-------|
| Value | `"fingerprintMode": "value"` (default) | ✅ | Full output fingerprint — same as JS/Python |
| Schema | `"fingerprintMode": "schema"` | ✅ | Structural fingerprint only — uses `extract_schema()` |
| Mixed | `"fingerprintMode": "mixed"` | ✅ | Schema + selected `valuePaths` — partial value checking |

---

## Equivalent of Ghost Proxy in PHP

### PHP Limitation: No Proxy

PHP doesn't have JavaScript's `Proxy` or Python's `unittest.mock.patch`. Instead, the PHP stack uses a **direct invocation** pattern:

1. The capture script loads the target PHP file via `require_once`
2. It instantiates the class and calls the entry method directly
3. Fingerprint is computed from entry-level input/output only (`fingerprintLevel: "entry"`)
4. For `fingerprintLevel: "full"`, you must manually instrument watched functions

### Dynamic Class Loading

Instead of JS `import()` or Python `importlib.import_module`, PHP uses `require_once`:

```php
require_once '/path/to/MyClass.php';
$instance = new MyClass();
$result = $instance->myMethod($input);
```

---

## fingerprint_php.php — SHA-256 + Base36

The fingerprint algorithm is **identical** to the JS and Python implementations. Same input must produce same 7-char hash.

### Cross-Stack Consistency Check

```
INPUT:  "2025-01-15T00:00:00"
OUTPUT: "15/01/2025"

JS:     yju9g9g  ✅
Python: yju9g9g  ✅
PHP:    yju9g9g  ✅
```

Uses PHP's `gmp_strval(gmp_init($hex, 16), 36)` to convert SHA-256 hex to base36 — equivalent to JS's `BigInt('0x' + hex).toString(36)` and Python's `to_base36(int(hex, 16))`.

**Requirement:** PHP GMP extension must be installed. If GMP is not available, the `bcmath` extension can be used as a fallback (not yet implemented).

---

## Manifest for PHP Clusters

```json
{
  "clusters": [
    {
      "id": "schulze-winning",
      "entry": "Election::getResult",
      "watches": ["SchulzeWinning"],
      "file": "src/Algo/Methods/Schulze/SchulzeWinning.php",
      "stack": "php",
      "fingerprintLevel": "entry",
      "constructorArgs": [],
      "description": "Schulze Winning election method"
    },
    {
      "id": "borda-count",
      "entry": "Election::getResult",
      "watches": ["BordaCount"],
      "file": "src/Algo/Methods/Borda/BordaCount.php",
      "stack": "php",
      "multiArgs": false,
      "constructorArgs": [],
      "inputs": [
        {"method": "BordaCount"}
      ]
    }
  ]
}
```

### PHP-Specific Manifest Fields

| Field | Required | Description |
|-------|----------|-------------|
| `stack` | ✅ | Must be `"php"` |
| `file` | ✅ | Path to PHP file relative to project root |
| `entry` | ✅ | Method reference: `"ClassName::methodName"` or `"functionName"` |
| `constructorArgs` | ❌ | Array of arguments to pass to class constructor |
| `watches` | ✅ | Array of method names to monitor (informational for PHP) |

---

## Entry Function Format

PHP's entry function uses `::` notation to specify class and method:

```json
{
  "entry": "Election::getResult",
  "constructorArgs": []
}
```

This will:
1. `require_once` the file specified in `file`
2. Create `new Election()` with `constructorArgs` if provided
3. Call `$instance->getResult($input)`

For standalone functions:

```json
{
  "entry": "my_standalone_function"
}
```

---

## Class-Based API Pattern

PHP libraries often use class-based APIs. The PHP stack supports two patterns:

### Pattern 1: Constructor + Method (Most Common)

```json
{
  "id": "election-schulze",
  "entry": "Election::getResult",
  "file": "src/Election.php",
  "stack": "php",
  "constructorArgs": [],
  "inputs": ["Schulze"]
}
```

### Pattern 2: Multi-Step Construction

For classes that require setup before calling the entry method, create a **wrapper script**:

```php
<?php
// regrets/wrappers/schulze_test.php
require_once __DIR__ . '/../../vendor/autoload.php';
use CondorcetPHP\Condorcet\Election;

function runSchulzeTest(array $input): array {
    $election = new Election();
    foreach ($input['candidates'] as $c) {
        $election->addCandidate($c);
    }
    foreach ($input['votes'] as $v) {
        $election->addVote($v);
    }
    return $election->getResult($input['method'])->rankingAsArray;
}
```

Then in the manifest:

```json
{
  "id": "schulze-test",
  "entry": "runSchulzeTest",
  "watches": ["runSchulzeTest"],
  "file": "regrets/wrappers/schulze_test.php",
  "stack": "php",
  "inputs": [
    {"candidates": ["A", "B", "C"], "votes": ["A>B>C"], "method": "Schulze"}
  ]
}
```

---

## Normalization — PHP-Specific Patterns

| Non-Deterministic Source | PHP Pattern | Normalization Rule | Replacement |
|--------------------------|-------------|-------------------|-------------|
| Current time | `time()` / `microtime(true)` | `"epochs"` | `<EPOCH>` |
| Current datetime | `date('c')` / `new DateTime()` | `"timestamps"` | `<TIMESTAMP>` |
| UUID | ` Ramsey\Uuid\Uuid::uuid4()` | `"uuids"` | `<UUID>` |
| Random | `random_int()` / `mt_rand()` | `"ignoreFields"` on that key | — |
| File paths | `__DIR__` / `realpath()` | `"absPaths"` | `<ROOT>/...` |
| Dynamic dates | Period strings in filenames | `"dynamicDates"` | `<MMYYYY>`/`<YYYY>` |

---

## Example `.regret` Output for PHP Function

```
cluster: schulze-winning
fingerprint: abc1234
captured: 2026-06-14T10:00:00+00:00
watches: [SchulzeWinning]
entry: Election::getResult
stack: php
fingerprintLevel: entry
file: src/Algo/Methods/Schulze/SchulzeWinning.php
---
INPUT  {"candidates":["A","B","C"],"votes":["A>B>C"],"method":"Schulze"}
OUTPUT {"1":"A","2":"B","3":"C"}
HASH   abc1234
```

---

## Differences from JS/Python Stacks

| Feature | JS | Python | PHP |
|---------|-----|--------|-----|
| Ghost Proxy | ✅ Native `Proxy` | ✅ `functools.wraps` + decorator | ❌ No proxy — direct invocation |
| `fingerprintLevel: "full"` | ✅ Full call sequence | ✅ Full call sequence | ⚠️ Entry only (manual wrapping) |
| `fingerprintLevel: "entry"` | ✅ | ✅ | ✅ |
| Dynamic import | `import()` | `importlib.import_module()` | `require_once` |
| Class instantiation | Dynamic | Dynamic | `new $className(...$args)` |
| Cross-stack parity | ✅ | ✅ | ✅ |

### PHP Limitation: No Automatic Ghost Proxy

PHP lacks JavaScript's `Proxy` or Python's monkey-patching capabilities. This means:

1. **`fingerprintLevel: "entry"`** works perfectly — it hashes the final output
2. **`fingerprintLevel: "full"`** requires manual instrumentation — you must wrap watched functions yourself
3. **`watches` field** is informational for PHP — it documents what functions contribute to the output but doesn't automatically instrument them

For most refactoring workflows, `fingerprintLevel: "entry"` is sufficient and recommended (as stated in the SKILL.md: "entry is recommended for AI-refactor workflows — most permissive, only cares about final contract").

---

## NPM Script Equivalents for PHP

```json
{
  "regret:capture:php": "php ../../The-skill/regresion-testing/scripts/capture_php.php",
  "regret:validate:php": "php ../../The-skill/regresion-testing/scripts/validate_php.php",
  "regret:drift:php": "php ../../The-skill/regresion-testing/scripts/validate_php.php --runs 5",
  "regret:update:php": "php ../../The-skill/regresion-testing/scripts/validate_php.php --update"
}
```

Or use the unified runner which auto-detects PHP clusters from the manifest:

```json
{
  "regret:capture": "node ../../The-skill/regresion-testing/scripts/regret.js capture",
  "regret:validate": "node ../../The-skill/regresion-testing/scripts/regret.js validate",
  "regret:health": "node ../../The-skill/regresion-testing/scripts/regret.js health"
}
```

---

## Compatibility with JS/Python Manifests

PHP clusters can coexist with JS and Python clusters in the same `manifest.json`. The capture/validate scripts filter by `stack` field:

- `capture.js` only processes `stack: "js"` or `stack: "ts"` clusters
- `capture.py` only processes `stack: "python"` clusters
- `capture_php.php` only processes `stack: "php"` clusters
- `validate.js` validates JS clusters; `validate.py` validates Python clusters; `validate_php.php` validates PHP clusters
- `health.js` and `health.py` both read the same `audit.log` — health reports cover all stacks

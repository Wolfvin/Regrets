# Case Study: MathPHP — Scientific Computing Library in PHP

## Target Repository

**markrogoyski/math-php** — A pure PHP mathematical computing library with zero external dependencies implementing algebra, linear algebra, statistics, probability, number theory, numerical analysis, and more.

- **Stars:** ~2,400
- **Source files:** 166 PHP files, ~40,000 lines
- **Stack:** PHP 7.2+ with PSR-4 autoloading
- **License:** MIT
- **Accepts external PRs:** Yes (multiple merged PRs from external contributors)

---

## Why This Repo Is Challenging for Regrets

### 1. Floating-Point Precision Is Non-Deterministic

MathPHP computes things like `gamma(5.5)`, `beta(2.3, 1.7)`, and eigenvalues of matrices. These computations involve floating-point arithmetic where tiny differences across PHP versions or platforms can cause fingerprints to drift.

**Gap found:** PHP `fingerprint_php.php` had no `floatTolerance` normalization rule. JS had it, but PHP didn't. Without it, every cluster in this repo would be FRAGILE — a math function returning `1.0000000000001` vs `1.0` would create a false negative.

### 2. Static Method Entry Points

MathPHP uses exclusively static methods: `Algebra::gcd()`, `Special::gamma()`, `Finance::pmt()`, `Average::mean()`. The existing PHP `capture_php.php` supports `ClassName::methodName` entry format, but the `receiver` field from capture wasn't supported in validate.

### 3. Pure Functions — Perfect for Entry-Level Fingerprinting

Unlike class-based APIs with state, MathPHP functions are pure: same input always produces same output. This makes `fingerprintLevel: "entry"` the ideal mode. But we needed `floatTolerance` to handle the inherent floating-point imprecision.

### 4. No Ghost Proxy in PHP

PHP doesn't have JavaScript's `Proxy` or Python's monkey-patching. This means `fingerprintLevel: "full"` is impossible without manual instrumentation. For MathPHP, this is actually fine — pure functions don't need watched call sequences.

### 5. Truth Capture Was Missing for PHP

The `regret truth` command only supported JS/TS and Python stacks. For a PHP repo, there was no way to save KEBENARAN 1 and KEBENARAN 2 baselines.

---

## Improvements Made to Regrets

| Improvement | File | What Changed | Why |
|-------------|------|-------------|-----|
| `floatTolerance` normalization | `fingerprint_php.php` | Added float rounding rule matching JS implementation | Math library outputs have floating-point representation differences |
| `floatPrecision` normalization | `fingerprint_php.php` | Added float-to-int normalization for whole-number floats | `1.0` vs `1` difference in math output |
| `deep_clone` fix | `fingerprint_php.php` | Added `JSON_PRESERVE_ZERO_FRACTION` flag | Preserves `1.0` as float instead of converting to int `1` |
| `truth_php.php` | New script | Saves KEBENARAN 1 + KEBENARAN 2 for PHP stacks | No truth capture existed for PHP |
| `regret truth` PHP dispatch | `regret.js` | Added PHP stack support to truth command | Unified runner couldn't dispatch to PHP truth script |
| `regret chain` PHP acknowledgment | `regret.js` | Added PHP stack case with info message | Prepares for future PHP chain testing support |

---

## Cluster Strategy for MathPHP

### Recommended Clusters

| Cluster ID | Entry | File | Description | Normalize |
|------------|-------|------|-------------|-----------|
| `algebra-gcd` | `Algebra::gcd` | `src/Algebra.php` | GCD computation | — |
| `algebra-lcm` | `Algebra::lcm` | `src/Algebra.php` | LCM computation | — |
| `algebra-quadratic` | `Algebra::quadratic` | `src/Algebra.php` | Quadratic equation solver | floatTolerance:8 |
| `special-gamma` | `Special::gamma` | `src/Functions/Special.php` | Gamma function (Lanczos) | floatTolerance:8 |
| `special-beta` | `Special::beta` | `src/Functions/Special.php` | Beta function | floatTolerance:8 |
| `finance-pmt` | `Finance::pmt` | `src/Finance.php` | Loan payment calculation | floatTolerance:6 |
| `average-mean` | `Average::mean` | `src/Statistics/Average.php` | Mean average | — |
| `average-median` | `Average::median` | `src/Statistics/Average.php` | Median average | — |
| `combinatorics-factorial` | `Combinatorics::factorial` | `src/Probability/Combinatorics.php` | Factorial | — |
| `integer-perfect` | `Integer::isPerfectNumber` | `src/NumberTheory/Integer.php` | Perfect number detection | — |

### Key Insight: floatTolerance is Essential

For a math library, `floatTolerance:8` is the right default for most clusters. Without it:
- `gamma(5.5)` might return `52.342777784556` on one run and `52.342777784557` on another
- These tiny differences create false negatives that destroy trust in the tool

---

## Lessons for Future PHP Targets

1. **Always add `floatTolerance` for math/scientific PHP code** — floating-point precision is the #1 source of false positives
2. **Pure functions are the ideal Regrets target** — no state, no side effects, deterministic output
3. **PSR-4 autoloading is straightforward** — `require_once` the file + `new ClassName()` or `ClassName::method()`
4. **PHP's lack of Proxy means entry-level fingerprinting only** — but for most PHP libs, this is sufficient

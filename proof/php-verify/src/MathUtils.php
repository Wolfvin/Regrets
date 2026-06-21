<?php declare(strict_types=1);
/**
 * MathUtils.php — Pure math functions for independent PHP Regrets verification.
 * Uses patterns DIFFERENT from PR #347's fixture to avoid confirmation bias.
 *
 * Patterns covered:
 * - Recursive function (fibonacci)
 * - Function with array input + array output (matrix_sum)
 * - Function with float precision (round_currency)
 * - Static class method (ConfigHelper::merge)
 */

/**
 * Compute nth fibonacci number iteratively.
 * Pure, deterministic — same input always produces same output.
 */
function fibonacci(int $n): int
{
    if ($n <= 0) return 0;
    if ($n === 1) return 1;
    $a = 0;
    $b = 1;
    for ($i = 2; $i <= $n; $i++) {
        $temp = $a + $b;
        $a = $b;
        $b = $temp;
    }
    return $b;
}

/**
 * Sum two 2D matrices element-wise.
 * Each matrix is array<array<int|float>>.
 * Returns the element-wise sum.
 */
function matrix_sum(array $a, array $b): array
{
    $result = [];
    for ($i = 0; $i < count($a); $i++) {
        $row = [];
        for ($j = 0; $j < count($a[$i]); $j++) {
            $row[] = $a[$i][$j] + $b[$i][$j];
        }
        $result[] = $row;
    }
    return $result;
}

/**
 * Round a monetary value to 2 decimal places.
 * Tests float handling in the fingerprint pipeline.
 */
function round_currency(float $amount): float
{
    return round($amount, 2);
}

/**
 * Static class with a merge method.
 * Tests: static method invocation pattern "ClassName::methodName"
 */
class ConfigHelper
{
    /**
     * Deep-merge two associative arrays. Values from $override take precedence.
     * Only handles one level deep (no recursive merge).
     */
    public static function merge(array $base, array $override): array
    {
        $result = $base;
        foreach ($override as $key => $value) {
            $result[$key] = $value;
        }
        return $result;
    }
}

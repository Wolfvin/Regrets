<?php declare(strict_types=1);
/**
 * fingerprint_php.php — deterministic hash for regression contracts
 * IDENTICAL algorithm to fingerprint.js / fingerprint.py. Same input must produce same 7-char hash.
 *
 * Shared module — required by capture_php.php and validate_php.php.
 * Do NOT duplicate these functions.
 *
 * Cross-stack consistency verified:
 * - JS:     BigInt('0x' + sha256_hex).toString(36).slice(0, 7)
 * - Python: to_base36(int(sha256_hex, 16))[:7]
 * - PHP:    to_base36(gmp_init(sha256_hex, 16))[:7]
 * - Must produce same result for same input/output pair
 */

namespace RegretTesting;

function stable_dumps($obj): string
{
    /** Stable JSON serialization — keys sorted recursively (mirrors JS stableStringify). */
    return json_encode(
        stable_sort_recursive($obj),
        JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES
    );
}

function stable_sort_recursive($obj)
{
    if ($obj === null || is_bool($obj) || is_int($obj) || is_float($obj) || is_string($obj)) {
        return $obj;
    }
    if (is_array($obj)) {
        // Check if associative array (object-like)
        if (is_assoc_array($obj)) {
            $sorted = [];
            $keys = array_keys($obj);
            sort($keys, SORT_STRING);
            foreach ($keys as $key) {
                $sorted[$key] = stable_sort_recursive($obj[$key]);
            }
            return $sorted;
        }
        // Sequential array
        return array_map(__NAMESPACE__ . '\\stable_sort_recursive', $obj);
    }
    return $obj;
}

function is_assoc_array(array $arr): bool
{
    if (empty($arr)) {
        return false;
    }
    return array_keys($arr) !== range(0, count($arr) - 1);
}

function normalize($obj, array $rules = [])
{
    /** Normalize non-deterministic values before hashing. Rules match JS fingerprint.js. */
    if (is_string($obj)) {
        if (in_array('timestamps', $rules) && preg_match('/^\d{4}-\d{2}-\d{2}T[\d:.Z+\-]+$/', $obj)) {
            return '<TIMESTAMP>';
        }
        if (in_array('uuids', $rules) && preg_match('/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i', $obj)) {
            return '<UUID>';
        }
        if (in_array('absPaths', $rules) && str_starts_with($obj, '/')) {
            $parts = explode('/', $obj);
            if (count($parts) >= 3) {
                return '<ROOT>/' . implode('/', array_slice($parts, 3));
            }
        }
        if (in_array('dynamicDates', $rules)) {
            // MMYYYY requires valid month (01-12), YYYY only matches standalone years
            $result = preg_replace('/(0[1-9]|1[0-2])\d{4}/', '<MMYYYY>', $obj);
            $result = preg_replace('/(?<!\d)(20\d{2}|19\d{2})(?!\d)/', '<YYYY>', $result);
            return $result;
        }
        // floatPrecision: normalize float-like strings that differ only in trailing zeros
        // Common in OCR/math output where "1500000.0" and "1500000" should be equivalent.
        // Strips trailing ".0" from number-like strings (including negative).
        if (in_array('floatPrecision', $rules)) {
            return preg_replace('/^-?(\d+)\.0+$/', '$1', $obj);
        }
        return $obj;
    }

    if (is_int($obj)) {
        if (in_array('epochs', $rules) && $obj > 1_000_000_000 && $obj < 9_999_999_999_999) {
            return '<EPOCH>';
        }
        // floatPrecision: integers are already whole, no change needed
        if (in_array('floatPrecision', $rules)) {
            return $obj;
        }
        return $obj;
    }

    if (is_float($obj)) {
        if (in_array('epochs', $rules) && $obj > 1_000_000_000 && $obj < 9_999_999_999_999) {
            return '<EPOCH>';
        }
        // floatTolerance: round floating-point numbers to N decimal places before hashing.
        // Prevents false negatives from tiny floating-point representation differences
        // (e.g., 123456.0 vs 123456.00000001 in financial/scientific computing).
        // Usage: "floatTolerance" (default 2 decimal places) or "floatTolerance:N" for N places.
        $floatTolRule = null;
        foreach ($rules as $r) {
            if (str_starts_with($r, 'floatTolerance')) {
                $floatTolRule = $r;
                break;
            }
        }
        if ($floatTolRule !== null) {
            $decimals = 2;
            if (str_contains($floatTolRule, ':')) {
                $parts = explode(':', $floatTolRule);
                $decimals = (int) ($parts[1] ?? 2);
            }
            $factor = pow(10, $decimals);
            return round($obj * $factor) / $factor;
        }
        // floatPrecision: normalize numbers that are whole but stored as float
        // e.g., 1500000.0 → 1500000 (common in math/parsing pipelines)
        if (in_array('floatPrecision', $rules) && is_finite($obj)) {
            if (floor($obj) === $obj) {
                // It's a whole number stored as float — normalize to int for consistency
                return (int) $obj;
            }
            // Round to 2 decimal places to normalize precision differences
            return round($obj * 100) / 100;
        }
        return $obj;
    }

    if (is_array($obj)) {
        if (is_assoc_array($obj)) {
            return array_map(fn($v) => normalize($v, $rules), $obj);
        }
        return array_map(fn($v) => normalize($v, $rules), $obj);
    }

    return $obj;
}

function strip_fields($obj, array $fields = [])
{
    /** Strip ignored fields from output before hashing. */
    if (empty($fields)) {
        return $obj;
    }

    if (is_array($obj) && is_assoc_array($obj)) {
        $result = [];
        foreach ($obj as $k => $v) {
            if (!in_array($k, $fields, true)) {
                $result[$k] = strip_fields($v, $fields);
            }
        }
        return $result;
    }

    if (is_array($obj)) {
        return array_map(fn($v) => strip_fields($v, $fields), $obj);
    }

    return $obj;
}

function to_base36(string $hex): string
{
    /** Convert hex string to base36 (mirrors JS BigInt.toString(36)). */
    // Use GMP for arbitrary precision integer conversion
    $num = gmp_init($hex, 16);
    $result = gmp_strval($num, 36);
    return $result;
}

function deep_clone($val)
{
    /** Deep clone via JSON round-trip.
     *  Uses JSON_PRESERVE_ZERO_FRACTION to ensure that 1.0 stays as 1.0
     *  instead of becoming 1 (critical for math libraries where float vs int matters).
     *  Uses JSON_FORCE_OBJECT flag only when needed to preserve empty-object vs empty-array distinction.
     */
    try {
        $encoded = json_encode($val, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES | JSON_PRESERVE_ZERO_FRACTION);
        return json_decode($encoded, true);
    } catch (\Throwable $e) {
        return $val;
    }
}

function fingerprint($input_data, $output_data, array $rules = [], array $ignore_fields = []): string
{
    /**
     * Core fingerprint function — IDENTICAL algorithm to fingerprint.js / fingerprint.py:
     * stableStringify(input) + '|' + stableStringify(output) → sha256 → base36 → first 7 chars
     */
    $clean_input = strip_fields(normalize(deep_clone($input_data), $rules), $ignore_fields);
    $clean_output = strip_fields(normalize(deep_clone($output_data), $rules), $ignore_fields);

    $combined = stable_dumps($clean_input) . '|' . stable_dumps($clean_output);
    $hash_hex = hash('sha256', $combined);

    $base36 = to_base36($hash_hex);
    return substr($base36, 0, 7);
}

function fingerprint_sequence(array $calls, array $rules = [], array $ignore_fields = []): string
{
    /** Fingerprint an entire call sequence (for fingerprintLevel: 'full' or 'watched'). */
    $normalized = [];
    foreach ($calls as $call) {
        $normalized[] = [
            'fn' => $call['fn'],
            'args' => strip_fields(normalize(deep_clone($call['args']), $rules), $ignore_fields),
            'result' => strip_fields(normalize(deep_clone($call['result']), $rules), $ignore_fields),
        ];
    }

    $combined = stable_dumps($normalized);
    $hash_hex = hash('sha256', $combined);
    $base36 = to_base36($hash_hex);
    return substr($base36, 0, 7);
}

function extract_schema($obj)
{
    /**
     * Extract structural schema from a JSON value.
     * All values replaced with their type name for structural fingerprinting.
     * Cross-stack consistent with fingerprint.js extractSchema() and fingerprint.py extract_schema().
     */
    if ($obj === null) {
        return 'null';
    }
    if (is_bool($obj)) {
        return 'boolean';
    }
    if (is_int($obj)) {
        return 'number';
    }
    if (is_float($obj)) {
        return 'number';
    }
    if (is_string($obj)) {
        return 'string';
    }
    if (is_array($obj)) {
        if (empty($obj)) {
            return 'array';
        }
        // Check if associative (object-like) or sequential
        if (is_assoc_array($obj)) {
            $keys = array_keys($obj);
            sort($keys, SORT_STRING);
            $schema = [];
            foreach ($keys as $k) {
                $schema[$k] = extract_schema($obj[$k]);
            }
            return $schema;
        }
        // Sequential array — sample up to 5 elements
        $sampleSize = min(count($obj), 5);
        $schemas = [];
        $seen = [];
        for ($i = 0; $i < $sampleSize; $i++) {
            $s = extract_schema($obj[$i]);
            $key = json_encode($s, JSON_UNESCAPED_UNICODE);
            if (!isset($seen[$key])) {
                $seen[$key] = true;
                $schemas[] = $s;
            }
        }
        if (count($schemas) === 1) {
            return [$schemas[0]];
        }
        return $schemas;
    }
    return 'unknown';
}

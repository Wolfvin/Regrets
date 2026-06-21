<?php declare(strict_types=1);
/**
 * TextUtils.php — standalone pure functions for the PHP Regrets fixture.
 *
 * Loaded via require_once by capture_php.php / validate_php.php.
 * Functions live in the global namespace so the manifest `entry: "slugify"`
 * resolves directly via function_exists().
 */

/**
 * Slugify a string: lowercase, replace non-alphanumeric runs with single dashes,
 * trim leading/trailing dashes. Empty input returns empty string.
 *
 * Pure, deterministic, no side effects.
 */
function slugify(string $text): string
{
    if ($text === '') {
        return '';
    }
    $lower = strtolower($text);
    $dashed = preg_replace('/[^a-z0-9]+/', '-', $lower);
    return trim($dashed ?? '', '-');
}

/**
 * Count words in a string by splitting on whitespace runs.
 * Returns 0 for empty/whitespace-only input.
 */
function count_words(string $text): int
{
    if (trim($text) === '') {
        return 0;
    }
    $parts = preg_split('/\s+/', trim($text));
    return $parts === false ? 0 : count($parts);
}

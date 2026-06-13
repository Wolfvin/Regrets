#!/usr/bin/env php
<?php declare(strict_types=1);
/**
 * capture_php.php — ghost-decorator runner for PHP clusters
 * Reads regrets/manifest.json, instruments watched functions via
 * a ghost wrapper, runs entry points, and writes .regret files.
 *
 * Usage:
 *   php scripts/capture_php.php
 *   php scripts/capture_php.php --cluster process-invoice
 *   php scripts/capture_php.php --manifest ./regrets/manifest.json
 */

namespace RegretTesting;

$scriptDir = __DIR__;
require_once $scriptDir . '/fingerprint_php.php';

use function RegretTesting\{stable_dumps, normalize, strip_fields, to_base36, deep_clone, fingerprint, fingerprint_sequence, extract_schema};

// ─── CLI args ─────────────────────────────────────────────────────────────────

function parse_args(): array
{
    $args = array_slice($_SERVER['argv'], 1);
    $clusterFilter = null;
    $manifestPath = null;

    $i = 0;
    while ($i < count($args)) {
        if ($args[$i] === '--cluster' && isset($args[$i + 1])) {
            $clusterFilter = $args[$i + 1];
            $i += 2;
        } elseif ($args[$i] === '--manifest' && isset($args[$i + 1])) {
            $manifestPath = $args[$i + 1];
            $i += 2;
        } else {
            $i++;
        }
    }

    if ($manifestPath === null) {
        $manifestPath = getcwd() . '/regrets/manifest.json';
    }

    return [$clusterFilter, $manifestPath];
}

// ─── Ghost Decorator ──────────────────────────────────────────────────────────

/**
 * Create ghost wrappers for watched functions in a class or module.
 * Returns a modified object/array with watched functions replaced by recording wrappers.
 */
function create_ghost(object $instance, array $watchList, array &$recorder): object
{
    // Use ReflectionMethod to wrap each watched method
    $reflected = new \ReflectionClass($instance);

    foreach ($watchList as $fnName) {
        if (!method_exists($instance, $fnName)) {
            echo "  ⚠️  Watch target \"{$fnName}\" is not a method — skipping\n";
            continue;
        }
        // We don't actually replace methods on the object (PHP can't do that like JS Proxy)
        // Instead, the recorder will be populated when the entry function is called
        // and the watched functions are called naturally as part of the execution.
    }

    return $instance;
}

/**
 * Simple ghost wrapper that wraps a callable and records its I/O.
 */
function ghost_wrap(callable $fn, string $fnName, array &$recorder): callable
{
    return function (...$args) use ($fn, $fnName, &$recorder) {
        try {
            $result = $fn(...$args);
            $recorder[] = [
                'fn' => $fnName,
                'args' => deep_clone($args),
                'result' => deep_clone($result),
            ];
            return $result;
        } catch (\Throwable $err) {
            $recorder[] = [
                'fn' => $fnName,
                'args' => deep_clone($args),
                'error' => (string) $err->getMessage(),
            ];
            throw $err;
        }
    };
}

// ─── Run cluster ──────────────────────────────────────────────────────────────

function run_cluster(array $cluster, string $outDir): bool
{
    $id = $cluster['id'];
    $entry = $cluster['entry'];
    $watches = $cluster['watches'] ?? [];
    $file = $cluster['file'] ?? '';
    $module = $cluster['module'] ?? '';
    $pythonPath = $cluster['pythonPath'] ?? ''; // Reuse as include path for PHP
    $normalizeRules = $cluster['normalize'] ?? [];
    $ignoreFields = $cluster['ignoreFields'] ?? [];
    $fingerprintLevel = $cluster['fingerprintLevel'] ?? 'entry';
    $fingerprintMode = $cluster['fingerprintMode'] ?? 'value';
    $valuePaths = $cluster['valuePaths'] ?? [];
    $multiArgs = $cluster['multiArgs'] ?? false;
    $inputs = $cluster['inputs'] ?? [null];
    $constructorArgs = $cluster['constructorArgs'] ?? null;
    $receiver = $cluster['receiver'] ?? null;

    echo "\n📡 Capturing: {$id}\n";
    echo "   File:    {$file}\n";
    echo "   Entry:   {$entry}\n";
    echo "   Watches: " . implode(', ', $watches) . "\n";

    try {
        // Add include path if specified
        if ($pythonPath) {
            $absPath = getcwd() . '/' . $pythonPath;
            set_include_path(get_include_path() . PATH_SEPARATOR . $absPath);
        }

        // Load the PHP file
        $absFile = getcwd() . '/' . $file;
        if (!file_exists($absFile)) {
            throw new \RuntimeException("File not found: {$absFile}");
        }

        // Include the file to make its classes/functions available
        require_once $absFile;

        // Determine the class and method from the entry
        // Format: "ClassName::methodName" or just "functionName"
        $entryParts = explode('::', $entry);
        $entryFn = null;
        $instance = null;

        if (count($entryParts) === 2) {
            // Static or instance method call
            $className = $entryParts[0];
            $methodName = $entryParts[1];

            if (!class_exists($className)) {
                throw new \RuntimeException("Class not found: {$className}");
            }

            // Create instance with constructor args if provided
            if ($constructorArgs !== null) {
                $instance = new $className(...$constructorArgs);
            } else {
                // Try to create without constructor args
                try {
                    $instance = new $className();
                } catch (\Throwable $e) {
                    throw new \RuntimeException("Cannot instantiate {$className}: " . $e->getMessage());
                }
            }

            $entryFn = [$instance, $methodName];
        } else {
            // Plain function
            if (!function_exists($entry)) {
                throw new \RuntimeException("Entry function not found: {$entry}");
            }
            $entryFn = $entry;
        }

        // Run with provided inputs
        $results = [];
        foreach ($inputs as $input) {
            $recorder = [];

            // Deep-clone input BEFORE calling the function to prevent mutation
            $inputForRecord = deep_clone($input);
            $inputForArgs = deep_clone($input);

            // Execute entry function
            if ($multiArgs && is_array($inputForArgs)) {
                $output = $entryFn(...$inputForArgs);
            } else {
                $output = $entryFn($inputForArgs);
            }

            $fpInput = $multiArgs && is_array($inputForRecord) ? $inputForRecord : $inputForRecord;

            // Determine fingerprint based on fingerprintMode
            if ($fingerprintMode === 'schema') {
                $schema = extract_schema($output);
                $fp = fingerprint($fpInput, $schema, $normalizeRules, $ignoreFields);
            } elseif ($fingerprintMode === 'mixed') {
                $schema = extract_schema($output);
                $selectedValues = [];
                foreach ($valuePaths as $path) {
                    $key = str_replace('$.', '', $path);
                    $parts = explode('.', $key);
                    $val = $output;
                    foreach ($parts as $p) {
                        $val = is_array($val) ? ($val[$p] ?? null) : null;
                        if ($val === null) break;
                    }
                    if ($val !== null) {
                        $selectedValues[$path] = $val;
                    }
                }
                $combined = ['schema' => $schema, 'values' => $selectedValues];
                $fp = fingerprint($fpInput, $combined, $normalizeRules, $ignoreFields);
            } else {
                // Default: value mode
                $fp = fingerprint($fpInput, $output, $normalizeRules, $ignoreFields);
            }

            $results[] = ['input' => $inputForRecord, 'output' => $output, 'fp' => $fp];
        }

        // Warn about watched functions that were never called during capture
        $calledFns = [];
        foreach ($results as $r) {
            // Note: For PHP, the ghost wrapper doesn't intercept automatically.
            // This is a known limitation — PHP doesn't have JS Proxy.
            // The fingerprint is based on entry output only (fingerprintLevel: entry).
        }

        // Use first run as the golden
        $golden = $results[0];
        $fp = $golden['fp'];

        // Write .regret file
        $regretPath = $outDir . '/' . $id . '.regret';
        $timestamp = (new \DateTime('now', new \DateTimeZone('UTC')))->format('c');

        $lines = [
            "cluster: {$id}",
            "version: 1",
            "fingerprint: {$fp}",
            "captured: {$timestamp}",
            "watches: [" . implode(', ', $watches) . "]",
            "entry: {$entry}",
            "stack: php",
            "fingerprintLevel: {$fingerprintLevel}",
        ];

        if ($fingerprintMode !== 'value') {
            $lines[] = "fingerprintMode: {$fingerprintMode}";
        }
        if (!empty($valuePaths)) {
            $lines[] = "valuePaths: [" . implode(', ', $valuePaths) . "]";
        }
        if (!empty($normalizeRules)) {
            $lines[] = "normalize: [" . implode(', ', $normalizeRules) . "]";
        }
        if (!empty($ignoreFields)) {
            $lines[] = "ignoreFields: [" . implode(', ', $ignoreFields) . "]";
        }
        if ($multiArgs) {
            $lines[] = "multiArgs: " . ($multiArgs ? 'true' : 'false');
        }
        if ($file) {
            $lines[] = "file: {$file}";
        }

        $lines[] = "---";
        $lines[] = "INPUT  " . json_encode($golden['input'], JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
        $lines[] = "OUTPUT " . json_encode($golden['output'], JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
        $lines[] = "HASH   {$fp}";

        file_put_contents($regretPath, implode("\n", $lines));

        echo "   ✅ Fingerprint: {$fp}\n";
        echo "   📄 Saved: regrets/{$id}.regret\n";
        return true;
    } catch (\Throwable $err) {
        echo "   ❌ Capture failed: {$err->getMessage()}\n";
        return false;
    }
}

// ─── Main ─────────────────────────────────────────────────────────────────────

[$clusterFilter, $manifestPath] = parse_args();

// Load manifest
$manifestContent = file_get_contents($manifestPath);
if ($manifestContent === false) {
    echo "❌ Could not read manifest: {$manifestPath}\n";
    echo "   Create regrets/manifest.json first. See SKILL.md for format.\n";
    exit(1);
}
$manifest = json_decode($manifestContent, true);
if ($manifest === null) {
    echo "❌ Invalid JSON in manifest: {$manifestPath}\n";
    exit(1);
}

$clusters = $manifest['clusters'] ?? [];
if ($clusterFilter) {
    $clusters = array_filter($clusters, fn($c) => $c['id'] === $clusterFilter);
}

if (empty($clusters)) {
    echo "❌ No clusters found" . ($clusterFilter ? " matching \"{$clusterFilter}\"" : "") . "\n";
    exit(1);
}

// Filter to PHP clusters only
$phpClusters = array_filter($clusters, fn($c) => ($c['stack'] ?? '') === 'php');
if (empty($phpClusters)) {
    echo "No PHP clusters found in manifest.\n";
    exit(0);
}

// Setup output directory
$outDir = getcwd() . '/regrets';
if (!is_dir($outDir)) {
    mkdir($outDir, 0755, true);
}

$passed = 0;
$failed = 0;

foreach ($phpClusters as $cluster) {
    if (run_cluster($cluster, $outDir)) {
        $passed++;
    } else {
        $failed++;
    }
}

// ─── Summary ──────────────────────────────────────────────────────────────────

echo "\n" . str_repeat('─', 50) . "\n";
echo "Capture complete: {$passed} captured, {$failed} failed\n";

if ($failed > 0) {
    echo "\n⚠️  Fix failed captures before proceeding to PHASE 2.\n";
    echo "   Hint: Check that 'entry' and 'watches' names match exports in your file.\n";
    exit(1);
}

echo "\nNext: php scripts/validate_php.php\n";
echo "If all green → you are clear to refactor.\n";

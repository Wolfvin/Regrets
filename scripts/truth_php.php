#!/usr/bin/env php
<?php declare(strict_types=1);
/**
 * truth_php.php — Save dual truth baselines before refactoring (PHP stack)
 * KEBENARAN 1: Raw output from every entry function
 * KEBENARAN 2: Fingerprint contracts from .regret files + chain hashes
 *
 * Usage:
 *   php scripts/truth_php.php
 *   php scripts/truth_php.php --outdir ./proof/myproject
 *
 * Both truths must be identical in meaning. If they disagree,
 * there's a false negative in Regrets — fix it before refactoring.
 */

namespace RegretTesting;

$scriptDir = __DIR__;
require_once $scriptDir . '/fingerprint_php.php';

use function RegretTesting\{stable_dumps, normalize, strip_fields, to_base36, deep_clone, fingerprint, fingerprint_sequence, extract_schema};

// ─── CLI args ─────────────────────────────────────────────────────────────────

$args = array_slice($_SERVER['argv'], 1);
$outdirIdx = array_search('--outdir', $args);
$outDir = $outdirIdx !== false && isset($args[$outdirIdx + 1])
    ? $args[$outdirIdx + 1]
    : getcwd() . '/proof';
$manifestPath = getcwd() . '/regrets/manifest.json';

// ─── Load manifest ────────────────────────────────────────────────────────────

$manifestContent = file_get_contents($manifestPath);
if ($manifestContent === false) {
    echo "❌ Could not read manifest: {$manifestPath}\n";
    exit(1);
}
$manifest = json_decode($manifestContent, true);

// ─── KEBENARAN 1: Raw Output ─────────────────────────────────────────────────

echo "\n📡 Saving KEBENARAN 1 — Raw output from PHP entry functions\n\n";

$rawOutputs = [];

foreach ($manifest['clusters'] as $cluster) {
    $id = $cluster['id'];
    $entry = $cluster['entry'];
    $file = $cluster['file'] ?? '';
    $stack = $cluster['stack'] ?? 'php';
    $inputs = $cluster['inputs'] ?? [null];
    $multiArgs = $cluster['multiArgs'] ?? false;
    $constructorArgs = $cluster['constructorArgs'] ?? null;

    if ($stack !== 'php') {
        echo "  ⏭️  {$id}: stack={$stack} — skipping (use truth.js for JS/TS)\n";
        continue;
    }

    try {
        // Load the PHP file
        $absFile = getcwd() . '/' . $file;
        if (file_exists($absFile)) {
            require_once $absFile;
        }

        // Determine the entry callable
        $entryParts = explode('::', $entry);
        $entryFn = null;

        if (count($entryParts) === 2) {
            $className = $entryParts[0];
            $methodName = $entryParts[1];
            if (!class_exists($className)) {
                throw new \RuntimeException("Class not found: {$className}");
            }
            if ($constructorArgs !== null) {
                $instance = new $className(...$constructorArgs);
            } else {
                $instance = new $className();
            }
            $entryFn = [$instance, $methodName];
        } else {
            if (!function_exists($entry)) {
                throw new \RuntimeException("Entry function not found: {$entry}");
            }
            $entryFn = $entry;
        }

        $outputs = [];
        foreach ($inputs as $input) {
            $inputForArgs = deep_clone($input);
            if ($multiArgs && is_array($inputForArgs)) {
                $output = $entryFn(...$inputForArgs);
            } else {
                $output = $entryFn($inputForArgs);
            }
            $outputs[] = ['input' => deep_clone($input), 'output' => deep_clone($output)];
        }
        $rawOutputs[$id] = $outputs;
        echo "  ✅ {$id}\n";
    } catch (\Throwable $err) {
        echo "  ❌ {$id}: {$err->getMessage()}\n";
    }
}

// ─── KEBENARAN 2: Fingerprint Contracts ───────────────────────────────────────

echo "\n📡 Saving KEBENARAN 2 — Fingerprint contracts from .regret files\n\n";

$fingerprints = [];
$regretDir = getcwd() . '/regrets';

foreach (glob($regretDir . '/*.regret') ?: [] as $file) {
    $content = file_get_contents($file);
    if ($content === false) continue;

    $id = basename($file, '.regret');
    $fpMatch = null;
    $hashMatch = null;
    $clusterMatch = null;
    $capturedMatch = null;
    $entryMatch = null;
    $outputMatch = null;

    if (preg_match('/^fingerprint:\s+(\S+)/m', $content, $m)) $fpMatch = $m[1];
    if (preg_match('/^HASH\s+(\S+)/m', $content, $m)) $hashMatch = $m[1];
    if (preg_match('/^cluster:\s+(.+)$/m', $content, $m)) $clusterMatch = trim($m[1]);
    if (preg_match('/^captured:\s+(.+)$/m', $content, $m)) $capturedMatch = trim($m[1]);
    if (preg_match('/^entry:\s+(.+)$/m', $content, $m)) $entryMatch = trim($m[1]);
    if (preg_match('/^OUTPUT\s+(.+)$/m', $content, $m)) $outputMatch = json_decode($m[1], true);

    $fid = $clusterMatch ?: $id;
    $fingerprints[$fid] = [
        'fingerprint' => $fpMatch,
        'hash' => $hashMatch,
        'captured' => $capturedMatch,
        'entry' => $entryMatch,
        'golden_output' => $outputMatch,
    ];
    echo "  ✅ {$fid}: " . ($fpMatch ?: 'no fingerprint') . "\n";
}

// Read chain hashes
$chains = [];
$chainsDir = $regretDir . '/chains';
if (is_dir($chainsDir)) {
    foreach (glob($chainsDir . '/*.chain') ?: [] as $file) {
        $content = file_get_contents($file);
        if ($content === false) continue;
        $chainHashMatch = null;
        if (preg_match('/^chain_hash:\s+(\S+)/m', $content, $m)) $chainHashMatch = $m[1];
        $chainId = basename($file, '.chain');
        $chains[$chainId] = ['chainHash' => $chainHashMatch];
        echo "  ✅ chain/{$chainId}: " . ($chainHashMatch ?: 'no hash') . "\n";
    }
}

// ─── Consistency Check ───────────────────────────────────────────────────────

$k1Ids = array_keys($rawOutputs);
$k2Ids = array_keys($fingerprints);

$inK1NotK2 = array_diff($k1Ids, $k2Ids);
$inK2NotK1 = array_diff($k2Ids, $k1Ids);

if (!empty($inK1NotK2) || !empty($inK2NotK1)) {
    echo "\n❌ INCONSISTENCY between KEBENARAN 1 and KEBENARAN 2:\n";
    if (!empty($inK1NotK2)) echo "   In K1 but not K2: " . implode(', ', $inK1NotK2) . "\n";
    if (!empty($inK2NotK1)) echo "   In K2 but not K1: " . implode(', ', $inK2NotK1) . "\n";
    echo "   Fix this before refactoring — it indicates a false negative.\n";
    exit(1);
}

// ─── Write Output Files ───────────────────────────────────────────────────────

$projectName = $manifest['projectName'] ?? basename(getcwd());
$proofDir = $outdirIdx !== false ? $outDir : $outDir . '/' . $projectName;

if (!is_dir($proofDir)) {
    mkdir($proofDir, 0755, true);
}

$k1Path = $proofDir . '/KEBENARAN_1_raw_output.json';
$k2Path = $proofDir . '/KEBENARAN_2_fingerprints.json';

file_put_contents($k1Path, json_encode($rawOutputs, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES | JSON_PRETTY_PRINT) . "\n");
file_put_contents($k2Path, json_encode(['fingerprints' => $fingerprints, 'chains' => $chains], JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES | JSON_PRETTY_PRINT) . "\n");

echo "\n" . str_repeat('─', 50) . "\n";
echo "✅ Both truths saved:\n";
echo "   KEBENARAN 1: {$k1Path} (" . count($rawOutputs) . " clusters)\n";
echo "   KEBENARAN 2: {$k2Path} (" . count($fingerprints) . " fingerprints, " . count($chains) . " chains)\n";
echo "\n   Consistency: ✅ Both truths are aligned\n";
echo "\nYou are now safe to refactor. Run 'regret validate' after each change.\n";

#!/usr/bin/env php
<?php declare(strict_types=1);
/**
 * validate_php.php — regression validator for PHP clusters
 * Reads .regret files and validates fingerprints against current code.
 *
 * Usage:
 *   php scripts/validate_php.php
 *   php scripts/validate_php.php --cluster process-invoice
 *   php scripts/validate_php.php --runs 5
 *   php scripts/validate_php.php --update process-invoice --reason "tax rate changed"
 *   php scripts/validate_php.php --fail-fast
 */

namespace RegretTesting;

$scriptDir = __DIR__;
require_once $scriptDir . '/fingerprint_php.php';

use function RegretTesting\{stable_dumps, normalize, strip_fields, to_base36, deep_clone, fingerprint, fingerprint_sequence, extract_schema};

// ─── CLI args ─────────────────────────────────────────────────────────────────

function get_arg(array $args, string $flag): ?string
{
    $i = array_search($flag, $args);
    return $i !== false && isset($args[$i + 1]) ? $args[$i + 1] : null;
}

$args = array_slice($_SERVER['argv'], 1);
$clusterFilter = get_arg($args, '--cluster');
$failFast = in_array('--fail-fast', $args);
$runs = (int) (get_arg($args, '--runs') ?? '1');
$updateTarget = get_arg($args, '--update');
$updateReason = get_arg($args, '--reason');
$manifestPath = get_arg($args, '--manifest') ?? getcwd() . '/regrets/manifest.json';
$regretDir = getcwd() . '/regrets';
$auditLog = $regretDir . '/audit.log';

// ─── Validate --update usage ──────────────────────────────────────────────────

if ($updateTarget && !$updateReason) {
    echo "❌ --update requires --reason\n";
    echo "   Example: --update process-invoice --reason \"describe why behavior changed\"\n";
    exit(1);
}

if ($updateReason && str_word_count($updateReason) < 4) {
    echo "❌ --reason is too vague: \"{$updateReason}\"\n";
    echo "   Be specific. e.g. \"tax rate updated from 11% to 12% per new regulation\"\n";
    exit(1);
}

// ─── Parse a .regret file ─────────────────────────────────────────────────────

function parse_regret(string $content): array
{
    $sections = explode("\n---\n", $content, 2);
    $metaSection = $sections[0];
    $dataSection = $sections[1] ?? '';

    $meta = [];
    foreach (explode("\n", $metaSection) as $line) {
        $colonIdx = strpos($line, ': ');
        if ($colonIdx === false) continue;
        $key = substr($line, 0, $colonIdx);
        $val = trim(substr($line, $colonIdx + 2));

        if ($key === 'watches') {
            $meta['watches'] = array_filter(array_map('trim', explode(',', trim($val, '[]'))));
        } elseif ($key === 'normalize') {
            $meta['normalize'] = array_filter(array_map('trim', explode(',', trim($val, '[]'))));
        } elseif ($key === 'ignoreFields') {
            $meta['ignoreFields'] = array_filter(array_map('trim', explode(',', trim($val, '[]'))));
        } elseif ($key === 'valuePaths') {
            $meta['valuePaths'] = array_filter(array_map('trim', explode(',', trim($val, '[]'))));
        } elseif ($key === 'version') {
            $meta['version'] = (int) $val;
        } elseif ($key === 'multiArgs') {
            $meta['multiArgs'] = $val === 'true';
        } else {
            $meta[$key] = $val;
        }
    }

    $lines = explode("\n", $dataSection);
    $inputLine = null;
    $outputLine = null;
    $hashLine = null;

    foreach ($lines as $line) {
        if (str_starts_with($line, 'INPUT ')) $inputLine = $line;
        if (str_starts_with($line, 'OUTPUT ')) $outputLine = $line;
        if (str_starts_with($line, 'HASH ')) $hashLine = $line;
    }

    $parsedInput = null;
    $parsedOutput = null;

    if ($inputLine) {
        $inputStr = preg_replace('/^INPUT\s+/', '', $inputLine);
        $parsedInput = $inputStr === 'undefined' ? null : json_decode($inputStr, true);
    }
    if ($outputLine) {
        $outputStr = preg_replace('/^OUTPUT\s+/', '', $outputLine);
        $parsedOutput = $outputStr === 'undefined' ? null : json_decode($outputStr, true);
    }

    return [
        ...$meta,
        'input' => $parsedInput,
        'output' => $parsedOutput,
        'goldenHash' => $hashLine ? trim(preg_replace('/^HASH\s+/', '', $hashLine)) : null,
        'raw' => $content,
    ];
}

// ─── Load manifest ────────────────────────────────────────────────────────────

$manifestContent = file_get_contents($manifestPath);
if ($manifestContent === false) {
    echo "❌ Could not read manifest: {$manifestPath}\n";
    exit(1);
}
$manifest = json_decode($manifestContent, true);

// ─── Find .regret files ───────────────────────────────────────────────────────

$filterId = $clusterFilter ?? $updateTarget ?? null;
$regretFiles = [];
foreach (glob($regretDir . '/*.regret') ?: [] as $file) {
    $id = basename($file, '.regret');
    if (!$filterId || $id === $filterId) {
        $regretFiles[] = basename($file);
    }
}

if (empty($regretFiles)) {
    echo "❌ No .regret files found" . ($filterId ? " for \"{$filterId}\"" : "") . ".\n";
    exit(1);
}

// ─── Run cluster N times ──────────────────────────────────────────────────────

function run_cluster(array $clusterDef, array $regret, int $runs): array
{
    $entry = $clusterDef['entry'];
    $file = $clusterDef['file'] ?? '';
    $normalizeRules = $clusterDef['normalize'] ?? [];
    $ignoreFields = $clusterDef['ignoreFields'] ?? [];
    $fingerprintLevel = $clusterDef['fingerprintLevel'] ?? 'entry';
    $multiArgs = $clusterDef['multiArgs'] ?? false;
    $fingerprintMode = $regret['fingerprintMode'] ?? $clusterDef['fingerprintMode'] ?? 'value';
    $valuePaths = $regret['valuePaths'] ?? $clusterDef['valuePaths'] ?? [];
    $constructorArgs = $clusterDef['constructorArgs'] ?? null;

    // Load the PHP file
    $absFile = getcwd() . '/' . $file;
    if (file_exists($absFile)) {
        require_once $absFile;
    }

    $hashes = [];
    $hashesPerInput = [];
    $lastOutput = null;
    $firstOutput = null;  // output corresponding to $hashes[0] — used by --update

    // Determine which inputs to validate
    $allInputs = $clusterDef['inputs'] ?? [$regret['input']];
    $inputsToValidate = [$regret['input']];
    foreach ($allInputs as $inp) {
        if (json_encode($inp) !== json_encode($regret['input'])) {
            $inputsToValidate[] = $inp;
        }
    }

    for ($i = 0; $i < $runs; $i++) {
        foreach ($inputsToValidate as $currentInput) {
            $inputForFp = deep_clone($currentInput);
            $inputForArgs = deep_clone($currentInput);

            // Determine the entry callable
            $entryParts = explode('::', $entry);
            if (count($entryParts) === 2) {
                $className = $entryParts[0];
                $methodName = $entryParts[1];
                if ($constructorArgs !== null) {
                    $instance = new $className(...$constructorArgs);
                } else {
                    $instance = new $className();
                }
                $entryFn = [$instance, $methodName];
            } else {
                $entryFn = $entry;
            }

            if ($multiArgs && is_array($inputForArgs)) {
                $output = $entryFn(...$inputForArgs);
            } else {
                $output = $entryFn($inputForArgs);
            }

            $lastOutput = $output;
            if ($firstOutput === null) {
                $firstOutput = $output;  // captured on the very first iteration
            }
            $fpInput = $multiArgs && is_array($inputForFp) ? $inputForFp : $inputForFp;

            // Determine fingerprint
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
                $fp = fingerprint($fpInput, $output, $normalizeRules, $ignoreFields);
            }

            $hashes[] = $fp;

            // Track per-input hashes for drift detection
            $inputKey = json_encode($currentInput);
            if (!isset($hashesPerInput[$inputKey])) {
                $hashesPerInput[$inputKey] = [];
            }
            $hashesPerInput[$inputKey][] = $fp;
        }
    }

    return ['hashes' => $hashes, 'hashesPerInput' => $hashesPerInput, 'lastOutput' => $lastOutput, 'firstOutput' => $firstOutput];
}

// ─── Update a .regret ─────────────────────────────────────────────────────────

function update_regret(string $regretPath, array $regret, string $newHash, $liveOutput, string $reason): array
{
    $oldHash = $regret['goldenHash'];
    $now = (new \DateTime('now', new \DateTimeZone('UTC')))->format('c');
    $safeReason = preg_replace('/[\r\n]+/', ' ', $reason);

    $newContent = $regret['raw'];
    $newContent = preg_replace('/^fingerprint: .+$/m', "fingerprint: {$newHash}", $newContent);
    $newContent = preg_replace('/^captured: .+$/m', "captured: {$now}", $newContent);
    $newContent = preg_replace('/^OUTPUT .+$/m', "OUTPUT " . json_encode($liveOutput, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES), $newContent);
    $newContent = preg_replace('/^HASH .+$/m', "HASH   {$newHash}", $newContent);

    file_put_contents($regretPath, $newContent);

    // Hash chain
    $auditLog = getcwd() . '/regrets/audit.log';
    $prevChain = '0000000';
    if (file_exists($auditLog)) {
        $logContent = trim(file_get_contents($auditLog));
        if (!empty($logContent)) {
            $lines = explode("\n", $logContent);
            for ($i = count($lines) - 1; $i >= 0; $i--) {
                if (preg_match('/^\s*chain:\s*(\S+)/', $lines[$i], $m)) {
                    $prevChain = $m[1];
                    break;
                }
            }
        }
    }

    $clusterId = basename($regretPath, '.regret');
    $newEntryContent = "{$now}  UPDATE  {$clusterId}\n  old: {$oldHash}\n  new: {$newHash}\n  reason: {$safeReason}\n  by: AI refactor session";
    $chainHash = substr(hash('sha256', $prevChain . $newEntryContent), 0, 7);

    $entry = "\n{$newEntryContent}\n  chain: {$chainHash}";
    file_put_contents($auditLog, $entry, FILE_APPEND);

    return ['oldHash' => $oldHash, 'newHash' => $newHash];
}

// ─── Main ─────────────────────────────────────────────────────────────────────

$updateMode = !!$updateTarget;
$driftMode = $runs > 1 && !$updateMode;

if ($updateMode) {
    echo "\n🔄 Update mode — cluster: {$updateTarget}\n   Reason: {$updateReason}\n\n";
} elseif ($driftMode) {
    echo "\n🔍 Drift detection — {$runs} runs per cluster...\n\n";
} else {
    echo "\n🔍 Validating " . count($regretFiles) . " cluster(s)...\n\n";
}

$results = [];

foreach ($regretFiles as $file) {
    $id = basename($file, '.regret');
    $regretPath = $regretDir . '/' . $file;
    $regret = parse_regret(file_get_contents($regretPath));

    // Find matching cluster definition
    $def = null;
    foreach ($manifest['clusters'] as $c) {
        if ($c['id'] === $id) {
            $def = $c;
            break;
        }
    }
    if (!$def) {
        echo "  ⚠️  {$id}: not in manifest — skipping\n";
        continue;
    }

    try {
        $runResult = run_cluster($def, $regret, $runs);
        $hashes = $runResult['hashes'];
        $hashesPerInput = $runResult['hashesPerInput'];
        $lastOutput = $runResult['lastOutput'];
        $firstOutput = $runResult['firstOutput'];

        $liveHash = $hashes[0];
        $isMatch = $liveHash === $regret['goldenHash'];

        // Per-input drift detection
        $isDrift = false;
        if ($driftMode) {
            foreach ($hashesPerInput as $inputHashes) {
                if (count(array_unique($inputHashes)) > 1) {
                    $isDrift = true;
                    break;
                }
            }
        }

        $idPadded = str_pad($id, 35);

        if ($updateMode) {
            if ($isMatch) {
                echo "  ℹ️  {$idPadded} unchanged — no update needed\n";
                $results[] = ['id' => $id, 'pass' => true];
            } else {
                // BUGFIX: --update must write the FIRST input's output to the .regret file,
                // not the last. The HASH field is computed from $hashes[0] (= first input),
                // so the OUTPUT field must match that same input — otherwise the .regret
                // file ends up with INPUT="first input" + OUTPUT="last input's output"
                // + HASH="first input's hash", which is internally inconsistent.
                $updateResult = update_regret($regretPath, $regret, $liveHash, $firstOutput, $updateReason);
                echo "  ✅ {$idPadded} {$updateResult['oldHash']} → {$updateResult['newHash']}  UPDATED\n";
                $results[] = ['id' => $id, 'pass' => true, 'updated' => true];
            }
        } elseif ($driftMode) {
            if ($isDrift) {
                echo "  ❌ {$idPadded} DRIFT  [" . implode(' / ', $hashes) . "]\n";
                $results[] = ['id' => $id, 'pass' => false, 'drift' => true];
            } else {
                $icon = $isMatch ? '✅' : '❌';
                echo "  {$icon} {$idPadded} {$liveHash}  × {$runs}  " . ($isMatch ? 'PASS+STABLE' : 'FAIL') . "\n";
                $results[] = ['id' => $id, 'pass' => $isMatch];
            }
        } else {
            $icon = $isMatch ? '✅' : '❌';
            $hstr = $isMatch ? $regret['goldenHash'] : "{$regret['goldenHash']} → {$liveHash}";
            echo "  {$icon} {$idPadded} " . str_pad($hstr, 22) . " " . ($isMatch ? 'PASS' : 'FAIL') . "\n";
            $results[] = ['id' => $id, 'pass' => $isMatch, 'golden' => $regret['goldenHash'], 'live' => $liveHash];
        }
    } catch (\Throwable $err) {
        echo "  ❌ " . str_pad($id, 35) . " ERROR: {$err->getMessage()}\n";
        $results[] = ['id' => $id, 'pass' => false, 'error' => $err->getMessage()];
    }

    $lastResult = $results[count($results) - 1];
    if (!$lastResult['pass'] && $failFast) {
        echo "\n  --fail-fast: stopping.\n";
        break;
    }
}

// ─── Summary ──────────────────────────────────────────────────────────────────

$passed = count(array_filter($results, fn($r) => $r['pass']));
$failed = count(array_filter($results, fn($r) => !$r['pass']));
$drifted = count(array_filter($results, fn($r) => isset($r['drift']) && $r['drift']));

echo "\n" . str_repeat('─', 60) . "\n";

if ($updateMode) {
    $updated = count(array_filter($results, fn($r) => isset($r['updated']) && $r['updated']));
    echo "✅ Update complete. {$updated} updated.\n   Audit: regrets/audit.log\n";
    exit(0);
}
if ($driftMode && $drifted > 0) {
    echo "❌ Drift in {$drifted} cluster(s). Add normalize rules and re-capture.\n";
    exit(1);
}
if ($failed === 0) {
    echo "✅ All {$passed} tests passed" . ($driftMode ? " ({$runs} runs — stable)" : "") . ". Refactor is safe.\n\n";
    exit(0);
}
echo "❌ {$failed}/" . count($results) . " FAILED.\n\n";
foreach (array_filter($results, fn($r) => !$r['pass']) as $r) {
    echo "  • {$r['id']}\n";
    if (isset($r['error'])) {
        echo "    {$r['error']}\n";
    } else {
        echo "    Expected: {$r['golden']}  Got: {$r['live']}\n";
    }
}
echo "\nFix the CODE — do not edit .regret files.\nRe-run: php scripts/validate_php.php\n";
exit(1);

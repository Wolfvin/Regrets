#!/usr/bin/env node
// validate_css.mjs — CSS regression validator
// Reads .regret files, re-extracts CSS declarations, compares fingerprints.
//
// Usage:
//   node scripts/validate_css.mjs
//   node scripts/validate_css.mjs --cluster cue-enter
//   node scripts/validate_css.mjs --manifest ./regrets/manifest.json
//   node scripts/validate_css.mjs --fail-fast
//   node scripts/validate_css.mjs --quiet

import { readFileSync, writeFileSync, existsSync, readdirSync } from 'fs';
import { resolve, join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { createHash } from 'crypto';
import postcss from 'postcss';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ─── Fingerprint (identical to capture_css.mjs) ──────────────────────────────

function stableStringify(obj) {
  if (obj === null || obj === undefined) return String(obj);
  if (typeof obj === 'number') {
    if (Number.isNaN(obj)) return '"__nan__"';
    if (obj === Infinity) return '"__infinity__"';
    if (obj === -Infinity) return '"__neg_infinity__"';
  }
  if (typeof obj === 'bigint') return '__bigint__:' + obj.toString();
  if (typeof obj === 'function') return '"__function__"';
  if (typeof obj === 'symbol') return '"__symbol__"';
  if (obj instanceof Date) return JSON.stringify(obj.toISOString());
  if (obj instanceof Map) {
    const entries = [...obj.entries()].sort((a, b) => String(a[0]).localeCompare(String(b[0])));
    return JSON.stringify(entries);
  }
  if (obj instanceof Set) {
    return JSON.stringify([...obj].sort());
  }
  if (Array.isArray(obj)) {
    return '[' + obj.map(stableStringify).join(',') + ']';
  }
  if (typeof obj === 'object') {
    const keys = Object.keys(obj).sort();
    const pairs = keys.map(k => JSON.stringify(k) + ':' + stableStringify(obj[k]));
    return '{' + pairs.join(',') + '}';
  }
  return JSON.stringify(obj);
}

function fingerprint(input, output) {
  const inputStr = stableStringify(input);
  const outputStr = stableStringify(output);
  const hash = createHash('sha256').update(inputStr + '|' + outputStr).digest('hex');
  // Convert to base36 (BigInteger) — uses the FULL 256-bit hash to match
  // scripts/fingerprint.js. Previously this used only the first 16 hex chars
  // (64 bits), which broke cross-stack parity (CSS hash != JS hash for the
  // same input/output). Issue #356 verification.
  const num = BigInt('0x' + hash);
  return num.toString(36).slice(0, 7);
}

// ─── CSS Declaration Extraction (identical to capture_css.mjs) ───────────────

function extractDeclarations(cssContent, targetSelector) {
  const root = postcss.parse(cssContent);
  const declarations = [];

  root.walkRules((rule) => {
    const selectors = rule.selectors;
    let matched = false;

    for (const sel of selectors) {
      const normalizedSel = sel.trim();
      const normalizedTarget = targetSelector.trim();

      if (normalizedSel === normalizedTarget) {
        matched = true;
        break;
      }

      if (normalizedSel.startsWith(normalizedTarget)) {
        const remainder = normalizedSel.substring(normalizedTarget.length);
        if (remainder.length > 0 && (remainder.startsWith(':') || remainder.startsWith('['))) {
          matched = true;
          break;
        }
      }
    }

    if (matched) {
      rule.walkDecls((decl) => {
        declarations.push(`${decl.prop}: ${decl.value}`);
      });
    }
  });

  declarations.sort();
  return declarations;
}

// ─── .regret file parser ─────────────────────────────────────────────────────

function parseRegret(content) {
  const lines = content.split('\n');
  const sepIdx = lines.findIndex(l => l.trim() === '---');

  const meta = {};
  const metaLines = sepIdx >= 0 ? lines.slice(0, sepIdx) : lines;
  for (const line of metaLines) {
    const colonIdx = line.indexOf(':');
    if (colonIdx > 0) {
      const key = line.substring(0, colonIdx).trim();
      const value = line.substring(colonIdx + 1).trim();
      meta[key] = value;
    }
  }

  const dataLines = sepIdx >= 0 ? lines.slice(sepIdx + 1) : [];
  let input = null, output = null, hash = null;

  for (const line of dataLines) {
    if (line.startsWith('INPUT ')) {
      input = JSON.parse(line.substring(6));
    } else if (line.startsWith('OUTPUT ')) {
      output = JSON.parse(line.substring(7));
    } else if (line.startsWith('HASH ')) {
      hash = line.substring(5).trim();
    }
  }

  return { meta, input, output, hash };
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2);
  let clusterFlag = null;
  let manifestPath = 'regrets/manifest.json';
  let failFast = false;
  let quiet = false;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--cluster' && args[i + 1]) {
      clusterFlag = args[i + 1];
      i++;
    } else if (args[i] === '--manifest' && args[i + 1]) {
      manifestPath = args[i + 1];
      i++;
    } else if (args[i] === '--fail-fast') {
      failFast = true;
    } else if (args[i] === '--quiet') {
      quiet = true;
    }
  }

  const manifestFullPath = resolve(manifestPath);
  const manifestDir = dirname(manifestFullPath);

  if (!existsSync(manifestFullPath)) {
    console.error(`✗ Manifest not found: ${manifestFullPath}`);
    process.exit(1);
  }

  const manifest = JSON.parse(readFileSync(manifestFullPath, 'utf8'));
  const clusters = (manifest.clusters || []).filter(c => c.stack === 'css');

  if (clusters.length === 0) {
    console.log('No CSS clusters found in manifest.');
    process.exit(0);
  }

  const targetClusters = clusterFlag
    ? clusters.filter(c => c.id === clusterFlag)
    : clusters;

  const regretDir = manifestDir;
  let passed = 0;
  let failed = 0;
  let skipped = 0;

  for (const cluster of targetClusters) {
    const { id, entry, file: cssFile } = cluster;
    const regretPath = join(regretDir, `${id}.regret`);

    if (!existsSync(regretPath)) {
      console.error(`✗ ${id}: .regret file not found — run capture first`);
      failed++;
      if (failFast) break;
      continue;
    }

    const regretContent = readFileSync(regretPath, 'utf8');
    const { meta, input, output: goldenOutput, hash: goldenHash } = parseRegret(regretContent);

    // Re-extract from current CSS
    const cssFilePath = resolve(manifestDir, cssFile || meta.file);
    if (!existsSync(cssFilePath)) {
      console.error(`✗ ${id}: CSS file not found: ${cssFilePath}`);
      failed++;
      if (failFast) break;
      continue;
    }

    const cssContent = readFileSync(cssFilePath, 'utf8');
    const selector = entry || meta.entry;
    const currentDeclarations = extractDeclarations(cssContent, selector);

    // Recompute fingerprint using the SAME input from the .regret file
    const currentHash = fingerprint(input, currentDeclarations);

    if (currentHash === goldenHash) {
      if (!quiet) {
        console.log(`✓ ${id}: PASS (${currentHash})`);
      }
      passed++;
    } else {
      console.error(`✗ ${id}: FAIL`);
      console.error(`  Expected hash: ${goldenHash}`);
      console.error(`  Actual hash:   ${currentHash}`);

      // Show diff
      const goldenDecls = goldenOutput || [];
      const currentSet = new Set(currentDeclarations);
      const goldenSet = new Set(goldenDecls);

      const removed = goldenDecls.filter(d => !currentSet.has(d));
      const added = currentDeclarations.filter(d => !goldenSet.has(d));

      if (removed.length > 0) {
        console.error(`  Removed declarations:`);
        for (const d of removed) {
          console.error(`    - ${d}`);
        }
      }
      if (added.length > 0) {
        console.error(`  Added declarations:`);
        for (const d of added) {
          console.error(`    + ${d}`);
        }
      }
      if (removed.length === 0 && added.length === 0) {
        console.error(`  (Same declarations but different order or normalization)`);
      }

      failed++;
      if (failFast) break;
    }
  }

  if (!quiet) {
    console.log(`\n🔍 ${passed}/${passed + failed + skipped} CSS clusters passed`);
  }

  process.exit(failed > 0 ? 1 : 0);
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});

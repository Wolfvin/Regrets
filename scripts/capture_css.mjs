#!/usr/bin/env node
// capture_css.mjs — CSS regression capture
// Reads regrets/manifest.json, extracts CSS declarations for each cluster's
// selector, computes fingerprint, writes .regret files.
//
// Usage:
//   node scripts/capture_css.mjs
//   node scripts/capture_css.mjs --cluster cue-enter
//   node scripts/capture_css.mjs --manifest ./regrets/manifest.json
//   node scripts/capture_css.mjs --quiet

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { resolve, join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { createHash } from 'crypto';
import postcss from 'postcss';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ─── Fingerprint (identical algorithm to fingerprint.js) ─────────────────────

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
  // Convert FULL 256-bit hash to base36, take first 7 chars.
  // MUST match `fingerprint.js` (JS) / `fingerprint.py` (Python) / Rust /
  // Go / C / etc. for cross-stack .regret parity. Using only the first 16
  // hex chars (64 bits) was a bug in the original PR #366 — it produced
  // different 7-char hashes than the JS stack for the same input/output,
  // breaking the cross-stack contract. The bug was caught during
  // independent re-verification (PR: feat/css-verify).
  const num = BigInt('0x' + hash);
  return num.toString(36).slice(0, 7);
}

// ─── CSS Declaration Extraction ──────────────────────────────────────────────

/**
 * Extract all declarations for a given selector from CSS content.
 * Returns a sorted array of "property: value" strings.
 *
 * Handles:
 * - Simple selectors: .cue-enter
 * - Compound selectors: .cue-enter.cue-hover
 * - Attribute selectors: .cue-dropdown[data-status="open"]
 * - Pseudo-classes: .cue-enter:hover
 * - Descendant selectors (only extracts the rule if the FULL selector matches)
 * - @media queries (includes media condition in the key)
 */
function extractDeclarations(cssContent, targetSelector) {
  const root = postcss.parse(cssContent);
  const declarations = [];

  root.walkRules((rule) => {
    // Check if any of the rule's selectors match our target
    const selectors = rule.selectors;
    let matched = false;

    for (const sel of selectors) {
      // Normalize both selectors for comparison
      const normalizedSel = sel.trim();
      const normalizedTarget = targetSelector.trim();

      if (normalizedSel === normalizedTarget) {
        matched = true;
        break;
      }

      // Also check if target is a prefix (e.g., ".cue-enter" matches ".cue-enter:hover")
      // But NOT if it's a descendant (".cue-enter .child")
      if (normalizedSel.startsWith(normalizedTarget)) {
        const remainder = normalizedSel.substring(normalizedTarget.length);
        // Match if remainder starts with : (pseudo) or [ (attribute) but NOT space (descendant)
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

  // Sort for deterministic output
  declarations.sort();
  return declarations;
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
  // Parse CLI args
  const args = process.argv.slice(2);
  let clusterFlag = null;
  let manifestPath = 'regrets/manifest.json';
  let quiet = false;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--cluster' && args[i + 1]) {
      clusterFlag = args[i + 1];
      i++;
    } else if (args[i] === '--manifest' && args[i + 1]) {
      manifestPath = args[i + 1];
      i++;
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

  if (targetClusters.length === 0) {
    console.log(`No CSS cluster matching: ${clusterFlag}`);
    process.exit(0);
  }

  const regretDir = manifestDir;
  mkdirSync(regretDir, { recursive: true });

  let captured = 0;
  let skipped = 0;

  for (const cluster of targetClusters) {
    const { id, entry, file: cssFile, inputs } = cluster;

    if (!cssFile) {
      console.error(`✗ Cluster "${id}" has no "file" field (CSS file path required)`);
      skipped++;
      continue;
    }

    const cssFilePath = resolve(manifestDir, cssFile);
    if (!existsSync(cssFilePath)) {
      console.error(`✗ CSS file not found: ${cssFilePath} (cluster: ${id})`);
      skipped++;
      continue;
    }

    // The "entry" for CSS is the selector to extract
    const selector = entry;
    const cssContent = readFileSync(cssFilePath, 'utf8');

    // Extract declarations
    const declarations = extractDeclarations(cssContent, selector);

    if (declarations.length === 0) {
      console.error(`✗ No declarations found for selector "${selector}" in ${cssFile}`);
      skipped++;
      continue;
    }

    // The input is the selector (and optional custom property overrides from inputs)
    const input = inputs && inputs.length > 0 ? { selector, inputs } : { selector };
    const output = declarations;

    const fp = fingerprint(input, output);
    const now = new Date().toISOString();

    // Write .regret file
    const regretPath = join(regretDir, `${id}.regret`);
    const meta = [
      `cluster: ${id}`,
      `version: 1`,
      `fingerprint: ${fp}`,
      `captured: ${now}`,
      `entry: ${selector}`,
      `stack: css`,
      `file: ${cssFile}`,
    ];

    if (inputs && inputs.length > 0) {
      meta.push(`inputs: ${JSON.stringify(inputs)}`);
    }

    const inputLine = `INPUT  ${JSON.stringify(input)}`;
    const outputLine = `OUTPUT ${JSON.stringify(output)}`;
    const hashLine = `HASH   ${fp}`;

    const regretContent = meta.join('\n') + '\n---\n' + inputLine + '\n' + outputLine + '\n' + hashLine + '\n';

    writeFileSync(regretPath, regretContent);

    if (!quiet) {
      console.log(`✓ ${id}: ${fp} (${declarations.length} declarations)`);
    }
    captured++;
  }

  if (!quiet) {
    console.log(`\n📡 Captured ${captured} CSS cluster(s), skipped ${skipped}`);
  }
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});

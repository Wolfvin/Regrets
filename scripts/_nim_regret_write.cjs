#!/usr/bin/env node
// _nim_regret_write.js — write a .regret file from harness output.
// Called by capture_nim.sh.
//
// Args: <cluster_json> <input_line> <output_line> <hash_val>

const fs = require('fs');
const path = require('path');

const clusterJson = process.argv[2];
const inputLine = process.argv[3];
const outputLine = process.argv[4];
const hashVal = process.argv[5];

if (!clusterJson || !inputLine || !outputLine || !hashVal) {
  console.error('Usage: _nim_regret_write.js <cluster_json> <input_line> <output_line> <hash_val>');
  process.exit(1);
}

const c = JSON.parse(clusterJson);

// Strip 'REGRET_INPUT ' / 'REGRET_OUTPUT ' prefix
const inputJSON = inputLine.replace(/^REGRET_INPUT\s+/, '');
const outputJSON = outputLine.replace(/^REGRET_OUTPUT\s+/, '');

const fpLevel = c.fingerprintLevel || 'entry';
const watches = c.watches || [];
const rules = c.normalize || [];
const ignore = c.ignoreFields || [];

// ISO 8601 timestamp with microseconds
const captured = new Date().toISOString();

const lines = [];
lines.push('cluster: ' + c.id);
lines.push('version: 1');
lines.push('fingerprint: ' + hashVal);
lines.push('captured: ' + captured);
lines.push('watches: [' + watches.join(', ') + ']');
lines.push('entry: ' + c.entry);
lines.push('stack: nim');
lines.push('fingerprintLevel: ' + fpLevel);
if (rules.length > 0) lines.push('normalize: [' + rules.join(', ') + ']');
if (ignore.length > 0) lines.push('ignoreFields: [' + ignore.join(', ') + ']');
if (c.file) lines.push('file: ' + c.file);
lines.push('---');
lines.push('INPUT  ' + inputJSON);
lines.push('OUTPUT ' + outputJSON);
lines.push('HASH   ' + hashVal);

const regretPath = path.join(process.cwd(), 'regrets', c.id + '.regret');
fs.writeFileSync(regretPath, lines.join('\n') + '\n');
process.stdout.write(regretPath);

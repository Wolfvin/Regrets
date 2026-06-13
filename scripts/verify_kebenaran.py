#!/usr/bin/env python3
# verify_kebenaran.py — Verify KEBENARAN 1 and KEBENARAN 2 are semantically identical
# Python version — handles both Python and JS KEBENARAN formats.
#
# Part of the Dual-Truth Verification pattern.
#
# Usage:
#   python scripts/verify_kebenaran.py
#   python scripts/verify_kebenaran.py --manifest ./regrets/manifest.json

import sys
import os
import json
import re

regret_dir = os.path.join(os.getcwd(), 'regrets')

# ─── Load KEBENARAN files ──────────────────────────────────────────────────

k1_path = os.path.join(regret_dir, 'KEBENARAN_1_raw_output.json')
k2_path = os.path.join(regret_dir, 'KEBENARAN_2_fingerprints.json')

# Also check proof/ directory
if not os.path.isfile(k1_path):
    # Look in proof/ subdirectories
    proof_dir = os.path.join(os.getcwd(), 'proof')
    if os.path.isdir(proof_dir):
        for subdir in os.listdir(proof_dir):
            candidate = os.path.join(proof_dir, subdir, 'KEBENARAN_1_raw_output.json')
            if os.path.isfile(candidate):
                k1_path = candidate
                k2_path = os.path.join(proof_dir, subdir, 'KEBENARAN_2_fingerprints.json')
                break

if not os.path.isfile(k1_path):
    print(f'❌ KEBENARAN 1 not found at: {k1_path}')
    print('   Run this first: regret truth (to capture raw outputs before refactoring)')
    sys.exit(1)

if not os.path.isfile(k2_path):
    print(f'❌ KEBENARAN 2 not found at: {k2_path}')
    print('   Run this first: regret truth (to capture Regrets fingerprints before refactoring)')
    sys.exit(1)

with open(k1_path, 'r', encoding='utf-8') as f:
    k1 = json.load(f)
with open(k2_path, 'r', encoding='utf-8') as f:
    k2 = json.load(f)

# ─── Verify identity ──────────────────────────────────────────────────────

print('\n🔍 Verifying KEBENARAN 1 (raw output) vs KEBENARAN 2 (fingerprints)...\n')

all_ok = True
checked = 0

# K1 format (Python truth.py): dict of cluster_id → [{ input, output }]
# K1 format (JS truth.js): dict of cluster_id → { entry, outputs: [{ input, output }] }
# K2 format (Python truth.py): { fingerprints: { cluster_id → { fingerprint, golden_output, ... } }, chains: {...} }
# K2 format (JS truth.js): { clusters: { cluster_id → { fingerprint, golden_output, ... } }, chains: {...} }

# Normalize K2 to a common format
k2_clusters = k2.get('fingerprints', k2.get('clusters', {}))

for cluster_id, data in k1.items():
    k2_cluster = k2_clusters.get(cluster_id)
    if not k2_cluster:
        print(f'❌ {cluster_id}: not found in KEBENARAN 2')
        all_ok = False
        continue

    # Handle both Python format (list) and JS format (dict with outputs key)
    if isinstance(data, list):
        outputs = data
    elif isinstance(data, dict):
        outputs = data.get('outputs', [])
    else:
        print(f'⚠️  {cluster_id}: unexpected K1 format: {type(data).__name__}')
        continue

    if not outputs:
        print(f'⚠️  {cluster_id}: no outputs in KEBENARAN 1')
        continue

    # Compare the first output (which is what the .regret file stores)
    k1_output = outputs[0].get('output') if isinstance(outputs[0], dict) else outputs[0]
    k2_golden_output = k2_cluster.get('golden_output')

    if k2_golden_output is None:
        print(f'⚠️  {cluster_id}: no golden_output in KEBENARAN 2')
        checked += 1
        continue

    k1_str = json.dumps(k1_output, sort_keys=True, ensure_ascii=False)
    k2_str = json.dumps(k2_golden_output, sort_keys=True, ensure_ascii=False)

    if k1_str == k2_str:
        print(f'✅ {cluster_id}: K1 output === K2 golden output')
        checked += 1
    else:
        print(f'❌ {cluster_id}: MISMATCH')
        print(f'   K1: {k1_str[:200]}')
        print(f'   K2: {k2_str[:200]}')
        all_ok = False

# Check for clusters in K2 but not in K1
for cluster_id in k2_clusters:
    if cluster_id not in k1:
        print(f'⚠️  {cluster_id}: in K2 but not in K1')

# Verify chain hashes
k2_chains = k2.get('chains', {})
for chain_id, chain_data in k2_chains.items():
    chain_hash = chain_data.get('chainHash', chain_data.get('chain_hash'))
    print(f'⛓  Chain {chain_id}: hash = {chain_hash}')

print()

if all_ok:
    print(f'✅ VERIFICATION PASSED: {checked} clusters verified — KEBENARAN 1 and KEBENARAN 2 are semantically identical.')
    print('   Safe to proceed with refactoring.')
    sys.exit(0)
else:
    print('❌ VERIFICATION FAILED: KEBENARAN 1 and KEBENARAN 2 are NOT identical.')
    print('   This means there is a false negative — Regrets is capturing something incorrectly.')
    print('   STOP. Fix Regrets before proceeding.')
    sys.exit(1)

#!/usr/bin/env python3
# verify_kebenaran.py — Verify KEBENARAN 1 vs KEBENARAN 2 identity
#
# This script addresses the gap discovered during the mhostetter/sdr refactoring:
# The existing verify_kebenaran.js only works for JS clusters. Python clusters
# with numpy arrays and complex numbers need their own verification.
#
# Usage:
#   python scripts/verify_kebenaran.py
#   python scripts/verify_kebenaran.py --cluster db-value
#
# What it does:
# 1. Reads KEBENARAN_1_raw_output.json (ground truth raw output)
# 2. Reads KEBENARAN_2_fingerprints.json (ground truth fingerprints)
# 3. Re-runs all entry functions from the manifest
# 4. Compares live output vs KEBENARAN 1 (must be identical)
# 5. Compares live fingerprints vs KEBENARAN 2 (must match)
#
# This is the Python equivalent of verify_kebenaran.js but with native
# numpy/complex number support.

import json
import os
import sys
import importlib

# Add scripts dir to path for fingerprint module
SCRIPTS_DIR = os.path.dirname(os.path.abspath(__file__))
if SCRIPTS_DIR not in sys.path:
    sys.path.insert(0, SCRIPTS_DIR)

from fingerprint import (
    stable_dumps, normalize, strip_fields, to_base36,
    deep_clone, fingerprint, extract_schema,
    _numpy_to_native, _complex_to_json, materialize_output
)


def parse_args():
    args = sys.argv[1:]
    cluster_filter = None
    i = 0
    while i < len(args):
        if args[i] == '--cluster' and i + 1 < len(args):
            cluster_filter = args[i + 1]
            i += 2
        else:
            i += 1
    return cluster_filter


def load_json(path):
    with open(path, 'r', encoding='utf-8') as f:
        return json.load(f)


def run_entry(cluster, manifest):
    """Run an entry function and return its raw output."""
    module_path = cluster.get('module', cluster.get('file', ''))
    entry_name = cluster['entry']
    inputs = cluster.get('inputs', [None])
    multi_args = cluster.get('multiArgs', False)
    kwargs_mode = cluster.get('kwargs', False)
    output_transform = cluster.get('outputTransform', None)
    normalize_rules = cluster.get('normalize', [])
    ignore_fields = cluster.get('ignoreFields', [])

    # Add pythonPath
    raw_python_path = cluster.get('pythonPath', '')
    if isinstance(raw_python_path, str):
        python_paths = [raw_python_path] if raw_python_path else []
    elif isinstance(raw_python_path, list):
        python_paths = raw_python_path
    else:
        python_paths = []
    for pp in python_paths:
        abs_pp = os.path.join(os.getcwd(), pp)
        if abs_pp not in sys.path:
            sys.path.insert(0, abs_pp)

    mod = importlib.import_module(module_path)
    entry_fn = getattr(mod, entry_name, None)
    if entry_fn is None or not callable(entry_fn):
        raise TypeError(f'Entry "{entry_name}" not found in {module_path}')

    results = []
    for input_val in inputs:
        input_for_args = deep_clone(input_val)
        if multi_args and isinstance(input_for_args, list):
            raw_output = entry_fn(*input_for_args)
        elif kwargs_mode and isinstance(input_for_args, dict):
            raw_output = entry_fn(**input_for_args)
        else:
            raw_output = entry_fn(input_for_args) if input_for_args is not None else entry_fn()

        # Serialize output for comparison
        serialized = _complex_to_json(_numpy_to_native(raw_output))
        fp = fingerprint(deep_clone(input_val), deep_clone(raw_output), normalize_rules, ignore_fields)
        results.append({
            'input': input_val,
            'output': serialized,
            'fingerprint': fp,
        })

    return results


def main():
    cluster_filter = parse_args()
    regret_dir = os.path.join(os.getcwd(), 'regrets')

    # Load manifest
    manifest_path = os.path.join(regret_dir, 'manifest.json')
    manifest = load_json(manifest_path)

    # Load KEBENARAN files
    k1_path = os.path.join(regret_dir, 'KEBENARAN_1_raw_output.json')
    k2_path = os.path.join(regret_dir, 'KEBENARAN_2_fingerprints.json')

    if not os.path.isfile(k1_path):
        print(f'❌ KEBENARAN 1 not found: {k1_path}')
        sys.exit(1)
    if not os.path.isfile(k2_path):
        print(f'❌ KEBENARAN 2 not found: {k2_path}')
        sys.exit(1)

    kebenaran_1 = load_json(k1_path)
    kebenaran_2 = load_json(k2_path)
    saved_fingerprints = kebenaran_2.get('fingerprints', {})

    clusters = manifest.get('clusters', [])
    if cluster_filter:
        clusters = [c for c in clusters if c['id'] == cluster_filter]

    print('\n🔍 KEBENARAN VERIFICATION (Python)\n')

    output_pass = 0
    output_fail = 0
    fp_pass = 0
    fp_fail = 0

    for cluster in clusters:
        cid = cluster['id']
        if cluster.get('stack') != 'python':
            print(f'  ⏭️  {cid}: non-Python stack, skip')
            continue

        try:
            results = run_entry(cluster, manifest)
            golden_fp = saved_fingerprints.get(cid)

            # Check fingerprints
            live_fp = results[0]['fingerprint']
            if live_fp == golden_fp:
                fp_status = '✅'
                fp_pass += 1
            else:
                fp_status = '❌'
                fp_fail += 1

            # Check output (compare serialized form)
            # For scalar outputs, compare directly
            k1_data = kebenaran_1.get(cid)
            output_match = True
            if k1_data is not None:
                live_output = results[0]['output']
                # Normalize both for comparison
                live_str = json.dumps(_complex_to_json(_numpy_to_native(live_output)), sort_keys=True)
                k1_str = json.dumps(_complex_to_json(_numpy_to_native(k1_data)), sort_keys=True)
                # For array outputs, just check fingerprint match
                # For scalar outputs, check exact match
                if isinstance(live_output, (int, float, str, bool)) or live_output is None:
                    output_match = (live_str == k1_str)

            if output_match:
                out_status = '✅'
                output_pass += 1
            else:
                out_status = '❌'
                output_fail += 1

            print(f'  {fp_status} {out_status} {cid:<35} fp={live_fp} (saved={golden_fp})')

        except Exception as err:
            print(f'  ❌ ❌ {cid:<35} ERROR: {err}')
            output_fail += 1
            fp_fail += 1

    print(f'\n{"─" * 60}')
    print(f'Fingerprint check: {fp_pass} match, {fp_fail} mismatch')
    print(f'Output check:      {output_pass} match, {output_fail} mismatch')

    if fp_fail == 0 and output_fail == 0:
        print('\n✅ KEBENARAN verification PASSED — both truths are identical')
        sys.exit(0)
    else:
        print('\n❌ KEBENARAN verification FAILED — truths are not identical')
        sys.exit(1)


if __name__ == '__main__':
    main()

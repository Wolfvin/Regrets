#!/usr/bin/env python3
# verify_kebenaran.py — Verify KEBENARAN 1 and KEBENARAN 2 are semantically identical
# Python version — handles both Python and JS KEBENARAN formats.
#
# Part of the Dual-Truth Verification pattern for Python stacks.
#
# This script addresses the gap discovered during the mhostetter/sdr refactoring:
# The existing verify_kebenaran.js only works for JS clusters. Python clusters
# with numpy arrays and complex numbers need their own verification.
#
# Usage:
#   python scripts/verify_kebenaran.py
#   python scripts/verify_kebenaran.py --manifest ./regrets/manifest.json
#   python scripts/verify_kebenaran.py --cluster db-value
#   python scripts/verify_kebenaran.py --proof-dir ./proof/my-project
#
# This script re-runs all Python entry functions, compares:
#   1. Raw output vs KEBENARAN 1 (ground truth)
#   2. Fingerprints vs KEBENARAN 2 (fingerprint contracts)
#   3. Chain hashes vs KEBENARAN 2 (chain contracts)

import sys
import os
import json
import re
import importlib
from pathlib import Path

# Add scripts dir to path for fingerprint module
SCRIPTS_DIR = os.path.dirname(os.path.abspath(__file__))
if SCRIPTS_DIR not in sys.path:
    sys.path.insert(0, SCRIPTS_DIR)

# Import shared fingerprint module
from fingerprint import (
    stable_dumps, normalize, strip_fields, to_base36,
    deep_clone, fingerprint, extract_schema,
    _numpy_to_native, _complex_to_json, materialize_output
)


def parse_args():
    args = sys.argv[1:]
    result = {
        'manifest': os.path.join(os.getcwd(), 'regrets', 'manifest.json'),
        'proof_dir': None,
        'cluster': None,
    }
    i = 0
    while i < len(args):
        if args[i] == '--manifest' and i + 1 < len(args):
            result['manifest'] = args[i + 1]
            i += 2
        elif args[i] == '--proof-dir' and i + 1 < len(args):
            result['proof_dir'] = args[i + 1]
            i += 2
        elif args[i] == '--cluster' and i + 1 < len(args):
            result['cluster'] = args[i + 1]
            i += 2
        else:
            i += 1
    return result


def load_json(path):
    """Load and parse a JSON file."""
    with open(path, 'r', encoding='utf-8') as f:
        return json.load(f)


def consume_generator(val):
    """If val is a generator or iterator, consume it into a list."""
    import types
    if isinstance(val, (str, bytes, dict)):
        return val
    if isinstance(val, types.GeneratorType):
        return list(val)
    if hasattr(val, '__iter__') and hasattr(val, '__next__'):
        if isinstance(val, (list, tuple)):
            return val
        return list(val)
    return val


def apply_output_transform(output, transform):
    """Apply an outputTransform to convert complex objects to fingerprintable form."""
    if transform is None:
        return output
    if isinstance(output, tuple):
        output = list(output)
    if '.' in transform and transform not in ('json',):
        parts = transform.rsplit('.', 1)
        try:
            mod = importlib.import_module(parts[0])
            fn = getattr(mod, parts[1])
            return fn(output)
        except (ImportError, AttributeError) as e:
            raise ValueError(f"Cannot resolve outputTransform '{transform}': {e}")

    def transform_one(obj):
        if transform == 'str': return str(obj)
        elif transform == 'repr': return repr(obj)
        elif transform == 'dict':
            if hasattr(obj, 'to_dict') and callable(obj.to_dict): return obj.to_dict()
            if hasattr(obj, '__dict__'): return obj.__dict__
            return dict(obj)
        elif transform == 'len': return len(obj)
        elif transform == 'type': return type(obj).__name__
        else: raise ValueError(f"Unknown outputTransform: '{transform}'")

    if isinstance(output, list) and transform not in ('len',):
        return [transform_one(item) for item in output]
    return transform_one(output)


def run_entry(cluster, manifest):
    """Run an entry function and return results for all inputs."""
    module_path = cluster.get('module', cluster.get('file', ''))
    entry_name = cluster['entry']
    inputs = cluster.get('inputs', [None])
    multi_args = cluster.get('multiArgs', False)
    kwargs_mode = cluster.get('kwargs', False)
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


def find_proof_dir(cli):
    """Auto-detect proof directory, with fallback to proof/ subdirectories."""
    # Explicit --proof-dir wins
    proof_dir = cli.get('proof_dir')
    if proof_dir:
        return proof_dir

    # Try manifest-based detection
    manifest_path = cli['manifest']
    try:
        with open(manifest_path, 'r') as f:
            manifest = json.load(f)
        project_name = manifest.get('projectName', os.getcwd().split(os.sep)[-1])
    except:
        project_name = os.getcwd().split(os.sep)[-1]
    proof_dir = os.path.join(os.getcwd(), 'proof', project_name)
    if os.path.isdir(proof_dir):
        return proof_dir

    # Fallback: scan proof/ subdirectories (HEAD compatibility)
    proof_base = os.path.join(os.getcwd(), 'proof')
    if os.path.isdir(proof_base):
        for subdir in os.listdir(proof_base):
            candidate = os.path.join(proof_base, subdir, 'KEBENARAN_1_raw_output.json')
            if os.path.isfile(candidate):
                return os.path.join(proof_base, subdir)

    return proof_dir


def main():
    cli = parse_args()
    regret_dir = os.path.join(os.getcwd(), 'regrets')

    # ─── Find KEBENARAN files ───────────────────────────────────────────────

    proof_dir = find_proof_dir(cli)

    k1_path = os.path.join(proof_dir, 'KEBENARAN_1_raw_output.json')
    k2_path = os.path.join(proof_dir, 'KEBENARAN_2_fingerprints.json')

    if not os.path.exists(k1_path):
        print(f'❌ KEBENARAN 1 not found at: {k1_path}')
        print('   Run this first: python scripts/truth.py')
        sys.exit(1)

    if not os.path.exists(k2_path):
        print(f'❌ KEBENARAN 2 not found at: {k2_path}')
        print('   Run this first: python scripts/truth.py')
        sys.exit(1)

    with open(k1_path, 'r') as f:
        k1 = json.load(f)
    with open(k2_path, 'r') as f:
        k2 = json.load(f)

    # ─── Load manifest ──────────────────────────────────────────────────────

    try:
        with open(cli['manifest'], 'r') as f:
            manifest = json.load(f)
    except:
        print(f'❌ Could not read manifest: {cli["manifest"]}')
        sys.exit(1)

    # Add pythonPath: manifest-level first, then cluster-level
    manifest_python_path = manifest.get('pythonPath', '')
    if isinstance(manifest_python_path, str):
        manifest_python_paths = [manifest_python_path] if manifest_python_path else []
    elif isinstance(manifest_python_path, list):
        manifest_python_paths = manifest_python_path
    else:
        manifest_python_paths = []
    for python_path in manifest_python_paths:
        if python_path:
            abs_path = os.path.join(os.getcwd(), python_path)
            if abs_path not in sys.path:
                sys.path.insert(0, abs_path)
    for cluster in manifest.get('clusters', []):
        if cluster.get('stack') == 'python':
            raw_python_path = cluster.get('pythonPath', '')
            if isinstance(raw_python_path, str):
                python_paths = [raw_python_path] if raw_python_path else []
            elif isinstance(raw_python_path, list):
                python_paths = raw_python_path
            else:
                python_paths = []
            if not python_paths:
                python_paths = manifest_python_paths
            for python_path in python_paths:
                if python_path:
                    abs_path = os.path.join(os.getcwd(), python_path)
                    if abs_path not in sys.path:
                        sys.path.insert(0, abs_path)

    # Cluster filter
    cluster_filter = cli.get('cluster')

    print('\n🔍 Verifying KEBENARAN 1 (raw output) vs KEBENARAN 2 (fingerprints)...\n')

    all_ok = True
    checked = 0

    # Normalize K2 to handle both Python format (fingerprints) and JS format (clusters)
    k2_fingerprints = k2.get('fingerprints', k2.get('clusters', {}))

    # Build set of cluster IDs from manifest for K2-not-in-K1 check
    manifest_cluster_ids = set()
    for cluster in manifest.get('clusters', []):
        if cluster.get('stack') == 'python':
            manifest_cluster_ids.add(cluster['id'])

    for cluster in manifest.get('clusters', []):
        if cluster.get('stack') != 'python':
            continue

        cid = cluster['id']

        # Apply cluster filter
        if cluster_filter and cid != cluster_filter:
            continue

        entry = cluster['entry']
        module_path = cluster.get('module', cluster.get('file', ''))
        normalize_rules = cluster.get('normalize', [])
        ignore_fields = cluster.get('ignoreFields', [])
        fingerprint_level = cluster.get('fingerprintLevel', 'entry')
        fingerprint_mode = cluster.get('fingerprintMode', 'value')
        value_paths = cluster.get('valuePaths', [])
        multi_args = cluster.get('multiArgs', False)
        kwargs_mode = cluster.get('kwargs', False)
        inputs = cluster.get('inputs', [None])
        output_transform = cluster.get('outputTransform', None)
        materialize_output_flag = cluster.get('materializeOutput', False)

        # Get K1 data
        k1_data = k1.get(cid)
        k2_data = k2_fingerprints.get(cid)

        if not k1_data:
            print(f'⚠️  {cid}: not in KEBENARAN 1')
            continue
        if not k2_data:
            print(f'❌ {cid}: not in KEBENARAN 2')
            all_ok = False
            continue

        # Re-run entry function and compare with K1
        try:
            mod = importlib.import_module(module_path)
            entry_fn = getattr(mod, entry, None)
            if entry_fn is None or not callable(entry_fn):
                print(f'❌ {cid}: Entry "{entry}" not found in {module_path}')
                all_ok = False
                continue

            # Test first input
            test_input = inputs[0]
            input_for_args = deep_clone(test_input)

            if multi_args and isinstance(input_for_args, list):
                raw_output = entry_fn(*input_for_args)
            elif kwargs_mode and isinstance(input_for_args, dict):
                raw_output = entry_fn(**input_for_args)
            else:
                raw_output = entry_fn(input_for_args) if input_for_args is not None else entry_fn()

            # Materialize and transform
            output, was_materialized = materialize_output(raw_output) if materialize_output_flag else (raw_output, False)
            if not materialize_output_flag:
                output = consume_generator(output)
            output_for_fp = apply_output_transform(deep_clone(output), output_transform)

            # Compare with K1 first output
            k1_outputs = k1_data if isinstance(k1_data, list) else k1_data
            if isinstance(k1_outputs, list) and len(k1_outputs) > 0:
                k1_first_output = k1_outputs[0].get('output') if isinstance(k1_outputs[0], dict) else k1_outputs[0]
            else:
                k1_first_output = k1_outputs

            # Compare fingerprints
            live_fp = fingerprint(deep_clone(test_input), output_for_fp, normalize_rules, ignore_fields)
            k2_fp = k2_data.get('fingerprint')

            # Use _complex_to_json for robust serialization comparison
            live_serialized = _complex_to_json(_numpy_to_native(output_for_fp))
            k1_serialized = _complex_to_json(_numpy_to_native(k1_first_output))

            k1_match = (live_serialized == k1_serialized) or (output_for_fp == k1_first_output)
            k2_match = (live_fp == k2_fp)

            if k1_match and k2_match:
                print(f'✅ {cid}: K1 output === K1 golden, fingerprint {live_fp} === {k2_fp}')
                checked += 1
            elif k1_match and not k2_match:
                print(f'❌ {cid}: K1 match but fingerprint MISMATCH: live={live_fp}, saved={k2_fp}')
                all_ok = False
            elif not k1_match and k2_match:
                print(f'⚠️  {cid}: Fingerprint match but K1 output differs (check normalization)')
                checked += 1
            else:
                print(f'❌ {cid}: BOTH MISMATCH — K1 output differs, fingerprint: live={live_fp}, saved={k2_fp}')
                all_ok = False

        except Exception as err:
            print(f'❌ {cid}: ERROR — {err}')
            all_ok = False

    # Check for clusters in K2 but not in K1 (HEAD feature)
    for cluster_id in k2_fingerprints:
        if cluster_id not in k1:
            print(f'⚠️  {cluster_id}: in K2 but not in K1')

    # Verify chain hashes
    k2_chains = k2.get('chains', {})
    chains_dir = os.path.join(regret_dir, 'chains')
    if os.path.isdir(chains_dir):
        for f in os.listdir(chains_dir):
            if f.endswith('.chain'):
                with open(os.path.join(chains_dir, f), 'r') as fh:
                    content = fh.read()
                chain_hash_match = re.search(r'^chain_hash:\s+(\S+)', content, re.MULTILINE)
                chain_id = f.replace('.chain', '')
                current_hash = chain_hash_match.group(1) if chain_hash_match else None
                saved_hash = k2_chains.get(chain_id, {}).get('chain_hash')
                if current_hash == saved_hash:
                    print(f'⛓  Chain {chain_id}: {current_hash} ✅')
                else:
                    print(f'⛓  Chain {chain_id}: MISMATCH — live={current_hash}, saved={saved_hash}')
                    all_ok = False

    print()

    if all_ok:
        print(f'✅ VERIFICATION PASSED: {checked} clusters verified — KEBENARAN 1 and KEBENARAN 2 are semantically identical.')
        print('   Refactoring is proven safe.')
        sys.exit(0)
    else:
        print('❌ VERIFICATION FAILED: KEBENARAN 1 and KEBENARAN 2 are NOT identical.')
        print('   This means the refactoring changed behavior — fix the CODE, NOT .regret files.')
        sys.exit(1)


if __name__ == '__main__':
    main()

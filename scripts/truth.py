#!/usr/bin/env python3
# truth.py — Save dual truth baselines before refactoring (Python stack)
# KEBENARAN 1: Raw output from every entry function
# KEBENARAN 2: Fingerprint contracts from .regret files
#
# This is the Python stack equivalent of truth.js.
# Both truths must be identical in meaning. If they disagree,
# there's a false negative in Regrets — fix it before refactoring.
#
# Usage:
#   python scripts/truth.py
#   python scripts/truth.py --outdir ./proof/myproject
#   python scripts/truth.py --cluster my-cluster

import sys
import os
import json
import importlib
from datetime import datetime, timezone

from fingerprint import (
    stable_dumps, normalize, strip_fields, to_base36,
    deep_clone, fingerprint, fingerprint_sequence, extract_schema,
    _numpy_to_native, materialize_output, snapshot_state, get_env_snapshot
)


def parse_args():
    args = sys.argv[1:]
    result = {
        'outdir': os.path.join(os.getcwd(), 'proof'),
        'manifest': os.path.join(os.getcwd(), 'regrets', 'manifest.json'),
        'cluster': None,
    }
    i = 0
    while i < len(args):
        if args[i] == '--outdir' and i + 1 < len(args):
            result['outdir'] = args[i + 1]; i += 2
        elif args[i] == '--manifest' and i + 1 < len(args):
            result['manifest'] = args[i + 1]; i += 2
        elif args[i] == '--cluster' and i + 1 < len(args):
            result['cluster'] = args[i + 1]; i += 2
        else:
            i += 1
    return result


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
        if transform == 'str':
            return str(obj)
        elif transform == 'repr':
            return repr(obj)
        elif transform == 'dict':
            if hasattr(obj, 'to_dict') and callable(obj.to_dict):
                return obj.to_dict()
            if hasattr(obj, '__dict__'):
                return obj.__dict__
            return dict(obj)
        elif transform == 'len':
            return len(obj)
        elif transform == 'type':
            return type(obj).__name__
        else:
            raise ValueError(f"Unknown outputTransform: '{transform}'")

    if isinstance(output, list) and transform not in ('len',):
        return [transform_one(item) for item in output]
    return transform_one(output)


def main():
    cli = parse_args()

    # Load manifest
    try:
        with open(cli['manifest'], 'r', encoding='utf-8') as f:
            manifest = json.load(f)
    except (FileNotFoundError, json.JSONDecodeError) as e:
        print(f"❌ Could not read manifest: {cli['manifest']}")
        print(f"   Error: {e}")
        sys.exit(1)

    clusters = manifest.get('clusters', [])
    if cli['cluster']:
        clusters = [c for c in clusters if c['id'] == cli['cluster']]

    python_clusters = [c for c in clusters if c.get('stack') == 'python']
    if not python_clusters:
        print("No Python clusters found in manifest.")
        sys.exit(0)

    # Add pythonPath to sys.path
    for cluster in python_clusters:
        raw_python_path = cluster.get('pythonPath', '')
        if isinstance(raw_python_path, str):
            python_paths = [raw_python_path] if raw_python_path else []
        elif isinstance(raw_python_path, list):
            python_paths = raw_python_path
        else:
            python_paths = []
        for python_path in python_paths:
            if python_path:
                abs_python_path = os.path.join(os.getcwd(), python_path)
                if abs_python_path not in sys.path:
                    sys.path.insert(0, abs_python_path)

    # ─── KEBENARAN 1: Raw Output ─────────────────────────────────────────────
    print('\n📡 Saving KEBENARAN 1 — Raw output from entry functions\n')

    raw_outputs = {}

    for cluster in python_clusters:
        cid = cluster['id']
        entry = cluster['entry']
        module_path = cluster.get('module', cluster.get('file', ''))
        multi_args = cluster.get('multiArgs', False)
        kwargs_mode = cluster.get('kwargs', False)
        inputs = cluster.get('inputs', [None])
        output_transform = cluster.get('outputTransform', None)
        materialize_output_flag = cluster.get('materializeOutput', False)
        norm_rules = cluster.get('normalize', [])
        ign_fields = cluster.get('ignoreFields', [])
        fp_level = cluster.get('fingerprintLevel', 'entry')
        fp_mode = cluster.get('fingerprintMode', 'value')
        value_paths = cluster.get('valuePaths', [])

        try:
            mod = importlib.import_module(module_path)
            entry_fn = getattr(mod, entry, None)
            if entry_fn is None or not callable(entry_fn):
                print(f"  ❌ {cid}: Entry \"{entry}\" not found or not callable in {module_path}")
                continue

            outputs = []
            for input_val in inputs:
                input_for_args = deep_clone(input_val)

                if multi_args and isinstance(input_for_args, list):
                    raw_output = entry_fn(*input_for_args)
                elif kwargs_mode and isinstance(input_for_args, dict):
                    raw_output = entry_fn(**input_for_args)
                else:
                    raw_output = entry_fn(input_for_args) if input_for_args is not None else entry_fn()

                # Materialize if needed
                output, was_materialized = materialize_output(raw_output) if materialize_output_flag else (raw_output, False)
                if not materialize_output_flag:
                    output = consume_generator(output)

                # Apply output transform if specified
                output_for_record = apply_output_transform(deep_clone(output), output_transform)

                outputs.append({
                    'input': deep_clone(input_val),
                    'output': _numpy_to_native(output_for_record),
                })

            raw_outputs[cid] = {
                'entry': entry,
                'module': module_path,
                'outputs': outputs,
            }
            print(f"  ✅ {cid}")
        except Exception as err:
            print(f"  ❌ {cid}: {err}")
            import traceback
            traceback.print_exc()

    # ─── KEBENARAN 2: Fingerprint Contracts ──────────────────────────────────
    print('\n📡 Saving KEBENARAN 2 — Fingerprint contracts from .regret files\n')

    fingerprints = {}
    regret_dir = os.path.join(os.getcwd(), 'regrets')

    try:
        regret_files = [f for f in os.listdir(regret_dir) if f.endswith('.regret')]
        for regret_file in regret_files:
            regret_path = os.path.join(regret_dir, regret_file)
            with open(regret_path, 'r', encoding='utf-8') as f:
                content = f.read()

            # Parse key fields
            fp_match = __import__('re').search(r'^fingerprint:\s+(\S+)', content, __import__('re').MULTILINE)
            hash_match = __import__('re').search(r'^HASH\s+(\S+)', content, __import__('re').MULTILINE)
            cluster_match = __import__('re').search(r'^cluster:\s+(.+)$', content, __import__('re').MULTILINE)
            captured_match = __import__('re').search(r'^captured:\s+(.+)$', content, __import__('re').MULTILINE)
            entry_match = __import__('re').search(r'^entry:\s+(.+)$', content, __import__('re').MULTILINE)
            input_match = __import__('re').search(r'^INPUT\s+(.+)$', content, __import__('re').MULTILINE)
            output_match = __import__('re').search(r'^OUTPUT\s+(.+)$', content, __import__('re').MULTILINE)

            cid = cluster_match.group(1).strip() if cluster_match else os.path.splitext(regret_file)[0]
            fingerprints[cid] = {
                'fingerprint': fp_match.group(1) if fp_match else None,
                'golden_hash': hash_match.group(1) if hash_match else None,
                'captured': captured_match.group(1) if captured_match else None,
                'entry': entry_match.group(1).strip() if entry_match else None,
                'golden_input': json.loads(input_match.group(1)) if input_match else None,
                'golden_output': json.loads(output_match.group(1)) if output_match else None,
            }
            print(f"  ✅ {cid}: {fp_match.group(1) if fp_match else 'no fingerprint'}")
    except FileNotFoundError:
        print("  ⚠️  No .regret files found")

    # Read chain hashes
    chains = {}
    chains_dir = os.path.join(regret_dir, 'chains')
    if os.path.isdir(chains_dir):
        import re as _re
        for chain_file in os.listdir(chains_dir):
            if chain_file.endswith('.chain'):
                chain_path = os.path.join(chains_dir, chain_file)
                with open(chain_path, 'r', encoding='utf-8') as f:
                    content = f.read()
                chain_hash_match = _re.search(r'^chain_hash:\s+(\S+)', content, _re.MULTILINE)
                chain_id = os.path.splitext(chain_file)[0]
                chains[chain_id] = {'chain_hash': chain_hash_match.group(1) if chain_hash_match else None}
                print(f"  ✅ chain/{chain_id}: {chain_hash_match.group(1) if chain_hash_match else 'no hash'}")

    # ─── Consistency Check ──────────────────────────────────────────────────
    k1_ids = set(raw_outputs.keys())
    k2_ids = set(fingerprints.keys())

    in_k1_not_k2 = k1_ids - k2_ids
    in_k2_not_k1 = k2_ids - k1_ids

    if in_k1_not_k2 or in_k2_not_k1:
        print('\n❌ INCONSISTENCY between KEBENARAN 1 and KEBENARAN 2:')
        if in_k1_not_k2:
            print(f'   In K1 but not K2: {", ".join(sorted(in_k1_not_k2))}')
        if in_k2_not_k1:
            print(f'   In K2 but not K1: {", ".join(sorted(in_k2_not_k1))}')
        print('   Fix this before refactoring — it indicates a false negative.')
        sys.exit(1)

    # ─── Cross-validate: ensure K1 raw output matches K2 golden output ───────
    mismatches = []
    for cid in k1_ids:
        k1_output = raw_outputs[cid]['outputs'][0]['output'] if raw_outputs[cid]['outputs'] else None
        k2_golden = fingerprints[cid].get('golden_output')
        if k1_output is not None and k2_golden is not None:
            k1_str = stable_dumps(k1_output)
            k2_str = stable_dumps(k2_golden)
            if k1_str != k2_str:
                mismatches.append(cid)

    if mismatches:
        print('\n❌ MISMATCH between KEBENARAN 1 raw output and KEBENARAN 2 golden output:')
        for cid in mismatches:
            print(f'   {cid}')
        print('   This means Regrets captured something incorrectly.')
        print('   STOP. Fix Regrets before proceeding.')
        sys.exit(1)

    # ─── Write Output Files ──────────────────────────────────────────────────
    project_name = manifest.get('projectName', os.getcwd().split('/')[-1])
    proof_dir = os.path.join(cli['outdir'], project_name)
    os.makedirs(proof_dir, exist_ok=True)

    k1_path = os.path.join(proof_dir, 'KEBENARAN_1_raw_output.json')
    k2_path = os.path.join(proof_dir, 'KEBENARAN_2_fingerprints.json')

    with open(k1_path, 'w', encoding='utf-8') as f:
        json.dump(raw_outputs, f, indent=2, ensure_ascii=False)
        f.write('\n')

    with open(k2_path, 'w', encoding='utf-8') as f:
        json.dump({'fingerprints': fingerprints, 'chains': chains}, f, indent=2, ensure_ascii=False)
        f.write('\n')

    print(f'\n{"─" * 50}')
    print('✅ Both truths saved:')
    print(f'   KEBENARAN 1: {k1_path} ({len(raw_outputs)} clusters)')
    print(f'   KEBENARAN 2: {k2_path} ({len(fingerprints)} fingerprints, {len(chains)} chains)')
    print(f'\n   Consistency: ✅ Both truths are aligned')
    if mismatches:
        print(f'   Cross-validation: ❌ {len(mismatches)} mismatch(es)')
    else:
        print('   Cross-validation: ✅ K1 output matches K2 golden output')
    print(f'\nYou are now safe to refactor. Run \'regret validate\' after each change.')


if __name__ == '__main__':
    main()

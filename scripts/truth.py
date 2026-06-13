#!/usr/bin/env python3
# truth.py — Save dual truth baselines before refactoring (Python)
# KEBENARAN 1: Raw output from every entry function
# KEBENARAN 2: Fingerprint contracts from .regret files
#
# Usage:
#   python scripts/truth.py
#   python scripts/truth.py --outdir ./proof/myproject
#
# Both truths must be identical in meaning. If they disagree,
# there's a false negative in Regrets — fix it before refactoring.

import sys
import os
import json
import re
import importlib
from datetime import datetime, timezone

from fingerprint import (
    stable_dumps, normalize, strip_fields, to_base36,
    deep_clone, fingerprint, fingerprint_sequence, extract_schema,
    materialize_output, snapshot_state, get_env_snapshot
)


def parse_args():
    args = sys.argv[1:]
    result = {'outdir': None}
    i = 0
    while i < len(args):
        if args[i] == '--outdir' and i + 1 < len(args):
            result['outdir'] = args[i + 1]
            i += 2
        else:
            i += 1
    return result


def json_serialize(val):
    """Serialize value to JSON string for output. Handles numpy types."""
    from fingerprint import _numpy_to_native
    return json.dumps(_numpy_to_native(val), ensure_ascii=False)


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
    manifest_path = os.path.join(os.getcwd(), 'regrets', 'manifest.json')

    # Load manifest
    try:
        with open(manifest_path, 'r', encoding='utf-8') as f:
            manifest = json.load(f)
    except (FileNotFoundError, json.JSONDecodeError) as e:
        print(f'❌ Could not read manifest: {manifest_path}')
        print(f'   Error: {e}')
        sys.exit(1)

    # Filter to Python clusters
    python_clusters = [c for c in manifest.get('clusters', []) if c.get('stack') == 'python']

    # Setup pythonPath
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

    # ─── KEBENARAN 1: Raw Output ─────────────────────────────────────────────────

    print('\n📡 Saving KEBENARAN 1 — Raw output from entry functions\n')

    raw_outputs = {}

    for cluster in python_clusters:
        cid = cluster['id']
        entry = cluster['entry']
        module_path = cluster.get('module', cluster.get('file', ''))
        inputs = cluster.get('inputs', [None])
        multi_args = cluster.get('multiArgs', False)
        kwargs_mode = cluster.get('kwargs', False)
        class_method = cluster.get('classMethod', None)
        constructor = cluster.get('constructor', None)
        constructor_args = cluster.get('constructorArgs', [])
        setup = cluster.get('setup', [])
        output_transform = cluster.get('outputTransform', None)
        materialize_output_flag = cluster.get('materializeOutput', False)

        try:
            mod = importlib.import_module(module_path)
            test_inputs = inputs if inputs else [None]

            if class_method:
                # Class-based entry
                cls_name = constructor or entry
                Cls = getattr(mod, cls_name, None)
                if Cls is None:
                    raise TypeError(f'Class "{cls_name}" not found in {module_path}')

                outputs = []
                for input_val in test_inputs:
                    instance = Cls(*deep_clone(constructor_args))
                    # Run setup steps
                    for step in setup:
                        method_fn = getattr(instance, step.get('method', ''), None)
                        if method_fn:
                            step_args = step.get('args', [])
                            method_fn(*deep_clone(step_args))
                    # Call classMethod
                    input_for_args = deep_clone(input_val)
                    if multi_args and isinstance(input_for_args, list):
                        raw_output = getattr(instance, class_method)(*input_for_args)
                    elif kwargs_mode and isinstance(input_for_args, dict):
                        raw_output = getattr(instance, class_method)(**input_for_args)
                    elif input_for_args is not None:
                        raw_output = getattr(instance, class_method)(input_for_args)
                    else:
                        raw_output = getattr(instance, class_method)()

                    # Materialize generators if configured
                    if materialize_output_flag:
                        raw_output, _ = materialize_output(raw_output)
                    else:
                        raw_output = consume_generator(raw_output)

                    # Apply output transform
                    output_for_fp = apply_output_transform(deep_clone(raw_output), output_transform)
                    outputs.append({
                        'input': deep_clone(input_val),
                        'output': output_for_fp
                    })
                raw_outputs[cid] = outputs
            else:
                # Function-based entry
                entry_fn = getattr(mod, entry, None)
                if entry_fn is None or not callable(entry_fn):
                    raise TypeError(f'Entry "{entry}" not found or not callable in {module_path}')

                outputs = []
                for input_val in test_inputs:
                    input_for_args = deep_clone(input_val)
                    if multi_args and isinstance(input_for_args, list):
                        raw_output = entry_fn(*input_for_args)
                    elif kwargs_mode and isinstance(input_for_args, dict):
                        raw_output = entry_fn(**input_for_args)
                    elif input_for_args is not None:
                        raw_output = entry_fn(input_for_args)
                    else:
                        raw_output = entry_fn()

                    # Materialize generators if configured
                    if materialize_output_flag:
                        raw_output, _ = materialize_output(raw_output)
                    else:
                        raw_output = consume_generator(raw_output)

                    # Apply output transform
                    output_for_fp = apply_output_transform(deep_clone(raw_output), output_transform)
                    outputs.append({
                        'input': deep_clone(input_val),
                        'output': output_for_fp
                    })
                raw_outputs[cid] = outputs

            print(f'  ✅ {cid}')
        except Exception as err:
            print(f'  ❌ {cid}: {err}')

    # ─── KEBENARAN 2: Fingerprint Contracts ───────────────────────────────────────

    print('\n📡 Saving KEBENARAN 2 — Fingerprint contracts from .regret files\n')

    fingerprints = {}
    regret_dir = os.path.join(os.getcwd(), 'regrets')

    try:
        regret_files = [f for f in os.listdir(regret_dir) if f.endswith('.regret')]
        for file in regret_files:
            filepath = os.path.join(regret_dir, file)
            with open(filepath, 'r', encoding='utf-8') as f:
                content = f.read()

            fp_match = re.search(r'^fingerprint:\s+(\S+)', content, re.MULTILINE)
            hash_match = re.search(r'^HASH\s+(\S+)', content, re.MULTILINE)
            cluster_match = re.search(r'^cluster:\s+(.+)$', content, re.MULTILINE)
            captured_match = re.search(r'^captured:\s+(.+)$', content, re.MULTILINE)
            entry_match = re.search(r'^entry:\s+(.+)$', content, re.MULTILINE)

            cid = cluster_match.group(1).strip() if cluster_match else file.replace('.regret', '')
            fingerprints[cid] = {
                'fingerprint': fp_match.group(1) if fp_match else None,
                'hash': hash_match.group(1) if hash_match else None,
                'captured': captured_match.group(1).strip() if captured_match else None,
                'entry': entry_match.group(1).strip() if entry_match else None
            }
            print(f'  ✅ {cid}: {fp_match.group(1) if fp_match else "no fingerprint"}')
    except Exception as err:
        print(f'❌ Could not read .regret files: {err}')

    # Read chain hashes
    chains = {}
    chains_dir = os.path.join(regret_dir, 'chains')
    if os.path.isdir(chains_dir):
        for file in os.listdir(chains_dir):
            if file.endswith('.chain'):
                filepath = os.path.join(chains_dir, file)
                with open(filepath, 'r', encoding='utf-8') as f:
                    content = f.read()
                chain_hash_match = re.search(r'^chain_hash:\s+(\S+)', content, re.MULTILINE)
                chain_id = file.replace('.chain', '')
                chains[chain_id] = {'chainHash': chain_hash_match.group(1) if chain_hash_match else None}
                print(f'  ✅ chain/{chain_id}: {chain_hash_match.group(1) if chain_hash_match else "no hash"}')

    # ─── Consistency Check ───────────────────────────────────────────────────────

    k1_ids = set(raw_outputs.keys())
    k2_ids = set(fingerprints.keys())

    in_k1_not_k2 = k1_ids - k2_ids
    in_k2_not_k1 = k2_ids - k1_ids

    if in_k1_not_k2 or in_k2_not_k1:
        print('\n❌ INCONSISTENCY between KEBENARAN 1 and KEBENARAN 2:')
        if in_k1_not_k2:
            print(f'   In K1 but not K2: {", ".join(in_k1_not_k2)}')
        if in_k2_not_k1:
            print(f'   In K2 but not K1: {", ".join(in_k2_not_k1)}')
        print('   Fix this before refactoring — it indicates a false negative.')
        sys.exit(1)

    # ─── Write Output Files ───────────────────────────────────────────────────────

    project_name = manifest.get('projectName', os.path.basename(os.getcwd()))

    if cli['outdir']:
        proof_dir = cli['outdir']
    else:
        proof_dir = os.path.join(os.getcwd(), 'proof', project_name)

    os.makedirs(proof_dir, exist_ok=True)

    k1_path = os.path.join(proof_dir, 'KEBENARAN_1_raw_output.json')
    k2_path = os.path.join(proof_dir, 'KEBENARAN_2_fingerprints.json')

    with open(k1_path, 'w', encoding='utf-8') as f:
        json.dump(raw_outputs, f, indent=2, ensure_ascii=False)
        f.write('\n')

    with open(k2_path, 'w', encoding='utf-8') as f:
        json.dump({'fingerprints': fingerprints, 'chains': chains}, f, indent=2, ensure_ascii=False)
        f.write('\n')

    print(f"\n{'─' * 50}")
    print('✅ Both truths saved:')
    print(f'   KEBENARAN 1: {k1_path} ({len(raw_outputs)} clusters)')
    print(f'   KEBENARAN 2: {k2_path} ({len(fingerprints)} fingerprints, {len(chains)} chains)')
    print('\n   Consistency: ✅ Both truths are aligned')
    print("\nYou are now safe to refactor. Run 'regret validate' after each change.")


if __name__ == '__main__':
    main()

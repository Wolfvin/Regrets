#!/usr/bin/env python3
# truth.py — Save dual truth baselines before refactoring (Python stack)
# Mirrors truth.js functionality for Python stack clusters.
#
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
import importlib
from datetime import datetime, timezone

# Import shared fingerprint module
from fingerprint import (
    stable_dumps, normalize, strip_fields, to_base36,
    deep_clone, fingerprint, fingerprint_sequence, extract_schema
)


# ─── Local helpers (mirrored from fingerprint.py) ────────────────────────────

def materialize_output(val):
    """Materialize generator/iterator output into a list for fingerprinting.

    Returns a tuple: (materialized_value, was_materialized_bool)
    """
    import types as _types
    if val is None or isinstance(val, (bool, int, float, str, bytes, dict, list, tuple, set)):
        return val, False
    is_generator = isinstance(val, _types.GeneratorType)
    is_map_filter = isinstance(val, (map, filter))
    is_range = isinstance(val, range)
    is_iterator = hasattr(val, '__next__') and not isinstance(val, (str, bytes, dict))
    if is_generator or is_map_filter or is_range or is_iterator:
        try:
            return list(val), True
        except Exception:
            return val, False
    return val, False


# ─── CLI args ─────────────────────────────────────────────────────────────────

def parse_args():
    args = sys.argv[1:]
    result = {
        'outdir': None,
        'manifest': os.path.join(os.getcwd(), 'regrets', 'manifest.json'),
    }
    i = 0
    while i < len(args):
        if args[i] == '--outdir' and i + 1 < len(args):
            result['outdir'] = args[i + 1]
            i += 2
        elif args[i] == '--manifest' and i + 1 < len(args):
            result['manifest'] = args[i + 1]
            i += 2
        else:
            i += 1

    if result['outdir'] is None:
        result['outdir'] = os.path.join(os.getcwd(), 'proof')

    return result


# ─── Helpers (shared with capture.py) ─────────────────────────────────────────

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
    """Apply an outputTransform to convert complex objects to fingerprintable form.

    See capture.py for full documentation.
    """
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
        elif transform == 'hex':
            if isinstance(obj, bytes):
                return obj.hex()
            return obj
        else:
            raise ValueError(f"Unknown outputTransform: '{transform}'")

    if isinstance(output, list) and transform not in ('len',):
        return [transform_one(item) for item in output]
    return transform_one(output)


# ─── Main ─────────────────────────────────────────────────────────────────────

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
        inputs = cluster.get('inputs', [None])
        multi_args = cluster.get('multiArgs', False)
        kwargs_mode = cluster.get('kwargs', False)
        output_transform = cluster.get('outputTransform', None)
        materialize_output_flag = cluster.get('materializeOutput', False)

        print(f'  Processing: {cid}')

        try:
            mod = importlib.import_module(module_path)
            entry_fn = getattr(mod, entry, None)

            if entry_fn is None or not callable(entry_fn):
                print(f'    ❌ Entry "{entry}" not found in {module_path}')
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

                # Materialize generators
                output, was_materialized = materialize_output(raw_output) if materialize_output_flag else (raw_output, False)
                if not materialize_output_flag:
                    output = consume_generator(output)

                # Apply output transform for serialization
                output_for_storage = apply_output_transform(deep_clone(output), output_transform)

                outputs.append({
                    'input': deep_clone(input_val),
                    'output': output_for_storage,
                })

            raw_outputs[cid] = {
                'entry': entry,
                'outputs': outputs,
            }
            print(f'    ✅ {cid}: {len(outputs)} output(s) captured')

        except Exception as err:
            print(f'    ❌ {cid}: {err}')
            import traceback
            traceback.print_exc()

    # ─── KEBENARAN 2: Fingerprint Contracts ───────────────────────────────────

    print('\n📡 Saving KEBENARAN 2 — Fingerprint contracts from .regret files\n')

    fingerprints = {}
    regret_dir = os.path.join(os.getcwd(), 'regrets')

    try:
        regret_files = [f for f in os.listdir(regret_dir) if f.endswith('.regret')]
    except FileNotFoundError:
        regret_files = []

    for regret_file in regret_files:
        cluster_id = os.path.splitext(regret_file)[0]
        regret_path = os.path.join(regret_dir, regret_file)

        with open(regret_path, 'r', encoding='utf-8') as f:
            content = f.read()

        # Parse metadata
        fp_match = None
        hash_match = None
        captured_match = None
        entry_match = None

        for line in content.split('\n---\n')[0].split('\n'):
            if line.startswith('fingerprint: '):
                fp_match = line[len('fingerprint: '):].strip()
            elif line.startswith('HASH '):
                hash_match = line[len('HASH '):].strip()
            elif line.startswith('captured: '):
                captured_match = line[len('captured: '):].strip()
            elif line.startswith('entry: '):
                entry_match = line[len('entry: '):].strip()

        # Parse data section for golden output
        golden_output = None
        golden_input = None
        data_section = content.split('\n---\n')[1] if '\n---\n' in content else ''
        for line in data_section.split('\n'):
            if line.startswith('OUTPUT '):
                try:
                    golden_output = json.loads(line[len('OUTPUT '):])
                except json.JSONDecodeError:
                    golden_output = line[len('OUTPUT '):]
            elif line.startswith('INPUT '):
                try:
                    golden_input = json.loads(line[len('INPUT '):])
                except json.JSONDecodeError:
                    golden_input = line[len('INPUT '):]

        fingerprints[cluster_id] = {
            'fingerprint': fp_match or hash_match,
            'golden_hash': hash_match,
            'golden_input': golden_input,
            'golden_output': golden_output,
            'captured': captured_match,
            'entry': entry_match,
        }
        print(f'  ✅ {cluster_id}: {fp_match or "no fingerprint"}')

    # Read chain hashes
    chains = {}
    chains_dir = os.path.join(regret_dir, 'chains')
    if os.path.isdir(chains_dir):
        for chain_file in os.listdir(chains_dir):
            if chain_file.endswith('.chain'):
                chain_path = os.path.join(chains_dir, chain_file)
                with open(chain_path, 'r', encoding='utf-8') as f:
                    chain_content = f.read()
                chain_hash_match = None
                for line in chain_content.split('\n'):
                    if line.startswith('chain_hash: '):
                        chain_hash_match = line[len('chain_hash: '):].strip()
                        break
                chain_id = os.path.splitext(chain_file)[0]
                chains[chain_id] = {'chain_hash': chain_hash_match}
                print(f'  ✅ chain/{chain_id}: {chain_hash_match or "no hash"}')

    # ─── Consistency Check ────────────────────────────────────────────────────

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

    # ─── Write Output Files ───────────────────────────────────────────────────

    project_name = manifest.get('projectName', os.getcwd().split(os.sep)[-1])
    proof_dir = os.path.join(cli['outdir'], project_name)
    os.makedirs(proof_dir, exist_ok=True)

    k1_path = os.path.join(proof_dir, 'KEBENARAN_1_raw_output.json')
    k2_path = os.path.join(proof_dir, 'KEBENARAN_2_fingerprints.json')

    with open(k1_path, 'w', encoding='utf-8') as f:
        json.dump(raw_outputs, f, indent=2, ensure_ascii=False)
        f.write('\n')

    with open(k2_path, 'w', encoding='utf-8') as f:
        json.dump({'clusters': fingerprints, 'chains': chains}, f, indent=2, ensure_ascii=False)
        f.write('\n')

    print(f'\n{"─" * 50}')
    print('✅ Both truths saved:')
    print(f'   KEBENARAN 1: {k1_path} ({len(raw_outputs)} clusters)')
    print(f'   KEBENARAN 2: {k2_path} ({len(fingerprints)} fingerprints, {len(chains)} chains)')
    print(f'\n   Consistency: ✅ Both truths are aligned')
    print(f'\nYou are now safe to refactor. Run \'regret validate\' after each change.')


if __name__ == '__main__':
    main()

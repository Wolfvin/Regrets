#!/usr/bin/env python3
# truth.py — Save dual truth baselines before refactoring (Python stack)
# KEBENARAN 1: Raw output from every entry function
# KEBENARAN 2: Fingerprint contracts from .regret files + chain hashes
#
# This is the Python stack equivalent of truth.js.
# Both truths must be identical in meaning. If they disagree,
# there's a false negative in Regrets — fix it before refactoring.
#
# Usage:
#   python scripts/truth.py
#   python scripts/truth.py --outdir ./proof/myproject
#   python scripts/truth.py --cluster my-cluster
#
# Generates:
#   KEBENARAN_1_raw_output.json — Raw output from every entry function
#   KEBENARAN_2_fingerprints.json — Fingerprint contracts from .regret files + chain hashes
#
# Both truths must be identical in meaning. If they disagree,
# there's a false negative in Regrets — fix it before refactoring.

import sys
import os
import json
import importlib
import re
import types
import glob
from pathlib import Path
from datetime import datetime, timezone

# Import shared fingerprint module
SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, SCRIPT_DIR)
from fingerprint import (
    stable_dumps, normalize, strip_fields, to_base36,
    deep_clone, fingerprint, fingerprint_sequence, extract_schema,
    _numpy_to_native, materialize_output, snapshot_state, get_env_snapshot
)


def parse_args():
    args = sys.argv[1:]
    result = {
        'outdir': None,
        'manifest': os.path.join(os.getcwd(), 'regrets', 'manifest.json'),
        'cluster': None,
    }
    i = 0
    while i < len(args):
        if args[i] == '--outdir' and i + 1 < len(args):
            result['outdir'] = args[i + 1]
            i += 2
        elif args[i] == '--manifest' and i + 1 < len(args):
            result['manifest'] = args[i + 1]
            i += 2
        elif args[i] == '--cluster' and i + 1 < len(args):
            result['cluster'] = args[i + 1]
            i += 2
        else:
            i += 1

    if result['outdir'] is None:
        result['outdir'] = os.path.join(os.getcwd(), 'proof')

    return result


def json_serialize(val):
    """Serialize value to JSON string for output. Handles numpy types."""
    return json.dumps(_numpy_to_native(val), ensure_ascii=False)


def consume_generator(val):
    """If val is a generator or iterator, consume it into a list."""
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


def parse_regret_file(content):
    """Parse a .regret file and return its metadata and data sections."""
    meta = {}
    sections = content.split('\n---\n')
    meta_section = sections[0]
    for line in meta_section.split('\n'):
        colon_idx = line.find(': ')
        if colon_idx == -1:
            continue
        key = line[:colon_idx]
        val = line[colon_idx + 2:].strip()
        if key == 'watches':
            meta[key] = [w.strip() for w in val.strip('[]').split(',') if w.strip()]
        elif key == 'normalize':
            meta[key] = [n.strip() for n in val.strip('[]').split(',') if n.strip()]
        elif key == 'ignoreFields':
            meta[key] = [f.strip() for f in val.strip('[]').split(',') if f.strip()]
        else:
            meta[key] = val
    # Parse data section
    data_section = sections[1] if len(sections) > 1 else ''
    for line in data_section.split('\n'):
        if line.startswith('INPUT '):
            meta['input'] = json.loads(line[6:])
        elif line.startswith('OUTPUT '):
            meta['output'] = json.loads(line[7:])
        elif line.startswith('HASH '):
            meta['goldenHash'] = line[5:].strip()
    return meta


def main():
    cli = parse_args()
    manifest_path = cli['manifest']
    out_dir = cli['outdir']

    # Load manifest
    try:
        with open(manifest_path, 'r', encoding='utf-8') as f:
            manifest = json.load(f)
    except (FileNotFoundError, json.JSONDecodeError) as e:
        print(f"❌ Could not read manifest: {manifest_path}")
        print(f"   Error: {e}")
        sys.exit(1)

    clusters = manifest.get('clusters', [])
    if cli['cluster']:
        clusters = [c for c in clusters if c['id'] == cli['cluster']]

    python_clusters = [c for c in clusters if c.get('stack') == 'python']

    if not python_clusters:
        print("No Python clusters found in manifest.")
        sys.exit(0)

    # Setup pythonPath: manifest-level first, then cluster-level
    manifest_python_path = manifest.get('pythonPath', '')
    if isinstance(manifest_python_path, str):
        manifest_python_paths = [manifest_python_path] if manifest_python_path else []
    elif isinstance(manifest_python_path, list):
        manifest_python_paths = manifest_python_path
    else:
        manifest_python_paths = []
    for pp in manifest_python_paths:
        if pp:
            abs_pp = os.path.join(os.getcwd(), pp) if not os.path.isabs(pp) else pp
            if abs_pp not in sys.path:
                sys.path.insert(0, abs_pp)

    # Setup cluster-level pythonPath
    for cluster in python_clusters:
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
                abs_python_path = os.path.join(os.getcwd(), python_path) if not os.path.isabs(python_path) else python_path
                if abs_python_path not in sys.path:
                    sys.path.insert(0, abs_python_path)

    # ─── KEBENARAN 1: Raw Output ─────────────────────────────────────────────

    print('\n📡 Saving KEBENARAN 1 — Raw output from entry functions (Python)\n')

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
        norm_rules = cluster.get('normalize', [])
        ign_fields = cluster.get('ignoreFields', [])
        fp_level = cluster.get('fingerprintLevel', 'entry')
        fp_mode = cluster.get('fingerprintMode', 'value')
        value_paths = cluster.get('valuePaths', [])

        print(f'  📡 Capturing raw output: {cid}')

        try:
            mod = importlib.import_module(module_path)
            test_inputs = inputs if inputs else [None]

            if class_method:
                # Class-based entry (god-module decomposition support)
                cls_name = constructor or entry
                Cls = getattr(mod, cls_name, None)
                if Cls is None:
                    raise TypeError(f'Class "{cls_name}" not found in {module_path}')

                outputs = []
                for input_val in test_inputs:
                    try:
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
                        elif kwargs_mode and not isinstance(input_for_args, dict):
                            raise TypeError(
                                f'kwargs=True but input is {type(input_for_args).__name__}, not dict.'
                            )
                        elif input_for_args is not None:
                            raw_output = getattr(instance, class_method)(input_for_args)
                        else:
                            raw_output = getattr(instance, class_method)()

                        # Materialize generator/iterator output if configured
                        output, was_materialized = materialize_output(raw_output) if materialize_output_flag else (raw_output, False)
                        if was_materialized:
                            print(f'     🔄 Output materialized: {type(raw_output).__name__} → list ({len(output)} items)')

                        # Consume generators/iterators into lists (always-on fallback)
                        if not materialize_output_flag:
                            raw_type_name = type(output).__name__
                            output = consume_generator(output)
                            if type(output).__name__ != raw_type_name and raw_type_name in ('generator', 'map', 'filter', 'range'):
                                print(f'     🔄 Auto-materialized: {raw_type_name} → list ({len(output)} items)')

                        # Apply output transform if specified
                        output_for_record = apply_output_transform(deep_clone(output), output_transform)

                        outputs.append({
                            'input': deep_clone(input_val),
                            'output': _numpy_to_native(output_for_record),
                        })
                    except Exception as err:
                        print(f'     ❌ Input {input_val}: {err}')
                        outputs.append({
                            'input': deep_clone(input_val),
                            'output': {'__error__': str(err)},
                        })

                raw_outputs[cid] = {
                    'entry': entry,
                    'module': module_path,
                    'classMethod': class_method,
                    'outputs': outputs,
                }
                print(f'  ✅ {cid}: {len(outputs)} output(s) captured')

            else:
                # Function-based entry
                entry_fn = getattr(mod, entry, None)
                if entry_fn is None or not callable(entry_fn):
                    raise TypeError(f'Entry "{entry}" not found or not callable in {module_path}')

                outputs = []
                for input_val in test_inputs:
                    input_for_args = deep_clone(input_val)

                    try:
                        if multi_args and isinstance(input_for_args, list):
                            raw_output = entry_fn(*input_for_args)
                        elif kwargs_mode and isinstance(input_for_args, dict):
                            raw_output = entry_fn(**input_for_args)
                        elif kwargs_mode and not isinstance(input_for_args, dict):
                            raise TypeError(
                                f'kwargs=True but input is {type(input_for_args).__name__}, not dict.'
                            )
                        else:
                            raw_output = entry_fn(input_for_args) if input_for_args is not None else entry_fn()

                        # Materialize generator/iterator output if configured
                        output, was_materialized = materialize_output(raw_output) if materialize_output_flag else (raw_output, False)
                        if was_materialized:
                            print(f'     🔄 Output materialized: {type(raw_output).__name__} → list ({len(output)} items)')

                        # Consume generators/iterators into lists (always-on fallback)
                        if not materialize_output_flag:
                            raw_type_name = type(output).__name__
                            output = consume_generator(output)
                            if type(output).__name__ != raw_type_name and raw_type_name in ('generator', 'map', 'filter', 'range'):
                                print(f'     🔄 Auto-materialized: {raw_type_name} → list ({len(output)} items)')

                        # Apply output transform if specified
                        output_for_record = apply_output_transform(deep_clone(output), output_transform)

                        outputs.append({
                            'input': deep_clone(input_val),
                            'output': _numpy_to_native(output_for_record),
                        })
                    except Exception as err:
                        print(f'     ❌ Input {input_val}: {err}')
                        outputs.append({
                            'input': deep_clone(input_val),
                            'output': {'__error__': str(err)},
                        })

                raw_outputs[cid] = {
                    'entry': entry,
                    'module': module_path,
                    'outputs': outputs,
                }
                print(f'  ✅ {cid}: {len(outputs)} output(s) captured')

        except Exception as err:
            print(f'  ❌ {cid}: {err}')
            import traceback
            traceback.print_exc()

    # ─── KEBENARAN 2: Fingerprint Contracts ───────────────────────────────────

    print('\n📡 Saving KEBENARAN 2 — Fingerprint contracts from .regret files\n')

    fingerprints = {}
    regret_dir = os.path.join(os.getcwd(), 'regrets')

    try:
        regret_files = [f for f in os.listdir(regret_dir) if f.endswith('.regret')]

        for fname in regret_files:
            fpath = os.path.join(regret_dir, fname)
            with open(fpath, 'r', encoding='utf-8') as f:
                content = f.read()

            meta = parse_regret_file(content)
            cid = meta.get('cluster', fname.replace('.regret', ''))

            # Extract fingerprint from header
            fp_match = re.search(r'^fingerprint:\s+(\S+)', content, re.MULTILINE)
            hash_match = re.search(r'^HASH\s+(\S+)', content, re.MULTILINE)
            captured_match = re.search(r'^captured:\s+(.+)$', content, re.MULTILINE)
            entry_match = re.search(r'^entry:\s+(.+)$', content, re.MULTILINE)

            # Extract golden input/output from data section
            golden_output = None
            golden_input = None
            sections = content.split('\n---\n')
            if len(sections) > 1:
                data_section = sections[1]
                for line in data_section.split('\n'):
                    if line.startswith('OUTPUT '):
                        output_str = line[7:]
                        try:
                            golden_output = json.loads(output_str)
                        except json.JSONDecodeError:
                            golden_output = output_str
                    elif line.startswith('INPUT '):
                        input_str = line[6:]
                        try:
                            golden_input = json.loads(input_str)
                        except json.JSONDecodeError:
                            golden_input = input_str

            fingerprints[cid] = {
                'fingerprint': fp_match.group(1) if fp_match else None,
                'golden_hash': hash_match.group(1) if hash_match else None,
                'captured': captured_match.group(1).strip() if captured_match else None,
                'entry': entry_match.group(1).strip() if entry_match else None,
                'golden_input': golden_input,
                'golden_output': golden_output,
            }
            fp_val = fp_match.group(1) if fp_match else 'no fingerprint'
            print(f'  ✅ {cid}: {fp_val}')

    except FileNotFoundError:
        print("  ⚠️  No .regret files found")
    except Exception as err:
        print(f'❌ Could not read .regret files: {err}')

    # Read chain hashes
    chains = {}
    chains_dir = os.path.join(regret_dir, 'chains')
    if os.path.isdir(chains_dir):
        chain_files = [f for f in os.listdir(chains_dir) if f.endswith('.chain')]
        for fname in chain_files:
            fpath = os.path.join(chains_dir, fname)
            with open(fpath, 'r', encoding='utf-8') as f:
                content = f.read()
            chain_hash_match = re.search(r'^chain_hash:\s+(\S+)', content, re.MULTILINE)
            chain_id = fname.replace('.chain', '')
            chains[chain_id] = {
                'chain_hash': chain_hash_match.group(1) if chain_hash_match else None
            }
            ch_val = chain_hash_match.group(1) if chain_hash_match else 'no hash'
            print(f'  ✅ chain/{chain_id}: {ch_val}')

    # ─── Consistency Check ───────────────────────────────────────────────────

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

    project_name = manifest.get('projectName', os.path.basename(os.getcwd()))

    if cli['outdir']:
        proof_dir = cli['outdir']
    else:
        proof_dir = os.path.join(out_dir, project_name)

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

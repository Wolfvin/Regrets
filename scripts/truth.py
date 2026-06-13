#!/usr/bin/env python3
# truth.py — Save dual truth baselines for Python clusters before refactoring
# KEBENARAN 1: Raw output from every entry function
# KEBENARAN 2: Fingerprint contracts from .regret files + chain hashes
#
# Usage:
#   python scripts/truth.py
#   python scripts/truth.py --outdir ./proof/myproject

import json
import os
import sys
import importlib
import re

# Import shared fingerprint module
SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, SCRIPT_DIR)
from fingerprint import deep_clone, fingerprint, normalize, strip_fields


def parse_args():
    args = sys.argv[1:]
    out_dir = os.path.join(os.getcwd(), 'proof')
    manifest_path = os.path.join(os.getcwd(), 'regrets', 'manifest.json')
    i = 0
    while i < len(args):
        if args[i] == '--outdir' and i + 1 < len(args):
            out_dir = args[i + 1]; i += 2
        elif args[i] == '--manifest' and i + 1 < len(args):
            manifest_path = args[i + 1]; i += 2
        else:
            i += 1
    return out_dir, manifest_path


def parse_regret_meta(content):
    meta = {}
    parts = content.split('\n---\n', 1)
    meta_section = parts[0]
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
    data_section = parts[1] if len(parts) > 1 else ''
    for line in data_section.split('\n'):
        if line.startswith('INPUT '):
            meta['input'] = json.loads(line[6:])
        elif line.startswith('OUTPUT '):
            meta['output'] = json.loads(line[7:])
        elif line.startswith('HASH '):
            meta['goldenHash'] = line[5:].strip()
    return meta


def main():
    out_dir, manifest_path = parse_args()

    # Load manifest
    with open(manifest_path, 'r', encoding='utf-8') as f:
        manifest = json.load(f)

    clusters = [c for c in manifest.get('clusters', []) if c.get('stack') == 'python']
    if not clusters:
        print('No Python clusters found in manifest.')
        sys.exit(0)

    # Add pythonPath to sys.path
    for cluster in clusters:
        raw_python_path = cluster.get('pythonPath', '')
        if isinstance(raw_python_path, str):
            python_paths = [raw_python_path] if raw_python_path else []
        elif isinstance(raw_python_path, list):
            python_paths = raw_python_path
        else:
            python_paths = []
        for python_path in python_paths:
            abs_path = os.path.join(os.getcwd(), python_path)
            if abs_path not in sys.path:
                sys.path.insert(0, abs_path)

    # ─── KEBENARAN 1: Raw output from entry functions ──────────────────────────
    print('\n📡 Saving KEBENARAN 1 — Raw output from entry functions\n')

    raw_outputs = {}
    for cluster in clusters:
        cid = cluster['id']
        entry_name = cluster['entry']
        module_path = cluster.get('module', cluster.get('file', ''))
        multi_args = cluster.get('multiArgs', False)
        kwargs_mode = cluster.get('kwargs', False)
        inputs = cluster.get('inputs', [None])

        try:
            mod = importlib.import_module(module_path)
            entry_fn = getattr(mod, entry_name, None)
            if entry_fn is None or not callable(entry_fn):
                raise TypeError(f'Entry "{entry_name}" not found in {module_path}')

            outputs = []
            for input_val in inputs:
                input_for_args = deep_clone(input_val)
                if multi_args and isinstance(input_for_args, list):
                    raw_output = entry_fn(*input_for_args)
                elif kwargs_mode and isinstance(input_for_args, dict):
                    raw_output = entry_fn(**input_for_args)
                elif input_for_args is not None:
                    raw_output = entry_fn(input_for_args)
                else:
                    raw_output = entry_fn()
                outputs.append({'input': deep_clone(input_val), 'output': deep_clone(raw_output)})

            raw_outputs[cid] = outputs
            print(f'  ✅ {cid}')
        except Exception as err:
            print(f'  ❌ {cid}: {err}')

    # ─── KEBENARAN 2: Fingerprint contracts from .regret files ──────────────────
    print('\n📡 Saving KEBENARAN 2 — Fingerprint contracts from .regret files\n')

    fingerprints = {}
    regret_dir = os.path.join(os.getcwd(), 'regrets')

    try:
        regret_files = [f for f in os.listdir(regret_dir) if f.endswith('.regret')]
        for f in regret_files:
            with open(os.path.join(regret_dir, f), 'r', encoding='utf-8') as fh:
                content = fh.read()
            meta = parse_regret_meta(content)
            cid = meta.get('cluster', f.replace('.regret', ''))
            fingerprints[cid] = {
                'fingerprint': meta.get('fingerprint'),
                'hash': meta.get('goldenHash'),
                'captured': meta.get('captured'),
                'entry': meta.get('entry'),
            }
            print(f'  ✅ {cid}: {meta.get("fingerprint", "no fingerprint")}')
    except Exception as err:
        print(f'❌ Could not read .regret files: {err}')

    # Read chain hashes
    chains = {}
    chains_dir = os.path.join(regret_dir, 'chains')
    if os.path.isdir(chains_dir):
        chain_files = [f for f in os.listdir(chains_dir) if f.endswith('.chain')]
        for f in chain_files:
            with open(os.path.join(chains_dir, f), 'r', encoding='utf-8') as fh:
                content = fh.read()
            m = re.search(r'^chain_hash:\s+(\S+)', content, re.MULTILINE)
            chain_id = f.replace('.chain', '')
            chains[chain_id] = {'chainHash': m.group(1) if m else None}
            print(f'  ✅ chain/{chain_id}: {m.group(1) if m else "no hash"}')

    # ─── Consistency Check ────────────────────────────────────────────────────
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

    # ─── Write Output Files ──────────────────────────────────────────────────
    project_name = manifest.get('projectName', os.getcwd().split('/')[-1])
    proof_dir = os.path.join(out_dir, project_name)
    os.makedirs(proof_dir, exist_ok=True)

    k1_path = os.path.join(proof_dir, 'KEBENARAN_1_raw_output.json')
    k2_path = os.path.join(proof_dir, 'KEBENARAN_2_fingerprints.json')

    with open(k1_path, 'w', encoding='utf-8') as f:
        json.dump(raw_outputs, f, indent=2, ensure_ascii=False)
    with open(k2_path, 'w', encoding='utf-8') as f:
        json.dump({'fingerprints': fingerprints, 'chains': chains}, f, indent=2, ensure_ascii=False)

    print(f'\n{"─" * 50}')
    print(f'✅ Both truths saved:')
    print(f'   KEBENARAN 1: {k1_path} ({len(raw_outputs)} clusters)')
    print(f'   KEBENARAN 2: {k2_path} ({len(fingerprints)} fingerprints, {len(chains)} chains)')
    print(f'\n   Consistency: ✅ Both truths are aligned')
    print(f'\nYou are now safe to refactor. Run "regret validate" after each change.')


if __name__ == '__main__':
    main()

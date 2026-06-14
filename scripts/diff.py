#!/usr/bin/env python3
# diff.py — Compare live output against .regret golden output for Python clusters
# Shows exactly what changed when a cluster goes RED.
#
# Usage:
#   python scripts/diff.py                              Compare all Python clusters
#   python scripts/diff.py --cluster <id>               Compare specific cluster
#   python scripts/diff.py --manifest ./regrets/manifest.json

import sys
import os
import json
import importlib
from fingerprint import (
    stable_dumps, normalize, strip_fields, to_base36,
    deep_clone, fingerprint, fingerprint_sequence, extract_schema,
    _numpy_to_native
)


def parse_args():
    args = sys.argv[1:]
    result = {
        'cluster': None,
        'manifest': os.path.join(os.getcwd(), 'regrets', 'manifest.json'),
    }
    i = 0
    while i < len(args):
        if args[i] == '--cluster' and i + 1 < len(args):
            result['cluster'] = args[i + 1]; i += 2
        elif args[i] == '--manifest' and i + 1 < len(args):
            result['manifest'] = args[i + 1]; i += 2
        else:
            i += 1
    return result


def parse_regret(content):
    parts = content.split('\n---\n', 1)
    meta_section = parts[0]
    data_section = parts[1] if len(parts) > 1 else ''
    meta = {}
    for line in meta_section.split('\n'):
        colon_idx = line.find(': ')
        if colon_idx == -1:
            continue
        key = line[:colon_idx]
        val = line[colon_idx + 2:].strip()
        if key == 'watches':
            meta['watches'] = [w.strip() for w in val.strip('[]').split(',') if w.strip()]
        elif key == 'normalize':
            meta['normalize'] = [n.strip() for n in val.strip('[]').split(',') if n.strip()]
        elif key == 'ignoreFields':
            meta['ignoreFields'] = [f.strip() for f in val.strip('[]').split(',') if f.strip()]
        elif key == 'fingerprintMode':
            meta['fingerprintMode'] = val
        elif key == 'valuePaths':
            meta['valuePaths'] = [p.strip() for p in val.strip('[]').split(',') if p.strip()]
        else:
            meta[key] = val

    for line in data_section.split('\n'):
        if line.startswith('INPUT '):
            meta['input'] = json.loads(line[6:])
        elif line.startswith('OUTPUT '):
            meta['output'] = json.loads(line[7:])
        elif line.startswith('HASH '):
            meta['goldenHash'] = line[5:].strip()
    meta['raw'] = content
    return meta


def deep_diff(expected, actual, path=''):
    """Recursively compare two values and return a list of differences."""
    diffs = []

    if expected is actual:
        return diffs

    if expected is None or actual is None:
        if expected is not actual:
            diffs.append({'path': path or '(root)', 'expected': expected, 'actual': actual, 'type': 'value_mismatch'})
        return diffs

    if type(expected) != type(actual):
        diffs.append({'path': path or '(root)', 'expected': expected, 'actual': actual, 'type': 'type_mismatch'})
        return diffs

    if isinstance(expected, list) and isinstance(actual, list):
        if len(expected) != len(actual):
            diffs.append({'path': path or '(root)', 'expected': f'array[{len(expected)}]', 'actual': f'array[{len(actual)}]', 'type': 'length_mismatch'})
        for i in range(max(len(expected), len(actual))):
            e_val = expected[i] if i < len(expected) else None
            a_val = actual[i] if i < len(actual) else None
            sub_path = f'{path}[{i}]'
            diffs.extend(deep_diff(e_val, a_val, sub_path))
        return diffs

    if isinstance(expected, dict) and isinstance(actual, dict):
        all_keys = set(expected.keys()) | set(actual.keys())
        for key in sorted(all_keys):
            sub_path = f'{path}.{key}' if path else key
            if key not in expected:
                diffs.append({'path': sub_path, 'expected': None, 'actual': actual[key], 'type': 'added_key'})
            elif key not in actual:
                diffs.append({'path': sub_path, 'expected': expected[key], 'actual': None, 'type': 'removed_key'})
            else:
                diffs.extend(deep_diff(expected[key], actual[key], sub_path))
        return diffs

    if expected != actual:
        # Check float tolerance
        if isinstance(expected, (int, float)) and isinstance(actual, (int, float)):
            diff = abs(expected - actual)
            rel_diff = diff / abs(expected) if expected != 0 else diff
            if diff < 0.01 or rel_diff < 1e-10:
                diffs.append({'path': path or '(root)', 'expected': expected, 'actual': actual, 'type': 'float_tolerance', 'diff': diff})
                return diffs
        diffs.append({'path': path or '(root)', 'expected': expected, 'actual': actual, 'type': 'value_mismatch'})

    return diffs


def format_value(val, max_len=80):
    if val is None:
        return 'null'
    if isinstance(val, str):
        s = val
    elif isinstance(val, (dict, list)):
        s = json.dumps(val, ensure_ascii=False)
    else:
        s = str(val)
    return s[:max_len] + '...' if len(s) > max_len else s


def format_diffs(diffs):
    if not diffs:
        return '  (no differences)'
    lines = []
    for d in diffs:
        icon = {'float_tolerance': '≈', 'added_key': '+', 'removed_key': '-'}.get(d['type'], '≠')
        lines.append(f'  {icon} {d["path"]}')
        lines.append(f'      golden:  {format_value(d["expected"])}')
        lines.append(f'      live:    {format_value(d["actual"])}')
        if d['type'] == 'float_tolerance':
            lines.append(f'      diff:    {d["diff"]} (within float tolerance)')
        if d['type'] == 'length_mismatch':
            lines.append(f'      ⚠️  Array length changed — this likely means added/removed items')
    return '\n'.join(lines)


def main():
    cli = parse_args()

    # Load manifest
    try:
        with open(cli['manifest'], 'r', encoding='utf-8') as f:
            manifest = json.load(f)
    except (FileNotFoundError, json.JSONDecodeError):
        print(f"❌ Could not read manifest: {cli['manifest']}")
        sys.exit(1)

    # Add pythonPath to sys.path: manifest-level first, then cluster-level
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

    # Find .regret files
    regret_dir = os.path.join(os.getcwd(), 'regrets')
    filter_id = cli['cluster']

    try:
        regret_files = [
            f for f in os.listdir(regret_dir)
            if f.endswith('.regret') and (not filter_id or f == f'{filter_id}.regret')
        ]
    except FileNotFoundError:
        print("❌ regrets/ not found.")
        sys.exit(1)

    if not regret_files:
        print(f"❌ No .regret files found{' for ' + filter_id if filter_id else ''}.")
        sys.exit(1)

    print(f'\n🔍 Diffing {len(regret_files)} Python cluster(s) against live output...\n')

    any_diff = False

    for regret_file in regret_files:
        cluster_id = os.path.splitext(regret_file)[0]
        regret_path = os.path.join(regret_dir, regret_file)

        with open(regret_path, 'r', encoding='utf-8') as f:
            regret = parse_regret(f.read())

        # Find cluster definition
        cluster_def = None
        for c in manifest.get('clusters', []):
            if c['id'] == cluster_id:
                cluster_def = c
                break

        if not cluster_def:
            print(f"  ⚠️  {cluster_id}: not in manifest — skipping")
            continue

        if cluster_def.get('stack') != 'python':
            print(f"  ⏭️  {cluster_id}: stack={cluster_def.get('stack', 'js')} — use node scripts/diff.js")
            continue

        try:
            module_path = cluster_def.get('module', cluster_def.get('file', ''))
            entry_name = cluster_def['entry']
            norm_rules = cluster_def.get('normalize', [])
            ign_fields = cluster_def.get('ignoreFields', [])
            multi_args = cluster_def.get('multiArgs', False)

            mod = importlib.import_module(module_path)
            entry_fn = getattr(mod, entry_name, None)
            if entry_fn is None or not callable(entry_fn):
                raise TypeError(f"Entry \"{entry_name}\" not found in {module_path}")

            golden_input = regret.get('input')
            input_for_args = deep_clone(golden_input)
            if multi_args and isinstance(input_for_args, list):
                output = entry_fn(*input_for_args)
            else:
                output = entry_fn(input_for_args) if input_for_args is not None else entry_fn()

            live_output = _numpy_to_native(output)
            golden_output = regret.get('output')

            live_fp = fingerprint(golden_input, live_output, norm_rules, ign_fields)
            golden_fp = regret.get('fingerprint', '')

            is_match = live_fp == golden_fp
            icon = '✅' if is_match else '❌'

            print(f'{icon} {cluster_id:<40} {golden_fp} → {live_fp}')

            if not is_match:
                any_diff = True
                diffs = deep_diff(golden_output, live_output)
                if not diffs:
                    print(f'  ⚠️  Fingerprint differs but deep diff shows no structural difference.')
                    print(f'      This may be caused by normalization rules or key ordering.')
                    print(f'      Golden output: {format_value(golden_output, 200)}')
                    print(f'      Live output:   {format_value(live_output, 200)}')
                else:
                    print(format_diffs(diffs))
                print()

        except Exception as err:
            print(f'  ❌ {cluster_id:<40} ERROR: {err}')
            any_diff = True

    if any_diff:
        print('\n⚠️  Differences found. Fix the CODE — do not edit .regret files.')
        sys.exit(1)
    else:
        print('\n✅ All clusters match — no differences found.')
        sys.exit(0)


if __name__ == '__main__':
    main()

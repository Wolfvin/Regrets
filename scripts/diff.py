#!/usr/bin/env python3
# diff.py — Deep-compare live output vs golden output for Python clusters
#
# Usage:
#   python scripts/diff.py
#   python scripts/diff.py --cluster chord-construct
#   python scripts/diff.py --verbose
#   python scripts/diff.py --json
#
# Shows path-by-path differences between the current live output and
# the golden output stored in .regret files.

import sys
import os
import json
import math
import importlib
from pathlib import Path

from fingerprint import deep_clone
from capture import apply_output_transform, consume_generator
from validate import parse_regret


# ─── Constants ────────────────────────────────────────────────────────────────

FLOAT_TOLERANCE = 1e-9


# ─── CLI args ─────────────────────────────────────────────────────────────────

def parse_args():
    args = sys.argv[1:]
    result = {
        'cluster': None,
        'manifest': os.path.join(os.getcwd(), 'regrets', 'manifest.json'),
        'verbose': False,
        'json': False,
    }

    i = 0
    while i < len(args):
        if args[i] == '--cluster' and i + 1 < len(args):
            result['cluster'] = args[i + 1]; i += 2
        elif args[i] == '--manifest' and i + 1 < len(args):
            result['manifest'] = args[i + 1]; i += 2
        elif args[i] == '--verbose':
            result['verbose'] = True; i += 1
        elif args[i] == '--json':
            result['json'] = True; i += 1
        else:
            i += 1

    return result


# ─── Deep diff ────────────────────────────────────────────────────────────────

def _is_within_float_tolerance(expected, actual):
    """Check if two numeric values are within float tolerance threshold.

    Returns True if both values are numbers and the absolute difference
    is less than FLOAT_TOLERANCE (1e-9). This handles Python floating
    point non-determinism where operations may produce slightly different
    results across runs.
    """
    if not isinstance(expected, (int, float)) or not isinstance(actual, (int, float)):
        return False
    # Don't treat bools as numbers for this check
    if isinstance(expected, bool) or isinstance(actual, bool):
        return False
    return abs(expected - actual) < FLOAT_TOLERANCE


def deep_diff(expected, actual, path='', verbose=False):
    """Recursively compare two values and return list of differences.

    Float tolerance: when both expected and actual are numeric and their
    absolute difference is < 1e-9, they are considered equal and no diff
    is reported. This prevents false positives from Python floating point
    non-determinism.
    """
    diffs = []

    if type(expected) != type(actual):
        # Special case: both are numeric (int/float but not bool) —
        # check float tolerance before reporting type mismatch
        if (isinstance(expected, (int, float)) and isinstance(actual, (int, float))
                and not isinstance(expected, bool) and not isinstance(actual, bool)):
            if _is_within_float_tolerance(expected, actual):
                return diffs
        diffs.append({
            'path': path or 'root',
            'type': 'type_mismatch',
            'expected_type': type(expected).__name__,
            'actual_type': type(actual).__name__,
            'expected': _truncate(repr(expected), 100) if verbose else None,
            'actual': _truncate(repr(actual), 100) if verbose else None,
        })
        return diffs

    if isinstance(expected, dict):
        all_keys = set(list(expected.keys()) + list(actual.keys()))
        for key in sorted(all_keys):
            sub_path = f'{path}.{key}' if path else key
            if key not in expected:
                diffs.append({'path': sub_path, 'type': 'extra_key', 'actual': _truncate(repr(actual[key]), 100)})
            elif key not in actual:
                diffs.append({'path': sub_path, 'type': 'missing_key', 'expected': _truncate(repr(expected[key]), 100)})
            else:
                diffs.extend(deep_diff(expected[key], actual[key], sub_path, verbose))

    elif isinstance(expected, list):
        max_len = max(len(expected), len(actual))
        for i in range(max_len):
            sub_path = f'{path}[{i}]'
            if i >= len(expected):
                diffs.append({'path': sub_path, 'type': 'extra_item', 'actual': _truncate(repr(actual[i]), 100)})
            elif i >= len(actual):
                diffs.append({'path': sub_path, 'type': 'missing_item', 'expected': _truncate(repr(expected[i]), 100)})
            else:
                diffs.extend(deep_diff(expected[i], actual[i], sub_path, verbose))

    elif expected != actual:
        # Float tolerance: if both are numbers and within threshold, skip
        if _is_within_float_tolerance(expected, actual):
            return diffs
        diffs.append({
            'path': path or 'root',
            'type': 'value_mismatch',
            'expected': _truncate(repr(expected), 100),
            'actual': _truncate(repr(actual), 100),
        })

    return diffs


def _truncate(s, max_len):
    if len(s) > max_len:
        return s[:max_len] + '...'
    return s


# ─── JSON output formatting ──────────────────────────────────────────────────

def _diff_to_json_change(d):
    """Convert an internal diff dict to the --json changes format.

    Maps internal diff fields to the JSON schema:
    { path, old, new, type }
    """
    change = {
        'path': d['path'],
        'type': d['type'],
    }
    # Map expected → old, actual → new for JSON output
    if 'expected' in d and d['expected'] is not None:
        change['old'] = d['expected']
    if 'actual' in d and d['actual'] is not None:
        change['new'] = d['actual']
    # For type_mismatch, include type info
    if d['type'] == 'type_mismatch':
        change['old'] = d.get('expected_type', '')
        change['new'] = d.get('actual_type', '')
    return change


# ─── Main ─────────────────────────────────────────────────────────────────────

def main():
    cli = parse_args()

    # Load manifest
    try:
        with open(cli['manifest'], 'r', encoding='utf-8') as f:
            manifest = json.load(f)
    except (FileNotFoundError, json.JSONDecodeError):
        if cli['json']:
            print(json.dumps([]))
        else:
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
        if cli['json']:
            print(json.dumps([]))
        else:
            print("❌ regrets/ not found. Run capture.py first.")
        sys.exit(1)

    if not regret_files:
        if cli['json']:
            print(json.dumps([]))
        else:
            print("❌ No .regret files found.")
        sys.exit(1)

    total_diffs = 0
    json_results = []

    for regret_file in sorted(regret_files):
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

        if not cluster_def or cluster_def.get('stack') != 'python':
            continue

        module_path = cluster_def.get('module', cluster_def.get('file', ''))
        entry_name = cluster_def['entry']
        multi_args = cluster_def.get('multiArgs', False)
        kwargs_mode = regret.get('kwargs', cluster_def.get('kwargs', False))
        output_transform = regret.get('outputTransform') or cluster_def.get('outputTransform', None)

        try:
            mod = importlib.import_module(module_path)
            entry_fn = getattr(mod, entry_name, None)
            if entry_fn is None or not callable(entry_fn):
                if not cli['json']:
                    print(f"  ⚠️  {cluster_id}: Entry '{entry_name}' not found")
                continue

            # Get the golden input
            golden_input = regret.get('input')
            input_for_args = deep_clone(golden_input)

            # Run the entry function
            if multi_args and isinstance(input_for_args, list):
                raw_output = entry_fn(*input_for_args)
            elif kwargs_mode and isinstance(input_for_args, dict):
                raw_output = entry_fn(**input_for_args)
            else:
                raw_output = entry_fn(input_for_args) if input_for_args is not None else entry_fn()

            raw_output = consume_generator(raw_output)
            live_output = apply_output_transform(deep_clone(raw_output), output_transform)

            # Get golden output
            golden_output = regret.get('output')

            # Diff
            diffs = deep_diff(golden_output, live_output, verbose=cli['verbose'])

            if diffs:
                total_diffs += len(diffs)
                if cli['json']:
                    json_results.append({
                        'cluster': cluster_id,
                        'input': golden_input,
                        'changes': [_diff_to_json_change(d) for d in diffs],
                    })
                else:
                    print(f"\n❌ {cluster_id}: {len(diffs)} difference(s)")
                    for d in diffs[:10]:  # Show first 10
                        print(f"  📍 {d['path']}: {d['type']}", end='')
                        if d.get('expected'):
                            print(f" (expected: {d['expected']}, got: {d['actual']})", end='')
                        print()
                    if len(diffs) > 10:
                        print(f"  ... and {len(diffs) - 10} more")
            else:
                if not cli['json']:
                    print(f"  ✅ {cluster_id}: No differences")

        except Exception as err:
            total_diffs += 1
            if cli['json']:
                json_results.append({
                    'cluster': cluster_id,
                    'input': regret.get('input'),
                    'changes': [{
                        'path': 'error',
                        'old': '',
                        'new': str(err),
                        'type': 'error',
                    }],
                })
            else:
                print(f"  ❌ {cluster_id}: ERROR: {err}")

    if cli['json']:
        print(json.dumps(json_results, ensure_ascii=False))
    else:
        print(f"\n{'─' * 50}")
        if total_diffs == 0:
            print("✅ No differences found. All outputs match golden .regret files.")
        else:
            print(f"❌ {total_diffs} total difference(s) found.")
            print("   Fix the CODE — do not edit .regret files.")


if __name__ == '__main__':
    main()

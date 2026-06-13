#!/usr/bin/env python3
# capture.py — ghost-decorator runner for Python clusters
# Reads regrets/manifest.json, instruments watched functions via
# unittest.mock.patch, runs entry points, and writes .regret files.
#
# Usage:
#   python scripts/capture.py
#   python scripts/capture.py --cluster transform-invoice
#   python scripts/capture.py --manifest ./regrets/manifest.json

import sys
import os
import json
import importlib
import copy
from datetime import datetime, timezone
from functools import wraps

# Import shared fingerprint module (same directory)
from fingerprint import (
    stable_dumps, normalize, strip_fields, to_base36,
    deep_clone, fingerprint, fingerprint_sequence, extract_schema,
    snapshot_output, get_env_snapshot
)

# ─── CLI args ─────────────────────────────────────────────────────────────────

def parse_args():
    args = sys.argv[1:]
    cluster_filter = None
    manifest_path = None

    i = 0
    while i < len(args):
        if args[i] == '--cluster' and i + 1 < len(args):
            cluster_filter = args[i + 1]
            i += 2
        elif args[i] == '--manifest' and i + 1 < len(args):
            manifest_path = args[i + 1]
            i += 2
        else:
            i += 1

    if manifest_path is None:
        manifest_path = os.path.join(os.getcwd(), 'regrets', 'manifest.json')

    return cluster_filter, manifest_path

# ─── Helpers ────────────────────────────────────────────────────────────────────

def json_serialize(val):
    """Serialize value to JSON string for .regret file. Handles numpy types."""
    from fingerprint import _numpy_to_native
    return json.dumps(_numpy_to_native(val), ensure_ascii=False)


# ─── Ghost decorator ──────────────────────────────────────────────────────────

def create_ghost(module, watch_list, recorder):
    """
    Wrap watched functions in the module with recording decorators.
    Returns a namespace-like object with ghost-wrapped functions.
    """
    import types

    class GhostModule:
        pass

    ghost = GhostModule()

    # Copy all attributes from original module
    for attr_name in dir(module):
        if not attr_name.startswith('_'):
            try:
                setattr(ghost, attr_name, getattr(module, attr_name))
            except AttributeError:
                pass

    # Replace watched functions with ghost wrappers
    for fn_name in watch_list:
        original = getattr(module, fn_name, None)
        if original is None or not callable(original):
            print(f"  ⚠️  Watch target \"{fn_name}\" is not callable — skipping")
            continue

        # Create closure that captures the original function and recorder
        def make_ghost(orig, name, rec):
            @wraps(orig)
            def wrapper(*args, **kwargs):
                try:
                    result = orig(*args, **kwargs)
                    rec.append({
                        'fn': name,
                        'args': deep_clone(args),
                        'result': deep_clone(result),
                    })
                    return result
                except Exception as err:
                    rec.append({
                        'fn': name,
                        'args': deep_clone(args),
                        'error': str(err),
                    })
                    raise
            return wrapper

        setattr(ghost, fn_name, make_ghost(original, fn_name, recorder))

    return ghost


# ─── Main ─────────────────────────────────────────────────────────────────────

def main():
    cluster_filter, manifest_path = parse_args()

    # Load manifest
    try:
        with open(manifest_path, 'r', encoding='utf-8') as f:
            manifest = json.load(f)
    except (FileNotFoundError, json.JSONDecodeError) as e:
        print(f"❌ Could not read manifest: {manifest_path}")
        print(f"   Error: {e}")
        print(f"   Create regrets/manifest.json first. See SKILL.md for format.")
        sys.exit(1)

    clusters = manifest.get('clusters', [])
    if cluster_filter:
        clusters = [c for c in clusters if c['id'] == cluster_filter]

    if not clusters:
        print(f"❌ No clusters found{' matching "' + cluster_filter + '"' if cluster_filter else ''}")
        sys.exit(1)

    # Filter to Python clusters only
    python_clusters = [c for c in clusters if c.get('stack') == 'python']
    if not python_clusters:
        print("No Python clusters found in manifest.")
        sys.exit(0)

    # Setup output directory
    out_dir = os.path.join(os.getcwd(), 'regrets')
    os.makedirs(out_dir, exist_ok=True)

    # Add pythonPath to sys.path if specified
    for cluster in python_clusters:
        python_path = cluster.get('pythonPath', '')
        if python_path and python_path not in sys.path:
            abs_python_path = os.path.join(os.getcwd(), python_path)
            if abs_python_path not in sys.path:
                sys.path.insert(0, abs_python_path)

    passed = 0
    failed = 0

    for cluster in python_clusters:
        cid = cluster['id']
        entry = cluster['entry']
        watches = cluster.get('watches', [])
        module_path = cluster.get('module', cluster.get('file', ''))
        normalize_rules = cluster.get('normalize', [])
        ignore_fields = cluster.get('ignoreFields', [])
        fingerprint_level = cluster.get('fingerprintLevel', 'entry')
        fingerprint_mode = cluster.get('fingerprintMode', 'value')
        value_paths = cluster.get('valuePaths', [])
        multi_args = cluster.get('multiArgs', False)
        inputs = cluster.get('inputs', [None])
        output_transform = cluster.get('outputTransform', None)

        print(f"\n📡 Capturing: {cid}")
        print(f"   Module:  {module_path}")
        print(f"   Entry:   {entry}")
        print(f"   Watches: {', '.join(watches)}")
        if output_transform:
            print(f"   OutputTransform: {output_transform}")

        try:
            # Dynamic import of target module
            # module uses dot notation: "src.invoice.processor"
            mod = importlib.import_module(module_path)

            recorder_local = []
            ghost = create_ghost(mod, watches, recorder_local)

            # Get entry function from ghost module
            entry_fn = getattr(ghost, entry, None) or getattr(mod, entry, None)
            if entry_fn is None or not callable(entry_fn):
                raise TypeError(f"Entry \"{entry}\" not found or not callable in {module_path}")

            # Capture environment snapshot
            env_snapshot = get_env_snapshot()

            # Run with provided inputs
            results = []
            for input_val in inputs:
                recorder_local = []
                ghost = create_ghost(mod, watches, recorder_local)

                # Deep-clone input BEFORE calling the function to prevent mutation from
                # corrupting the stored fingerprint. Two clones: one for the .regret file
                # (immutable record), one for the args (may be mutated by the function)
                input_for_record = deep_clone(input_val)
                input_for_args = deep_clone(input_val)

                if multi_args and isinstance(input_for_args, list):
                    output = entry_fn(*input_for_args)
                    fp_input = input_for_record
                else:
                    output = entry_fn(input_for_args) if input_for_args is not None else entry_fn()
                    fp_input = input_for_record

                # Apply output transform if specified
                output_for_fp = snapshot_output(output, output_transform) if output_transform else deep_clone(output)

                if fingerprint_mode == 'schema':
                    schema = extract_schema(output_for_fp)
                    fp = fingerprint(fp_input, schema, normalize_rules, ignore_fields)
                elif fingerprint_mode == 'mixed':
                    schema = extract_schema(output_for_fp)
                    selected_values = {}
                    for path in value_paths:
                        key = path.replace('$.', '')
                        parts = key.split('.')
                        val = output_for_fp
                        for p in parts:
                            val = val.get(p) if isinstance(val, dict) else None
                            if val is None:
                                break
                        if val is not None:
                            selected_values[path] = val
                    combined = {'schema': schema, 'values': selected_values}
                    fp = fingerprint(fp_input, combined, normalize_rules, ignore_fields)
                elif fingerprint_level == 'entry':
                    fp = fingerprint(fp_input, output_for_fp, normalize_rules, ignore_fields)
                else:
                    fp = fingerprint_sequence(recorder_local, normalize_rules, ignore_fields)

                results.append({'input': input_val, 'output': output_for_fp, 'fp': fp, 'calls': list(recorder_local)})

            # Use first result as golden
            golden = results[0]
            fp = golden['fp']

            # Write .regret file
            regret_path = os.path.join(out_dir, f"{cid}.regret")
            timestamp = datetime.now(timezone.utc).isoformat()

            lines = [
                f"cluster: {cid}",
                "version: 1",
                f"fingerprint: {fp}",
                f"captured: {timestamp}",
                f"watches: [{', '.join(watches)}]",
                f"entry: {entry}",
                "stack: python",
                f"fingerprintLevel: {fingerprint_level}",
            ]
            if fingerprint_mode != 'value':
                lines.append(f"fingerprintMode: {fingerprint_mode}")
            if value_paths:
                lines.append(f"valuePaths: [{', '.join(value_paths)}]")
            if normalize_rules:
                lines.append(f"normalize: [{', '.join(normalize_rules)}]")
            if ignore_fields:
                lines.append(f"ignoreFields: [{', '.join(ignore_fields)}]")
            if cluster.get('multiArgs'):
                lines.append(f"multiArgs: {multi_args}")
            if cluster.get('module'):
                lines.append(f"module: {module_path}")
            if output_transform:
                lines.append(f"outputTransform: {output_transform}")

            # Environment snapshot
            env_str = json.dumps(env_snapshot, sort_keys=True)
            lines.append(f"env: {env_str}")

            lines.append("---")
            lines.append(f"INPUT  {json_serialize(golden['input'])}")
            lines.append(f"OUTPUT {json_serialize(golden['output'])}")
            lines.append(f"HASH   {fp}")

            with open(regret_path, 'w', encoding='utf-8') as f:
                f.write('\n'.join(lines))

            print(f"   ✅ Fingerprint: {fp}")
            print(f"   📄 Saved: regrets/{cid}.regret")
            passed += 1

        except Exception as err:
            print(f"   ❌ Capture failed: {err}")
            import traceback
            traceback.print_exc()
            failed += 1

    # ─── Summary ──────────────────────────────────────────────────────────────

    print(f"\n{'─' * 50}")
    print(f"Capture complete: {passed} captured, {failed} failed")

    if failed > 0:
        print(f"\n⚠️  Fix failed captures before proceeding to PHASE 2.")
        print(f"   Hint: Check that 'entry' and 'watches' names match exports in your module.")
        sys.exit(1)

    print(f"\nNext: python scripts/validate.py")
    print(f"If all green → you are clear to refactor.")


if __name__ == '__main__':
    main()

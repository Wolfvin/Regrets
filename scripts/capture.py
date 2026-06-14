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
import types
from datetime import datetime, timezone
from functools import wraps

# Import shared fingerprint module (same directory)
from fingerprint import (
    stable_dumps, normalize, strip_fields, to_base36,
    deep_clone, fingerprint, fingerprint_sequence, extract_schema,
    materialize_output, snapshot_state, get_env_snapshot
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


def consume_generator(val):
    """If val is a generator or iterator, consume it into a list.

    This is critical for entry functions that return generators (e.g.,
    FilterStack.run(), StatementSplitter.process()). Without this,
    the ghost proxy would record the generator object itself, not
    the values it yields.

    Strings, bytes, dicts, and non-iterable objects are returned as-is.
    """
    if isinstance(val, (str, bytes, dict)):
        return val
    if isinstance(val, types.GeneratorType):
        return list(val)
    if hasattr(val, '__iter__') and hasattr(val, '__next__'):
        # Generic iterator — consume but don't double-consume lists/tuples
        if isinstance(val, (list, tuple)):
            return val
        return list(val)
    return val


def apply_output_transform(output, transform):
    """Apply an outputTransform to convert complex objects to fingerprintable form.

    Supported transforms:
    - "str":     Convert each element to its string representation
    - "repr":    Convert each element to its repr representation
    - "dict":    Convert each element using dict(obj) or obj.__dict__
    - "json":    Attempt obj.to_json() or json.dumps(obj)
    - "len":     Return len(obj) — useful for large collections
    - "type":    Return type names of elements
    - "module.fn": Import and call module.fn(output) for custom transforms

    When output is a tuple, it is first converted to a list.
    When output is a list, the transform is applied to each element.
    When output is a single object (not list/tuple), transform is applied to it.
    """
    if transform is None:
        return output

    # Convert tuples to lists for consistent serialization
    if isinstance(output, tuple):
        output = list(output)

    # Handle custom callable path: "module.function"
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

    # Apply to each element of lists, or to the single object
    # Exception: "len" and "type" apply to the whole collection, not each element
    if isinstance(output, list) and transform not in ('len',):
        return [transform_one(item) for item in output]
    return transform_one(output)


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
            # Ensure wrapper has a meaningful name (not '<lambda>')
            # This is critical for lambda-assigned functions (e.g., in PyJHora's house.py)
            # where the variable name is the true identifier, not __name__
            if getattr(wrapper, '__name__', '') == '<lambda>':
                wrapper.__name__ = name
                wrapper.__qualname__ = name
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
    # Supports both single string ("src") and array of strings (["src", "lib"])
    # Also supports manifest-level pythonPath as default for all clusters
    manifest_python_path = manifest.get('pythonPath', '')
    if isinstance(manifest_python_path, str):
        manifest_python_paths = [manifest_python_path] if manifest_python_path else []
    elif isinstance(manifest_python_path, list):
        manifest_python_paths = manifest_python_path
    else:
        manifest_python_paths = []

    for cluster in python_clusters:
        # Cluster-level pythonPath overrides manifest-level
        raw_python_path = cluster.get('pythonPath', '')
        if isinstance(raw_python_path, str):
            python_paths = [raw_python_path] if raw_python_path else []
        elif isinstance(raw_python_path, list):
            python_paths = raw_python_path
        else:
            python_paths = []
        # If no cluster-level pythonPath, fall back to manifest-level
        if not python_paths:
            python_paths = manifest_python_paths
        for python_path in python_paths:
            if python_path:
                abs_python_path = os.path.join(os.getcwd(), python_path)
                if abs_python_path not in sys.path:
                    sys.path.insert(0, abs_python_path)
                    print(f"   📂 pythonPath resolved: {python_path} → {abs_python_path}")

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
        kwargs_mode = cluster.get('kwargs', False)
        inputs = cluster.get('inputs', [None])
        output_transform = cluster.get('outputTransform', None)
        materialize_output_flag = cluster.get('materializeOutput', False)
        track_mutation = cluster.get('trackMutation', False)

        print(f"\n📡 Capturing: {cid}")
        print(f"   Module:  {module_path}")
        print(f"   Entry:   {entry}")
        print(f"   Watches: {', '.join(watches)}")

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

                # Snapshot input state BEFORE call (for mutation tracking)
                input_snapshot_before = None
                if track_mutation:
                    input_snapshot_before = snapshot_state(input_for_args)

                if multi_args and isinstance(input_for_args, list):
                    raw_output = entry_fn(*input_for_args)
                    fp_input = input_for_record
                elif kwargs_mode and isinstance(input_for_args, dict):
                    # kwargs mode: input dict is unpacked as keyword arguments
                    # e.g., input {"tiles": [...], "win_tile": 36} → entry_fn(tiles=[...], win_tile=36)
                    raw_output = entry_fn(**input_for_args)
                    fp_input = input_for_record
                elif kwargs_mode and not isinstance(input_for_args, dict):
                    raise TypeError(
                        f"kwargs=True but input is {type(input_for_args).__name__}, not dict. "
                        f"When kwargs is enabled, each input must be a dict to unpack as **kwargs."
                    )
                else:
                    raw_output = entry_fn(input_for_args) if input_for_args is not None else entry_fn()
                    fp_input = input_for_record

                # Materialize generator/iterator output if configured
                output, was_materialized = materialize_output(raw_output) if materialize_output_flag else (raw_output, False)
                if was_materialized:
                    print(f"   🔄 Output materialized: {type(raw_output).__name__} → list ({len(output)} items)")

                # Consume generators/iterators into lists for fingerprinting (always-on fallback)
                if not materialize_output_flag:
                    raw_type_name = type(output).__name__
                    output = consume_generator(output)
                    if type(output).__name__ != raw_type_name and raw_type_name in ('generator', 'map', 'filter', 'range'):
                        print(f"   🔄 Auto-materialized: {raw_type_name} → list ({len(output)} items)")

                # Apply output transform if specified (e.g., "str" for Statement objects)
                output_for_fp = apply_output_transform(deep_clone(output), output_transform)

                # Snapshot input state AFTER call (for mutation tracking)
                input_snapshot_after = None
                input_mutation_fingerprint = None
                if track_mutation:
                    input_snapshot_after = snapshot_state(input_for_args)
                    # Compute mutation fingerprint — if input changed, this hash will differ
                    input_mutation_fingerprint = fingerprint(
                        input_snapshot_before, input_snapshot_after,
                        normalize_rules, ignore_fields
                    )
                    if input_snapshot_before != input_snapshot_after:
                        print(f"   ⚠️  Input mutation detected! Fingerprint: {input_mutation_fingerprint}")

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

                results.append({
                    'input': input_val,
                    'output': output_for_fp,
                    'fp': fp,
                    'calls': list(recorder_local),
                    'input_snapshot_before': input_snapshot_before,
                    'input_snapshot_after': input_snapshot_after,
                    'input_mutation_fingerprint': input_mutation_fingerprint,
                    'was_materialized': was_materialized,
                })

            # Warn about watched functions that were never called during capture
            called_fns = set()
            for r in results:
                for call in r['calls']:
                    called_fns.add(call['fn'])
            uncalled_watches = [w for w in watches if w not in called_fns]
            if uncalled_watches:
                # When entry == watches (common for pure functions), the ghost proxy
                # wraps the watched function but entry_fn may bypass it. This is
                # expected — the fingerprint is still correct because it captures
                # the input/output pair. Only warn if the watch is NOT the entry.
                non_entry_uncalled = [w for w in uncalled_watches if w != entry]
                if non_entry_uncalled:
                    print(f"   ⚠️  Watched function(s) never called during capture: {', '.join(non_entry_uncalled)}")
                    print(f"      The fingerprint may be based on incomplete data.")
                    print(f"      Consider splitting into separate clusters or adjusting the entry function.")
                elif uncalled_watches and entry in uncalled_watches and len(uncalled_watches) == 1:
                    # Entry function was called directly, not through ghost proxy.
                    # This is normal for pure functions where entry == watches.
                    pass  # No warning needed — fingerprint is correct

            # Warn about private entry functions with fingerprintLevel=full
            # Ghost proxy skips attributes starting with _, so it can't wrap them
            if fingerprint_level == 'full' and entry.startswith('_'):
                print(f"   ⚠️  Entry function '{entry}' starts with underscore.")
                print(f"      Ghost proxy cannot wrap private functions — watches will be empty.")
                print(f"      With fingerprintLevel=full, this produces an empty-sequence fingerprint.")
                print(f"      RECOMMENDATION: Change fingerprintLevel to 'entry' for this cluster.")

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
            if kwargs_mode:
                lines.append(f"kwargs: {kwargs_mode}")
            if cluster.get('module'):
                lines.append(f"module: {module_path}")
            if output_transform:
                lines.append(f"outputTransform: {output_transform}")
            if materialize_output_flag:
                lines.append("materializeOutput: true")
            if track_mutation:
                lines.append("trackMutation: true")
                if golden.get('input_mutation_fingerprint'):
                    lines.append(f"mutationFingerprint: {golden['input_mutation_fingerprint']}")

            # Environment snapshot
            env_str = json.dumps(get_env_snapshot(), sort_keys=True)
            lines.append(f"env: {env_str}")

            lines.append("---")
            lines.append(f"INPUT  {json_serialize(golden['input'])}")
            lines.append(f"OUTPUT {json_serialize(golden['output'])}")
            lines.append(f"HASH   {fp}")
            if track_mutation and golden.get('input_snapshot_before') is not None:
                lines.append(f"MUTATION_BEFORE {json_serialize(golden['input_snapshot_before'])}")
                lines.append(f"MUTATION_AFTER  {json_serialize(golden['input_snapshot_after'])}")

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

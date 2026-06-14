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


def freeze_time(frozen_dt_str):
    """Context manager that patches datetime.now() and time.localtime() to return
    a fixed value during capture/validate.

    This is critical for functions that default to datetime.now() (e.g., rrule's
    dtstart default, parser.parse's default). Without freezing, the fingerprint
    would be different every run.

    Args:
        frozen_dt_str: ISO 8601 datetime string (e.g., "2024-01-15T10:30:00")

    Returns a context manager that freezes time within the block.
    """
    from unittest.mock import patch
    import datetime as dt_module
    import time as time_module

    frozen_dt = dt_module.datetime.fromisoformat(frozen_dt_str)
    frozen_date = frozen_dt.date()
    frozen_struct = time_module.localtime(frozen_dt.timestamp())

    class FrozenDateTime(dt_module.datetime):
        @classmethod
        def now(cls, tz=None):
            if tz is not None:
                return frozen_dt.replace(tzinfo=tz)
            return frozen_dt

        @classmethod
        def utcnow(cls):
            return frozen_dt.replace(tzinfo=dt_module.timezone.utc)

    class FrozenDate(dt_module.date):
        @classmethod
        def today(cls):
            return frozen_date

    class FrozenTime:
        @staticmethod
        def localtime(secs=None):
            if secs is not None:
                return time_module.localtime(secs)
            return frozen_struct

    return patch.multiple(
        dt_module,
        datetime=FrozenDateTime,
        date=FrozenDate,
    ), patch.object(time_module, 'localtime', FrozenTime.localtime)

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
        elif transform == 'isoformat':
            # Convert datetime/date/time objects to ISO 8601 strings.
            # Recommended for libraries returning datetime objects.
            if hasattr(obj, 'isoformat') and callable(obj.isoformat):
                return obj.isoformat()
            return str(obj)
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
        max_yields = cluster.get('maxYields', cluster.get('materializeLimit', None))
        freeze_time_str = cluster.get('freezeTime', None)
        track_state_attrs = cluster.get('trackState', None)  # list of attr names to track on the entry object

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

            # Setup freeze_time context managers if needed
            freeze_cms = []
            if freeze_time_str:
                dt_cm, time_cm = freeze_time(freeze_time_str)
                freeze_cms = [dt_cm, time_cm]

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

                # Snapshot object state BEFORE call (for trackState)
                obj_state_before = None
                obj_state_fingerprint = None
                if track_state_attrs and isinstance(input_for_args, dict) and 'self' in input_for_args:
                    # When input contains a 'self' key pointing to the object instance
                    obj_state_before = snapshot_state(
                        input_for_args['self'],
                        include_private=True,
                        attr_filter=track_state_attrs
                    )
                elif track_state_attrs and hasattr(input_for_args, '__dict__'):
                    # When the input IS the object instance itself
                    obj_state_before = snapshot_state(
                        input_for_args,
                        include_private=True,
                        attr_filter=track_state_attrs
                    )

                # Execute entry function, optionally with frozen time
                def _run_entry():
                    if multi_args and isinstance(input_for_args, list):
                        return entry_fn(*input_for_args), input_for_record
                    elif kwargs_mode and isinstance(input_for_args, dict):
                        return entry_fn(**input_for_args), input_for_record
                    elif kwargs_mode and not isinstance(input_for_args, dict):
                        raise TypeError(
                            f"kwargs=True but input is {type(input_for_args).__name__}, not dict. "
                            f"When kwargs is enabled, each input must be a dict to unpack as **kwargs."
                        )
                    else:
                        return (entry_fn(input_for_args) if input_for_args is not None else entry_fn()), input_for_record

                if freeze_cms:
                    for cm in freeze_cms:
                        cm.__enter__()
                    try:
                        raw_output, fp_input = _run_entry()
                    finally:
                        for cm in reversed(freeze_cms):
                            cm.__exit__(None, None, None)
                else:
                    raw_output, fp_input = _run_entry()

                # Materialize generator/iterator output if configured
                # Pass max_yields for bounded materialization of infinite generators
                if materialize_output_flag:
                    output, was_materialized = materialize_output(raw_output, max_yields=max_yields)
                    if was_materialized:
                        trunc_marker = any(
                            isinstance(item, dict) and item.get('__truncated__')
                            for item in (output if isinstance(output, list) else [])
                        )
                        if trunc_marker:
                            print(f"   🔄 Output materialized (bounded): {type(raw_output).__name__} → list ({max_yields} items + truncation marker)")
                        else:
                            print(f"   🔄 Output materialized: {type(raw_output).__name__} → list ({len(output)} items)")
                else:
                    output = raw_output
                    was_materialized = False

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

                # Snapshot object state AFTER call (for trackState)
                obj_state_after = None
                if track_state_attrs and isinstance(input_for_args, dict) and 'self' in input_for_args:
                    obj_state_after = snapshot_state(
                        input_for_args['self'],
                        include_private=True,
                        attr_filter=track_state_attrs
                    )
                elif track_state_attrs and hasattr(input_for_args, '__dict__'):
                    obj_state_after = snapshot_state(
                        input_for_args,
                        include_private=True,
                        attr_filter=track_state_attrs
                    )

                if obj_state_before is not None and obj_state_after is not None:
                    obj_state_fingerprint = fingerprint(
                        obj_state_before, obj_state_after,
                        normalize_rules, ignore_fields
                    )
                    if obj_state_before != obj_state_after:
                        print(f"   ⚠️  Object state mutation detected! Fingerprint: {obj_state_fingerprint}")

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
                    'obj_state_before': obj_state_before,
                    'obj_state_after': obj_state_after,
                    'obj_state_fingerprint': obj_state_fingerprint,
                })

            # Warn about watched functions that were never called during capture
            called_fns = set()
            for r in results:
                for call in r['calls']:
                    called_fns.add(call['fn'])
            uncalled_watches = [w for w in watches if w not in called_fns]
            if uncalled_watches:
                print(f"   ⚠️  Watched function(s) never called during capture: {', '.join(uncalled_watches)}")
                print(f"      The fingerprint may be based on incomplete data.")
                print(f"      Consider splitting into separate clusters or adjusting the entry function.")

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
            if max_yields:
                lines.append(f"maxYields: {max_yields}")
            if freeze_time_str:
                lines.append(f"freezeTime: {freeze_time_str}")
            if track_state_attrs:
                lines.append(f"trackState: [{', '.join(track_state_attrs)}]")
                if golden.get('obj_state_fingerprint'):
                    lines.append(f"stateFingerprint: {golden['obj_state_fingerprint']}")

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
            if track_state_attrs and golden.get('obj_state_before') is not None:
                lines.append(f"STATE_BEFORE {json_serialize(golden['obj_state_before'])}")
                lines.append(f"STATE_AFTER  {json_serialize(golden['obj_state_after'])}")

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

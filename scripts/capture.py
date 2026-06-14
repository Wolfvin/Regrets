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
    materialize_output, snapshot_state, get_env_snapshot,
    object_state_serialize, snapshot_module_globals, restore_module_globals,
    fingerprint_modes
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
    """Serialize value to JSON string for .regret file. Handles numpy types and complex numbers."""
    from fingerprint import _numpy_to_native, _complex_to_json
    return json.dumps(_complex_to_json(_numpy_to_native(val)), ensure_ascii=False)


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


def _numpy_array_summary(arr):
    """Compute a summary of a numpy array for fingerprinting.

    Instead of serializing every element (which can be thousands of floats),
    this produces a compact summary with shape, dtype, and key statistics.
    This is essential for DSP/scientific computing libraries where functions
    return large arrays (e.g., sdr.sinusoid returns 1000+ sample arrays).

    The summary is deterministic and sufficient for regression testing:
    if the algorithm changes, at least one statistic will change.
    """
    try:
        import numpy as np
        if not isinstance(arr, np.ndarray):
            return arr
    except ImportError:
        return arr

    summary = {
        'shape': list(arr.shape),
        'dtype': str(arr.dtype),
        'size': int(arr.size),
    }

    # For empty arrays, just return shape/dtype
    if arr.size == 0:
        summary['note'] = 'empty array'
        return summary

    # For complex arrays, compute stats on real and imag parts separately
    if np.iscomplexobj(arr):
        real_part = arr.real.astype(np.float64)
        imag_part = arr.imag.astype(np.float64)
        summary['real_mean'] = float(np.mean(real_part))
        summary['real_std'] = float(np.std(real_part))
        summary['real_min'] = float(np.min(real_part))
        summary['real_max'] = float(np.max(real_part))
        summary['imag_mean'] = float(np.mean(imag_part))
        summary['imag_std'] = float(np.std(imag_part))
        summary['imag_min'] = float(np.min(imag_part))
        summary['imag_max'] = float(np.max(imag_part))
        # Include first and last few elements for extra sensitivity
        flat = arr.flatten()
        n_head = min(5, flat.size)
        n_tail = min(5, flat.size)
        summary['head'] = [complex(x) for x in flat[:n_head]]
        summary['tail'] = [complex(x) for x in flat[-n_tail:]]
    else:
        # For real arrays
        float_arr = arr.astype(np.float64) if np.issubdtype(arr.dtype, np.floating) else arr.astype(np.float64)
        summary['mean'] = float(np.mean(float_arr))
        summary['std'] = float(np.std(float_arr))
        summary['min'] = float(np.min(float_arr))
        summary['max'] = float(np.max(float_arr))
        # Include first and last few elements for extra sensitivity
        flat = arr.flatten()
        n_head = min(5, flat.size)
        n_tail = min(5, flat.size)
        summary['head'] = [float(x) for x in flat[:n_head]]
        summary['tail'] = [float(x) for x in flat[-n_tail:]]

    # For integer arrays, also include sum for extra determinism
    if np.issubdtype(arr.dtype, np.integer):
        summary['sum'] = int(np.sum(arr))

    return summary


def apply_input_transform(input_val, transform):
    """Apply an inputTransform to convert JSON-safe input to the actual function input type.

    This solves the problem of functions that expect bytes, bytearray, or other
    non-JSON-serializable types as input. Since manifest.json can only store
    JSON-safe values, an inputTransform converts them back before calling the
    entry function.

    Supported transforms:
    - "hex_to_bytes": Convert hex string input to bytes
      e.g., "0a1b2c" → b"\\x0a\\x1b\\x2c"
    - "list_to_bytes": Convert list of integers to bytes
      e.g., [10, 27, 44] → b"\\x0a\\x1b\\x2c"
    - "list_of_hex_to_bytes": Convert list of hex strings to list of bytes
      e.g., ["0a1b", "2c3d"] → [b"\\x0a\\x1b", b"\\x2c\\x3d"]

    For multiArgs clusters, the transform is applied to each argument individually.
    """
    if transform is None:
        return input_val

    if transform == 'hex_to_bytes':
        if isinstance(input_val, str):
            return bytes.fromhex(input_val)
        if isinstance(input_val, list):
            # Multi-arg: convert each hex string arg to bytes
            return [bytes.fromhex(v) if isinstance(v, str) else v for v in input_val]
        return input_val

    elif transform == 'list_to_bytes':
        if isinstance(input_val, list):
            # Check if this is a list of integers (single bytes arg)
            if all(isinstance(v, int) for v in input_val):
                return bytes(input_val)
            # Or multi-arg where one arg is a list of ints
            return [bytes(v) if isinstance(v, list) and all(isinstance(x, int) for x in v) else v for v in input_val]
        return input_val

    elif transform == 'list_of_hex_to_bytes':
        if isinstance(input_val, list):
            return [bytes.fromhex(v) if isinstance(v, str) else v for v in input_val]
        return input_val

    return input_val


def dataclass_to_dict(obj):
    """Recursively convert dataclass instances (and common Python types) to
    JSON-serializable dicts.

    This handles the common challenge of fingerprinting output from class-heavy
    Python libraries (e.g., eyecite, pydantic models, dataclass hierarchies)
    where the default "dict" transform fails because:

    1. Frozen dataclasses don't allow __dict__ mutation but do have __dict__
    2. Nested dataclasses need recursive conversion
    3. UserString subclasses (like Token) need special handling — str() gives
       the string value but we also need to capture dataclass fields
    4. datetime/date objects need deterministic string conversion
    5. Sequences of dataclass instances need element-wise conversion
    6. None values in Optional fields must be preserved (not dropped)

    The resulting dict includes a '__class__' key so that class identity is
    part of the fingerprint — a FullCaseCitation and a ShortCaseCitation with
    the same field values will produce different fingerprints, which is correct
    because they represent different behavioral contracts.

    Handles:
    - dataclass instances (via dataclasses.fields or __dict__)
    - UserString subclasses (captures .data field + all dataclass fields)
    - datetime/date objects → ISO format strings
    - nested lists, tuples, dicts, sets
    - None, bool, int, float, str — pass through
    - objects with to_dict() method
    - objects with __dict__ — captured as fallback
    - tuple/Sequence fields in dataclasses — converted to lists
    - unhashable/complex fields — fall back to repr()
    """
    import dataclasses
    from datetime import date, datetime
    from collections import UserString

    # Primitives — pass through
    if obj is None or isinstance(obj, (bool, int, float, str)):
        return obj

    # datetime/date — deterministic ISO format
    if isinstance(obj, datetime):
        return obj.isoformat()
    if isinstance(obj, date):
        return obj.isoformat()

    # bytes → hex string
    if isinstance(obj, bytes):
        return obj.hex()

    # Lists — recurse
    if isinstance(obj, list):
        return [dataclass_to_dict(v) for v in obj]

    # Tuples → list (JSON-safe) — recurse
    if isinstance(obj, tuple):
        return [dataclass_to_dict(v) for v in obj]

    # Sets → sorted list
    if isinstance(obj, set):
        return sorted([dataclass_to_dict(v) for v in obj], key=lambda x: str(x))

    # Dicts — recurse
    if isinstance(obj, dict):
        return {k: dataclass_to_dict(v) for k, v in obj.items()}

    # Dataclass instances — the primary use case
    if dataclasses.is_dataclass(obj) and not isinstance(obj, type):
        cls_name = type(obj).__name__
        result = {'__class__': cls_name}

        # UserString subclasses (e.g., Token objects in citation parsers)
        # str(obj) gives the string value, but we also need all dataclass fields
        if isinstance(obj, UserString):
            result['data'] = str(obj)

        # Try dataclasses.fields() first (works for frozen and non-frozen)
        try:
            for field in dataclasses.fields(obj):
                try:
                    val = getattr(obj, field.name)
                    result[field.name] = dataclass_to_dict(val)
                except Exception:
                    result[field.name] = f'<unrepresentable:{field.name}>'
        except TypeError:
            # Not a dataclass after all — fall through to __dict__
            pass

        return result

    # Objects with to_dict() — use it
    if hasattr(obj, 'to_dict') and callable(obj.to_dict):
        try:
            return dataclass_to_dict(obj.to_dict())
        except Exception:
            pass

    # Objects with __dict__ — capture instance attributes
    if hasattr(obj, '__dict__'):
        cls_name = type(obj).__name__
        result = {'__class__': cls_name}
        for k, v in obj.__dict__.items():
            if not k.startswith('_'):
                try:
                    result[k] = dataclass_to_dict(v)
                except Exception:
                    result[k] = f'<unrepresentable:{type(v).__name__}>'
        return result

    # Fallback — repr() (lossy but deterministic)
    return repr(obj)


def apply_output_transform(output, transform):
    """Apply an outputTransform to convert complex objects to fingerprintable form.

    Supported transforms:
    - "str":           Convert each element to its string representation
    - "repr":          Convert each element to its repr representation
    - "dict":          Convert each element using dict(obj) or obj.__dict__
    - "snapshot":      Deep recursive class-to-dict conversion using snapshot_state().
                       Walks through nested class instances and converts them all to
                       JSON-serializable dicts with __class__ tags. This is essential for
                       libraries like musicpy where chord/scale/note objects contain other
                       class instances inside lists.
    - "dataclass_dict": Recursively convert dataclass instances to JSON-serializable
      dicts. Handles nested dataclasses, frozen dataclasses, UserString subclasses
      (like Token objects), datetime objects, and sequences of dataclass instances.
      Adds __class__ key so class identity is part of the fingerprint.
    - "json":          Attempt obj.to_json() or json.dumps(obj)
    - "len":           Return len(obj) — useful for large collections
    - "type":          Return type names of elements
    - "array_summary": Compute shape/dtype/mean/std/min/max summary of numpy arrays
                       — essential for DSP/scientific computing where outputs are
                       large signal arrays (e.g., 1000+ sample arrays from sdr.sinusoid)
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
        elif transform == 'array_summary':
            return _numpy_array_summary(obj)
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
        elif transform == 'snapshot':
            # Deep recursive class-to-dict conversion using snapshot_state().
            # This is the key transform for class-heavy libraries like musicpy
            # where output objects contain nested class instances (e.g., chord
            # objects contain lists of note objects, which themselves have
            # __dict__ attributes). Unlike "dict" which only does a shallow
            # __dict__ conversion (leaving nested class instances as unhashable
            # objects), "snapshot" recursively walks through all nested objects
            # and converts them to JSON-serializable dicts with __class__ tags.
            return snapshot_state(obj)
        elif transform == 'dataclass_dict':
            return dataclass_to_dict(obj)
        elif transform == 'len':
            return len(obj)
        elif transform == 'type':
            return type(obj).__name__
        elif transform == 'hex':
            if isinstance(obj, bytes):
                return obj.hex()
            return obj
        elif transform == 'state':
            # Deep object state serialization with cycle detection and type discriminator
            # Essential for stateful objects with circular references (e.g., pycrate ASN1Obj)
            include_private = getattr(apply_output_transform, '_include_private', False)
            return object_state_serialize(obj, include_private=include_private)
        elif transform == 'state_private':
            # Same as 'state' but includes private attributes (_prefixed)
            return object_state_serialize(obj, include_private=True)
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
        isolate_globals = cluster.get('isolateGlobals', None)
        class_method = cluster.get('classMethod', None)
        constructor_name = cluster.get('constructor', None)
        constructor_args = cluster.get('constructorArgs', [])
        setup_steps = cluster.get('setup', [])
        input_transform = cluster.get('inputTransform', None)
        max_yields = cluster.get('maxYields', cluster.get('materializeLimit', None))
        freeze_time_str = cluster.get('freezeTime', None)
        track_state_attrs = cluster.get('trackState', None)  # list of attr names to track on the entry object
        modes = cluster.get('modes', None)

        print(f"\n📡 Capturing: {cid}")
        print(f"   Module:  {module_path}")
        if class_method:
            print(f"   Class:   {constructor_name or entry} → {class_method}()")
        else:
            print(f"   Entry:   {entry}")
        print(f"   Watches: {', '.join(watches)}")
        if modes:
            print(f"   Modes:   {len(modes)} ({', '.join(m.get('name', f'mode_{i}') for i, m in enumerate(modes))})")

        # Read classMethod-related fields early for display
        class_method = cluster.get('classMethod', None)
        if class_method:
            print(f"   Class:   {cluster.get('constructor', entry)} → {class_method}()")

        try:
            # Global state isolation — snapshot before, restore after
            # This is critical for libraries with module-level mutable state
            # (e.g., pycrate's ASN1CodecPER.ALIGNED, ASN1CodecBER.ENC_* flags)
            saved_globals = None
            if isolate_globals:
                saved_globals = snapshot_module_globals(isolate_globals)

            # Dynamic import of target module
            # module uses dot notation: "src.invoice.processor"
            mod = importlib.import_module(module_path)

            # ── CWD shadowing detection ────────────────────────────────────
            # When the project directory name matches the package name,
            # Python may find the CWD as a namespace package instead of
            # the real package subdirectory. Detect this and warn.
            if hasattr(mod, '__path__') and not hasattr(mod, '__file__'):
                # This is a namespace package — check if it's the CWD
                mod_paths = list(mod.__path__)
                cwd = os.getcwd()
                for mp in mod_paths:
                    if os.path.normpath(mp) == os.path.normpath(cwd):
                        print(f"   ⚠️  CWD SHADOWING: Module \"{module_path}\" resolves to a namespace package at")
                        print(f"      {mp} instead of the real package.")
                        print(f"      This happens when the project directory name matches the package name.")
                        print(f"      Fix: Run from a different directory, or use `pip install -e .`")
                        break

            # ── classMethod mode ────────────────────────────────────────────
            # For class-based APIs: construct a fresh instance for each input,
            # optionally call setup methods, then call the target method.
            #
            # This is essential for stateful classes (e.g., inflect.engine)
            # where methods like classical() mutate instance state and affect
            # subsequent calls. A fresh instance per input ensures clean state
            # and deterministic fingerprints.
            #
            # Manifest fields:
            #   classMethod: "methodName"          — the instance method to fingerprint
            #   constructor: "ClassName"           — class to instantiate (default: entry)
            #   constructorArgs: [...]             — args for the constructor
            #   setup: [{ method, args }, ...]     — setup calls before the target method

            if class_method:
                Cls = getattr(mod, constructor_name or entry, None)
                if Cls is None or not isinstance(Cls, type):
                    raise TypeError(
                        f"Constructor \"{constructor_name or entry}\" not found or not a class in {module_path}"
                    )
                if setup_steps:
                    print(f"   Setup:   {', '.join(s['method'] + '()' for s in setup_steps)}")

                # Setup freeze_time context managers if needed
                freeze_cms = []
                if freeze_time_str:
                    dt_cm, time_cm = freeze_time(freeze_time_str)
                    freeze_cms = [dt_cm, time_cm]

                # Run with provided inputs
                results = []
                for input_val in inputs:
                    recorder_local = []

                    # Deep-clone input BEFORE calling the function
                    input_for_record = deep_clone(input_val)
                    input_for_args = deep_clone(input_val)

                    # Create fresh instance for each input
                    c_args = deep_clone(constructor_args) if constructor_args else []
                    if kwargs_mode and isinstance(c_args, dict):
                        instance = Cls(**c_args)
                    elif isinstance(c_args, list):
                        instance = Cls(*c_args)
                    else:
                        instance = Cls(c_args)

                    # Apply ghost proxy to instance methods for watch recording
                    for watch_fn in watches:
                        orig_method = getattr(instance, watch_fn, None)
                        if orig_method is not None and callable(orig_method):
                            def make_instance_ghost(orig, name, rec):
                                @wraps(orig)
                                def wrapper(*a, **kw):
                                    try:
                                        result = orig(*a, **kw)
                                        rec.append({
                                            'fn': name,
                                            'args': deep_clone(a),
                                            'result': deep_clone(result),
                                        })
                                        return result
                                    except Exception as err:
                                        rec.append({
                                            'fn': name,
                                            'args': deep_clone(a),
                                            'error': str(err),
                                        })
                                        raise
                                return wrapper
                            setattr(instance, watch_fn, make_instance_ghost(orig_method, watch_fn, recorder_local))

                    # Run setup methods (e.g., classical(all=True))
                    for step in setup_steps:
                        setup_method = getattr(instance, step.get('method', ''), None)
                        if setup_method is None or not callable(setup_method):
                            raise TypeError(
                                f"Setup method \"{step.get('method')}\" not found on instance"
                            )
                        setup_args = deep_clone(step.get('args', []))
                        if isinstance(setup_args, list):
                            setup_method(*setup_args)
                        elif isinstance(setup_args, dict):
                            setup_method(**setup_args)
                        else:
                            setup_method(setup_args)

                    # Call the target method
                    target_method = getattr(instance, class_method, None)
                    if target_method is None or not callable(target_method):
                        raise TypeError(
                            f"Method \"{class_method}\" not found on instance"
                        )

                    # Handle multiArgs and kwargs, optionally with frozen time
                    if freeze_cms:
                        for cm in freeze_cms:
                            cm.__enter__()
                        try:
                            if multi_args and isinstance(input_for_args, list):
                                raw_output = target_method(*input_for_args)
                            elif kwargs_mode and isinstance(input_for_args, dict):
                                raw_output = target_method(**input_for_args)
                            else:
                                raw_output = target_method(input_for_args) if input_for_args is not None else target_method()
                        finally:
                            for cm in reversed(freeze_cms):
                                cm.__exit__(None, None, None)
                    else:
                        if multi_args and isinstance(input_for_args, list):
                            raw_output = target_method(*input_for_args)
                        elif kwargs_mode and isinstance(input_for_args, dict):
                            raw_output = target_method(**input_for_args)
                        else:
                            raw_output = target_method(input_for_args) if input_for_args is not None else target_method()

                    fp_input = input_for_record

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

                    # Apply output transform if specified
                    output_for_fp = apply_output_transform(deep_clone(output), output_transform)

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
                        'was_materialized': was_materialized,
                    })

            else:
                # ── Function-based entry (original behavior) ────────────────
                # Setup freeze_time context managers if needed
                freeze_cms = []
                if freeze_time_str:
                    dt_cm, time_cm = freeze_time(freeze_time_str)
                    freeze_cms = [dt_cm, time_cm]

                ghost = create_ghost(mod, watches, recorder_local)
                entry_fn = getattr(ghost, entry, None) or getattr(mod, entry, None)
                if entry_fn is None or not callable(entry_fn):
                    raise TypeError(f"Entry \"{entry}\" not found or not callable in {module_path}")

                # Run with provided inputs
                results = []
                for input_val in inputs:
                    recorder_local = []

                    # Deep-clone input BEFORE calling the function to prevent mutation from
                    # corrupting the stored fingerprint. Two clones: one for the .regret file
                    # (immutable record), one for the args (may be mutated by the function)
                    input_for_record = deep_clone(input_val)
                    input_for_args = deep_clone(input_val)

                    # Apply input transform (e.g., hex_to_bytes for bytes-argument functions)
                    if input_transform:
                        input_for_args = apply_input_transform(input_for_args, input_transform)

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
                # Self-watching is common for simple pure functions where entry == watch.
                # In this case, the entry function IS the watch — it's called directly,
                # not through the ghost proxy, so the recorder never sees it.
                # This is expected behavior, not a real issue.
                self_watches = [w for w in uncalled_watches if w == entry]
                other_uncalled = [w for w in uncalled_watches if w != entry]

                if self_watches:
                    print(f"   ℹ️  Self-watching: entry '{entry}' is also in watches — ghost cannot intercept self-calls")
                    print(f"      This is expected for simple pure functions. Fingerprint is based on entry output only.")

                if other_uncalled:
                    print(f"   ⚠️  Watched function(s) never called during capture: {', '.join(other_uncalled)}")
                    print(f"      The fingerprint may be based on incomplete data.")
                    print(f"      Consider splitting into separate clusters or adjusting the entry function.")
                    if fingerprint_level == 'full':
                        print(f"      ⚠️  fingerprintLevel is 'full' but internal calls bypass the ghost proxy.")
                        print(f"      Consider using fingerprintLevel 'entry' instead, or split into separate clusters.")

            # Warn about private entry functions with fingerprintLevel=full
            # Ghost proxy skips attributes starting with _, so it can't wrap them
            if fingerprint_level == 'full' and entry.startswith('_'):
                print(f"   ⚠️  Entry function '{entry}' starts with underscore.")
                print(f"      Ghost proxy cannot wrap private functions — watches will be empty.")
                print(f"      With fingerprintLevel=full, this produces an empty-sequence fingerprint.")
                print(f"      RECOMMENDATION: Change fingerprintLevel to 'entry' for this cluster.")

            # ── Modes support ────────────────────────────────────────────────
            # When a cluster has 'modes', each mode represents a behavioral
            # variant of the same function (e.g., method='equinox' vs method='romme').
            # Each mode runs its own inputs and produces its own fingerprint.
            # A combined modes fingerprint is also computed.
            mode_results = []
            modes_fingerprint = None

            if modes:
                for mode_def in modes:
                    mode_name = mode_def.get('name', 'default')
                    mode_kwargs = mode_def.get('kwargs', {})
                    mode_inputs = mode_def.get('inputs', inputs)
                    # Merge cluster-level kwargs with mode-specific kwargs
                    # Mode kwargs override cluster-level kwargs
                    effective_kwargs = {**({} if not kwargs_mode else {}), **mode_kwargs}
                    mode_kwargs_mode = bool(effective_kwargs)

                    mode_fps = []
                    mode_outputs = []
                    for input_val in mode_inputs:
                        recorder_local = []
                        ghost = create_ghost(mod, watches, recorder_local)
                        entry_fn_mode = getattr(ghost, entry, None) or getattr(mod, entry, None)
                        input_for_record = deep_clone(input_val)
                        input_for_args = deep_clone(input_val)

                        # Build call: merge positional input with mode kwargs
                        if mode_kwargs_mode and isinstance(input_for_args, dict):
                            # Merge: mode kwargs override input dict keys
                            merged_args = {**input_for_args, **effective_kwargs}
                            raw_output = entry_fn_mode(**merged_args)
                            fp_input = deep_clone(merged_args)
                        elif mode_kwargs_mode:
                            # Input is positional, kwargs are separate
                            if multi_args and isinstance(input_for_args, list):
                                raw_output = entry_fn_mode(*input_for_args, **effective_kwargs)
                            else:
                                raw_output = entry_fn_mode(input_for_args, **effective_kwargs)
                            fp_input = input_for_record
                        else:
                            if multi_args and isinstance(input_for_args, list):
                                raw_output = entry_fn_mode(*input_for_args)
                            else:
                                raw_output = entry_fn_mode(input_for_args) if input_for_args is not None else entry_fn_mode()
                            fp_input = input_for_record

                        output = consume_generator(raw_output)
                        output_for_fp = apply_output_transform(deep_clone(output), output_transform)

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

                        mode_fps.append(fp)
                        mode_outputs.append({'input': input_for_record, 'output': output_for_fp, 'fp': fp})

                    # Use first mode input result as the mode's representative
                    mode_fp = mode_fps[0] if mode_fps else ''
                    mode_results.append({
                        'mode_name': mode_name,
                        'input': mode_outputs[0]['input'] if mode_outputs else None,
                        'output': mode_outputs[0]['output'] if mode_outputs else None,
                        'fp': mode_fp,
                        'all_fps': mode_fps,
                        'kwargs': effective_kwargs,
                    })
                    print(f"   🏷️  Mode '{mode_name}': {mode_fp}")

                # Compute combined modes fingerprint
                modes_fingerprint = fingerprint_modes(mode_results, normalize_rules, ignore_fields)
                print(f"   🔗 Modes fingerprint: {modes_fingerprint}")

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
            ]
            if class_method:
                if constructor_name:
                    lines.append(f"constructor: {constructor_name}")
                lines.append(f"classMethod: {class_method}")
                if constructor_args:
                    lines.append(f"constructorArgs: {json_serialize(constructor_args)}")
                if setup_steps:
                    lines.append(f"setup: {json_serialize(setup_steps)}")
            else:
                lines.append(f"entry: {entry}")
            lines.append("stack: python")
            lines.append(f"fingerprintLevel: {fingerprint_level}")

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
            if class_method:
                lines.append(f"classMethod: {class_method}")

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

            if input_transform:
                lines.append(f"inputTransform: {input_transform}")

            # Modes metadata
            if modes and mode_results:
                lines.append(f"modes: {len(mode_results)}")
                lines.append(f"modesFingerprint: {modes_fingerprint}")
                for mr in mode_results:
                    lines.append(f"mode: {mr['mode_name']}={mr['fp']}")

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

            # Write mode data section
            if modes and mode_results:
                lines.append(f"MODES_FINGERPRINT {modes_fingerprint}")
                for mr in mode_results:
                    lines.append(f"MODE {mr['mode_name']}")
                    lines.append(f"  INPUT  {json_serialize(mr['input'])}")
                    lines.append(f"  OUTPUT {json_serialize(mr['output'])}")
                    lines.append(f"  HASH   {mr['fp']}")
                    if mr.get('kwargs'):
                        lines.append(f"  KWARGS {json_serialize(mr['kwargs'])}")

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
        finally:
            # Restore global state even if capture failed
            if saved_globals:
                restore_module_globals(saved_globals)

    # ─── Summary ──────────────────────────────────────────────────────────────

    print(f"\n{'─' * 50}")
    print(f"Capture complete: {passed} captured, {failed} failed")

    # Warn about stateful class clusters
    class_clusters = [c for c in manifest.get('clusters', []) if c.get('classMethod')]
    if class_clusters:
        print(f"\n⚠️  {len(class_clusters)} class-based cluster(s) detected.")
        print(f"   These use fresh instances per input to avoid state leakage.")
        print(f"   When verifying raw output manually, create a new instance per call.")
        print(f"   Stateful methods (num, classical, gender) affect subsequent calls.")

    if failed > 0:
        print(f"\n⚠️  Fix failed captures before proceeding to PHASE 2.")
        print(f"   Hint: Check that 'entry' and 'watches' names match exports in your module.")
        sys.exit(1)

    print(f"\nNext: python scripts/validate.py")
    print(f"If all green → you are clear to refactor.")


if __name__ == '__main__':
    main()

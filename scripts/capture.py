#!/usr/bin/env python3
# capture.py — ghost-proxy runner for Python clusters
# Reads regrets/manifest.json, instruments watched functions via
# ghost.py (Ghost Proxy), runs entry points, and writes .regret files.
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
import time
import random
import asyncio
import inspect
import errno
from datetime import datetime, timezone
from functools import wraps
from unittest.mock import patch  # only used by freeze_time()

# ─── Lightweight file locking ─────────────────────────────────────────────────
# Uses fcntl.flock on Unix for locking, with fallback to lockfile pattern
# (O_EXCL atomic create) for cross-platform.  Timeout 10 s with exponential
# backoff.  Auto-releases in finally block.

_LOCK_TIMEOUT_S = 10
_LOCK_BASE_DELAY_S = 0.05
_LOCK_MAX_DELAY_S = 0.5

try:
    import fcntl
    _HAS_FCNTL = True
except ImportError:
    _HAS_FCNTL = False


def _lockfile_path(filepath):
    """Place lockfile next to the target: /path/to/file.ext → /path/to/file.ext.lock"""
    return filepath + '.lock'


def _acquire_lock_fcntl(filepath):
    """Acquire lock using fcntl.flock (Unix). Returns (lock_path, fd)."""
    lock_path = _lockfile_path(filepath)
    fd = os.open(lock_path, os.O_CREAT | os.O_RDWR, 0o600)
    deadline = time.monotonic() + _LOCK_TIMEOUT_S
    delay = _LOCK_BASE_DELAY_S
    while True:
        try:
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
            return (lock_path, fd)
        except (IOError, OSError):
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                os.close(fd)
                raise TimeoutError(
                    f"filelock: could not acquire lock on {filepath} within {_LOCK_TIMEOUT_S}s"
                )
            time.sleep(min(delay, remaining, _LOCK_MAX_DELAY_S))
            delay = min(delay * 2, _LOCK_MAX_DELAY_S)


def _release_lock_fcntl(lock_info):
    """Release fcntl lock. lock_info = (lock_path, fd)."""
    lock_path, fd = lock_info
    try:
        fcntl.flock(fd, fcntl.LOCK_UN)
    finally:
        try:
            os.close(fd)
        except OSError:
            pass
        try:
            os.unlink(lock_path)
        except OSError:
            pass


def _acquire_lock_lockfile(filepath):
    """Acquire lock using O_EXCL lockfile pattern (cross-platform fallback)."""
    lock_path = _lockfile_path(filepath)
    deadline = time.monotonic() + _LOCK_TIMEOUT_S
    delay = _LOCK_BASE_DELAY_S
    while True:
        # Remove stale lock if older than timeout
        try:
            mtime = os.path.getmtime(lock_path)
            if time.time() - mtime > _LOCK_TIMEOUT_S:
                try:
                    os.unlink(lock_path)
                except OSError:
                    pass
                continue  # retry immediately
        except OSError:
            pass  # lock doesn't exist yet

        try:
            fd = os.open(lock_path, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
            os.close(fd)
            return (lock_path, None)
        except OSError as e:
            if e.errno != errno.EEXIST:
                raise

        remaining = deadline - time.monotonic()
        if remaining <= 0:
            raise TimeoutError(
                f"filelock: could not acquire lock on {filepath} within {_LOCK_TIMEOUT_S}s"
            )
        time.sleep(min(delay, remaining, _LOCK_MAX_DELAY_S))
        delay = min(delay * 2, _LOCK_MAX_DELAY_S)


def _release_lock_lockfile(lock_info):
    """Release lockfile pattern lock. lock_info = (lock_path, None)."""
    lock_path, _ = lock_info
    try:
        os.unlink(lock_path)
    except OSError:
        pass


# Choose the best locking strategy for this platform
if _HAS_FCNTL:
    acquire_lock = _acquire_lock_fcntl
    release_lock = _release_lock_fcntl
else:
    acquire_lock = _acquire_lock_lockfile
    release_lock = _release_lock_lockfile

# Import shared fingerprint module (same directory)
from fingerprint import (
    stable_dumps, normalize, strip_fields, to_base36,
    deep_clone, fingerprint, fingerprint_sequence, extract_schema,
    materialize_output, snapshot_state, get_env_snapshot,
    object_state_serialize, snapshot_module_globals, restore_module_globals,
    fingerprint_modes
)

# Import Ghost Proxy — transparent recording wrapper equivalent to JS ghost.js
from ghost import create_ghost, create_instance_ghost, restore_instance


# ─── Manifest path resolution ─────────────────────────────────────────────────
#
# Issue #274: capture.py previously called `importlib.import_module(module_path)`
# where `module_path` was read directly from `cluster['module']` (or, as a
# fallback, `cluster['file']`). When install.js emitted `file: "src/foo.py"`
# for a Python cluster (issue #279), capture.py fell through to the fallback
# and tried `import_module("src/foo.py")` → ModuleNotFoundError, because
# `importlib.import_module` expects a dotted module path, not a file path.
#
# `resolve_module_path()` is the single source of truth that turns a cluster
# dict into the dotted import path capture.py actually uses. It:
#
#   1. Prefers `cluster['module']` when present (correct dotted path).
#   2. Falls back to `cluster['file']` for backward compatibility with
#      manifests written before the #279 fix — but ONLY after converting
#      the file path to a dotted module path AND auto-adding the parent
#      directory to `python_paths` so the import can succeed.
#   3. Returns a 2-tuple (module_path, extra_python_paths) so the caller
#      can inject the auto-discovered paths into sys.path before importing.
#
# This function does NOT mutate sys.path itself — the caller decides whether
# to apply the suggestions (e.g. only when the user didn't already set a
# pythonPath). Keeping it pure makes it testable in isolation.

def _file_path_to_module(rel_path):
    """Convert a filesystem path to a (module_path, parent_dir) pair.

    Examples:
        "transforms.py"            → ("transforms", "")
        "src/invoice/processor.py" → ("invoice.processor", "src")
        "pkg/mod.py"               → ("pkg.mod", "")
        "src/utils/__init__.py"    → ("utils", "src")
        "tests/conftest.py"        → ("conftest", "tests")

    The parent_dir is the directory component that must be added to
    sys.path so the dotted module path can be imported. Empty string means
    the module lives at the project root (cwd is on sys.path already).

    Mirrors `filePathToPythonModule()` in scripts/install.js so that an
    install.js-generated manifest and a capture.py auto-conversion of a
    legacy `file`-based manifest produce identical import paths.
    """
    # Normalize Windows-style backslashes to forward slashes
    norm = rel_path.replace('\\', '/')
    # Strip .py extension
    if norm.lower().endswith('.py'):
        norm = norm[:-3]
    parts = [p for p in norm.split('/') if p != '' and p != '.']

    # Drop __init__ segments — the package itself is importable without it
    cleaned = [p for p in parts if p != '__init__']

    if not cleaned:
        return ('', '')

    if len(cleaned) == 1:
        # File at project root → no parent_dir needed (cwd is on sys.path)
        return (cleaned[0], '')

    # File in a subdirectory: first segment is the parent_dir (package root),
    # the rest is the dotted module path inside it.
    return ('.'.join(cleaned[1:]), cleaned[0])


def resolve_module_path(cluster):
    """Resolve a cluster's import path + any extra sys.path entries needed.

    Returns a tuple (module_path, extra_python_paths) where:
      - module_path: dotted module path suitable for importlib.import_module
      - extra_python_paths: list of relative paths (relative to cwd) that
        must be added to sys.path before the import can succeed. May be
        empty when no extra entries are needed.

    Behavior:
      - If `cluster['module']` is present and non-empty, use it as-is.
        The caller is still expected to honor any `pythonPath` declared
        on the cluster or manifest.
      - Otherwise, fall back to `cluster['file']` (legacy manifests from
        before the #279 fix). Convert it to a dotted module path and
        return the auto-discovered parent directory as an extra path.

    Raises ValueError when neither `module` nor `file` is present.
    """
    module_path = cluster.get('module', '').strip() if isinstance(cluster.get('module'), str) else (cluster.get('module') or '')
    if module_path:
        return (module_path, [])

    file_path = cluster.get('file', '').strip() if isinstance(cluster.get('file'), str) else (cluster.get('file') or '')
    if not file_path:
        raise ValueError(
            f"Cluster \"{cluster.get('id', '<unknown>')}\" has neither 'module' nor 'file' "
            f"field — cannot import. Update regrets/manifest.json to include "
            f"\"module\": \"<dotted.path>\" (and optionally \"pythonPath\": \"<dir>\")."
        )

    mod, parent_dir = _file_path_to_module(file_path)
    if not mod:
        raise ValueError(
            f"Cluster \"{cluster.get('id', '<unknown>')}\" has 'file': \"{file_path}\" "
            f"which could not be converted to a module path. Update the manifest "
            f"to use \"module\": \"<dotted.path>\" instead."
        )

    extra = [parent_dir] if parent_dir else []
    return (mod, extra)


# ─── Seeded RNG support ───────────────────────────────────────────────────────
# When a cluster config includes `seed: N`, we seed Python's random module
# (and numpy if available) before each input run, then restore the previous
# state afterwards. This ensures deterministic output for functions that use
# random number generation.

_numpy_available = False
_numpy_state = None
try:
    import numpy as np
    _numpy_available = True
except ImportError:
    pass


def seed_rng(seed_value):
    """Seed the Python random module and numpy (if available).

    Returns a tuple (saved_python_state, saved_numpy_state) that can be
    passed to restore_rng() to restore the previous RNG state.

    Args:
        seed_value: Integer seed value from the cluster config.

    Returns:
        tuple: (saved_python_state, saved_numpy_state_or_None)
    """
    saved_python_state = random.getstate()
    saved_numpy_state = None

    random.seed(seed_value)

    if _numpy_available:
        try:
            saved_numpy_state = np.random.get_state()
            np.random.seed(seed_value)
        except Exception:
            saved_numpy_state = None

    return saved_python_state, saved_numpy_state


def restore_rng(saved_python_state, saved_numpy_state):
    """Restore the Python random module and numpy (if available) to a
    previously saved state.

    This ensures that seeding for one cluster doesn't affect subsequent
    clusters or the rest of the program.

    Args:
        saved_python_state: State tuple from random.getstate()
        saved_numpy_state: State tuple from np.random.get_state(), or None
    """
    try:
        random.setstate(saved_python_state)
    except Exception as e:
        print(f"   ⚠️  Could not restore Python RNG state: {e}")

    if _numpy_available and saved_numpy_state is not None:
        try:
            np.random.set_state(saved_numpy_state)
        except Exception as e:
            print(f"   ⚠️  Could not restore numpy RNG state: {e}")


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


def _reduce_to_call_counts(recorder):
    """Reduce recorded calls to {fn, count} pairs, sorted by fn name.

    Mirrors the JS reduceToCallCounts() for cross-stack fingerprintLevel: "calls" consistency.
    """
    from collections import Counter
    counts = Counter()
    for call in recorder:
        fn_name = call.get('fn', call.get('name', 'unknown'))
        counts[fn_name] += 1
    return [{'fn': fn, 'count': count} for fn, count in sorted(counts.items())]


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


def call_maybe_async(fn, *args, **kwargs):
    """Call a function that may be sync or async, returning its result.

    If the function is a coroutine function (async def) or returns a
    coroutine object, automatically awaits it using asyncio.run().
    This is essential for Python codebases that use async/await patterns
    (e.g., theHarvester's discovery modules, aiohttp-based tools).

    Args:
        fn: The function to call (sync or async).
        *args: Positional arguments.
        **kwargs: Keyword arguments.

    Returns:
        The function's return value, with coroutines automatically awaited.
    """
    result = fn(*args, **kwargs)
    if inspect.iscoroutine(result):
        result = asyncio.run(result)
    return result


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


# ─── Time Freezing ────────────────────────────────────────────────────────────

def _make_frozen_time(freeze_str):
    """Parse a freezeTime string and return a frozen time.localtime replacement.

    Supported formats:
    - ISO 8601 datetime: "2025-06-14T12:00:00"
    - Date only (time defaults to noon): "2025-06-14"
    - Unix timestamp (integer string): "1749892800"

    Returns a function that returns time.struct_time, replacing time.localtime.
    """
    if freeze_str.isdigit():
        ts = int(freeze_str)
        frozen_st = time.gmtime(ts)
    elif 'T' in freeze_str:
        dt = datetime.fromisoformat(freeze_str)
        frozen_st = dt.timetuple()
    else:
        # Date only — default to noon
        dt = datetime.fromisoformat(freeze_str + 'T12:00:00')
        frozen_st = dt.timetuple()

    def frozen_localtime(seconds=None):
        if seconds is not None:
            return time.gmtime(seconds)
        return frozen_st

    return frozen_localtime


class FreezeTime:
    """Context manager that freezes time.localtime() and datetime.now().

    Usage:
        with FreezeTime("2025-06-14T12:00:00"):
            result = calendar.parse("tomorrow")  # deterministic!

    This patches:
    - time.localtime → returns frozen struct_time
    - datetime.now → returns frozen datetime
    - time.time → returns frozen timestamp

    Only active within the context manager scope.
    """

    def __init__(self, freeze_str):
        self.freeze_str = freeze_str
        self.patches = []

    def __enter__(self):
        frozen_localtime = _make_frozen_time(self.freeze_str)
        # Parse the frozen time once
        if self.freeze_str.isdigit():
            dt = datetime.fromtimestamp(int(self.freeze_str))
        elif 'T' in self.freeze_str:
            dt = datetime.fromisoformat(self.freeze_str)
        else:
            dt = datetime.fromisoformat(self.freeze_str + 'T12:00:00')
        frozen_timestamp = dt.timestamp()

        # Patch time.localtime
        p1 = patch.object(time, 'localtime', frozen_localtime)
        p1.start()
        self.patches.append(p1)

        # Patch time.time to return frozen timestamp
        p2 = patch.object(time, 'time', return_value=frozen_timestamp)
        p2.start()
        self.patches.append(p2)

        # Patch datetime.datetime.now — C types are immutable, must use
        # the module-level datetime reference to patch datetime.datetime
        # Approach: patch the 'now' attribute on the datetime.datetime class
        # by temporarily replacing it via the datetime module's reference
        import datetime as _dt_module
        original_datetime_cls = _dt_module.datetime

        # Create a subclass that overrides now() and utcnow()
        class FrozenDateTime(_dt_module.datetime):
            @classmethod
            def now(cls, tz=None):
                if tz is not None:
                    return dt.replace(tzinfo=tz)
                return dt
            @classmethod
            def utcnow(cls):
                return dt

        # Replace datetime.datetime in the datetime module
        _dt_module.datetime = FrozenDateTime

        # Also try to replace it in the builtins if imported differently
        self._original_datetime_cls = original_datetime_cls
        self._dt_module = _dt_module

        return self

    def __exit__(self, *args):
        for p in reversed(self.patches):
            p.stop()
        self.patches = []
        # Restore original datetime.datetime class
        if hasattr(self, '_dt_module') and hasattr(self, '_original_datetime_cls'):
            self._dt_module.datetime = self._original_datetime_cls


# ─── Ghost decorator ──────────────────────────────────────────────────────────
# create_ghost, create_instance_ghost, and restore_instance are now imported
# from ghost.py — the Python Ghost Proxy equivalent of JS ghost.js.
# See ghost.py for implementation details.


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
        suffix = f' matching "{cluster_filter}"' if cluster_filter else ''
        print(f"❌ No clusters found{suffix}")
        sys.exit(1)

    # Filter to Python clusters only
    python_clusters = [c for c in clusters if c.get('stack') == 'python']
    if not python_clusters:
        print("No Python clusters found in manifest.")
        sys.exit(0)

    # Setup output directory
    out_dir = os.path.join(os.getcwd(), 'regrets')
    os.makedirs(out_dir, exist_ok=True)

    # ── Issue #274: ensure cwd is on sys.path BEFORE any import ──────────────
    #
    # When the user runs `python scripts/capture.py` from the project root,
    # Python sets sys.path[0] to `scripts/` (the script's own directory) —
    # NOT the cwd. That means modules declared at the project root (e.g.
    # `module: "transforms"` with no pythonPath) cannot be imported because
    # the cwd isn't searched. This is the root cause of #274: even with
    # `pythonPath` correctly set on the manifest, root-level modules would
    # fail because Python's default sys.path didn't include the cwd.
    #
    # Fix: unconditionally insert cwd at the front of sys.path. This is
    # idempotent (we check membership first) and matches the convention
    # that the project root is the import root for any Python cluster
    # whose `module` doesn't begin with a `pythonPath`-declared prefix.
    cwd = os.getcwd()
    if cwd not in sys.path:
        sys.path.insert(0, cwd)
        print(f"   📂 Added cwd to sys.path: {cwd}")

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

    # Per-cluster pythonPath resolution. We ALSO collect any auto-discovered
    # extra paths produced by `resolve_module_path()` (issue #279 backward
    # compat: a legacy manifest with `file: "src/foo.py"` but no `module`
    # field needs `src/` added to sys.path so the converted dotted path can
    # be imported). Auto-discovered paths are only added when the cluster
    # does NOT already declare its own pythonPath — we don't want to
    # shadow an explicit user setting.
    for cluster in python_clusters:
        # Cluster-level pythonPath overrides manifest-level
        raw_python_path = cluster.get('pythonPath', '')
        if isinstance(raw_python_path, str):
            python_paths = [raw_python_path] if raw_python_path else []
        elif isinstance(raw_python_path, list):
            python_paths = raw_python_path
        else:
            python_paths = []

        # If the cluster has no explicit pythonPath, ask resolve_module_path
        # whether it discovered one (e.g. from a legacy `file` field). This
        # keeps backward compatibility with manifests written before the
        # #279 install.js fix without silently overriding explicit user
        # configuration.
        if not python_paths:
            try:
                _, extra_paths = resolve_module_path(cluster)
                python_paths = list(extra_paths)
            except ValueError:
                # resolve_module_path will raise again when we try to import;
                # for now, leave python_paths empty so the manifest-level
                # fallback below can still apply.
                python_paths = []

        # If still no pythonPath, fall back to manifest-level
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
        # Issue #274: use the centralized resolver instead of reading the
        # field directly. This handles both `module` (preferred) and legacy
        # `file` (auto-converted) forms, and surfaces a clear error when
        # neither is present.
        try:
            module_path, _ = resolve_module_path(cluster)
        except ValueError as e:
            print(f"\n📡 Capturing: {cid}")
            print(f"   ❌ {e}")
            failed += 1
            continue
        if not module_path:
            print(f"\n📡 Capturing: {cid}")
            print(f"   ❌ Resolved module path is empty — check manifest.")
            failed += 1
            continue
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
        instance_methods = cluster.get('instanceMethods', {})
        input_transform = cluster.get('inputTransform', None)
        max_yields = cluster.get('maxYields', cluster.get('materializeLimit', None))
        freeze_time_str = cluster.get('freezeTime', None)
        track_state_attrs = cluster.get('trackState', None)  # list of attr names to track on the entry object
        seed_value = cluster.get('seed', None)  # RNG seed for deterministic random output
        modes = cluster.get('modes', None)

        # classMethod support: instantiate a class and call methods on the instance
        class_method = cluster.get('classMethod', None)
        constructor_name = cluster.get('constructor', None)
        constructor_args = cluster.get('constructorArgs', [])
        setup_fn = cluster.get('setup', None)
        instance_methods = cluster.get('instanceMethods', {})
        detect_mode = cluster.get('detectMode', False)

        print(f"\n📡 Capturing: {cid}")
        print(f"   Module:  {module_path}")
        if class_method:
            print(f"   Class:   {constructor_name or entry} → {class_method}()")
        else:
            print(f"   Entry:   {entry}")
        if freeze_time_str:
            print(f"   ⏰ Time frozen: {freeze_time_str}")
        if seed_value is not None:
            numpy_note = " + numpy" if _numpy_available else ""
            print(f"   🎲 Seeded RNG with seed={seed_value}{numpy_note}")
        print(f"   Watches: {', '.join(watches)}")
        if modes:
            print(f"   Modes:   {len(modes)} ({', '.join(m.get('name', f'mode_{i}') for i, m in enumerate(modes))})")

        try:
            # Global state isolation — snapshot before, restore after
            # This is critical for libraries with module-level mutable state
            # (e.g., pycrate's ASN1CodecPER.ALIGNED, ASN1CodecBER.ENC_* flags)
            saved_globals = None
            if isolate_globals:
                saved_globals = snapshot_module_globals(isolate_globals)

            # Dynamic import of target module
            # module uses dot notation: "src.invoice.processor"
            #
            # Issue #274: wrap importlib.import_module in a try/except so we
            # can surface a clear, actionable error message instead of a raw
            # traceback. The most common failure is ModuleNotFoundError when
            # either:
            #   - The manifest declares `file: "src/foo.py"` instead of
            #     `module: "foo"` (issue #279 backward-compat scenario —
            #     resolve_module_path already converts this, but the user
            #     may have a hand-edited manifest that doesn't match).
            #   - The pythonPath is missing or wrong — sys.path doesn't
            #     include the directory containing the module's package.
            #
            # The diagnostics below print the resolved module_path, the
            # current sys.path, and the cluster's pythonPath so the user
            # can quickly identify which piece is misconfigured.
            try:
                mod = importlib.import_module(module_path)
            except ModuleNotFoundError as mnfe:
                print(f"   ❌ ModuleNotFoundError: {mnfe}")
                print(f"      Resolved module path: {module_path!r}")
                print(f"      Cluster pythonPath:   {cluster.get('pythonPath', '<not set>')!r}")
                print(f"      Manifest pythonPath:  {manifest.get('pythonPath', '<not set>')!r}")
                print(f"      Cluster 'file' field: {cluster.get('file', '<not set>')!r}")
                print(f"      Cluster 'module' field: {cluster.get('module', '<not set>')!r}")
                print(f"      sys.path (first 5):")
                for p in sys.path[:5]:
                    print(f"        - {p}")
                if len(sys.path) > 5:
                    print(f"        ... ({len(sys.path) - 5} more)")
                print(f"      Hint: ensure the directory containing the package root is on sys.path.")
                print(f"        Add \"pythonPath\": \"<dir>\" to the cluster (or manifest top-level)")
                print(f"        in regrets/manifest.json. For a file at `src/invoice/processor.py`,")
                print(f"        the cluster should declare:")
                print(f"          {{ \"module\": \"invoice.processor\", \"pythonPath\": \"src\" }}")
                raise

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

            # ── detectMode: auto-infer execution mode from module structure ──────
            # When detectMode: true is set in manifest, inspect module to infer
            # the execution mode. This helps agents who are unsure which mode to use.
            # If classMethod is already set, skip inference.
            if detect_mode and not class_method:
                entry_obj = getattr(mod, entry, None)
                if entry_obj is not None and isinstance(entry_obj, type):
                    # Entry is a class
                    method_names = [m for m in dir(entry_obj)
                                    if not m.startswith('_') and callable(getattr(entry_obj, m))]
                    print(f'   ℹ️  Auto-detected mode: class-based (entry "{entry}" is a class)')
                    if method_names:
                        print(f'      Suggested: add "classMethod": "{method_names[0]}" to manifest')
                        print(f'      Available methods: {", ".join(method_names)}')
                elif entry_obj is not None and callable(entry_obj):
                    # Entry is a function
                    print(f'   ℹ️  Auto-detected mode: function-based (entry "{entry}" is a function)')
                elif entry_obj is not None and isinstance(entry_obj, object):
                    # Entry is an object — likely a singleton
                    obj_methods = [m for m in dir(entry_obj)
                                   if not m.startswith('_') and callable(getattr(entry_obj, m))]
                    if obj_methods:
                        print(f'   ℹ️  Auto-detected mode: singleton (entry "{entry}" is an object with methods)')
                        print(f'      Suggested: add "singletonMethod": "{obj_methods[0]}" to manifest')
                        print(f'      Available methods: {", ".join(obj_methods)}')
                    else:
                        print(f'   ℹ️  Auto-detected mode: unable to infer — entry "{entry}" is an object but has no callable methods')
                else:
                    print(f'   ℹ️  Auto-detected mode: unable to infer — entry "{entry}" not found in module')

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
            #   instanceMethods: {"WatchedClass": ["method1", "method2"]}

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

                    # ── Seed RNG if configured ────────────────────────────
                    saved_rng = None
                    if seed_value is not None:
                        saved_rng = seed_rng(seed_value)

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
                                        result = call_maybe_async(orig, *a, **kw)
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
                            call_maybe_async(setup_method, *setup_args)
                        elif isinstance(setup_args, dict):
                            call_maybe_async(setup_method, **setup_args)
                        else:
                            call_maybe_async(setup_method, setup_args)

                    # Call the target method
                    target_method = getattr(instance, class_method, None)
                    if target_method is None or not callable(target_method):
                        raise TypeError(
                            f"Method \"{class_method}\" not found on instance"
                        )

                    # Handle multiArgs and kwargs, optionally with frozen time (with async support)
                    if freeze_cms:
                        for cm in freeze_cms:
                            cm.__enter__()
                        try:
                            if multi_args and isinstance(input_for_args, list):
                                raw_output = call_maybe_async(target_method, *input_for_args)
                            elif kwargs_mode and isinstance(input_for_args, dict):
                                raw_output = call_maybe_async(target_method, **input_for_args)
                            else:
                                raw_output = call_maybe_async(target_method, input_for_args) if input_for_args is not None else call_maybe_async(target_method)
                        finally:
                            for cm in reversed(freeze_cms):
                                cm.__exit__(None, None, None)
                    else:
                        if multi_args and isinstance(input_for_args, list):
                            raw_output = call_maybe_async(target_method, *input_for_args)
                        elif kwargs_mode and isinstance(input_for_args, dict):
                            raw_output = call_maybe_async(target_method, **input_for_args)
                        else:
                            raw_output = call_maybe_async(target_method, input_for_args) if input_for_args is not None else call_maybe_async(target_method)

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

                    # Snapshot tracked attrs from the return object (for trackState)
                    return_state = None
                    if track_state_attrs and raw_output is not None and hasattr(raw_output, '__dict__'):
                        return_state = snapshot_state(
                            raw_output,
                            include_private=True,
                            attr_filter=track_state_attrs
                        )

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
                    elif fingerprint_level == 'calls':
                        watches = cluster.get('watches', [])
                        if not watches:
                            print(f"      ⚠️  fingerprintLevel='calls' but no watches defined — falling back to 'entry'")
                            fp = fingerprint(fp_input, output_for_fp, normalize_rules, ignore_fields)
                        else:
                            call_counts = _reduce_to_call_counts(recorder_local)
                            fp = fingerprint(fp_input, call_counts, normalize_rules, ignore_fields)
                    else:
                        fp = fingerprint_sequence(recorder_local, normalize_rules, ignore_fields)

                    results.append({
                        'input': input_val,
                        'output': output_for_fp,
                        'fp': fp,
                        'calls': list(recorder_local),
                        'was_materialized': was_materialized,
                        'return_state': return_state,
                    })

                    # ── Restore RNG state after this input run ──────────────
                    if saved_rng is not None:
                        restore_rng(*saved_rng)

            else:
                # ── Function-based entry (original behavior) ────────────────
                # Setup freeze_time context managers if needed
                freeze_cms = []
                if freeze_time_str:
                    dt_cm, time_cm = freeze_time(freeze_time_str)
                    freeze_cms = [dt_cm, time_cm]

                recorder_local = []  # initialized here; cleared per input in the loop below
                ghost = create_ghost(mod, watches, recorder_local, instance_methods=instance_methods)
                entry_fn = getattr(ghost, entry, None) or getattr(mod, entry, None)
                if entry_fn is None or not callable(entry_fn):
                    ghost.restore()
                    raise TypeError(f"Entry \"{entry}\" not found or not callable in {module_path}")

                # Run with provided inputs
                results = []
                for input_val in inputs:
                    # Clear the recorder list instead of creating a new one.
                    # The Ghost Proxy's wrappers hold a reference to the original
                    # list object — if we reassign recorder_local = [], the wrappers
                    # would still write to the old list. Clearing in-place fixes this.
                    recorder_local.clear()

                    # Deep-clone input BEFORE calling the function to prevent mutation from
                    # corrupting the stored fingerprint. Two clones: one for the .regret file
                    # (immutable record), one for the args (may be mutated by the function)
                    input_for_record = deep_clone(input_val)
                    input_for_args = deep_clone(input_val)

                    # ── Seed RNG if configured ────────────────────────────
                    saved_rng = None
                    if seed_value is not None:
                        saved_rng = seed_rng(seed_value)

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
                            return call_maybe_async(entry_fn, *input_for_args), input_for_record
                        elif kwargs_mode and isinstance(input_for_args, dict):
                            return call_maybe_async(entry_fn, **input_for_args), input_for_record
                        elif kwargs_mode and not isinstance(input_for_args, dict):
                            raise TypeError(
                                f"kwargs=True but input is {type(input_for_args).__name__}, not dict. "
                                f"When kwargs is enabled, each input must be a dict to unpack as **kwargs."
                            )
                        else:
                            return (call_maybe_async(entry_fn, input_for_args) if input_for_args is not None else call_maybe_async(entry_fn)), input_for_record

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

                    # Also snapshot tracked attrs from the return object (if it has __dict__)
                    return_state = None
                    if track_state_attrs and raw_output is not None and hasattr(raw_output, '__dict__'):
                        return_state = snapshot_state(
                            raw_output,
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
                    elif fingerprint_level == 'calls':
                        watches = cluster.get('watches', [])
                        if not watches:
                            print(f"      ⚠️  fingerprintLevel='calls' but no watches defined — falling back to 'entry'")
                            fp = fingerprint(fp_input, output_for_fp, normalize_rules, ignore_fields)
                        else:
                            call_counts = _reduce_to_call_counts(recorder_local)
                            fp = fingerprint(fp_input, call_counts, normalize_rules, ignore_fields)
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
                        'return_state': return_state,
                    })

                    # ── Restore RNG state after this input run ──────────────
                    if saved_rng is not None:
                        restore_rng(*saved_rng)

            # Restore original functions on the module after ghost capture
            # This is critical: the Ghost Proxy mutates the module in-place
            # so that internal calls between watched functions are intercepted.
            # We must restore the originals after all inputs are processed.
            try:
                ghost.restore()
            except (NameError, AttributeError):
                pass

            # Warn about watched functions that were never called during capture
            # Note: If the entry function is also in the watches list, it IS called
            # (the ghost wrapper records it), but the recorder only captures calls
            # made by watched functions to OTHER watched functions. The entry function
            # call itself is recorded. So we should not warn about the entry function
            # being "uncalled" — it was called, just not as an internal call.
            called_fns = set()
            for r in results:
                for call in r['calls']:
                    called_fns.add(call['fn'])
            uncalled_watches = [w for w in watches if w not in called_fns and w != entry]
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
                        ghost = create_ghost(mod, watches, recorder_local, instance_methods=instance_methods)
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

                        # Restore original functions after this mode input
                        try:
                            ghost.restore()
                        except (NameError, AttributeError):
                            pass

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
            if class_method:
                lines.append(f"classMethod: {class_method}")
                lines.append(f"constructor: {constructor_name or entry}")
                if constructor_args:
                    lines.append(f"constructorArgs: {json_serialize(constructor_args)}")
                if setup_fn:
                    lines.append(f"setup: {setup_fn}")
                if instance_methods:
                    lines.append(f"instanceMethods: {json_serialize(instance_methods)}")
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
            # classMethod metadata
            if class_method:
                lines.append(f"constructor: {constructor_name}")
                lines.append(f"classMethod: {class_method}")
                if constructor_args:
                    lines.append(f"constructorArgs: {json_serialize(constructor_args)}")
                if setup_steps:
                    lines.append(f"setup: {json_serialize(setup_steps)}")
            # freezeTime metadata
            if freeze_time_str:
                lines.append(f"freezeTime: {freeze_time_str}")
            if seed_value is not None:
                lines.append(f"seed: {seed_value}")
            if track_state_attrs:
                attrs_str = ', '.join(track_state_attrs)
                lines.append("trackState: [" + attrs_str + "]")
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
            if track_state_attrs and golden.get('return_state') is not None:
                lines.append(f"RETURN_STATE {json_serialize(golden['return_state'])}")

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

            _lk = acquire_lock(regret_path)
            try:
                with open(regret_path, 'w', encoding='utf-8') as f:
                    f.write('\n'.join(lines))
            finally:
                release_lock(_lk)

            print(f"   ✅ Fingerprint: {fp}")
            print(f"   📄 Saved: regrets/{cid}.regret")
            passed += 1

        except Exception as err:
            # Ensure ghost proxy is restored even on error
            try:
                ghost.restore()
            except (NameError, AttributeError):
                pass
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

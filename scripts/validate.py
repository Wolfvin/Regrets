#!/usr/bin/env python3
# validate.py — regression validator for Python clusters
# Usage:
#   python scripts/validate.py
#   python scripts/validate.py --runs 5
#   python scripts/validate.py --cluster transform-invoice
#   python scripts/validate.py --update transform-invoice --reason "tax rate changed to 12%"
#   python scripts/validate.py --fail-fast

import sys
import os
import json
import importlib
import re
import hashlib
import types
import time
import random
import errno
from datetime import datetime, timezone
from functools import wraps
from pathlib import Path
from unittest.mock import patch

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
                continue
        except OSError:
            pass

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
    _numpy_to_native, materialize_output, snapshot_state, get_env_snapshot,
    object_state_serialize, snapshot_module_globals, restore_module_globals,
    fingerprint_modes
)


# ─── Seeded RNG support ───────────────────────────────────────────────────────
# Same implementation as capture.py — kept in sync.

_numpy_available = False
try:
    import numpy as np
    _numpy_available = True
except ImportError:
    pass


def seed_rng(seed_value):
    """Seed the Python random module and numpy (if available).

    Returns a tuple (saved_python_state, saved_numpy_state) that can be
    passed to restore_rng() to restore the previous RNG state.
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

    Same implementation as capture.py — kept in sync.
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
    result = {
        'cluster': None,
        'runs': 1,
        'runs_explicit': False,  # whether --runs was explicitly provided via CLI
        'drift_mode_flag': False,  # whether --drift-mode was passed (from regret drift)
        'update': None,
        'reason': None,
        'fail_fast': False,
        'manifest': os.path.join(os.getcwd(), 'regrets', 'manifest.json'),
        'json_output': False,
    }

    i = 0
    while i < len(args):
        if args[i] == '--cluster' and i + 1 < len(args):
            result['cluster'] = args[i + 1]; i += 2
        elif args[i] == '--runs' and i + 1 < len(args):
            result['runs'] = int(args[i + 1]); result['runs_explicit'] = True; i += 2
        elif args[i] == '--update' and i + 1 < len(args):
            result['update'] = args[i + 1]; i += 2
        elif args[i] == '--reason' and i + 1 < len(args):
            result['reason'] = args[i + 1]; i += 2
        elif args[i] == '--fail-fast':
            result['fail_fast'] = True; i += 1
        elif args[i] == '--drift-mode':
            result['drift_mode_flag'] = True; i += 1
            if not result['runs_explicit']:
                result['runs'] = 5
        elif args[i] == '--manifest' and i + 1 < len(args):
            result['manifest'] = args[i + 1]; i += 2
        elif args[i] == '--json':
            result['json_output'] = True; i += 1
        else:
            i += 1

    return result

# ─── Time Freezing (shared with capture.py) ────────────────────────────────────

def _make_frozen_time(freeze_str):
    """Parse a freezeTime string and return a frozen time.localtime replacement."""
    if freeze_str.isdigit():
        ts = int(freeze_str)
        frozen_st = time.gmtime(ts)
    elif 'T' in freeze_str:
        dt = datetime.fromisoformat(freeze_str)
        frozen_st = dt.timetuple()
    else:
        dt = datetime.fromisoformat(freeze_str + 'T12:00:00')
        frozen_st = dt.timetuple()

    def frozen_localtime(seconds=None):
        if seconds is not None:
            return time.gmtime(seconds)
        return frozen_st

    return frozen_localtime


class FreezeTime:
    """Context manager that freezes time.localtime() and datetime.now()."""

    def __init__(self, freeze_str):
        self.freeze_str = freeze_str
        self.patches = []

    def __enter__(self):
        frozen_localtime = _make_frozen_time(self.freeze_str)
        if self.freeze_str.isdigit():
            dt = datetime.fromtimestamp(int(self.freeze_str))
        elif 'T' in self.freeze_str:
            dt = datetime.fromisoformat(self.freeze_str)
        else:
            dt = datetime.fromisoformat(self.freeze_str + 'T12:00:00')
        frozen_timestamp = dt.timestamp()

        p1 = patch.object(time, 'localtime', frozen_localtime)
        p1.start()
        self.patches.append(p1)

        p2 = patch.object(time, 'time', return_value=frozen_timestamp)
        p2.start()
        self.patches.append(p2)

        # Patch datetime.datetime.now via module-level class replacement
        import datetime as _dt_module
        original_datetime_cls = _dt_module.datetime

        class FrozenDateTime(_dt_module.datetime):
            @classmethod
            def now(cls, tz=None):
                if tz is not None:
                    return dt.replace(tzinfo=tz)
                return dt
            @classmethod
            def utcnow(cls):
                return dt

        _dt_module.datetime = FrozenDateTime
        self._original_datetime_cls = original_datetime_cls
        self._dt_module = _dt_module

        return self

    def __exit__(self, *args):
        for p in reversed(self.patches):
            p.stop()
        self.patches = []
        if hasattr(self, '_dt_module') and hasattr(self, '_original_datetime_cls'):
            self._dt_module.datetime = self._original_datetime_cls


# ─── Helpers (shared with capture.py) ─────────────────────────────────────────

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


def _numpy_array_summary(arr):
    """Compute a summary of a numpy array for fingerprinting.

    Instead of serializing every element (which can be thousands of floats),
    this produces a compact summary with shape, dtype, and key statistics.
    This is essential for DSP/scientific computing libraries where functions
    return large arrays (e.g., sdr.sinusoid returns 1000+ sample arrays).
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

    if arr.size == 0:
        summary['note'] = 'empty array'
        return summary

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
        flat = arr.flatten()
        n_head = min(5, flat.size)
        n_tail = min(5, flat.size)
        summary['head'] = [complex(x) for x in flat[:n_head]]
        summary['tail'] = [complex(x) for x in flat[-n_tail:]]
    else:
        float_arr = arr.astype(np.float64) if np.issubdtype(arr.dtype, np.floating) else arr.astype(np.float64)
        summary['mean'] = float(np.mean(float_arr))
        summary['std'] = float(np.std(float_arr))
        summary['min'] = float(np.min(float_arr))
        summary['max'] = float(np.max(float_arr))
        flat = arr.flatten()
        n_head = min(5, flat.size)
        n_tail = min(5, flat.size)
        summary['head'] = [float(x) for x in flat[:n_head]]
        summary['tail'] = [float(x) for x in flat[-n_tail:]]

    if np.issubdtype(arr.dtype, np.integer):
        summary['sum'] = int(np.sum(arr))

    return summary


def apply_input_transform(input_val, transform):
    """Apply an inputTransform to convert JSON-safe input to the actual function input type.

    See capture.py for full documentation.
    """
    if transform is None:
        return input_val

    if transform == 'hex_to_bytes':
        if isinstance(input_val, str):
            return bytes.fromhex(input_val)
        if isinstance(input_val, list):
            return [bytes.fromhex(v) if isinstance(v, str) else v for v in input_val]
        return input_val

    elif transform == 'list_to_bytes':
        if isinstance(input_val, list):
            if all(isinstance(v, int) for v in input_val):
                return bytes(input_val)
            return [bytes(v) if isinstance(v, list) and all(isinstance(x, int) for x in v) else v for v in input_val]
        return input_val

    elif transform == 'list_of_hex_to_bytes':
        if isinstance(input_val, list):
            return [bytes.fromhex(v) if isinstance(v, str) else v for v in input_val]
        return input_val

    return input_val


def dataclass_to_dict(obj):
    """Recursively convert dataclass instances to JSON-serializable dicts.

    Identical implementation to capture.py — kept in sync.
    See capture.py for full documentation.
    """
    import dataclasses
    from datetime import date, datetime
    from collections import UserString

    if obj is None or isinstance(obj, (bool, int, float, str)):
        return obj
    if isinstance(obj, datetime):
        return obj.isoformat()
    if isinstance(obj, date):
        return obj.isoformat()
    if isinstance(obj, bytes):
        return obj.hex()
    if isinstance(obj, list):
        return [dataclass_to_dict(v) for v in obj]
    if isinstance(obj, tuple):
        return [dataclass_to_dict(v) for v in obj]
    if isinstance(obj, set):
        return sorted([dataclass_to_dict(v) for v in obj], key=lambda x: str(x))
    if isinstance(obj, dict):
        return {k: dataclass_to_dict(v) for k, v in obj.items()}
    if dataclasses.is_dataclass(obj) and not isinstance(obj, type):
        cls_name = type(obj).__name__
        result = {'__class__': cls_name}
        if isinstance(obj, UserString):
            result['data'] = str(obj)
        try:
            for field in dataclasses.fields(obj):
                try:
                    val = getattr(obj, field.name)
                    result[field.name] = dataclass_to_dict(val)
                except Exception:
                    result[field.name] = f'<unrepresentable:{field.name}>'
        except TypeError:
            pass
        return result
    if hasattr(obj, 'to_dict') and callable(obj.to_dict):
        try:
            return dataclass_to_dict(obj.to_dict())
        except Exception:
            pass
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
    return repr(obj)


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
        elif transform == 'array_summary':
            return _numpy_array_summary(obj)
        elif transform == 'isoformat':
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
            include_private = getattr(apply_output_transform, '_include_private', False)
            return object_state_serialize(obj, include_private=include_private)
        elif transform == 'state_private':
            return object_state_serialize(obj, include_private=True)
        else:
            raise ValueError(f"Unknown outputTransform: '{transform}'")

    if isinstance(output, list) and transform not in ('len',):
        return [transform_one(item) for item in output]
    return transform_one(output)


# ─── Parse .regret file ──────────────────────────────────────────────────────

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
        elif key == 'kwargs':
            meta['kwargs'] = val.lower() == 'true'
        elif key == 'outputTransform':
            meta['outputTransform'] = val
        elif key == 'env':
            try:
                meta['env'] = json.loads(val)
            except (json.JSONDecodeError, ValueError):
                meta['env'] = val
        elif key == 'materializeOutput':
            meta['materializeOutput'] = val.lower() == 'true'
        elif key == 'trackMutation':
            meta['trackMutation'] = val.lower() == 'true'
        elif key == 'mutationFingerprint':
            meta['mutationFingerprint'] = val.strip()
        elif key == 'classMethod':
            meta['classMethod'] = val
        elif key == 'constructor':
            meta['constructor'] = val
        elif key == 'constructorArgs':
            try:
                meta['constructorArgs'] = json.loads(val)
            except (json.JSONDecodeError, ValueError):
                meta['constructorArgs'] = val
        elif key == 'setup':
            try:
                meta['setup'] = json.loads(val)
            except (json.JSONDecodeError, ValueError):
                meta['setup'] = val
        elif key == 'inputTransform':
            meta['inputTransform'] = val
        elif key == 'maxYields':
            meta['maxYields'] = int(val)
        elif key == 'freezeTime':
            meta['freezeTime'] = val
        elif key == 'trackState':
            meta['trackState'] = [s.strip() for s in val.strip('[]').split(',') if s.strip()]
        elif key == 'seed':
            try:
                meta['seed'] = int(val.strip())
            except ValueError:
                meta['seed'] = val.strip()
        elif key == 'stateFingerprint':
            meta['stateFingerprint'] = val.strip()
        elif key == 'instanceMethods':
            try:
                meta['instanceMethods'] = json.loads(val)
            except (json.JSONDecodeError, ValueError):
                meta['instanceMethods'] = val
        else:
            meta[key] = val

    # Parse data section
    for line in data_section.split('\n'):
        if line.startswith('INPUT '):
            meta['input'] = json.loads(line[6:])
        elif line.startswith('OUTPUT '):
            meta['output'] = json.loads(line[7:])
        elif line.startswith('HASH '):
            meta['goldenHash'] = line[5:].strip()
        elif line.startswith('MUTATION_BEFORE '):
            meta['mutationBefore'] = json.loads(line[16:])
        elif line.startswith('MUTATION_AFTER '):
            meta['mutationAfter'] = json.loads(line[15:])
        elif line.startswith('STATE_BEFORE '):
            meta['stateBefore'] = json.loads(line[13:])
        elif line.startswith('STATE_AFTER '):
            meta['stateAfter'] = json.loads(line[12:])
        elif line.startswith('RETURN_STATE '):
            meta['returnState'] = json.loads(line[14:])
        elif line.startswith('MODES_FINGERPRINT '):
            meta['modesFingerprint'] = line[18:].strip()
        elif line.startswith('MODE '):
            # Parse mode entries: MODE name, followed by indented INPUT/OUTPUT/HASH/KWARGS
            if 'modes_data' not in meta:
                meta['modes_data'] = []
            meta['modes_data'].append({'mode_name': line[5:].strip()})
        elif line.startswith('  INPUT ') and 'modes_data' in meta and meta['modes_data']:
            meta['modes_data'][-1]['input'] = json.loads(line[8:])
        elif line.startswith('  OUTPUT ') and 'modes_data' in meta and meta['modes_data']:
            meta['modes_data'][-1]['output'] = json.loads(line[9:])
        elif line.startswith('  HASH ') and 'modes_data' in meta and meta['modes_data']:
            meta['modes_data'][-1]['fp'] = line[7:].strip()
        elif line.startswith('  KWARGS ') and 'modes_data' in meta and meta['modes_data']:
            meta['modes_data'][-1]['kwargs'] = json.loads(line[9:])

    meta['raw'] = content
    return meta


# ─── Ghost wrapper ────────────────────────────────────────────────────────────

def create_ghost(mod, watch_list, recorder):
    """Wrap watched functions with recording decorators."""
    class GhostModule:
        pass

    ghost = GhostModule()

    for attr_name in dir(mod):
        if not attr_name.startswith('_'):
            try:
                setattr(ghost, attr_name, getattr(mod, attr_name))
            except AttributeError:
                pass

    for fn_name in (watch_list or []):
        original = getattr(mod, fn_name, None)
        if original is None or not callable(original):
            continue

        def make_ghost(orig, name):
            @wraps(orig)
            def wrapper(*args, **kwargs):
                try:
                    result = orig(*args, **kwargs)
                    recorder.append({
                        'fn': name,
                        'args': deep_clone(args),
                        'result': deep_clone(result),
                    })
                    return result
                except Exception as err:
                    recorder.append({
                        'fn': name,
                        'args': deep_clone(args),
                        'error': str(err),
                    })
                    raise
            return wrapper

        setattr(ghost, fn_name, make_ghost(original, fn_name))

    return ghost


def create_instance_ghost(instance, watch_list, recorder):
    """Wrap watched methods on a class instance with recording decorators."""
    originals = {}
    for fn_name in (watch_list or []):
        original = getattr(instance, fn_name, None)
        if original is None or not callable(original):
            continue
        originals[fn_name] = original

        def make_ghost(orig, name):
            @wraps(orig)
            def wrapper(*args, **kwargs):
                try:
                    result = orig(*args, **kwargs)
                    recorder.append({
                        'fn': name,
                        'args': deep_clone(args),
                        'result': deep_clone(result),
                    })
                    return result
                except Exception as err:
                    recorder.append({
                        'fn': name,
                        'args': deep_clone(args),
                        'error': str(err),
                    })
                    raise
            return wrapper

        setattr(instance, fn_name, make_ghost(original, fn_name))

    return instance, originals


def restore_instance(instance, originals):
    """Restore original methods on an instance after ghost validation."""
    for name, original in originals.items():
        setattr(instance, name, original)


# ─── Update .regret file ─────────────────────────────────────────────────────

def update_regret(regret_path, regret, new_hash, live_output, reason):
    old_hash = regret.get('goldenHash', '')
    now = datetime.now(timezone.utc).isoformat()

    # Rebuild .regret content
    raw = regret['raw']
    new_content = re.sub(r'^fingerprint: .+$', f'fingerprint: {new_hash}', raw, flags=re.MULTILINE)
    new_content = re.sub(r'^captured: .+$', f'captured: {now}', new_content, flags=re.MULTILINE)
    new_content = re.sub(r'^OUTPUT .+$', f'OUTPUT {json.dumps(_numpy_to_native(live_output), ensure_ascii=False)}', new_content, flags=re.MULTILINE)
    new_content = re.sub(r'^HASH .+$', f'HASH   {new_hash}', new_content, flags=re.MULTILINE)

    _lk = acquire_lock(regret_path)
    try:
        with open(regret_path, 'w', encoding='utf-8') as f:
            f.write(new_content)
    finally:
        release_lock(_lk)

    # Sanitize reason: replace newlines to prevent audit.log corruption
    safe_reason = re.sub(r'[\r\n]+', ' ', reason) if isinstance(reason, str) else reason

    # ─── Hash chain ──────────────────────────────────────────────────────────
    audit_log = os.path.join(os.path.dirname(regret_path), 'audit.log')
    prev_chain = '0000000'  # genesis
    if os.path.isfile(audit_log):
        try:
            with open(audit_log, 'r', encoding='utf-8') as f:
                log_content = f.read().strip()
            if log_content:
                lines = log_content.split('\n')
                # Walk backwards to find the last chain hash
                for line in reversed(lines):
                    m = re.match(r'^\s*chain:\s*(\S+)', line)
                    if m:
                        prev_chain = m.group(1)
                        break
        except Exception:
            pass  # fall through to genesis

    cluster_id = os.path.splitext(os.path.basename(regret_path))[0]
    new_entry_content = (
        f"{now}  UPDATE  {cluster_id}\n"
        f"  old: {old_hash}\n"
        f"  new: {new_hash}\n"
        f"  reason: {safe_reason}\n"
        f"  by: AI refactor session"
    )
    chain_hash = hashlib.sha256((prev_chain + new_entry_content).encode('utf-8')).hexdigest()[:7]

    entry = f"\n{new_entry_content}\n  chain: {chain_hash}"
    _lk2 = acquire_lock(audit_log)
    try:
        with open(audit_log, 'a', encoding='utf-8') as f:
            f.write(entry)
    finally:
        release_lock(_lk2)

    return old_hash, new_hash


# ─── Main ─────────────────────────────────────────────────────────────────────

def main():
    cli = parse_args()

    json_output = cli['json_output']

    # Validate --update usage
    if cli['update'] and not cli['reason']:
        if json_output:
            print(json.dumps({'error': '--update requires --reason'}))
        else:
            print("❌ --update requires --reason")
            print(f'   Example: --update {cli["update"]} --reason "describe why behavior changed"')
        sys.exit(1)

    if cli['reason'] and len(cli['reason'].split()) < 4:
        if json_output:
            print(json.dumps({'error': f'--reason is too vague: "{cli["reason"]}"'}))
        else:
            print(f'❌ --reason is too vague: "{cli["reason"]}"')
            print('   Be specific. e.g. "tax rate updated from 11% to 12% per new regulation"')
        sys.exit(1)

    # Load manifest
    try:
        with open(cli['manifest'], 'r', encoding='utf-8') as f:
            manifest = json.load(f)
    except (FileNotFoundError, json.JSONDecodeError):
        if json_output:
            print(json.dumps({'error': f'Could not read manifest: {cli["manifest"]}'}))
        else:
            print(f"❌ Could not read manifest: {cli['manifest']}")
        sys.exit(1)

    # Find .regret files
    regret_dir = os.path.join(os.getcwd(), 'regrets')
    filter_id = cli['cluster'] or cli['update'] or None

    try:
        regret_files = [
            f for f in os.listdir(regret_dir)
            if f.endswith('.regret') and (not filter_id or f == f'{filter_id}.regret')
        ]
    except FileNotFoundError:
        if json_output:
            print(json.dumps({'error': 'regrets/ not found. Run capture.py first.'}))
        else:
            print("❌ regrets/ not found. Run capture.py first.")
        sys.exit(1)

    if not regret_files:
        if json_output:
            filter_msg = f' for "{filter_id}"' if filter_id else ''
            print(json.dumps({'error': f'No .regret files found{filter_msg}.'}))
        else:
            print(f"❌ No .regret files found{' for "' + filter_id + '"' if filter_id else ''}.")
        sys.exit(1)

    # Add pythonPath to sys.path if specified in any Python cluster
    # Supports both single string ("src") and array of strings (["src", "lib"])
    # Also supports manifest-level pythonPath as default for all clusters
    manifest_python_path = manifest.get('pythonPath', '')
    if isinstance(manifest_python_path, str):
        manifest_python_paths = [manifest_python_path] if manifest_python_path else []
    elif isinstance(manifest_python_path, list):
        manifest_python_paths = manifest_python_path
    else:
        manifest_python_paths = []

    for cluster in manifest.get('clusters', []):
        if cluster.get('stack') == 'python':
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
                    abs_path = os.path.join(os.getcwd(), python_path)
                    if abs_path not in sys.path:
                        sys.path.insert(0, abs_path)
                        if not json_output:
                            print(f"  📂 pythonPath resolved: {python_path} → {abs_path}")

    update_mode = bool(cli['update'])
    drift_mode = cli['runs'] > 1 and not update_mode

    if json_output:
        pass  # silent in JSON mode
    elif update_mode:
        print(f'\n🔄 Update mode — cluster: {cli["update"]}')
        print(f'   Reason: {cli["reason"]}\n')
    elif drift_mode:
        print(f'\n🔍 Drift detection — {cli["runs"]} runs per cluster...\n')
    else:
        print(f'\n🔍 Validating {len(regret_files)} cluster(s)...\n')

    results = []

    for regret_file in regret_files:
        saved_globals = None
        cluster_id = os.path.splitext(regret_file)[0]
        regret_path = os.path.join(regret_dir, regret_file)

        with open(regret_path, 'r', encoding='utf-8') as f:
            regret = parse_regret(f.read())

        # Find cluster definition in manifest
        cluster_def = None
        for c in manifest.get('clusters', []):
            if c['id'] == cluster_id:
                cluster_def = c
                break

        if not cluster_def:
            if not json_output:
                print(f"  ⚠️  {cluster_id}: not in manifest — skipping")
            results.append({'id': cluster_id, 'pass': False, 'skipped': True})
            continue

        # Compute effective runs for this cluster:
        # Priority: --runs CLI (explicit) > manifest driftRuns > default runs
        effective_runs = cli['runs'] if cli['runs_explicit'] else cluster_def.get('driftRuns', cli['runs'])

        # Only validate Python clusters
        if cluster_def.get('stack') != 'python':
            if not json_output:
                print(f"  ⏭️  {cluster_id}: stack={cluster_def.get('stack', 'js')} — use JS validator")
            results.append({'id': cluster_id, 'pass': False, 'skipped': True})
            continue

        try:
            module_path = cluster_def.get('module', cluster_def.get('file', ''))
            entry_name = cluster_def['entry']

            norm_rules = cluster_def.get('normalize', [])
            ign_fields = cluster_def.get('ignoreFields', [])
            fp_level = cluster_def.get('fingerprintLevel', 'entry')
            # Warn about private entry functions with fingerprintLevel=full
            if fp_level == 'full' and entry_name.startswith('_'):
                if not json_output:
                    print(f"  ⚠️  {cluster_id}: Entry '{entry_name}' is private — ghost proxy cannot wrap it. fingerprintLevel='full' will produce empty-sequence fingerprint. Consider 'entry'.")
            fp_mode = cluster_def.get('fingerprintMode', 'value')
            value_paths = cluster_def.get('valuePaths', [])
            multi_args = cluster_def.get('multiArgs', False)
            kwargs_mode = regret.get('kwargs', cluster_def.get('kwargs', False))
            output_transform = regret.get('outputTransform') or cluster_def.get('outputTransform', None)
            materialize_output_flag = regret.get('materializeOutput', cluster_def.get('materializeOutput', False))
            track_mutation = regret.get('trackMutation', cluster_def.get('trackMutation', False))
            # classMethod support for Python
            class_method = regret.get('classMethod', cluster_def.get('classMethod', None))
            constructor_name = regret.get('constructor', cluster_def.get('constructor', None))
            constructor_args = regret.get('constructorArgs', cluster_def.get('constructorArgs', []))
            setup_steps = regret.get('setup', cluster_def.get('setup', []))
            isolate_globals = cluster_def.get('isolateGlobals', None)
            input_transform = regret.get('inputTransform', cluster_def.get('inputTransform', None))
            max_yields = regret.get('maxYields', cluster_def.get('maxYields', cluster_def.get('materializeLimit', None)))
            freeze_time_str = regret.get('freezeTime', cluster_def.get('freezeTime', None))
            track_state_attrs = regret.get('trackState', cluster_def.get('trackState', None))
            seed_value = regret.get('seed', cluster_def.get('seed', None))
            golden_state_fp = regret.get('stateFingerprint', None)
            golden_return_state = regret.get('returnState', None)

            # Check environment snapshot if present in .regret file
            regret_env = regret.get('env')
            if regret_env and isinstance(regret_env, dict):
                current_env = get_env_snapshot()
                for k, v in regret_env.items():
                    if current_env.get(k) != v:
                        if not json_output:
                            print(f"  ⚠️  {cluster_id}: environment changed: {k} was {v}, now {current_env.get(k)}")

            mod = importlib.import_module(module_path)

            hashes = []           # flat list of all hashes (for backward compat)
            hashes_per_input = {}  # { inputKey: [hash_run1, hash_run2, ...] } for per-input drift
            last_output = None
            live_return_state = None

            # Determine which inputs to validate: golden from .regret + all from manifest
            all_inputs = cluster_def.get('inputs', [regret.get('input')])
            inputs_to_validate = [regret.get('input')]
            for inp in all_inputs:
                if json.dumps(inp, sort_keys=True) != json.dumps(regret.get('input'), sort_keys=True):
                    inputs_to_validate.append(inp)

            # Determine fingerprint mode: .regret file takes precedence over manifest
            effective_fp_mode = regret.get('fingerprintMode') or fp_mode or 'value'
            effective_value_paths = regret.get('valuePaths') or value_paths or []

            for _ in range(effective_runs):
                # Global state isolation — snapshot before each run, restore after
                saved_globals = None
                if isolate_globals:
                    saved_globals = snapshot_module_globals(isolate_globals)

                recorder = []
                watches_list = regret.get('watches', cluster_def.get('watches', []))

                if class_method:
                    # ── classMethod mode: fresh instance per input ──────────
                    Cls = getattr(mod, constructor_name or entry_name, None)
                    if Cls is None or not isinstance(Cls, type):
                        raise TypeError(f"Constructor \"{constructor_name or entry_name}\" not found or not a class in {module_path}")

                    for current_input in inputs_to_validate:
                        input_for_fp = deep_clone(current_input)
                        input_for_args = deep_clone(current_input)

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
                        for watch_fn in watches_list:
                            orig_method = getattr(instance, watch_fn, None)
                            if orig_method is not None and callable(orig_method):
                                def make_instance_ghost(orig, name, rec):
                                    @wraps(orig)
                                    def wrapper(*a, **kw):
                                        try:
                                            result = orig(*a, **kw)
                                            rec.append({'fn': name, 'args': deep_clone(a), 'result': deep_clone(result)})
                                            return result
                                        except Exception as err:
                                            rec.append({'fn': name, 'args': deep_clone(a), 'error': str(err)})
                                            raise
                                    return wrapper
                                setattr(instance, watch_fn, make_instance_ghost(orig_method, watch_fn, recorder))

                        # Snapshot object state BEFORE call (for trackState)
                        obj_state_before = None
                        if track_state_attrs and isinstance(input_for_args, dict) and 'self' in input_for_args:
                            obj_state_before = snapshot_state(
                                input_for_args['self'],
                                include_private=True,
                                attr_filter=track_state_attrs
                            )
                        elif track_state_attrs and hasattr(input_for_args, '__dict__'):
                            obj_state_before = snapshot_state(
                                input_for_args,
                                include_private=True,
                                attr_filter=track_state_attrs
                            )

                        # Run setup methods
                        for step in setup_steps:
                            setup_method = getattr(instance, step.get('method', ''), None)
                            if setup_method is None or not callable(setup_method):
                                raise TypeError(f"Setup method \"{step.get('method')}\" not found on instance")
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
                            raise TypeError(f"Method \"{class_method}\" not found on instance")

                        # Setup freeze_time context managers if needed
                        freeze_cms = []
                        if freeze_time_str:
                            dt_cm, time_cm = freeze_time(freeze_time_str)
                            freeze_cms = [dt_cm, time_cm]

                        # Execute target method, optionally with frozen time
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

                        # Materialize and transform output
                        output, was_materialized = materialize_output(raw_output, max_yields=max_yields) if materialize_output_flag else (raw_output, False)
                        if not materialize_output_flag:
                            output = consume_generator(output)
                        output_for_fp = apply_output_transform(deep_clone(output), output_transform)

                        last_output = output_for_fp

                        # Snapshot tracked attrs from the return object (for trackState)
                        live_return_state = None
                        if track_state_attrs and raw_output is not None and hasattr(raw_output, '__dict__'):
                            live_return_state = snapshot_state(
                                raw_output,
                                include_private=True,
                                attr_filter=track_state_attrs
                            )

                        if effective_fp_mode == 'schema':
                            schema = extract_schema(output_for_fp)
                            fp = fingerprint(input_for_fp, schema, norm_rules, ign_fields)
                        elif effective_fp_mode == 'mixed':
                            schema = extract_schema(output_for_fp)
                            selected_values = {}
                            for path in effective_value_paths:
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
                            fp = fingerprint(input_for_fp, combined, norm_rules, ign_fields)
                        elif fp_level == 'entry':
                            fp = fingerprint(input_for_fp, output_for_fp, norm_rules, ign_fields)
                        else:
                            fp = fingerprint_sequence(recorder, norm_rules, ign_fields)

                        hashes.append(fp)

                        # ── Restore RNG state after this input run ──────────────
                        if saved_rng is not None:
                            restore_rng(*saved_rng)

                        # Track per-input hashes for drift detection
                        input_key = json.dumps(current_input, sort_keys=True)
                        if input_key not in hashes_per_input:
                            hashes_per_input[input_key] = []
                        hashes_per_input[input_key].append(fp)
                else:
                    # ── Function-based entry (original behavior) ────────────
                    # Setup freeze_time context managers if needed
                    freeze_cms = []
                    if freeze_time_str:
                        dt_cm, time_cm = freeze_time(freeze_time_str)
                        freeze_cms = [dt_cm, time_cm]

                    ghost = create_ghost(mod, watches_list, recorder)

                    entry_fn = getattr(ghost, entry_name, None) or getattr(mod, entry_name, None)
                    if entry_fn is None or not callable(entry_fn):
                        raise TypeError(f"Entry \"{entry_name}\" not found in {module_path}")

                    for current_input in inputs_to_validate:
                        # Deep-clone input before calling to prevent mutation from corrupting fingerprint
                        input_for_fp = deep_clone(current_input)
                        input_for_args = deep_clone(current_input)

                        # ── Seed RNG if configured ────────────────────────────
                        saved_rng = None
                        if seed_value is not None:
                            saved_rng = seed_rng(seed_value)

                        # Apply input transform if specified (e.g., hex_to_bytes for bytes-argument functions)
                        if input_transform:
                            input_for_args = apply_input_transform(input_for_args, input_transform)

                        # Snapshot input state BEFORE call (for mutation tracking)
                        input_snapshot_before = None
                        if track_mutation:
                            input_snapshot_before = snapshot_state(input_for_args)

                        # Snapshot object state BEFORE call (for trackState)
                        obj_state_before = None
                        if track_state_attrs and isinstance(input_for_args, dict) and 'self' in input_for_args:
                            obj_state_before = snapshot_state(
                                input_for_args['self'],
                                include_private=True,
                                attr_filter=track_state_attrs
                            )
                        elif track_state_attrs and hasattr(input_for_args, '__dict__'):
                            obj_state_before = snapshot_state(
                                input_for_args,
                                include_private=True,
                                attr_filter=track_state_attrs
                            )

                        # Execute entry function, optionally with frozen time
                        def _run_entry():
                            if multi_args and isinstance(input_for_args, list):
                                return entry_fn(*input_for_args), input_for_fp
                            elif kwargs_mode and isinstance(input_for_args, dict):
                                return entry_fn(**input_for_args), input_for_fp
                            elif kwargs_mode and not isinstance(input_for_args, dict):
                                raise TypeError(
                                    f"kwargs=True but input is {type(input_for_args).__name__}, not dict. "
                                    f"When kwargs is enabled, each input must be a dict to unpack as **kwargs."
                                )
                            else:
                                return (entry_fn(input_for_args) if input_for_args is not None else entry_fn()), input_for_fp

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
                        output, was_materialized = materialize_output(raw_output, max_yields=max_yields) if materialize_output_flag else (raw_output, False)

                        # Consume generators/iterators into lists for fingerprinting (always-on fallback)
                        if not materialize_output_flag:
                            output = consume_generator(output)

                        # Apply output transform if specified
                        output_for_fp = apply_output_transform(deep_clone(output), output_transform)

                        # Snapshot input state AFTER call (for mutation tracking)
                        mutation_match = True
                        if track_mutation:
                            input_snapshot_after = snapshot_state(input_for_args)
                            # Check mutation fingerprint matches the golden
                            golden_mutation_fp = regret.get('mutationFingerprint')
                            live_mutation_fp = fingerprint(
                                input_snapshot_before, input_snapshot_after,
                                norm_rules, ign_fields
                            )
                            if golden_mutation_fp and live_mutation_fp != golden_mutation_fp:
                                mutation_match = False

                        last_output = output_for_fp

                        # Snapshot tracked attrs from the return object (for trackState)
                        live_return_state = None
                        if track_state_attrs and raw_output is not None and hasattr(raw_output, '__dict__'):
                            live_return_state = snapshot_state(
                                raw_output,
                                include_private=True,
                                attr_filter=track_state_attrs
                            )

                        if effective_fp_mode == 'schema':
                            schema = extract_schema(output_for_fp)
                            fp = fingerprint(fp_input, schema, norm_rules, ign_fields)
                        elif effective_fp_mode == 'mixed':
                            schema = extract_schema(output_for_fp)
                            selected_values = {}
                            for path in effective_value_paths:
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
                            fp = fingerprint(fp_input, combined, norm_rules, ign_fields)
                        elif fp_level == 'entry':
                            fp = fingerprint(fp_input, output_for_fp, norm_rules, ign_fields)
                        else:
                            fp = fingerprint_sequence(recorder, norm_rules, ign_fields)

                        hashes.append(fp)

                        # ── Restore RNG state after this input run ──────────────
                        if saved_rng is not None:
                            restore_rng(*saved_rng)

                        # Track per-input hashes for drift detection
                        input_key = json.dumps(current_input, sort_keys=True)
                        if input_key not in hashes_per_input:
                            hashes_per_input[input_key] = []
                        hashes_per_input[input_key].append(fp)

            live_hash = hashes[0]
            is_match = live_hash == regret.get('goldenHash')
            # Per-input drift detection: each input must produce the same hash across all runs.
            is_drift = drift_mode and any(
                len(set(input_hashes)) > 1
                for input_hashes in hashes_per_input.values()
            )

            # ── Modes validation ──────────────────────────────────────────────
            # If the .regret file has modes data, validate each mode's fingerprint
            modes_match = True
            modes_data = regret.get('modes_data', [])
            modes_fingerprint_stored = regret.get('modesFingerprint')

            if modes_data and cluster_def.get('modes'):
                live_mode_results = []
                for mode_def in cluster_def['modes']:
                    mode_name = mode_def.get('name', 'default')
                    mode_kwargs = mode_def.get('kwargs', {})
                    mode_inputs = mode_def.get('inputs', cluster_def.get('inputs', [None]))
                    effective_kwargs = mode_kwargs

                    # Find the golden mode data for comparison
                    golden_mode = next(
                        (m for m in modes_data if m.get('mode_name') == mode_name),
                        None
                    )

                    if not golden_mode:
                        print(f"  ⚠️  {cluster_id}: mode '{mode_name}' not found in .regret file")
                        modes_match = False
                        continue

                    mode_fps = []
                    for input_val in mode_inputs:
                        recorder_m = []
                        ghost_m = create_ghost(mod, regret.get('watches', cluster_def.get('watches', [])), recorder_m)
                        entry_fn_m = getattr(ghost_m, entry_name, None) or getattr(mod, entry_name, None)
                        input_for_args = deep_clone(input_val)
                        input_for_record = deep_clone(input_val)

                        if effective_kwargs and isinstance(input_for_args, dict):
                            merged_args = {**input_for_args, **effective_kwargs}
                            raw_output = entry_fn_m(**merged_args)
                            fp_input = deep_clone(merged_args)
                        elif effective_kwargs:
                            if multi_args and isinstance(input_for_args, list):
                                raw_output = entry_fn_m(*input_for_args, **effective_kwargs)
                            else:
                                raw_output = entry_fn_m(input_for_args, **effective_kwargs)
                            fp_input = input_for_record
                        else:
                            if multi_args and isinstance(input_for_args, list):
                                raw_output = entry_fn_m(*input_for_args)
                            else:
                                raw_output = entry_fn_m(input_for_args) if input_for_args is not None else entry_fn_m()
                            fp_input = input_for_record

                        output = consume_generator(raw_output)
                        output_for_fp = apply_output_transform(deep_clone(output), output_transform)

                        if effective_fp_mode == 'schema':
                            schema = extract_schema(output_for_fp)
                            fp = fingerprint(fp_input, schema, norm_rules, ign_fields)
                        elif effective_fp_mode == 'mixed':
                            schema = extract_schema(output_for_fp)
                            selected_values = {}
                            for path in effective_value_paths:
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
                            fp = fingerprint(fp_input, combined, norm_rules, ign_fields)
                        elif fp_level == 'entry':
                            fp = fingerprint(fp_input, output_for_fp, norm_rules, ign_fields)
                        else:
                            fp = fingerprint_sequence(recorder_m, norm_rules, ign_fields)

                        mode_fps.append(fp)

                    mode_fp = mode_fps[0] if mode_fps else ''
                    golden_mode_fp = golden_mode.get('fp', '')

                    if mode_fp != golden_mode_fp:
                        modes_match = False

                    live_mode_results.append({
                        'mode_name': mode_name,
                        'fp': mode_fp,
                    })

                # Validate combined modes fingerprint
                if live_mode_results and modes_fingerprint_stored:
                    live_modes_fp = fingerprint_modes(live_mode_results, norm_rules, ign_fields)
                    if live_modes_fp != modes_fingerprint_stored:
                        modes_match = False

            # Mutation mismatch is a separate failure condition
            if track_mutation and not mutation_match:
                if not json_output:
                    print(f"  ❌ {cluster_id:<35} MUTATION MISMATCH")
                results.append({'id': cluster_id, 'pass': False, 'mutation_mismatch': True, 'mutation_detected': True})
                continue

            # State mutation check (for trackState)
            state_match = True
            if track_state_attrs and obj_state_before is not None:
                obj_state_after = None
                if isinstance(input_for_args, dict) and 'self' in input_for_args:
                    obj_state_after = snapshot_state(
                        input_for_args['self'],
                        include_private=True,
                        attr_filter=track_state_attrs
                    )
                elif hasattr(input_for_args, '__dict__'):
                    obj_state_after = snapshot_state(
                        input_for_args,
                        include_private=True,
                        attr_filter=track_state_attrs
                    )
                if obj_state_after is not None:
                    live_state_fp = fingerprint(
                        obj_state_before, obj_state_after,
                        norm_rules, ign_fields
                    )
                    if golden_state_fp and live_state_fp != golden_state_fp:
                        state_match = False

            # Return object state check (for trackState on return values)
            return_state_match = True
            if track_state_attrs and golden_return_state is not None and live_return_state is not None:
                golden_return_fp = fingerprint(golden_return_state, norm_rules=norm_rules, ign_fields=ign_fields)
                live_return_fp = fingerprint(live_return_state, norm_rules=norm_rules, ign_fields=ign_fields)
                if golden_return_fp != live_return_fp:
                    return_state_match = False

            if not state_match:
                if not json_output:
                    print(f"  ❌ {cluster_id:<35} STATE MISMATCH")
                results.append({'id': cluster_id, 'pass': False, 'state_mismatch': True})
                continue

            if not return_state_match:
                if not json_output:
                    print(f"  ❌ {cluster_id:<35} RETURN STATE MISMATCH")
                results.append({'id': cluster_id, 'pass': False, 'return_state_mismatch': True})
                continue

            # Modes mismatch is a separate failure condition
            if modes_data and not modes_match:
                if not json_output:
                    print(f"  ❌ {cluster_id:<35} MODES MISMATCH")
                results.append({'id': cluster_id, 'pass': False, 'modes_mismatch': True})
                continue

            if update_mode:
                if is_match:
                    if not json_output:
                        print(f"  ℹ️  {cluster_id:<35} unchanged — no update needed")
                    results.append({'id': cluster_id, 'pass': True})
                else:
                    old_hash, new_hash = update_regret(
                        regret_path, regret, live_hash, last_output, cli['reason']
                    )
                    if not json_output:
                        print(f"  ✅ {cluster_id:<35} {old_hash} → {new_hash}  UPDATED")
                    results.append({'id': cluster_id, 'pass': True, 'updated': True})

            elif drift_mode:
                if is_drift:
                    if not json_output:
                        print(f"  ❌ {cluster_id:<35} DRIFT  [{' / '.join(hashes)}]")
                    results.append({'id': cluster_id, 'pass': False, 'drift': True})
                else:
                    if not json_output:
                        icon = '✅' if is_match else '❌'
                        print(f"  {icon} {cluster_id:<35} {live_hash}  × {effective_runs}  {'PASS+STABLE' if is_match else 'FAIL'}")
                    results.append({'id': cluster_id, 'pass': is_match})

            else:
                if not json_output:
                    icon = '✅' if is_match else '❌'
                    hash_str = regret.get('goldenHash', '') if is_match else f"{regret.get('goldenHash', '')} → {live_hash}"
                    print(f"  {icon} {cluster_id:<35} {hash_str:<22} {'PASS' if is_match else 'FAIL'}")
                results.append({
                    'id': cluster_id, 'pass': is_match,
                    'golden': regret.get('goldenHash'), 'live': live_hash
                })

        except Exception as err:
            if not json_output:
                print(f"  ❌ {cluster_id:<35} ERROR: {err}")
            results.append({'id': cluster_id, 'pass': False, 'error': str(err)})
        finally:
            # Restore global state even if validation failed
            if saved_globals:
                restore_module_globals(saved_globals)

        if results and not results[-1]['pass'] and cli['fail_fast']:
            if not json_output:
                print("\n  --fail-fast: stopping.")
            break

    # ─── Summary ──────────────────────────────────────────────────────────────

    passed = sum(1 for r in results if r['pass'])
    failed = sum(1 for r in results if not r['pass'])
    drifted = sum(1 for r in results if r.get('drift'))

    if json_output:
        # JSON output mode — match JS validate.js --json format
        json_clusters = []
        for r in results:
            if r.get('skipped'):
                continue
            if r['pass']:
                if r.get('drift'):
                    status = 'drift'
                elif r.get('updated'):
                    status = 'pass'
                else:
                    status = 'pass'
            else:
                if r.get('mutation_mismatch'):
                    status = 'mutation_mismatch'
                elif r.get('state_mismatch'):
                    status = 'state_mismatch'
                elif r.get('return_state_mismatch'):
                    status = 'return_state_mismatch'
                elif r.get('modes_mismatch'):
                    status = 'modes_mismatch'
                elif r.get('error'):
                    status = 'error'
                elif r.get('drift'):
                    status = 'drift'
                else:
                    status = 'fail'
            entry = {
                'id': r['id'],
                'status': status,
            }
            if r.get('golden') or r.get('live'):
                entry['expected'] = r.get('golden')
                entry['actual'] = r.get('live')
            if r.get('error'):
                entry['error'] = r['error']
            if r.get('drift'):
                entry['drift'] = True
            if r.get('updated'):
                entry['updated'] = True
            if r.get('mutation_mismatch'):
                entry['mutationMismatch'] = True
                entry['mutationDetected'] = r.get('mutation_detected', True)
            json_clusters.append(entry)

        json_result = {
            'passed': passed,
            'failed': failed,
            'clusters': json_clusters,
        }
        print(json.dumps(json_result, separators=(',', ':')))

        if update_mode:
            sys.exit(0)
        if drift_mode and drifted > 0:
            sys.exit(1)
        sys.exit(0 if failed == 0 else 1)

    print(f"\n{'─' * 60}")

    if update_mode:
        updated = sum(1 for r in results if r.get('updated'))
        print(f"✅ Update complete. {updated} updated.\n   Audit: regrets/audit.log")
        sys.exit(0)

    if drift_mode and drifted > 0:
        print(f"❌ Drift in {drifted} cluster(s). Add normalize rules and re-capture.")
        sys.exit(1)

    if failed == 0:
        print(f"✅ All {passed} tests passed{' (' + str(cli['runs']) + ' runs — stable)' if drift_mode else ''}. Refactor is safe.\n")
        sys.exit(0)

    print(f"❌ {failed}/{len(results)} FAILED.\n")
    for r in results:
        if not r['pass']:
            print(f"  • {r['id']}")
            if r.get('error'):
                print(f"    {r['error']}")
            elif r.get('golden'):
                print(f"    Expected: {r['golden']}  Got: {r['live']}")
    print("\nFix the CODE — do not edit .regret files.")
    print("Re-run: python scripts/validate.py")
    sys.exit(1)


if __name__ == '__main__':
    main()

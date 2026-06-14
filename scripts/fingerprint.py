#!/usr/bin/env python3
# fingerprint.py — deterministic hash for regression contracts
# IDENTICAL algorithm to fingerprint.js. Same input must produce same 7-char hash.
#
# Shared module — imported by capture.py and validate.py.
# Do NOT duplicate these functions. Import them: from fingerprint import fingerprint, ...

import hashlib
import json
import re
import time as time_module
from datetime import datetime, date, time, timedelta, timezone


def _numpy_to_native(obj):
    """Convert numpy types to native Python types for JSON serialization.

    Handles: ndarray -> list, numpy scalars (int64, float64, etc.) -> Python int/float,
    numpy bool_ -> Python bool, numpy complexfloating -> Python complex.
    This is a no-op if numpy is not installed.
    """
    try:
        import numpy as np
        if isinstance(obj, np.ndarray):
            return _numpy_to_native(obj.tolist())
        if isinstance(obj, np.integer):
            return int(obj)
        if isinstance(obj, np.floating):
            return float(obj)
        if isinstance(obj, np.complexfloating):
            return complex(obj)
        if isinstance(obj, np.bool_):
            return bool(obj)
        if isinstance(obj, (list, tuple)):
            return [_numpy_to_native(v) for v in obj]
        if isinstance(obj, dict):
            return {k: _numpy_to_native(v) for k, v in obj.items()}
    except ImportError:
        pass
    return obj


def stable_dumps(obj):
    """Stable JSON serialization — keys sorted recursively (mirrors JS stableStringify).

    Handles numpy arrays and scalars by converting to native Python types first.
    Also handles Python complex numbers by converting to {__complex__: true, real: ..., imag: ...}.
    """
    obj = _numpy_to_native(obj)
    # Convert any remaining complex numbers to JSON-safe dicts
    obj = _complex_to_json(obj)
    return json.dumps(obj, sort_keys=True, separators=(',', ':'), ensure_ascii=False)


def _complex_to_json(obj):
    """Recursively convert Python complex numbers to JSON-serializable dicts.

    This is needed because json.dumps() cannot serialize complex numbers.
    Complex numbers are converted to {"__complex__": true, "real": ..., "imag": ...}.
    """
    if isinstance(obj, complex):
        return {'__complex__': True, 'real': obj.real, 'imag': obj.imag}
    if isinstance(obj, list):
        return [_complex_to_json(v) for v in obj]
    if isinstance(obj, dict):
        return {k: _complex_to_json(v) for k, v in obj.items()}
    if isinstance(obj, tuple):
        return [_complex_to_json(v) for v in obj]
    return obj


def normalize(obj, rules=None):
    """Normalize non-deterministic values before hashing.

    Rules match the JS implementation in fingerprint.js:
    - timestamps: ISO 8601 datetime strings -> <TIMESTAMP>
    - uuids: UUID v4 format -> <UUID>
    - absPaths: Absolute file paths -> <ROOT>/...
    - dynamicDates: Embedded MMYYYY/YYYY in strings -> <MMYYYY>/<YYYY>
    - epochs: Unix epoch numbers (1B-10T) -> <EPOCH>
    - floatTolerance: Round floats to N decimal places (default 2)
    - floatPrecision: Normalize whole-value floats to int, decimal floats to 2dp,
      strip trailing ".0" from string-encoded floats (OCR/parsing pipelines)
    - datetimeNow: Replace datetime-like dicts (from _serialize_datetime) that
      contain a date matching today's date with <DATETIME_NOW>.
    - currentYearBound: Integers equal to current year or current year + 1
      -> <CURRENT_YEAR> / <CURRENT_YEAR+1>. Prevents drift in code that uses
      date.today().year for validation bounds (e.g., citation year validators).
    - tokenOffsets: Integers in dict keys "start", "end", "span_start", "span_end",
      "full_span_start", "full_span_end", "pin_cite_span_start", "pin_cite_span_end"
      -> <OFFSET>. Prevents brittleness when character offsets shift with input changes.

    Handles numpy arrays by converting to list before normalizing.
    """
    if rules is None:
        rules = []

    # Handle numpy arrays — convert to list before recursing
    try:
        import numpy as np
        if isinstance(obj, np.ndarray):
            return normalize(obj.tolist(), rules)
        if isinstance(obj, (np.integer, np.floating)):
            obj = obj.item()  # Convert numpy scalar to Python native
    except ImportError:
        pass

    # datetimeNow: replace serialized datetime dicts that represent "now"
    # This handles the common pattern where functions default to datetime.now()
    # (e.g. dateutil.parser.parse, dateutil.rrule.rrule).
    if 'datetimeNow' in rules and isinstance(obj, dict):
        if '__datetime__' in obj:
            dt_iso = obj['__datetime__']
            today_iso = datetime.now().strftime('%Y-%m-%d')
            if dt_iso.startswith(today_iso):
                return {'__datetime__': '<DATETIME_NOW>', 'fold': obj.get('fold', 0)}

    if isinstance(obj, str):
        if 'timestamps' in rules and re.match(r'^\d{4}-\d{2}-\d{2}T[\d:.Z+\-]+$', obj):
            return '<TIMESTAMP>'
        if 'uuids' in rules and re.match(
            r'^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$', obj, re.I
        ):
            return '<UUID>'
        if 'absPaths' in rules and obj.startswith('/'):
            parts = obj.split('/')
            if len(parts) >= 3:
                return '<ROOT>/' + '/'.join(parts[3:])
        if 'dynamicDates' in rules:
            # Narrowed: MMYYYY requires valid month (01-12), YYYY only matches standalone years
            result = re.sub(r'(0[1-9]|1[0-2])\d{4}', '<MMYYYY>', obj)
            result = re.sub(r'(?<!\d)(20\d{2}|19\d{2})(?!\d)', '<YYYY>', result)
            return result
        # normalizeNow: replace current-date-derived strings in output with placeholders.
        # For functions that call new Date()/datetime.now() internally and produce date-based output
        # (e.g., filenameFallback generating "FPK-062026" from current month).
        # Replaces MMYYYY patterns AND standalone YYYY patterns — same as dynamicDates
        # but also handles the common case where the ENTIRE output is a date-derived string.
        # This is semantically different from dynamicDates (which is for embedded dates in
        # larger strings): normalizeNow signals "this function's output IS a current-time value".
        if 'normalizeNow' in rules:
            result = re.sub(r'(0[1-9]|1[0-2])\d{4}', '<NOW_MMYYYY>', obj)
            result = re.sub(r'(?<!\d)(20\d{2}|19\d{2})(?!\d)', '<NOW_YYYY>', result)
            return result
        # floatPrecision: normalize float-like strings that differ only in trailing zeros
        # Common in OCR output where "1500000.0" and "1500000" should be equivalent.
        # Strips trailing ".0" from number-like strings (including negative).
        if 'floatPrecision' in rules:
            return re.sub(r'^-?(\d+)\.0+$', r'\1', obj)
        # incrementingIds: normalize auto-incrementing or unique IDs that change across runs.
        # Handles patterns from lodash/uniqueId ("rjsf-array-item-1"), nanoid, React.useId.
        # Replaces strings matching <prefix><digits> or pure hex/alnum IDs with <ID>.
        # This is essential for React component libraries that use uniqueId for keys,
        # where the internal counter never resets between runs.
        if 'incrementingIds' in rules:
            # Pattern 1: prefix + incrementing number (lodash/uniqueId style)
            m = re.match(r'^(.+[-_:])(\d+)$', obj)
            if m:
                return m.group(1) + '<ID>'
            # Pattern 2: pure numeric ID (e.g., "42")
            if re.match(r'^\d+$', obj) and len(obj) <= 10:
                return '<ID>'
            # Pattern 3: React useId format ":r0:", ":r1:", ":rs0:", ":rs1:"
            if re.match(r'^:r[s]?\d+:$', obj):
                return '<ID>'
            # Pattern 4: UUID-like hex strings without dashes (nanoid short, etc.)
            if re.match(r'^[A-Za-z0-9_-]{8,30}$', obj) and not re.match(r'^(true|false|null|undefined|NaN|Infinity)$', obj):
                # Heuristic: if it looks like a random ID (has both letters and digits)
                if re.search(r'[A-Za-z]', obj) and re.search(r'\d', obj):
                    return '<ID>'
        return obj

    # Handle Python complex numbers (common in DSP/SDR libraries like mhostetter/sdr)
    if isinstance(obj, complex):
        ft_rule = next((r for r in rules if r.startswith('floatTolerance')), None)
        if ft_rule:
            decimals = int(ft_rule.split(':')[1]) if ':' in ft_rule else 2
            factor = 10 ** decimals
            return complex(round(obj.real * factor) / factor, round(obj.imag * factor) / factor)
        if 'floatPrecision' in rules:
            real = int(obj.real) if obj.real == int(obj.real) else round(obj.real, 2)
            imag = int(obj.imag) if obj.imag == int(obj.imag) else round(obj.imag, 2)
            return complex(real, imag)
        return obj

    # numpySummary: replace large numpy arrays with a statistical summary.
    # For arrays with >16 elements, replace with {shape, dtype, min, max, mean, sum}.
    # This prevents massive JSON blobs in .regret files while preserving enough
    # information to detect behavioral changes in geometric/scientific code.
    # Usage: "numpySummary" (default threshold 16) or "numpySummary:100" for custom threshold.
    if 'numpySummary' in rules:
        try:
            import numpy as np
            if isinstance(obj, np.ndarray):
                ns_rule = next((r for r in rules if r.startswith('numpySummary')), 'numpySummary')
                threshold = int(ns_rule.split(':')[1]) if ':' in ns_rule else 16
                if obj.size > threshold:
                    summary = {
                        '__numpy_summary__': True,
                        'shape': list(obj.shape),
                        'dtype': str(obj.dtype),
                    }
                    if np.issubdtype(obj.dtype, np.number):
                        summary['min'] = float(np.nanmin(obj))
                        summary['max'] = float(np.nanmax(obj))
                        summary['mean'] = float(np.nanmean(obj))
                        summary['sum'] = float(np.nansum(obj))
                    elif np.issubdtype(obj.dtype, np.bool_):
                        summary['true_count'] = int(np.sum(obj))
                        summary['false_count'] = int(obj.size - np.sum(obj))
                    return summary
                # Small arrays: convert to list for normal fingerprinting
                return normalize(obj.tolist(), rules)
        except ImportError:
            pass

    if isinstance(obj, (int, float)):
        if 'epochs' in rules and 1_000_000_000 < obj < 9_999_999_999_999:
            return '<EPOCH>'
        # currentYearBound: replace integers that match the current year or current year + 1
        # This prevents fingerprint drift in code that uses date.today().year for
        # validation bounds (e.g., "_highest_valid_year = date.today().year + 1" in
        # citation year validators). These year bounds change every January, causing
        # drift detection that is NOT a real regression — it's just the calendar advancing.
        if 'currentYearBound' in rules and isinstance(obj, int):
            from datetime import date as _date
            this_year = _date.today().year
            if obj == this_year:
                return '<CURRENT_YEAR>'
            if obj == this_year + 1:
                return '<CURRENT_YEAR+1>'
        # floatTolerance: round floating-point numbers to N decimal places before hashing.
        # Prevents false negatives from tiny floating-point representation differences
        # (e.g., 123456.0 vs 123456.00000001 in financial/scientific computing).
        # Usage: "floatTolerance" (default 2 decimal places) or "floatTolerance:N" for N places.
        ft_rule = next((r for r in rules if r.startswith('floatTolerance')), None)
        if ft_rule:
            decimals = int(ft_rule.split(':')[1]) if ':' in ft_rule else 2
            factor = 10 ** decimals
            return round(obj * factor) / factor
        # floatPrecision: normalize numbers that are whole but stored as float
        # e.g., 1500000.0 → 1500000 (common in OCR/parsing pipelines)
        if 'floatPrecision' in rules and isinstance(obj, float) and obj == int(obj):
            return int(obj)
        if 'floatPrecision' in rules and isinstance(obj, float) and obj != int(obj):
            # Round to 2 decimal places to normalize precision differences
            return round(obj, 2)
        return obj

    if isinstance(obj, list):
        return [normalize(v, rules) for v in obj]

    if isinstance(obj, dict):
        # tokenOffsets: normalize character offset values in known offset keys.
        # When fingerprinting NLP/citation parsing output, character offsets (start, end,
        # span_start, etc.) are absolute positions that shift with ANY change to input
        # text length. They don't represent behavioral contracts — the contract is that
        # the correct text is identified, not that it's at byte offset 42 vs 44.
        # This rule replaces offset values with <OFFSET> to prevent false negatives
        # when the same logical parsing happens at different character positions.
        if 'tokenOffsets' in rules:
            offset_keys = {
                'start', 'end', 'span_start', 'span_end',
                'full_span_start', 'full_span_end',
                'pin_cite_span_start', 'pin_cite_span_end',
            }
            return {
                k: ('<OFFSET>' if k in offset_keys and isinstance(v, int) else normalize(v, rules))
                for k, v in obj.items()
            }
        return {k: normalize(v, rules) for k, v in obj.items()}

    return obj


def strip_fields(obj, fields=None):
    """Strip ignored fields from output before hashing. Handles numpy arrays."""
    if fields is None:
        fields = []
    if not fields:
        # Still need to convert numpy arrays to native types even if no fields to strip
        return _numpy_to_native(obj) if obj is not None else obj

    # Handle numpy arrays — convert to list before stripping
    try:
        import numpy as np
        if isinstance(obj, np.ndarray):
            return strip_fields(obj.tolist(), fields)
    except ImportError:
        pass

    if isinstance(obj, list):
        return [strip_fields(v, fields) for v in obj]

    if isinstance(obj, dict):
        return {
            k: strip_fields(v, fields)
            for k, v in obj.items()
            if k not in fields
        }

    return obj


def to_base36(n):
    """Convert integer to base36 string (mirrors JS BigInt.toString(36))."""
    chars = '0123456789abcdefghijklmnopqrstuvwxyz'
    if n == 0:
        return '0'
    result = ''
    while n:
        result = chars[n % 36] + result
        n //= 36
    return result


def _struct_time_to_list(val):
    """Convert time.struct_time to a deterministic JSON-serializable list.

    struct_time is a named tuple with 9 fields: tm_year, tm_mon, tm_mday,
    tm_hour, tm_min, tm_sec, tm_wday, tm_yday, tm_isdst.

    We convert it to [year, mon, mday, hour, min, sec, wday, yday, isdst]
    which is deterministic and JSON-serializable.
    """
    return [val.tm_year, val.tm_mon, val.tm_mday,
            val.tm_hour, val.tm_min, val.tm_sec,
            val.tm_wday, val.tm_yday, val.tm_isdst]


def _serialize_datetime(val):
    """Serialize datetime/date/time/timedelta to a deterministic JSON-safe dict.

    This is critical for libraries that return datetime objects (e.g. python-dateutil,
    arrow, pendulum). Without this, deep_clone falls back to repr() which is lossy
    and inconsistent across Python versions.

    Serialization format:
    - datetime: {"__datetime__": isoformat, "fold": int, "tzname": str|None}
    - date: {"__date__": isoformat}
    - time: {"__time__": isoformat, "fold": int, "tzinfo": str|None}
    - timedelta: {"__timedelta__": total_seconds}
    """
    if isinstance(val, datetime):
        result = {
            "__datetime__": val.isoformat(),
            "fold": val.fold,
        }
        if val.tzinfo is not None:
            tzname = getattr(val.tzinfo, 'tzname', None)
            if callable(tzname):
                try:
                    result["tzname"] = tzname(val)
                except Exception:
                    result["tzname"] = repr(val.tzinfo)
            else:
                result["tzname"] = repr(val.tzinfo)
            utcoff = getattr(val.tzinfo, 'utcoffset', None)
            if callable(utcoff):
                try:
                    offset = utcoff(val)
                    result["utcoffset"] = offset.total_seconds() if offset is not None else None
                except Exception:
                    pass
        return result
    if isinstance(val, date):
        return {"__date__": val.isoformat()}
    if isinstance(val, time):
        result = {
            "__time__": val.isoformat(),
            "fold": val.fold,
        }
        if val.tzinfo is not None:
            result["tzinfo"] = repr(val.tzinfo)
        return result
    if isinstance(val, timedelta):
        return {"__timedelta__": val.total_seconds()}
    return None



def deep_clone(val):
    """Deep clone via JSON round-trip. Handles numpy arrays by converting to native types.

    Enhanced to handle non-JSON-serializable types that commonly appear in class-heavy
    libraries (e.g. bytes, tuples with bytes, class instances with get_val_d()):
    - time.struct_time → list [year, mon, mday, hour, min, sec, wday, yday, isdst]
    - datetime/date/time/timedelta → deterministic dict snapshot
    - bytes → hex string (deterministic, recoverable)
    - tuple → list (JSON-safe, preserves order)
    - class instances with get_val_d() → dict snapshot
    - class instances with to_dict() → dict snapshot
    - class instances with _asdict() → dict snapshot (namedtuples)
    - other non-serializable → repr() string (lossy but deterministic)

    This prevents the silent fallthrough where deep_clone returns the SAME object reference
    instead of an actual clone, which causes mutation corruption in the ghost recorder.
    """
    val = _numpy_to_native(val)
    # Handle datetime/date/time/timedelta → deterministic JSON-safe dict
    dt_result = _serialize_datetime(val)
    if dt_result is not None:
        return dt_result
    # Handle time.struct_time → deterministic list
    if isinstance(val, time_module.struct_time):
        return _struct_time_to_list(val)
    # Handle complex numbers → dict with real/imag (JSON-safe, deterministic)
    # This is critical for DSP/SDR libraries where numpy complex128 arrays are common
    if isinstance(val, complex):
        return {'__complex__': True, 'real': val.real, 'imag': val.imag}
    # Handle bytes → hex string (deterministic, recoverable)
    if isinstance(val, bytes):
        return val.hex()
    # Handle tuples → list (JSON-safe, preserves order)
    if isinstance(val, tuple):
        return [deep_clone(v) for v in val]
    # Handle lists — recurse to catch nested bytes/tuples/instances
    if isinstance(val, list):
        return [deep_clone(v) for v in val]
    # Handle dicts — recurse to catch nested bytes/tuples/instances
    if isinstance(val, dict):
        return {k: deep_clone(v) for k, v in val.items()}
    # Handle class instances with get_val_d() (e.g. pycrate Envelope)
    if hasattr(val, 'get_val_d') and callable(val.get_val_d):
        try:
            return deep_clone(val.get_val_d())
        except Exception:
            pass
    # Handle namedtuples and other classes with _asdict()
    if hasattr(val, '_asdict') and callable(val._asdict):
        try:
            return deep_clone(val._asdict())
        except Exception:
            pass
    # Handle class instances with to_dict() (e.g. many Python data classes)
    if hasattr(val, 'to_dict') and callable(val.to_dict):
        try:
            return deep_clone(val.to_dict())
        except Exception:
            pass
    # Handle arbitrary class instances via __dict__ attribute snapshot
    # This captures the data fields of objects that don't implement to_dict()
    # or get_val_d(). The type name is included so that two different classes
    # with the same attribute values produce different fingerprints.
    # Example: musicpy.note(name='C', num=4) → {"__type__": "note", "base_name": "C", ...}
    if hasattr(val, '__dict__') and not isinstance(val, type):
        try:
            snapshot = {'__type__': type(val).__name__}
            for k, v in vars(val).items():
                try:
                    snapshot[k] = deep_clone(v)
                except Exception:
                    snapshot[k] = f'<unrepresentable:{type(v).__name__}>'
            return snapshot
        except Exception:
            pass
    # Handle class instances with __slots__ (no __dict__) — use slot-based scan
    # Also handles objects with __slots__ that ARE types (e.g. pdtContext)
    if hasattr(val, '__slots__'):
        try:
            snapshot = {'__type__': type(val).__name__}
            for slot in val.__slots__:
                try:
                    if hasattr(val, slot):
                        snapshot[slot] = deep_clone(getattr(val, slot))
                except AttributeError:
                    pass
            return snapshot
        except Exception:
            pass
    # Primitives: return as-is
    if isinstance(val, (int, float, str, bool)) or val is None:
        return val
    # Attempt JSON round-trip for other types
    try:
        return json.loads(json.dumps(val))
    except (TypeError, ValueError):
        # Fallback: repr() string (lossy but deterministic — at least it won't
        # return the same reference, preventing mutation corruption)
        return repr(val)


def materialize_output(val, max_yields=None):
    """Materialize generator/iterator output into a list for fingerprinting.

    When a function returns a generator, iterator, or other lazy sequence,
    it cannot be JSON-serialized or fingerprinted directly. This function
    detects lazy types and consumes them into a concrete list.

    Handles:
    - Generators (generator type)
    - Iterators (has __next__ but is not str/bytes/dict/list)
    - Custom iterables (has __iter__ but is not a concrete type) — e.g. rrule objects
    - map/filter objects
    - range objects

    Args:
        val: The value to potentially materialize.
        max_yields: If set, only consume up to this many items.
            Critical for infinite generators (e.g., rrule with no count/until).
            materializeLimit is an alias for maxYields in manifest config.

    Args:
        val: The value to potentially materialize.
        max_yields: If set, only consume up to this many items from the generator.
            This is critical for infinite generators (e.g., rrule with no count/until)
            where list() would hang. When max_yields is set and the generator has
            more items, a trailing sentinel {"__truncated__": true, "maxYields": N}
            is appended to signal that output was bounded.

    Returns a tuple: (materialized_value, was_materialized_bool)
    """
    # Primitives and already-concrete types — no materialization needed
    if val is None or isinstance(val, (bool, int, float, str, bytes, dict, list, tuple, set)):
        return val, False

    # numpy arrays — handled by _numpy_to_native, not materialization
    try:
        import numpy as np
        if isinstance(val, np.ndarray):
            return val, False
    except ImportError:
        pass

    # Detect lazy/iterable types that should be materialized
    import types as _types
    is_generator = isinstance(val, _types.GeneratorType)
    is_map_filter = isinstance(val, (map, filter))
    is_range = isinstance(val, range)
    is_iterator = hasattr(val, '__next__') and not isinstance(val, (str, bytes, dict))
    # Custom iterables: has __iter__ but may or may not have __len__
    # This catches rrule objects, custom iterator classes, etc.
    has_iter = hasattr(val, '__iter__')
    is_concrete = isinstance(val, (list, tuple, set, dict, str, bytes))
    is_custom_iterable = has_iter and not is_concrete

    if is_generator or is_map_filter or is_range or is_iterator or is_custom_iterable:
        try:
            if max_yields is not None and isinstance(max_yields, int) and max_yields > 0:
                # Bounded materialization: take only max_yields items
                result = []
                for i, item in enumerate(val):
                    if i >= max_yields:
                        result.append({"__truncated__": True, "maxYields": max_yields})
                        break
                    result.append(item)
                return result, True
            else:
                return list(val), True
        except Exception:
            # If materialization fails, return as-is
            return val, False

    return val, False


def snapshot_state(obj, include_private=False, attr_filter=None):
    """Create a JSON-serializable snapshot of an object's state.

    Used by trackMutation to capture input state before and after
    a function call, so mutations can be detected.

    Also used by trackState to capture object attribute state
    across method calls.

    Handles:
    - JSON-serializable types (dict, list, str, numbers)
    - Objects with __dict__ (captures instance attributes)
    - Objects with __slots__ (captures slot values)
    - Nested objects (recurses)

    Args:
        obj: The object to snapshot.
        include_private: If True, include attributes starting with '_'.
            This is needed for trackState which monitors internal state
            like _len, _cache, etc.
        attr_filter: Optional list of attribute names to include.
            When set, only these attributes are captured (useful for
            trackState which specifies exactly which attributes to watch).

    Returns a JSON-serializable dict/list/value.
    """
    if obj is None or isinstance(obj, (bool, int, float, str)):
        return obj

    if isinstance(obj, (list, tuple)):
        return [snapshot_state(v, include_private, attr_filter) for v in obj]

    if isinstance(obj, dict):
        return {k: snapshot_state(v, include_private, attr_filter) for k, v in obj.items()}

    if isinstance(obj, set):
        return sorted([snapshot_state(v, include_private, attr_filter) for v in obj], key=lambda x: str(x))

    if isinstance(obj, bytes):
        return obj.decode('utf-8', errors='replace')

    # Object with __dict__ (most class instances)
    if hasattr(obj, '__dict__'):
        cls_name = type(obj).__name__
        attrs = {}
        for k, v in obj.__dict__.items():
            # Apply attr_filter if specified
            if attr_filter is not None:
                if k not in attr_filter:
                    continue
            elif not include_private and k.startswith('_'):
                # skip private attrs by default
                continue
            try:
                attrs[k] = snapshot_state(v, include_private, attr_filter)
            except Exception:
                attrs[k] = f'<unrepresentable:{type(v).__name__}>'
        return {'__class__': cls_name, **attrs}

    # Object with __slots__
    if hasattr(obj, '__slots__'):
        cls_name = type(obj).__name__
        attrs = {}
        for slot in obj.__slots__:
            if attr_filter is not None and slot not in attr_filter:
                continue
            try:
                attrs[slot] = snapshot_state(getattr(obj, slot), include_private, attr_filter)
            except AttributeError:
                pass
        return {'__class__': cls_name, **attrs}

    # Fallback: try JSON serialization
    try:
        return json.loads(json.dumps(obj))
    except (TypeError, ValueError):
        return f'<unrepresentable:{type(obj).__name__}>'


def fingerprint(input_data, output_data, rules=None, ignore_fields=None):
    """
    Core fingerprint function — IDENTICAL algorithm to fingerprint.js:
    stableStringify(input) + '|' + stableStringify(output) -> sha256 -> base36 -> first 7 chars

    Cross-stack consistency verified:
    - JS:     BigInt('0x' + sha256_hex).toString(36).slice(0, 7)
    - Python: to_base36(int(sha256_hex, 16))[:7]
    - Must produce same result for same input/output pair
    """
    if rules is None:
        rules = []
    if ignore_fields is None:
        ignore_fields = []

    clean_input = strip_fields(normalize(deep_clone(input_data), rules), ignore_fields)
    clean_output = strip_fields(normalize(deep_clone(output_data), rules), ignore_fields)

    combined = stable_dumps(clean_input) + '|' + stable_dumps(clean_output)
    hash_hex = hashlib.sha256(combined.encode('utf-8')).hexdigest()

    big_num = int(hash_hex, 16)
    return to_base36(big_num)[:7]


def fingerprint_sequence(calls, rules=None, ignore_fields=None):
    """Fingerprint an entire call sequence (for fingerprintLevel: 'full' or 'watched')."""
    if rules is None:
        rules = []
    if ignore_fields is None:
        ignore_fields = []

    normalized = []
    for call in calls:
        normalized.append({
            'fn': call['fn'],
            'args': strip_fields(normalize(deep_clone(call['args']), rules), ignore_fields),
            'result': strip_fields(normalize(deep_clone(call['result']), rules), ignore_fields),
        })

    combined = stable_dumps(normalized)
    hash_hex = hashlib.sha256(combined.encode('utf-8')).hexdigest()
    big_num = int(hash_hex, 16)
    return to_base36(big_num)[:7]


def extract_schema(obj):
    """Extract structural schema from a JSON value.

    All values replaced with their type name for structural fingerprinting.
    Used by fingerprintMode: "schema" and "mixed".

    For arrays with mixed types, each unique schema is captured
    (up to 5 elements to avoid infinite schemas).

    Handles numpy arrays by converting to list first.

    Cross-stack consistent with fingerprint.js extractSchema().
    """
    # Handle numpy arrays — convert to list before extracting schema
    try:
        import numpy as np
        if isinstance(obj, np.ndarray):
            return extract_schema(obj.tolist())
        if isinstance(obj, (np.integer, np.floating)):
            return extract_schema(obj.item())
    except ImportError:
        pass

    if obj is None:
        return 'null'
    if isinstance(obj, list):
        if len(obj) == 0:
            return 'array'
        # Sample up to 5 elements to detect mixed-type arrays
        sample_size = min(len(obj), 5)
        schemas = []
        seen = set()
        for i in range(sample_size):
            s = extract_schema(obj[i])
            key = json.dumps(s, sort_keys=True)
            if key not in seen:
                seen.add(key)
                schemas.append(s)
        # If all elements share the same schema, return single-element list
        if len(schemas) == 1:
            return [schemas[0]]
        # Mixed types — return list of unique schemas
        return schemas
    if isinstance(obj, dict):
        keys = sorted(obj.keys())
        schema = {}
        for k in keys:
            schema[k] = extract_schema(obj[k])
        return schema
    return type(obj).__name__  # "str", "int", "float", "bool"


def snapshot_output(val, transform=None):
    """Transform output before fingerprinting, enabling class-heavy libraries.

    This function applies a named transform to the output value before it enters
    the fingerprint pipeline. It solves the problem of class instances that have
    meaningful internal state but are not JSON-serializable.

    Supported transforms:
    - None: pass through (use deep_clone as before)
    - 'get_val_d': call val.get_val_d() if available (e.g. pycrate Envelope)
    - 'to_dict': call val.to_dict() if available (e.g. dataclasses, pydantic)
    - 'to_bytes': call val.to_bytes() if available (e.g. pycrate Element)
    - 'repr': use repr(val) as the fingerprinted value
    - 'hex': convert bytes to hex string
    - callable: call transform(val) and use the result

    For tuples and lists, each element is transformed independently.
    """
    if transform is None:
        return deep_clone(val)

    # If transform is a callable (but not a string), call it directly
    if callable(transform) and not isinstance(transform, str):
        return deep_clone(transform(val))

    # Handle tuples and lists — transform each element
    if isinstance(val, tuple):
        return [snapshot_output(v, transform) for v in val]
    if isinstance(val, list):
        return [snapshot_output(v, transform) for v in val]

    # Named transforms
    if transform == 'get_val_d':
        if hasattr(val, 'get_val_d') and callable(val.get_val_d):
            return deep_clone(val.get_val_d())
        return deep_clone(val)
    elif transform == 'to_dict':
        if hasattr(val, 'to_dict') and callable(val.to_dict):
            return deep_clone(val.to_dict())
        return deep_clone(val)
    elif transform == 'to_bytes':
        if hasattr(val, 'to_bytes') and callable(val.to_bytes):
            return deep_clone(val.to_bytes())
        return deep_clone(val)
    elif transform == 'repr':
        return repr(val)
    elif transform == 'hex':
        if isinstance(val, bytes):
            return val.hex()
        return deep_clone(val)
    else:
        # Unknown transform — fall back to deep_clone
        return deep_clone(val)


def fingerprint_modes(mode_results, rules=None, ignore_fields=None):
    """Fingerprint multiple behavioral modes of a single function.

    Each mode result is a dict with 'mode_name', 'input', 'output', and 'fp' keys.
    The combined fingerprint ensures that ALL modes produce the same output
    after refactoring — if any mode changes, the combined hash changes.

    This is critical for functions with behavioral modes (e.g., method='equinox'
    vs method='romme' in calendar libraries, or eve=True vs eve=False in
    holiday calculations). Without modes, an agent would have to create separate
    clusters for each mode, which is verbose and doesn't express the relationship.

    The fingerprint is computed by:
    1. Sorting modes by name (deterministic ordering)
    2. Concatenating mode_name:fingerprint pairs
    3. Hashing the combined string

    Args:
        mode_results: List of dicts, each with 'mode_name', 'input', 'output', 'fp'
        rules: Normalization rules (same as fingerprint())
        ignore_fields: Fields to ignore (same as fingerprint())

    Returns:
        str: 7-char base36 hash representing all modes combined
    """
    if rules is None:
        rules = []
    if ignore_fields is None:
        ignore_fields = []

    # Sort by mode name for deterministic ordering
    sorted_results = sorted(mode_results, key=lambda x: x.get('mode_name', ''))

    # Combine mode name + fingerprint for each mode
    combined_parts = []
    for r in sorted_results:
        mode_name = r.get('mode_name', 'default')
        mode_fp = r.get('fp', '')
        combined_parts.append(f"{mode_name}:{mode_fp}")

    combined = '|'.join(combined_parts)
    hash_hex = hashlib.sha256(combined.encode('utf-8')).hexdigest()
    big_num = int(hash_hex, 16)
    return to_base36(big_num)[:7]


def get_env_snapshot():
    """Capture a snapshot of the current Python environment for reproducibility.

    Records key environment facts that could affect fingerprint stability:
    - Python version
    - Installed packages (with versions) for known-affecting packages
    - Module-level state keys for registered modules

    This snapshot is stored in the .regret file and compared during validation
    to detect environment drift before running functions.
    """
    import sys
    import platform

    snapshot = {
        'python_version': platform.python_version(),
        'python_impl': platform.python_implementation(),
    }

    # Check for optional packages that affect behavior
    optional_packages = ['numpy', 'gmpy2', 'gmpy']
    for pkg in optional_packages:
        try:
            mod = __import__(pkg)
            snapshot[pkg] = getattr(mod, '__version__', 'installed')
        except ImportError:
            snapshot[pkg] = 'not_installed'

    return snapshot


def object_state_serialize(obj, max_depth=10, _seen=None, _depth=0, include_private=False):
    """Deeply serialize an object's state for fingerprinting, with cycle detection.

    This is essential for libraries with deeply-nested, stateful objects where
    snapshot_state() fails due to circular references (e.g., pycrate's ASN1Obj
    tree with _parent back-references, or Element trees with _env pointers).

    Key features:
    - Cycle detection via id() memoization — circular references become <CIRCULAR:ClassName>
    - Depth limiting — prevents infinite recursion on unexpectedly deep structures
    - Type discriminator — every object gets a __class__ field so different types
      with same attribute values produce different fingerprints
    - Private attribute support — set include_private=True to capture _prefixed attrs
      (needed for pycrate where _val, _struct, _tag, etc. are critical state)

    Args:
        obj: The object to serialize
        max_depth: Maximum recursion depth (default 10)
        _seen: Internal — set of seen object ids for cycle detection
        _depth: Internal — current recursion depth
        include_private: If True, include attributes starting with _

    Returns:
        A JSON-serializable representation
    """
    if _seen is None:
        _seen = set()

    if _depth > max_depth:
        return f'<max_depth:{type(obj).__name__}>'

    # Primitives — return as-is
    if obj is None or isinstance(obj, (bool, int, float, str)):
        return obj

    # bytes → hex string
    if isinstance(obj, bytes):
        return obj.hex()

    # bytearray → hex string
    if isinstance(obj, bytearray):
        return obj.hex()

    # list — recurse
    if isinstance(obj, list):
        return [object_state_serialize(v, max_depth, _seen, _depth + 1, include_private) for v in obj]

    # tuple → list + recurse
    if isinstance(obj, tuple):
        return [object_state_serialize(v, max_depth, _seen, _depth + 1, include_private) for v in obj]

    # dict — recurse on values, add type hint if dict has special meaning
    if isinstance(obj, dict):
        return {k: object_state_serialize(v, max_depth, _seen, _depth + 1, include_private) for k, v in obj.items()}

    # set — sorted list
    if isinstance(obj, set):
        return sorted([object_state_serialize(v, max_depth, _seen, _depth + 1, include_private) for v in obj],
                       key=lambda x: str(x))

    # For objects with identity — check for circular references
    obj_id = id(obj)
    if obj_id in _seen:
        return f'<CIRCULAR:{type(obj).__name__}>'
    _seen.add(obj_id)

    try:
        cls_name = type(obj).__name__

        # Objects with get_val_d() — use it for a clean value dump
        if hasattr(obj, 'get_val_d') and callable(obj.get_val_d):
            try:
                val_d = obj.get_val_d()
                result = object_state_serialize(val_d, max_depth, _seen, _depth + 1, include_private)
                if isinstance(result, dict):
                    result['__class__'] = cls_name
                return result
            except Exception:
                pass

        # Objects with to_dict() — use it for serialization
        if hasattr(obj, 'to_dict') and callable(obj.to_dict):
            try:
                to_dict_result = obj.to_dict()
                result = object_state_serialize(to_dict_result, max_depth, _seen, _depth + 1, include_private)
                if isinstance(result, dict):
                    result['__class__'] = cls_name
                return result
            except Exception:
                pass

        # Objects with __dict__ — serialize instance attributes
        if hasattr(obj, '__dict__'):
            attrs = {'__class__': cls_name}
            for k, v in sorted(obj.__dict__.items()):
                if not include_private and k.startswith('_'):
                    continue
                try:
                    attrs[k] = object_state_serialize(v, max_depth, _seen, _depth + 1, include_private)
                except Exception:
                    attrs[k] = f'<unrepresentable:{type(v).__name__}>'
            return attrs

        # Objects with __slots__ — serialize slot values
        if hasattr(obj, '__slots__'):
            attrs = {'__class__': cls_name}
            for slot in sorted(obj.__slots__):
                try:
                    attrs[slot] = object_state_serialize(getattr(obj, slot), max_depth, _seen, _depth + 1, include_private)
                except AttributeError:
                    pass
            return attrs

        # Fallback — repr
        return repr(obj)
    finally:
        # Remove from seen when backtracking — allows same object in different branches
        _seen.discard(obj_id)


def snapshot_module_globals(module_names):
    """Snapshot specified module-level global variables for isolation.

    This is critical for libraries that use module-level mutable state
    (e.g., pycrate's ASN1CodecPER.ALIGNED, ASN1CodecBER.ENC_* flags).
    Without isolation, running multiple codec clusters back-to-back
    can corrupt state between them.

    Args:
        module_names: dict of {module_path: [attr_name, ...]}
                     e.g., {'pycrate_asn1rt.asnobj': ['ASN1CodecPER', 'ASN1CodecBER']}

    Returns:
        dict of {module_path.attr_name: saved_value} for restoration
    """
    saved = {}
    for mod_path, attr_names in module_names.items():
        try:
            mod = __import__(mod_path, fromlist=attr_names)
            for attr_name in attr_names:
                obj = getattr(mod, attr_name, None)
                if obj is not None:
                    # If it's a class, snapshot its class-level attributes
                    if isinstance(obj, type):
                        for k, v in vars(obj).items():
                            if not k.startswith('_') and not callable(v):
                                key = f'{mod_path}.{attr_name}.{k}'
                                try:
                                    saved[key] = deep_clone(v)
                                except Exception:
                                    saved[key] = repr(v)
                    else:
                        key = f'{mod_path}.{attr_name}'
                        try:
                            saved[key] = deep_clone(obj)
                        except Exception:
                            saved[key] = repr(obj)
        except ImportError:
            pass
    return saved


def restore_module_globals(saved):
    """Restore module-level global variables from a snapshot.

    Args:
        saved: dict as returned by snapshot_module_globals
    """
    for key, value in saved.items():
        parts = key.rsplit('.', 2)
        if len(parts) == 3:
            mod_path, class_name, attr_name = parts
            try:
                mod = __import__(mod_path, fromlist=[class_name])
                cls = getattr(mod, class_name, None)
                if cls is not None:
                    setattr(cls, attr_name, value)
            except (ImportError, AttributeError):
                pass
        elif len(parts) == 2:
            mod_path, attr_name = parts
            try:
                mod = __import__(mod_path, fromlist=[attr_name])
                setattr(mod, attr_name, value)
            except (ImportError, AttributeError):
                pass

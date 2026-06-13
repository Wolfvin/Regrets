#!/usr/bin/env python3
# fingerprint.py — deterministic hash for regression contracts
# IDENTICAL algorithm to fingerprint.js. Same input must produce same 7-char hash.
#
# Shared module — imported by capture.py and validate.py.
# Do NOT duplicate these functions. Import them: from fingerprint import fingerprint, ...

import hashlib
import json
import re


def _numpy_to_native(obj):
    """Convert numpy types to native Python types for JSON serialization.

    Handles: ndarray -> list, numpy scalars (int64, float64, etc.) -> Python int/float,
    numpy bool_ -> Python bool.
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
    """
    obj = _numpy_to_native(obj)
    return json.dumps(obj, sort_keys=True, separators=(',', ':'), ensure_ascii=False)


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
        # floatPrecision: normalize float-like strings that differ only in trailing zeros
        # Common in OCR output where "1500000.0" and "1500000" should be equivalent.
        # Strips trailing ".0" from number-like strings (including negative).
        if 'floatPrecision' in rules:
            return re.sub(r'^-?(\d+)\.0+$', r'\1', obj)
        return obj

    if isinstance(obj, (int, float)):
        if 'epochs' in rules and 1_000_000_000 < obj < 9_999_999_999_999:
            return '<EPOCH>'
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


def deep_clone(val):
    """Deep clone via JSON round-trip. Handles numpy arrays by converting to native types."""
    val = _numpy_to_native(val)
    try:
        return json.loads(json.dumps(val))
    except (TypeError, ValueError):
        return val


def materialize_output(val):
    """Materialize generator/iterator output into a list for fingerprinting.

    When a function returns a generator, iterator, or other lazy sequence,
    it cannot be JSON-serialized or fingerprinted directly. This function
    detects lazy types and consumes them into a concrete list.

    Handles:
    - Generators (generator type)
    - Iterators (has __next__ but is not str/bytes/dict/list)
    - map/filter objects
    - range objects

    Does NOT materialize:
    - str, bytes, dict, list, tuple, set (already concrete)
    - numpy arrays (handled by _numpy_to_native)
    - Numbers, booleans, None (primitives)

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
    is_iterable_only = hasattr(val, '__iter__') and not hasattr(val, '__len__') and not isinstance(val, (str, bytes, dict))

    if is_generator or is_map_filter or is_range or is_iterator or is_iterable_only:
        try:
            return list(val), True
        except Exception:
            # If materialization fails, return as-is
            return val, False

    return val, False


def snapshot_state(obj):
    """Create a JSON-serializable snapshot of an object's state.

    Used by trackMutation to capture input state before and after
    a function call, so mutations can be detected.

    Handles:
    - JSON-serializable types (dict, list, str, numbers)
    - Objects with __dict__ (captures instance attributes)
    - Objects with __slots__ (captures slot values)
    - Nested objects (recurses)

    Returns a JSON-serializable dict/list/value.
    """
    if obj is None or isinstance(obj, (bool, int, float, str)):
        return obj

    if isinstance(obj, (list, tuple)):
        return [snapshot_state(v) for v in obj]

    if isinstance(obj, dict):
        return {k: snapshot_state(v) for k, v in obj.items()}

    if isinstance(obj, set):
        return sorted([snapshot_state(v) for v in obj], key=lambda x: str(x))

    if isinstance(obj, bytes):
        return obj.decode('utf-8', errors='replace')

    # Object with __dict__ (most class instances)
    if hasattr(obj, '__dict__'):
        cls_name = type(obj).__name__
        attrs = {}
        for k, v in obj.__dict__.items():
            if not k.startswith('_'):  # skip private attrs by default
                try:
                    attrs[k] = snapshot_state(v)
                except Exception:
                    attrs[k] = f'<unrepresentable:{type(v).__name__}>'
        return {'__class__': cls_name, **attrs}

    # Object with __slots__
    if hasattr(obj, '__slots__'):
        cls_name = type(obj).__name__
        attrs = {}
        for slot in obj.__slots__:
            try:
                attrs[slot] = snapshot_state(getattr(obj, slot))
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

#!/usr/bin/env python3
# fingerprint.py — deterministic hash for regression contracts
# IDENTICAL algorithm to fingerprint.js. Same input must produce same 7-char hash.
#
# Shared module — imported by capture.py and validate.py.
# Do NOT duplicate these functions. Import them: from fingerprint import fingerprint, ...

import hashlib
import json
import re


def stable_dumps(obj):
    """Stable JSON serialization — keys sorted recursively (mirrors JS stableStringify)."""
    return json.dumps(obj, sort_keys=True, separators=(',', ':'), ensure_ascii=False)


def normalize(obj, rules=None):
    """Normalize non-deterministic values before hashing.

    Rules match the JS implementation in fingerprint.js:
    - timestamps: ISO 8601 datetime strings -> <TIMESTAMP>
    - uuids: UUID v4 format -> <UUID>
    - absPaths: Absolute file paths -> <ROOT>/...
    - dynamicDates: Embedded MMYYYY/YYYY in strings -> <MMYYYY>/<YYYY>
    - epochs: Unix epoch numbers (1B-10T) -> <EPOCH>
    """
    if rules is None:
        rules = []

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
        return obj

    if isinstance(obj, (int, float)):
        if 'epochs' in rules and 1_000_000_000 < obj < 9_999_999_999_999:
            return '<EPOCH>'
        return obj

    if isinstance(obj, list):
        return [normalize(v, rules) for v in obj]

    if isinstance(obj, dict):
        return {k: normalize(v, rules) for k, v in obj.items()}

    return obj


def strip_fields(obj, fields=None):
    """Strip ignored fields from output before hashing."""
    if fields is None:
        fields = []
    if not fields:
        return obj

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
    """Deep clone via JSON round-trip."""
    try:
        return json.loads(json.dumps(val))
    except (TypeError, ValueError):
        return val


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

    Cross-stack consistent with fingerprint.js extractSchema().
    """
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

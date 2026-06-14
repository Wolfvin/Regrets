#!/usr/bin/env python3
# freeze_time.py — Time freezing utility for deterministic fingerprinting
#
# Many Python libraries call time.localtime() or datetime.now() internally,
# making their output non-deterministic. This module provides a context
# manager to freeze time during Regrets capture/validate operations.
#
# Usage in manifest.json:
#   {
#     "freezeTime": "2025-06-14T12:00:00",
#     ...
#   }
#
# Usage in entry wrappers:
#   from scripts.freeze_time import FreezeTime
#   with FreezeTime("2025-06-14T12:00:00"):
#       result = calendar.parse("tomorrow")
#
# Supports:
#   - time.localtime() → returns frozen struct_time
#   - time.time() → returns frozen timestamp
#   - datetime.datetime.now() → returns frozen datetime
#   - datetime.datetime.utcnow() → returns frozen datetime
#
# The datetime.datetime class is C-implemented and immutable, so
# patch.object fails. Instead, we replace datetime.datetime in the
# datetime module with a subclass that overrides now() and utcnow().

import time
from datetime import datetime
from unittest.mock import patch


def _make_frozen_time(freeze_str):
    """Parse a freezeTime string and return a frozen time.localtime replacement.

    Supported formats:
    - ISO 8601 datetime: "2025-06-14T12:00:00"
    - Date only (time defaults to noon): "2025-06-14"
    - Unix timestamp (integer string): "1749892800"
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
    - time.time → returns frozen timestamp
    - datetime.datetime.now → returns frozen datetime (via module-level class replacement)

    The datetime.datetime class is C-implemented and immutable, so
    patch.object fails. Instead, we replace datetime.datetime in the
    datetime module with a subclass that overrides now() and utcnow().
    """

    def __init__(self, freeze_str):
        self.freeze_str = freeze_str
        self.patches = []
        self._original_datetime_cls = None
        self._dt_module = None

    def __enter__(self):
        frozen_localtime = _make_frozen_time(self.freeze_str)
        # Parse the frozen time once for datetime.now()
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

        # Patch datetime.datetime.now via module-level class replacement
        # datetime.datetime is C-implemented and immutable, so
        # patch.object(datetime.datetime, 'now', ...) fails with:
        # 'cannot set now attribute of immutable type datetime.datetime'
        import datetime as _dt_module
        self._original_datetime_cls = _dt_module.datetime

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
        self._dt_module = _dt_module

        return self

    def __exit__(self, *args):
        for p in reversed(self.patches):
            p.stop()
        self.patches = []
        # Restore original datetime.datetime class
        if self._dt_module and self._original_datetime_cls:
            self._dt_module.datetime = self._original_datetime_cls

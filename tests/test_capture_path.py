#!/usr/bin/env python3
"""
tests/test_capture_path.py — Issue #274 unit tests for capture.py's path resolver.

The JS test suite (tests/python-manifest-fields.test.js) covers the
end-to-end behavior by spawning capture.py as a subprocess. This file
unit-tests the pure helper functions inside capture.py directly:

  - `_file_path_to_module(rel_path)` — converts a file path to a
    (module_path, parent_dir) tuple.
  - `resolve_module_path(cluster)` — resolves a cluster dict to a
    (module_path, extra_python_paths) tuple, preferring `module` and
    falling back to `file` for backward compatibility.

These tests are pure (no subprocess, no sys.path mutation, no I/O) so
they're fast and isolated. Run them with:

    python3 -m unittest tests.test_capture_path -v
    # or
    python3 tests/test_capture_path.py
"""

import os
import sys
import unittest

# Make scripts/ importable. We resolve it relative to this test file so
# the test works regardless of where it's invoked from.
_HERE = os.path.dirname(os.path.abspath(__file__))
_REPO_ROOT = os.path.dirname(_HERE)
_SCRIPTS = os.path.join(_REPO_ROOT, 'scripts')
if _SCRIPTS not in sys.path:
    sys.path.insert(0, _SCRIPTS)

# Import the helpers under test. capture.py is a heavy module (it imports
# fingerprint and ghost at the top), but the resolver helpers themselves
# are pure functions defined before any of that machinery runs.
import capture  # noqa: E402


class TestFilePathToModule(unittest.TestCase):
    """Unit tests for capture._file_path_to_module()."""

    def test_root_level_file(self):
        self.assertEqual(capture._file_path_to_module('transforms.py'),
                         ('transforms', ''))

    def test_nested_file(self):
        self.assertEqual(capture._file_path_to_module('src/invoice/processor.py'),
                         ('invoice.processor', 'src'))

    def test_deeply_nested_file(self):
        self.assertEqual(capture._file_path_to_module('src/utils/math/normalize.py'),
                         ('utils.math.normalize', 'src'))

    def test_init_py_collapses_to_package_name(self):
        self.assertEqual(capture._file_path_to_module('src/pkg/__init__.py'),
                         ('pkg', 'src'))

    def test_root_init_py_collapses_to_empty(self):
        self.assertEqual(capture._file_path_to_module('__init__.py'),
                         ('', ''))

    def test_single_segment_no_extension(self):
        self.assertEqual(capture._file_path_to_module('transforms'),
                         ('transforms', ''))

    def test_windows_backslashes_normalized(self):
        self.assertEqual(capture._file_path_to_module('src\\invoice\\processor.py'),
                         ('invoice.processor', 'src'))

    def test_tests_directory(self):
        self.assertEqual(capture._file_path_to_module('tests/conftest.py'),
                         ('conftest', 'tests'))

    def test_strips_uppercase_py_extension(self):
        # .PY uppercase — make sure the suffix strip is case-insensitive.
        self.assertEqual(capture._file_path_to_module('transforms.PY'),
                         ('transforms', ''))

    def test_trailing_slash_ignored(self):
        # Pathological case: trailing slash. Should not produce empty parts.
        self.assertEqual(capture._file_path_to_module('src/invoice/'),
                         ('invoice', 'src'))

    def test_double_slashes_collapsed(self):
        # Pathological case: double slashes. Should not produce empty parts.
        self.assertEqual(capture._file_path_to_module('src//invoice/processor.py'),
                         ('invoice.processor', 'src'))


class TestResolveModulePath(unittest.TestCase):
    """Unit tests for capture.resolve_module_path()."""

    def test_prefers_module_field_when_present(self):
        cluster = {
            'id': 'c1',
            'module': 'invoice.processor',
            'file': 'src/invoice/processor.py',  # should be IGNORED
        }
        mod, extra = capture.resolve_module_path(cluster)
        self.assertEqual(mod, 'invoice.processor')
        self.assertEqual(extra, [])

    def test_module_field_with_no_file_field(self):
        cluster = {'id': 'c2', 'module': 'transforms'}
        mod, extra = capture.resolve_module_path(cluster)
        self.assertEqual(mod, 'transforms')
        self.assertEqual(extra, [])

    def test_falls_back_to_file_when_module_absent(self):
        # Backward compat: a pre-#279 manifest with only `file`.
        cluster = {'id': 'c3', 'file': 'src/invoice/processor.py'}
        mod, extra = capture.resolve_module_path(cluster)
        self.assertEqual(mod, 'invoice.processor')
        self.assertEqual(extra, ['src'])

    def test_root_level_file_falls_back_with_no_extra_path(self):
        cluster = {'id': 'c4', 'file': 'transforms.py'}
        mod, extra = capture.resolve_module_path(cluster)
        self.assertEqual(mod, 'transforms')
        self.assertEqual(extra, [])

    def test_raises_when_neither_field_present(self):
        cluster = {'id': 'c5'}
        with self.assertRaises(ValueError) as ctx:
            capture.resolve_module_path(cluster)
        self.assertIn('neither \'module\' nor \'file\'', str(ctx.exception))
        self.assertIn('c5', str(ctx.exception))

    def test_raises_when_both_fields_empty(self):
        cluster = {'id': 'c6', 'module': '', 'file': ''}
        with self.assertRaises(ValueError):
            capture.resolve_module_path(cluster)

    def test_raises_when_file_path_is_just_init_py_at_root(self):
        # _file_path_to_module returns ('', '') for `__init__.py` at root,
        # so resolve_module_path must surface a clear error rather than
        # silently producing an empty module path.
        cluster = {'id': 'c7', 'file': '__init__.py'}
        with self.assertRaises(ValueError) as ctx:
            capture.resolve_module_path(cluster)
        self.assertIn('could not be converted to a module path', str(ctx.exception))

    def test_module_field_whitespace_is_stripped(self):
        cluster = {'id': 'c8', 'module': '  invoice.processor  '}
        mod, extra = capture.resolve_module_path(cluster)
        self.assertEqual(mod, 'invoice.processor')
        self.assertEqual(extra, [])

    def test_file_field_whitespace_is_stripped(self):
        cluster = {'id': 'c9', 'file': '  src/invoice/processor.py  '}
        mod, extra = capture.resolve_module_path(cluster)
        self.assertEqual(mod, 'invoice.processor')
        self.assertEqual(extra, ['src'])

    def test_module_field_takes_precedence_over_file_even_if_file_looks_valid(self):
        # Defense in depth: even if both are present and `file` looks valid,
        # `module` wins. This protects against stale `file` entries left over
        # from a manifest migration.
        cluster = {
            'id': 'c10',
            'module': 'real.module',
            'file': 'src/legacy/path.py',
        }
        mod, extra = capture.resolve_module_path(cluster)
        self.assertEqual(mod, 'real.module')
        self.assertEqual(extra, [])


class TestParityWithInstallJs(unittest.TestCase):
    """Cross-stack parity: capture.py's resolver must agree with install.js's
    `filePathToPythonModule()` on every input shape. The JS test suite
    covers the install.js side; this Python test covers the capture.py side
    so we can detect drift if either side changes.
    """

    CASES = [
        ('transforms.py',              ('transforms', '')),
        ('src/invoice/processor.py',   ('invoice.processor', 'src')),
        ('src/utils/math/normalize.py', ('utils.math.normalize', 'src')),
        ('src/pkg/__init__.py',        ('pkg', 'src')),
        ('__init__.py',                ('', '')),
        ('tests/conftest.py',          ('conftest', 'tests')),
    ]

    def test_parity_with_install_js(self):
        for rel_path, expected in self.CASES:
            with self.subTest(rel_path=rel_path):
                actual = capture._file_path_to_module(rel_path)
                self.assertEqual(actual, expected,
                    f'capture._file_path_to_module({rel_path!r}) = {actual}, '
                    f'expected {expected} (must match install.js '
                    f'filePathToPythonModule)')


if __name__ == '__main__':
    unittest.main(verbosity=2)

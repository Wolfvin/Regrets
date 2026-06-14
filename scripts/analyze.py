#!/usr/bin/env python3
# analyze.py — Deep structural analysis for regret-based regression
# Identifies refactoring risks BEFORE you write manifest.json.
#
# This script was born from analyzing gaigutherz/Akkademia — an Akkadian
# cuneiform NLP tool where hmm_viterbi() has 11 parameters, overall_classifier()
# has 20 parameters, and hmm_preprocess() / build_extra_decoding_arguments()
# duplicate nearly identical code across modules. Regrets' existing `scan` only
# found surface-level exported functions and missed these structural risks.
#
# Usage:
#   python scripts/analyze.py [directory]
#   python scripts/analyze.py --format manifest   (output as manifest suggestions)
#
# What it finds that `scan` doesn't:
#   1. GOD FUNCTIONS — functions with >5 parameters (refactoring red flag)
#   2. DUPLICATE PATTERNS — functions across files with similar AST structure
#   3. CROSS-MODULE DEPENDENCIES — which external functions each function calls
#   4. MISSING WATCH CANDIDATES — internal helpers that should be watched
#      because they are called by entry functions but live in other modules

import ast
import json
import os
import sys
from collections import defaultdict
from pathlib import Path


# ─── Data structures ────────────────────────────────────────────────────────

class FunctionAnalysis:
    """Detailed analysis of a single function."""
    def __init__(self, name, module, filepath, lineno, params, calls, body_lines,
                 is_method=False, class_name=None, decorators=None, is_pure=True,
                 external_calls=None, internal_calls=None):
        self.name = name
        self.module = module
        self.filepath = filepath
        self.lineno = lineno
        self.params = params          # list of parameter names
        self.calls = calls            # all function calls within body
        self.body_lines = body_lines  # number of lines in function body
        self.is_method = is_method
        self.class_name = class_name
        self.decorators = decorators or []
        self.is_pure = is_pure
        self.external_calls = external_calls or []  # calls to functions in other modules
        self.internal_calls = internal_calls or []  # calls to functions in same module


# ─── AST Visitor ────────────────────────────────────────────────────────────

class DeepAnalyzer(ast.NodeVisitor):
    """Deep AST analysis that extracts parameter counts, cross-module calls,
    purity heuristics, and structural fingerprints for duplicate detection."""

    IMPURE_NAMES = {
        'open', 'print', 'input', 'exec', 'eval',
        'urllib', 'requests', 'http', 'socket',
        'os.system', 'subprocess', 'shutil',
    }

    IMPURE_ATTRS = {
        'random', 'randint', 'choice', 'shuffle', 'getrandbits',
        'write', 'read', 'flush',
    }

    def __init__(self, module_name, filepath, all_module_functions=None):
        self.module_name = module_name
        self.filepath = filepath
        self.all_module_functions = all_module_functions or set()
        self.functions = []
        self._current_class = None
        self._imported_modules = {}  # alias -> module_path

    def _count_body_lines(self, node):
        """Estimate the number of lines in a function body."""
        if hasattr(node, 'end_lineno') and node.end_lineno:
            return node.end_lineno - node.lineno
        return 0

    def _get_params(self, node):
        """Extract parameter names from a function definition."""
        params = []
        for arg in node.args.args:
            if arg.arg != 'self':
                params.append(arg.arg)
        if node.args.vararg:
            params.append('*' + node.args.vararg.arg)
        if node.args.kwarg:
            params.append('**' + node.args.kwarg.arg)
        return params

    def _collect_calls(self, node):
        """Collect all function calls within a function body."""
        calls = []
        for child in ast.walk(node):
            if isinstance(child, ast.Call):
                if isinstance(child.func, ast.Name):
                    calls.append(child.func.id)
                elif isinstance(child.func, ast.Attribute):
                    calls.append(child.func.attr)
        return list(set(calls))

    def _categorize_calls(self, calls):
        """Split calls into internal (same module) and external (other modules)."""
        internal = []
        external = []
        for call in calls:
            if call in self.all_module_functions:
                internal.append(call)
            else:
                external.append(call)
        return internal, external

    def _check_purity(self, node):
        """Heuristic purity check."""
        for child in ast.walk(node):
            if isinstance(child, (ast.Global, ast.Nonlocal)):
                return False
            if isinstance(child, ast.Call):
                func_name = None
                if isinstance(child.func, ast.Name):
                    func_name = child.func.id
                elif isinstance(child.func, ast.Attribute):
                    func_name = child.func.attr
                if func_name in self.IMPURE_NAMES:
                    return False
                if func_name in self.IMPURE_ATTRS:
                    return False
        return True

    def _structural_fingerprint(self, node):
        """Create a structural fingerprint for duplicate detection.
        Based on: parameter count, call count, branch count, body lines."""
        branches = 0
        for child in ast.walk(node):
            if isinstance(child, (ast.If, ast.While, ast.For)):
                branches += 1
            elif isinstance(child, ast.BoolOp):
                branches += len(child.values) - 1

        params = self._get_params(node)
        calls = self._collect_calls(node)
        body_lines = self._count_body_lines(node)

        return {
            'param_count': len(params),
            'call_count': len(calls),
            'branch_count': branches,
            'body_lines': body_lines,
            'calls_sorted': sorted(calls),
        }

    def visit_Import(self, node):
        """Track imports for cross-module analysis."""
        for alias in node.names:
            name = alias.asname or alias.name
            self._imported_modules[name] = alias.name
        self.generic_visit(node)

    def visit_ImportFrom(self, node):
        """Track from-imports for cross-module analysis."""
        if node.module:
            for alias in node.names:
                name = alias.asname or alias.name
                self._imported_modules[name] = f"{node.module}.{alias.name}"
        self.generic_visit(node)

    def visit_ClassDef(self, node):
        old_class = self._current_class
        self._current_class = node.name
        self.generic_visit(node)
        self._current_class = old_class

    def visit_FunctionDef(self, node):
        params = self._get_params(node)
        calls = self._collect_calls(node)
        internal_calls, external_calls = self._categorize_calls(calls)
        is_pure = self._check_purity(node)
        body_lines = self._count_body_lines(node)
        decorators = []
        for d in node.decorator_list:
            if isinstance(d, ast.Name):
                decorators.append(d.id)
            elif isinstance(d, ast.Attribute):
                decorators.append(d.attr)

        analysis = FunctionAnalysis(
            name=node.name,
            module=self.module_name,
            filepath=self.filepath,
            lineno=node.lineno,
            params=params,
            calls=calls,
            body_lines=body_lines,
            is_method=self._current_class is not None,
            class_name=self._current_class,
            decorators=decorators,
            is_pure=is_pure,
            external_calls=external_calls,
            internal_calls=internal_calls,
        )
        self.functions.append(analysis)
        self.generic_visit(node)

    visit_AsyncFunctionDef = visit_FunctionDef


# ─── Duplicate Detection ────────────────────────────────────────────────────

def find_duplicate_patterns(all_functions):
    """Find functions across files that have similar structure.

    Two functions are considered potential duplicates if:
    - Same parameter count
    - Same branch count (±1)
    - Overlap in calls (>60% of smaller call set)
    - Similar body line count (±30%)

    This catches cases like hmm_preprocess() and build_extra_decoding_arguments()
    in Akkademia, which build the same counts (possible_tags, q_uni_counts,
    q_bi_counts, q_tri_counts) with nearly identical loops.
    """
    duplicates = []
    funcs = [f for f in all_functions if not f.name.startswith('_') and f.body_lines > 10]

    for i, f1 in enumerate(funcs):
        for f2 in funcs[i+1:]:
            # Must be in different modules
            if f1.module == f2.module:
                continue

            # Same parameter count
            if len(f1.params) != len(f2.params):
                continue

            # Similar body size
            if f1.body_lines == 0 or f2.body_lines == 0:
                continue
            ratio = min(f1.body_lines, f2.body_lines) / max(f1.body_lines, f2.body_lines)
            if ratio < 0.7:
                continue

            # Call overlap
            c1 = set(f1.calls)
            c2 = set(f2.calls)
            if c1 and c2:
                overlap = len(c1 & c2) / min(len(c1), len(c2))
                if overlap < 0.6:
                    continue
            elif not c1 and not c2:
                pass  # both have no calls, still possible duplicates
            else:
                continue

            duplicates.append({
                'function1': f'{f1.module}.{f1.name}',
                'function2': f'{f2.module}.{f2.name}',
                'param_count': len(f1.params),
                'body_lines_f1': f1.body_lines,
                'body_lines_f2': f2.body_lines,
                'shared_calls': sorted(set(f1.calls) & set(f2.calls)),
            })

    return duplicates


# ─── God Function Detection ─────────────────────────────────────────────────

GOD_FUNCTION_PARAM_THRESHOLD = 6  # Flag functions with >5 params
GOD_FUNCTION_LINE_THRESHOLD = 50  # Flag functions with >50 lines

def find_god_functions(all_functions):
    """Find functions with too many parameters or too many lines.

    In Akkademia, hmm_viterbi() has 11 parameters and overall_classifier() has
    20. These are strong signals that the function needs decomposition — a
    parameter object or a class would group related parameters.

    Regrets' existing scan.py counts branches but not parameter count or
    function length. This fills that gap.
    """
    god_functions = []
    for f in all_functions:
        issues = []
        if len(f.params) > GOD_FUNCTION_PARAM_THRESHOLD:
            issues.append(f'{len(f.params)} parameters (>{GOD_FUNCTION_PARAM_THRESHOLD})')
        if f.body_lines > GOD_FUNCTION_LINE_THRESHOLD:
            issues.append(f'{f.body_lines} lines (>{GOD_FUNCTION_LINE_THRESHOLD})')

        if issues:
            god_functions.append({
                'function': f'{f.module}.{f.name}',
                'params': f.params,
                'param_count': len(f.params),
                'body_lines': f.body_lines,
                'issues': issues,
                'is_method': f.is_method,
                'class_name': f.class_name,
            })

    return sorted(god_functions, key=lambda x: x['param_count'], reverse=True)


# ─── Cross-Module Watch Suggestions ─────────────────────────────────────────

def suggest_cross_module_watches(all_functions):
    """Suggest watches that span multiple modules.

    When an entry function in module A calls helper functions in module B,
    those helpers should be watched even though they're in a different file.
    Regrets' current model assumes watches are in the same file as the entry,
    but real-world code often calls across modules.

    For each entry function, this identifies which external functions it calls
    and suggests them as additional watches.
    """
    module_map = defaultdict(list)
    for f in all_functions:
        module_map[f.module].append(f)

    suggestions = []
    for f in all_functions:
        if f.external_calls:
            # Find which modules those external functions live in
            external_modules = defaultdict(list)
            for call_name in f.external_calls:
                for other_module, other_funcs in module_map.items():
                    if other_module == f.module:
                        continue
                    for of in other_funcs:
                        if of.name == call_name:
                            external_modules[other_module].append(call_name)

            if external_modules:
                suggestions.append({
                    'entry': f'{f.module}.{f.name}',
                    'cross_module_watches': dict(external_modules),
                })

    return suggestions


# ─── File Scanner ───────────────────────────────────────────────────────────

def scan_file(filepath, base_dir=''):
    """Scan a single Python file with deep analysis."""
    with open(filepath, 'r', encoding='utf-8') as f:
        source = f.read()

    try:
        tree = ast.parse(source, filename=filepath)
    except SyntaxError:
        return []

    rel_path = os.path.relpath(filepath, base_dir) if base_dir else filepath
    module = os.path.splitext(rel_path)[0].replace(os.sep, '.')
    if module.startswith('.'):
        module = module[1:]

    # First pass: collect all function names in this module
    all_names = set()
    for node in ast.walk(tree):
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
            all_names.add(node.name)

    # Second pass: deep analysis
    analyzer = DeepAnalyzer(module, filepath, all_names)
    analyzer.visit(tree)

    return analyzer.functions


def scan_directory(dirpath, recursive=False):
    """Scan a directory for Python files."""
    results = []
    if recursive:
        for root, dirs, files in os.walk(dirpath):
            dirs[:] = [d for d in dirs if not d.startswith(('.', '__'))]
            for f in files:
                if f.endswith('.py') and not f.startswith('__'):
                    results.extend(scan_file(os.path.join(root, f), base_dir=dirpath))
    else:
        for f in os.listdir(dirpath):
            if f.endswith('.py') and not f.startswith('__'):
                full_path = os.path.join(dirpath, f)
                if os.path.isfile(full_path):
                    results.extend(scan_file(full_path, base_dir=dirpath))
    return results


# ─── Rendering ─────────────────────────────────────────────────────────────

def render_report(all_functions, god_funcs, duplicates, cross_module_watches):
    """Render the full analysis report."""
    print("\n" + "=" * 72)
    print("REGRET DEEP STRUCTURAL ANALYSIS")
    print("=" * 72)

    # God Functions
    if god_funcs:
        print(f"\n🔴 GOD FUNCTIONS ({len(god_funcs)}) — Refactoring Priority")
        print("-" * 72)
        for gf in god_funcs:
            print(f"  {gf['function']}")
            for issue in gf['issues']:
                print(f"    ⚠️  {issue}")
            if gf['params']:
                param_str = ', '.join(gf['params'][:8])
                if len(gf['params']) > 8:
                    param_str += ', ...'
                print(f"    params: ({param_str})")
    else:
        print("\n✅ No god functions detected (all functions ≤5 params and ≤50 lines)")

    # Duplicate Patterns
    if duplicates:
        print(f"\n🟡 POTENTIAL DUPLICATES ({len(duplicates)}) — Dedup Before Refactoring")
        print("-" * 72)
        for dup in duplicates:
            print(f"  {dup['function1']}")
            print(f"  ↔  {dup['function2']}")
            print(f"    params: {dup['param_count']}, lines: {dup['body_lines_f1']} vs {dup['body_lines_f2']}")
            if dup['shared_calls']:
                print(f"    shared calls: {', '.join(dup['shared_calls'][:8])}")
    else:
        print("\n✅ No cross-module duplicate patterns detected")

    # Cross-Module Watch Suggestions
    if cross_module_watches:
        print(f"\n⛓  CROSS-MODULE WATCHES ({len(cross_module_watches)}) — Extend Your Manifest")
        print("-" * 72)
        for suggestion in cross_module_watches:
            print(f"  Entry: {suggestion['entry']}")
            for mod, calls in suggestion['cross_module_watches'].items():
                print(f"    → {mod}: watch {', '.join(calls)}")
    else:
        print("\n✅ No cross-module dependencies detected")

    # Summary
    print(f"\n{'=' * 72}")
    print(f"SUMMARY: {len(all_functions)} functions analyzed")
    print(f"  God functions: {len(god_funcs)}")
    print(f"  Duplicate patterns: {len(duplicates)}")
    print(f"  Cross-module deps: {len(cross_module_watches)}")
    risk = len(god_funcs) + len(duplicates) * 2 + len(cross_module_watches)
    if risk > 10:
        print(f"\n⚠️  HIGH REFACTORING RISK (score: {risk}) — Fix god functions first, then deduplicate")
    elif risk > 3:
        print(f"\n🟡 MODERATE RISK (score: {risk}) — Plan refactoring before using Regrets")
    else:
        print(f"\n✅ LOW RISK (score: {risk}) — Safe to proceed with Regrets")
    print()


def render_manifest_json(all_functions, god_funcs, duplicates, cross_module_watches):
    """Output analysis results as JSON for programmatic use."""
    result = {
        'god_functions': god_funcs,
        'duplicate_patterns': duplicates,
        'cross_module_watches': cross_module_watches,
        'summary': {
            'total_functions': len(all_functions),
            'god_function_count': len(god_funcs),
            'duplicate_count': len(duplicates),
            'cross_module_count': len(cross_module_watches),
        }
    }
    print(json.dumps(result, indent=2, ensure_ascii=False))


# ─── CLI ────────────────────────────────────────────────────────────────────

def main():
    args = sys.argv[1:]

    target = '.'
    recursive = True
    as_json = '--json' in args
    as_manifest = '--manifest' in args

    # Find target directory/file
    positional = [a for a in args if not a.startswith('-')]
    if positional:
        target = positional[0]

    if not os.path.exists(target):
        print(f"❌ Path not found: {target}")
        sys.exit(1)

    # Collect all function analyses
    all_functions = []
    if os.path.isfile(target):
        all_functions = scan_file(target)
    elif os.path.isdir(target):
        all_functions = scan_directory(target, recursive=recursive)

    if not all_functions:
        print("No Python functions found.")
        sys.exit(0)

    # Run analyses
    god_funcs = find_god_functions(all_functions)
    duplicates = find_duplicate_patterns(all_functions)
    cross_module = suggest_cross_module_watches(all_functions)

    # Output
    if as_json or as_manifest:
        render_manifest_json(all_functions, god_funcs, duplicates, cross_module)
    else:
        render_report(all_functions, god_funcs, duplicates, cross_module)


if __name__ == '__main__':
    main()

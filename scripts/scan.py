#!/usr/bin/env python3
# scan.py — Source code cluster scanner for Regrets
# Analyzes Python source files via AST to suggest clusters, watches, and inputs.
#
# Usage:
#   python scripts/scan.py <file_or_directory>
#   python scripts/scan.py src/my_module.py
#   python scripts/scan.py src/ --recursive
#
# This helps agents who don't know where to start with Regrets.
# Instead of manually figuring out which functions to cluster, scan
# identifies pure functions, their call relationships, and suggests
# inputs based on type annotations and enum ranges.

import ast
import json
import os
import sys
import importlib
from pathlib import Path
from typing import NamedTuple


# ─── Data structures ────────────────────────────────────────────────────────

class FunctionInfo(NamedTuple):
    name: str
    lineno: int
    args: list[str]
    defaults: list
    has_return_annotation: bool
    is_method: bool
    decorators: list[str]
    calls: list[str]  # functions called within this function
    branch_count: int  # estimated number of branches
    is_pure: bool  # heuristic: no global/nonlocal/IO


class ScanResult(NamedTuple):
    file: str
    module: str
    functions: list[FunctionInfo]
    classes: dict[str, list[FunctionInfo]]
    suggested_clusters: list[dict]


# ─── AST Analysis ───────────────────────────────────────────────────────────

class FunctionCollector(ast.NodeVisitor):
    """Collect function definitions and their call relationships."""

    def __init__(self):
        self.functions: list[FunctionInfo] = []
        self.classes: dict[str, list[FunctionInfo]] = {}
        self._current_class = None
        self._current_function = None
        self._current_calls = []
        self._current_branches = 0
        self._current_impurities = 0

    def _count_branches(self, node):
        """Estimate the number of execution paths through a function."""
        count = 0
        for child in ast.walk(node):
            if isinstance(child, (ast.If, ast.While, ast.For)):
                count += 1
            elif isinstance(child, ast.Match):
                count += len(child.cases)
            elif isinstance(child, ast.BoolOp):
                # and/or short-circuit = branching
                count += len(child.values) - 1
            elif isinstance(child, ast.IfExp):  # ternary
                count += 1
            elif isinstance(child, (ast.ListComp, ast.SetComp, ast.GeneratorExp, ast.DictComp)):
                # comprehension with if clause
                for generator in child.generators:
                    count += len(generator.ifs)
        return count

    def _check_purity(self, node):
        """Heuristic purity check: no global, nonlocal, open, print, etc."""
        impurities = 0
        impure_names = {
            'open', 'print', 'input', 'exec', 'eval',
            'urllib', 'requests', 'http', 'socket',
            'os.system', 'subprocess', 'shutil',
        }
        for child in ast.walk(node):
            if isinstance(child, (ast.Global, ast.Nonlocal)):
                impurities += 1
            elif isinstance(child, ast.Call):
                func_name = None
                if isinstance(child.func, ast.Name):
                    func_name = child.func.id
                elif isinstance(child.func, ast.Attribute):
                    func_name = child.func.attr
                if func_name and func_name in impure_names:
                    impurities += 1
                # random.* = impure
                if isinstance(child.func, ast.Attribute):
                    if child.func.attr in ('random', 'randint', 'choice', 'shuffle', 'getrandbits'):
                        if isinstance(child.func.value, ast.Name) and child.func.value.id == 'random':
                            impurities += 1
        return impurities == 0

    def _collect_calls(self, node):
        """Collect function names called within a function body."""
        calls = []
        for child in ast.walk(node):
            if isinstance(child, ast.Call):
                if isinstance(child.func, ast.Name):
                    calls.append(child.func.id)
                elif isinstance(child.func, ast.Attribute):
                    calls.append(child.func.attr)
        return list(set(calls))

    def visit_ClassDef(self, node):
        old_class = self._current_class
        self._current_class = node.name
        self.classes[node.name] = []
        self.generic_visit(node)
        self._current_class = old_class

    def visit_FunctionDef(self, node):
        old_func = self._current_function
        self._current_function = node.name

        # Collect info
        args = [a.arg for a in node.args.args if a.arg != 'self']
        defaults = [ast.literal_eval(d) if isinstance(d, ast.Constant) else None for d in node.args.defaults]
        decorators = []
        for d in node.decorator_list:
            if isinstance(d, ast.Name):
                decorators.append(d.id)
            elif isinstance(d, ast.Attribute):
                decorators.append(d.attr)

        calls = self._collect_calls(node)
        branches = self._count_branches(node)
        is_pure = self._check_purity(node)
        has_return = node.returns is not None

        func_info = FunctionInfo(
            name=node.name,
            lineno=node.lineno,
            args=args,
            defaults=defaults,
            has_return_annotation=has_return,
            is_method=self._current_class is not None,
            decorators=decorators,
            calls=calls,
            branch_count=branches,
            is_pure=is_pure,
        )

        if self._current_class:
            self.classes[self._current_class].append(func_info)
        else:
            self.functions.append(func_info)

        self._current_function = old_func

    visit_AsyncFunctionDef = visit_FunctionDef


# ─── Cluster Suggestion ────────────────────────────────────────────────────

def suggest_clusters(result: ScanResult) -> list[dict]:
    """Suggest clusters based on function analysis.

    Strategy:
    1. Find pure, non-method functions with return annotations (best cluster candidates)
    2. For each candidate entry function, include functions it calls as watches
    3. Estimate branch coverage needs
    4. Suggest inputs based on argument patterns
    """
    suggestions = []
    all_func_names = {f.name for f in result.functions}

    for func in result.functions:
        # Skip private functions, impure functions, and setters
        if func.name.startswith('_'):
            continue
        if not func.is_pure:
            continue
        if 'setter' in func.decorators:
            continue

        # Find watches: functions called by this one that exist in the same module
        watches = [func.name]  # always include self
        for called in func.calls:
            if called in all_func_names and called != func.name:
                watches.append(called)

        # Determine if multiArgs is needed
        multi_args = len(func.args) > 1

        # Suggest cluster ID from function name
        # camelCase or PascalCase → kebab-case
        cluster_id = ''
        for c in func.name:
            if c.isupper() and cluster_id:
                cluster_id += '-'
            cluster_id += c.lower()

        # Branch coverage note
        branch_note = ''
        if func.branch_count > 0:
            branch_note = f"Has {func.branch_count} branch(es) — provide {func.branch_count + 1} inputs to cover all paths"

        # Input suggestion
        input_note = "Provide at least one input"
        if func.args:
            input_note = f"Inputs needed for args: {', '.join(func.args)}"

        suggestion = {
            'id': cluster_id,
            'entry': func.name,
            'watches': watches,
            'file': result.file,
            'module': result.module,
            'stack': 'python',
            'fingerprintLevel': 'entry',
            'branchCount': func.branch_count,
            'isPure': func.is_pure,
            'multiArgs': multi_args,
            'args': func.args,
            'suggestedInputs': input_note,
            'coverageNote': branch_note if branch_note else 'All paths covered with single input',
        }
        suggestions.append(suggestion)

    # Also suggest clusters from class methods that look like pure operations
    GOD_CLASS_THRESHOLD = 20  # Classes with 20+ public methods are god objects
    for class_name, methods in result.classes.items():
        public_methods = [m for m in methods if not m.name.startswith('_')]
        pure_methods = [m for m in public_methods if m.is_pure]

        # God class detection: suggest constructor + classMethod + instanceMethods pattern
        if len(public_methods) >= GOD_CLASS_THRESHOLD:
            # Find __init__ to understand constructor args
            init_method = next((m for m in methods if m.name == '__init__'), None)
            constructor_args = init_method.args if init_method else []

            # Group methods by domain heuristics (based on naming patterns)
            domain_groups = _group_methods_by_domain(pure_methods)

            # Suggest one cluster per domain group using constructor + instanceMethods
            for domain, domain_methods in domain_groups.items():
                if not domain_methods:
                    continue
                method_names = [m.name for m in domain_methods]
                cluster_id = f"{class_name.lower()}-{domain}".replace('_', '-')
                all_watches = [class_name] + method_names[:5]  # cap watches for readability

                suggestion = {
                    'id': cluster_id,
                    'entry': class_name,
                    'watches': all_watches,
                    'file': result.file,
                    'module': result.module,
                    'stack': 'python',
                    'fingerprintLevel': 'entry',
                    'branchCount': sum(m.branch_count for m in domain_methods),
                    'isPure': all(m.is_pure for m in domain_methods),
                    'isMethod': True,
                    'isGodClass': True,
                    'className': class_name,
                    'constructor': class_name,
                    'constructorArgs': _suggest_constructor_args(init_method) if init_method else [],
                    'instanceMethods': {class_name: method_names[:10]},
                    'domainHint': domain,
                    'multiArgs': False,
                    'args': constructor_args,
                    'suggestedInputs': f"God class {class_name} ({len(public_methods)} methods) — {domain} domain group ({len(domain_methods)} methods)",
                    'coverageNote': f"God class: {len(public_methods)} public methods, {len(domain_methods)} in {domain} domain. Consider decomposition.",
                }
                suggestions.append(suggestion)

            # Also add an anchor cluster for the whole class (entry-level)
            anchor_id = f"{class_name.lower()}-anchor".replace('_', '-')
            anchor_suggestion = {
                'id': anchor_id,
                'entry': class_name,
                'watches': [class_name],
                'file': result.file,
                'module': result.module,
                'stack': 'python',
                'fingerprintLevel': 'entry',
                'branchCount': 0,
                'isPure': False,
                'isMethod': True,
                'isGodClass': True,
                'className': class_name,
                'constructor': class_name,
                'constructorArgs': _suggest_constructor_args(init_method) if init_method else [],
                'domainHint': 'anchor',
                'multiArgs': False,
                'args': constructor_args,
                'suggestedInputs': f"Anchor cluster for god class {class_name} — tests constructor + basic output",
                'coverageNote': f"God class anchor — keep GREEN throughout refactor. {len(public_methods)} total methods.",
            }
            suggestions.append(anchor_suggestion)

        # Individual method clusters (for non-god classes, or for fine-grained testing)
        if len(public_methods) < GOD_CLASS_THRESHOLD:
            for method in pure_methods:
                cluster_id = f"{class_name.lower()}-{method.name.lower()}".replace('_', '-')
                watches = [method.name]
                for called in method.calls:
                    if called != method.name:
                        watches.append(called)

                suggestion = {
                    'id': cluster_id,
                    'entry': method.name,
                    'watches': watches,
                    'file': result.file,
                    'module': result.module,
                    'stack': 'python',
                    'fingerprintLevel': 'entry',
                    'branchCount': method.branch_count,
                    'isPure': method.is_pure,
                    'isMethod': True,
                    'className': class_name,
                    'multiArgs': len(method.args) > 1,
                    'args': method.args,
                    'suggestedInputs': f"Instance of {class_name} needed",
                    'coverageNote': f"Has {method.branch_count} branch(es)" if method.branch_count else 'All paths covered with single input',
                }
                suggestions.append(suggestion)

    return suggestions


def _group_methods_by_domain(methods: list[FunctionInfo]) -> dict[str, list[FunctionInfo]]:
    """Group class methods into domain buckets based on naming patterns.

    This heuristic identifies common domain patterns in god classes:
    - construction: __init__, build, create, from_*
    - query: get, find, detect, check, is_, has_, count, search
    - transform: up, down, sharp, flat, transpose, invert, reverse, normalize
    - filter: filter, remove, clear, keep, select, pick, only
    - time: cut, split, bar, beat, time, tempo, rhythm
    - io: read, write, load, save, export, import, parse, to_*
    - modify: set, add, insert, append, extend, replace, update, reset
    - analyze: analyze, compare, compare, similarity, detect, interval
    """
    groups: dict[str, list[FunctionInfo]] = {}
    domain_patterns = {
        'query': ['get', 'find', 'detect', 'check', 'is_', 'has_', 'count', 'search', 'eval'],
        'transform': ['up', 'down', 'sharp', 'flat', 'transpose', 'invert', 'reverse',
                       'normalize', 'modulat', 'retrograde', 'pitch_inversion'],
        'filter': ['filter', 'remove', 'clear', 'keep', 'select', 'pick', 'only',
                    'omit', 'delete'],
        'time': ['cut', 'split', 'bar', 'beat', 'time', 'tempo', 'rhythm',
                  'firstn', 'count_bar', 'fix_length', 'apply_rhythm'],
        'io': ['read', 'write', 'load', 'save', 'export', 'import', 'parse',
                'to_', 'from_', 'serialize', 'deserialize'],
        'modify': ['set', 'add', 'insert', 'append', 'extend', 'replace',
                    'update', 'reset', 'change', 'apply', 'move', 'place'],
        'analyze': ['analyze', 'compar', 'similar', 'interval', 'detect',
                     'notation', 'standard', 'info', 'same'],
    }

    for method in methods:
        name_lower = method.name.lower()
        assigned = False
        for domain, patterns in domain_patterns.items():
            if any(name_lower.startswith(p) or name_lower == p for p in patterns):
                groups.setdefault(domain, []).append(method)
                assigned = True
                break
        if not assigned:
            groups.setdefault('other', []).append(method)

    return groups


def _suggest_constructor_args(init_method: FunctionInfo) -> list:
    """Suggest constructor arguments from __init__ method analysis.

    Returns a list of suggested default values for constructor args,
    based on type annotations and common patterns.
    """
    args = []
    if not init_method:
        return args

    for i, arg_name in enumerate(init_method.args):
        # Skip 'self'
        if arg_name == 'self':
            continue
        # Try to use default value if available
        default_idx = i - (len(init_method.args) - len(init_method.defaults))
        if 0 <= default_idx < len(init_method.defaults) and init_method.defaults[default_idx] is not None:
            args.append(init_method.defaults[default_idx])
        else:
            # No default — provide a type-based placeholder
            args.append(f"<{arg_name}>")

    return args


# ─── File Scanner ───────────────────────────────────────────────────────────

def scan_file(filepath: str, base_dir: str = '') -> ScanResult:
    """Scan a single Python file and return analysis results."""
    with open(filepath, 'r', encoding='utf-8') as f:
        source = f.read()

    tree = ast.parse(source, filename=filepath)
    collector = FunctionCollector()
    collector.visit(tree)

    # Compute module path from file path
    rel_path = os.path.relpath(filepath, base_dir) if base_dir else filepath
    module = os.path.splitext(rel_path)[0].replace(os.sep, '.')
    if module.startswith('.'):
        module = module[1:]

    result = ScanResult(
        file=filepath,
        module=module,
        functions=collector.functions,
        classes=collector.classes,
        suggested_clusters=[],
    )
    result.suggested_clusters.extend(suggest_clusters(result))
    return result


def scan_directory(dirpath: str, recursive: bool = False) -> list[ScanResult]:
    """Scan a directory for Python files."""
    results = []
    if recursive:
        for root, dirs, files in os.walk(dirpath):
            # Skip __pycache__, .git, etc
            dirs[:] = [d for d in dirs if not d.startswith(('.', '__'))]
            for f in files:
                if f.endswith('.py') and not f.startswith('__'):
                    results.append(scan_file(os.path.join(root, f), base_dir=dirpath))
    else:
        for f in os.listdir(dirpath):
            if f.endswith('.py') and not f.startswith('__'):
                full_path = os.path.join(dirpath, f)
                if os.path.isfile(full_path):
                    results.append(scan_file(full_path, base_dir=dirpath))
    return results


# ─── Rendering ─────────────────────────────────────────────────────────────

def render_result(result: ScanResult):
    """Render a scan result to stdout."""
    print(f"\n{'─' * 60}")
    print(f"📁 {result.file}")
    print(f"   Module: {result.module}")

    if not result.functions and not result.classes:
        print("   No functions found.")
        return

    # Show all functions
    print(f"\n   Functions ({len(result.functions)}):")
    for func in result.functions:
        purity = "✅ pure" if func.is_pure else "⚠️  impure"
        branches = f"{func.branch_count} branch(es)" if func.branch_count else "straight-line"
        args_str = ', '.join(func.args) if func.args else "no args"
        calls_str = f" → calls: {', '.join(func.calls)}" if func.calls else ""
        print(f"     {func.name}({args_str})  [{purity}]  [{branches}]{calls_str}")

    # Show classes
    for class_name, methods in result.classes.items():
        print(f"\n   Class {class_name} ({len(methods)} methods):")
        for method in methods:
            purity = "✅ pure" if method.is_pure else "⚠️  impure"
            branches = f"{method.branch_count} branch(es)" if method.branch_count else "straight-line"
            args_str = ', '.join(method.args) if method.args else "no args"
            print(f"     {method.name}({args_str})  [{purity}]  [{branches}]")

    # Show suggested clusters
    if result.suggested_clusters:
        god_class_count = sum(1 for s in result.suggested_clusters if s.get('isGodClass'))
        regular_count = len(result.suggested_clusters) - god_class_count
        print(f"\n   💡 Suggested clusters ({len(result.suggested_clusters)}):"
              f"{f' ({god_class_count} god-class, {regular_count} regular)' if god_class_count else ''}")
        for s in result.suggested_clusters:
            purity = "pure" if s['isPure'] else "impure"
            god_tag = " 🔴 GOD CLASS" if s.get('isGodClass') else ""
            domain_tag = f" [{s['domainHint']}]" if s.get('domainHint') else ""
            print(f"     ┌─ {s['id']}  ({purity}){god_tag}{domain_tag}")
            print(f"     │  entry: {s['entry']}")
            print(f"     │  watches: {s['watches']}")
            print(f"     │  branches: {s['branchCount']}")
            if s.get('instanceMethods'):
                for cls, methods in s['instanceMethods'].items():
                    print(f"     │  instanceMethods: {cls} → {methods}")
            if s.get('constructorArgs'):
                print(f"     │  constructorArgs: {s['constructorArgs']}")
            if s.get('coverageNote'):
                print(f"     │  coverage: {s['coverageNote']}")
            if s.get('args'):
                print(f"     │  args: {s['args']}")
            print(f"     └─ input hint: {s['suggestedInputs']}")


def render_manifest_json(results: list[ScanResult]) -> str:
    """Generate a manifest.json snippet from scan results."""
    clusters = []
    for result in results:
        for s in result.suggested_clusters:
            # Include god-class clusters even if impure (they are anchor clusters)
            if not s['isPure'] and not s.get('isGodClass'):
                continue  # skip impure non-god-class clusters
            cluster = {
                'id': s['id'],
                'entry': s['entry'],
                'watches': s['watches'],
                'file': s['file'],
                'module': s['module'],
                'stack': 'python',
                'fingerprintLevel': 'entry',
                'description': f"Auto-suggested cluster for {s['entry']}",
            }
            if s.get('multiArgs'):
                cluster['multiArgs'] = True
            if s.get('isGodClass'):
                cluster['_isGodClass'] = True
                if s.get('constructor'):
                    cluster['constructor'] = s['constructor']
                if s.get('constructorArgs'):
                    cluster['constructorArgs'] = s['constructorArgs']
                if s.get('instanceMethods'):
                    cluster['instanceMethods'] = s['instanceMethods']
                if s.get('domainHint'):
                    cluster['_domainHint'] = s['domainHint']
            if s['branchCount'] > 0:
                cluster['_coverageNote'] = s['coverageNote']
            clusters.append(cluster)

    return json.dumps({'clusters': clusters}, indent=2, ensure_ascii=False)


# ─── CLI ────────────────────────────────────────────────────────────────────

def main():
    args = sys.argv[1:]
    if not args:
        print("""
regret scan — Source code cluster scanner

Usage:
  python scripts/scan.py <file_or_directory>     Scan a Python file or directory
  python scripts/scan.py <path> --recursive       Scan recursively
  python scripts/scan.py <path> --manifest        Output as manifest.json snippet

Analyzes Python source files and suggests:
  - Which functions to cluster
  - Which functions to watch
  - How many branches need coverage
  - Whether functions are pure (ideal for fingerprinting)

This helps agents set up Regrets on new projects without guessing.
""")
        sys.exit(0)

    target = args[0]
    recursive = '--recursive' in args
    as_manifest = '--manifest' in args

    if not os.path.exists(target):
        print(f"❌ Path not found: {target}")
        sys.exit(1)

    results = []

    if os.path.isfile(target):
        results.append(scan_file(target))
    elif os.path.isdir(target):
        results = scan_directory(target, recursive=recursive)
    else:
        print(f"❌ Not a file or directory: {target}")
        sys.exit(1)

    if as_manifest:
        print(render_manifest_json(results))
    else:
        total_funcs = sum(len(r.functions) for r in results)
        total_classes = sum(len(r.classes) for r in results)
        total_suggestions = sum(len(r.suggested_clusters) for r in results)
        pure_suggestions = sum(
            1 for r in results for s in r.suggested_clusters if s['isPure']
        )
        impure_suggestions = total_suggestions - pure_suggestions

        print(f"\n🔍 Scan Results: {len(results)} file(s)")
        print(f"   {total_funcs} functions, {total_classes} classes")
        print(f"   {total_suggestions} cluster suggestions ({pure_suggestions} pure, {impure_suggestions} impure)")

        for result in results:
            render_result(result)

        if pure_suggestions > 0:
            print(f"\n💡 To generate a manifest.json, run:")
            print(f"   python scripts/scan.py {target} --manifest > regrets/manifest.json")


if __name__ == '__main__':
    main()

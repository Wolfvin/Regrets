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
    line_count: int  # number of lines in function body
    mutates_args: bool  # whether function mutates its input arguments in-place
    mutation_details: list[str]  # which args are mutated and how


class ScanResult(NamedTuple):
    file: str
    module: str
    functions: list[FunctionInfo]
    classes: dict[str, list[FunctionInfo]]
    suggested_clusters: list[dict]
    dead_imports: list[tuple[str, int]]  # (import_name, line_number) of unused imports
    oversized_functions: list[tuple[str, int, int]]  # (name, lineno, line_count) for fns > 30 lines


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
        self._imported_names: dict[str, int] = {}  # name → line_number
        self._used_names: set[str] = set()

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

    def _detect_arg_mutations(self, node, arg_names):
        """Detect in-place mutations of function arguments.

        Catches patterns like:
          - arg[key] = value       (Subscript assignment)
          - arg.append(...)        (list mutation)
          - arg.extend(...)        (list mutation)
          - arg.insert(...)        (list mutation)
          - arg.pop(...)           (list/dict mutation)
          - arg.update(...)        (dict mutation)
          - arg[key].append(...)   (nested mutation)
          - arg.setdefault(...)    (dict mutation)
          - for x in arg: x[key] = value  (iterated element mutation)

        Returns (mutates: bool, details: list[str])
        """
        if not arg_names:
            return False, []

        mutations = []
        arg_set = set(arg_names)

        # First pass: find loop variables that iterate over arguments
        # e.g., "for x in arg:" means x is a proxy for arg items
        loop_vars_over_args = {}  # loop_var → arg_name
        for child in ast.walk(node):
            if isinstance(child, ast.For):
                # Check if iterating over an argument
                if isinstance(child.iter, ast.Name) and child.iter.id in arg_set:
                    if isinstance(child.target, ast.Name):
                        loop_vars_over_args[child.target.id] = child.iter.id
                # Also catch enumerate(arg) and arg.items() etc.
                elif isinstance(child.iter, ast.Call):
                    if isinstance(child.iter.func, ast.Name) and child.iter.func.id == 'enumerate':
                        if child.iter.args and isinstance(child.iter.args[0], ast.Name):
                            if child.iter.args[0].id in arg_set:
                                # for i, x in enumerate(arg):
                                if isinstance(child.target, ast.Tuple):
                                    for elt in child.target.elts:
                                        if isinstance(elt, ast.Name):
                                            loop_vars_over_args[elt.id] = child.iter.args[0].id

        # Extend arg_set with loop variables (they are proxies for arg items)
        effective_arg_set = arg_set | set(loop_vars_over_args.keys())

        for child in ast.walk(node):
            # Pattern 1: arg[key] = value  (Subscript assignment on an argument)
            if isinstance(child, ast.Assign):
                for target in child.targets:
                    if isinstance(target, ast.Subscript):
                        if isinstance(target.value, ast.Name) and target.value.id in effective_arg_set:
                            var_name = target.value.id
                            # Map loop variable back to the original arg
                            original_arg = loop_vars_over_args.get(var_name, var_name)
                            mutations.append(f"{original_arg}[...] = ... (via {var_name})")

            # Pattern 2: arg.append/extend/insert/pop/update/setdefault/clear/remove
            if isinstance(child, ast.Call):
                if isinstance(child.func, ast.Attribute):
                    method_name = child.func.attr
                    mutating_methods = {
                        'append', 'extend', 'insert', 'pop', 'remove',
                        'update', 'setdefault', 'clear', 'sort', 'reverse',
                    }
                    if method_name in mutating_methods:
                        if isinstance(child.func.value, ast.Name):
                            obj_name = child.func.value.id
                            if obj_name in effective_arg_set:
                                original_arg = loop_vars_over_args.get(obj_name, obj_name)
                                mutations.append(f"{original_arg}.{method_name}(...)")

                        # Also catch arg[key].mutating_method(...)
                        if isinstance(child.func.value, ast.Subscript):
                            if isinstance(child.func.value.value, ast.Name):
                                obj_name = child.func.value.value.id
                                if obj_name in effective_arg_set:
                                    original_arg = loop_vars_over_args.get(obj_name, obj_name)
                                    mutations.append(f"{original_arg}[...].{method_name}(...)")

        # Deduplicate
        mutations = list(dict.fromkeys(mutations))
        return bool(mutations), mutations

    def _collect_imports(self, tree):
        """Collect all import names and their line numbers."""
        for node in ast.walk(tree):
            if isinstance(node, ast.Import):
                for alias in node.names:
                    name = alias.asname if alias.asname else alias.name
                    self._imported_names[name] = node.lineno
            elif isinstance(node, ast.ImportFrom):
                for alias in node.names:
                    name = alias.asname if alias.asname else alias.name
                    self._imported_names[name] = node.lineno

    def _collect_used_names(self, tree):
        """Collect all names that are actually used (referenced) in the module."""
        for node in ast.walk(tree):
            if isinstance(node, ast.Name) and isinstance(node.ctx, ast.Load):
                self._used_names.add(node.id)
            elif isinstance(node, ast.Attribute):
                # For module.function calls, mark the module name as used
                if isinstance(node.value, ast.Name):
                    self._used_names.add(node.value.id)
            elif isinstance(node, ast.Call):
                # For decorated functions or direct calls
                if isinstance(node.func, ast.Name):
                    self._used_names.add(node.func.id)

    def get_dead_imports(self):
        """Return imported names that are never used in the module."""
        dead = []
        # Don't flag these common "used by tooling" imports
        allowed_unused = {'__all__', '__version__'}
        for name, lineno in self._imported_names.items():
            if name not in self._used_names and name not in allowed_unused:
                dead.append((name, lineno))
        return sorted(dead, key=lambda x: x[1])

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

        # Compute line count
        line_count = 0
        if hasattr(node, 'end_lineno') and node.end_lineno:
            line_count = node.end_lineno - node.lineno + 1

        # Detect argument mutations
        mutates_args, mutation_details = self._detect_arg_mutations(node, args)

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
            line_count=line_count,
            mutates_args=mutates_args,
            mutation_details=mutation_details,
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
            'lineCount': func.line_count,
            'mutatesArgs': func.mutates_args,
            'mutationDetails': func.mutation_details,
            'sizeWarning': f"Function is {func.line_count} lines — consider extracting sub-functions before clustering" if func.line_count > 30 else None,
            'mutationWarning': f"Mutates args in-place: {', '.join(func.mutation_details)} — wrap with deep_copy before fingerprinting" if func.mutates_args else None,
        }
        suggestions.append(suggestion)

    # Also suggest clusters from class methods that look like pure operations
    for class_name, methods in result.classes.items():
        for method in methods:
            if method.name.startswith('_'):
                continue
            if not method.is_pure:
                continue

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


# ─── File Scanner ───────────────────────────────────────────────────────────

def scan_file(filepath: str, base_dir: str = '') -> ScanResult:
    """Scan a single Python file and return analysis results."""
    with open(filepath, 'r', encoding='utf-8') as f:
        source = f.read()

    tree = ast.parse(source, filename=filepath)
    collector = FunctionCollector()
    collector.visit(tree)

    # Collect imports and usage for dead import detection
    collector._collect_imports(tree)
    collector._collect_used_names(tree)

    # Compute module path from file path
    rel_path = os.path.relpath(filepath, base_dir) if base_dir else filepath
    module = os.path.splitext(rel_path)[0].replace(os.sep, '.')
    if module.startswith('.'):
        module = module[1:]

    # Find oversized functions (> 30 lines)
    oversized = []
    for func in collector.functions:
        if func.line_count > 30:
            oversized.append((func.name, func.lineno, func.line_count))
    for class_name, methods in collector.classes.items():
        for method in methods:
            if method.line_count > 30:
                oversized.append((f"{class_name}.{method.name}", method.lineno, method.line_count))

    result = ScanResult(
        file=filepath,
        module=module,
        functions=collector.functions,
        classes=collector.classes,
        suggested_clusters=[],
        dead_imports=collector.get_dead_imports(),
        oversized_functions=oversized,
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
        size_flag = f" 📏{func.line_count}L" if func.line_count > 30 else ""
        mutation_flag = ""
        if func.mutates_args:
            mutation_flag = f" 🔄mutates({', '.join(func.mutation_details[:3])})"
        print(f"     {func.name}({args_str})  [{purity}]  [{branches}]{size_flag}{mutation_flag}{calls_str}")

    # Show classes
    for class_name, methods in result.classes.items():
        print(f"\n   Class {class_name} ({len(methods)} methods):")
        for method in methods:
            purity = "✅ pure" if method.is_pure else "⚠️  impure"
            branches = f"{method.branch_count} branch(es)" if method.branch_count else "straight-line"
            args_str = ', '.join(method.args) if method.args else "no args"
            size_flag = f" 📏{method.line_count}L" if method.line_count > 30 else ""
            mutation_flag = ""
            if method.mutates_args:
                mutation_flag = f" 🔄mutates({', '.join(method.mutation_details[:3])})"
            print(f"     {method.name}({args_str})  [{purity}]  [{branches}]{size_flag}{mutation_flag}")

    # Show suggested clusters
    if result.suggested_clusters:
        print(f"\n   💡 Suggested clusters ({len(result.suggested_clusters)}):")
        for s in result.suggested_clusters:
            purity = "pure" if s['isPure'] else "impure"
            print(f"     ┌─ {s['id']}  ({purity})")
            print(f"     │  entry: {s['entry']}")
            print(f"     │  watches: {s['watches']}")
            print(f"     │  branches: {s['branchCount']}")
            if s.get('coverageNote'):
                print(f"     │  coverage: {s['coverageNote']}")
            if s.get('args'):
                print(f"     │  args: {s['args']}")
            print(f"     └─ input hint: {s['suggestedInputs']}")

    # Show dead imports
    if result.dead_imports:
        print(f"\n   🧹 Dead imports ({len(result.dead_imports)}):")
        for name, lineno in result.dead_imports:
            print(f"     ⚠️  Line {lineno}: '{name}' imported but never used")

    # Show oversized functions
    if result.oversized_functions:
        print(f"\n   📏 Oversized functions >30 lines ({len(result.oversized_functions)}):")
        for name, lineno, line_count in result.oversized_functions:
            print(f"     ⚠️  {name} at line {lineno}: {line_count} lines — consider extracting sub-functions before clustering")


def render_manifest_json(results: list[ScanResult]) -> str:
    """Generate a manifest.json snippet from scan results."""
    clusters = []
    for result in results:
        for s in result.suggested_clusters:
            if not s['isPure']:
                continue  # only suggest pure functions as clusters
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

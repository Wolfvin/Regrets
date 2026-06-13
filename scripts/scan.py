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


# ─── God Module Detection ──────────────────────────────────────────────────

GOD_MODULE_LINE_THRESHOLD = 300  # files above this line count are flagged
GOD_MODULE_FUNC_THRESHOLD = 15   # files with more than this many functions are flagged


def detect_god_module(filepath: str, result: ScanResult) -> dict | None:
    """Detect if a file is a 'god module' that needs decomposition.

    A god module is a single file that contains too many functions/classes
    mixing multiple domains. This analysis:
    1. Counts total lines and functions
    2. Groups class methods by their call patterns (domain inference)
    3. Suggests decomposition boundaries

    Returns None if the file is not a god module.
    """
    try:
        with open(filepath, 'r', encoding='utf-8') as f:
            source = f.read()
        line_count = len(source.splitlines())
    except Exception:
        line_count = 0

    # Count all functions and methods
    all_funcs = list(result.functions)
    for methods in result.classes.values():
        all_funcs.extend(methods)

    total_funcs = len(all_funcs)

    if line_count < GOD_MODULE_LINE_THRESHOLD and total_funcs < GOD_MODULE_FUNC_THRESHOLD:
        return None

    # Build call graph for domain grouping
    # Strategy: group functions that call each other into the same domain
    call_graph = {}
    for func in all_funcs:
        call_graph[func.name] = {
            'calls': func.calls,
            'called_by': [],
            'is_method': func.is_method,
            'is_pure': func.is_pure,
            'branch_count': func.branch_count,
        }

    # Build reverse call graph (who calls whom)
    for func in all_funcs:
        for called in func.calls:
            if called in call_graph:
                call_graph[called]['called_by'].append(func.name)

    # Group functions into domains using call-graph connectivity
    visited = set()
    domains = []

    for func in all_funcs:
        if func.name in visited:
            continue
        # BFS to find all connected functions
        domain = set()
        queue = [func.name]
        while queue:
            current = queue.pop(0)
            if current in visited:
                continue
            visited.add(current)
            domain.add(current)
            # Add functions this one calls
            if current in call_graph:
                for called in call_graph[current]['calls']:
                    if called in call_graph and called not in visited:
                        queue.append(called)
                # Add functions that call this one
                for caller in call_graph[current]['called_by']:
                    if caller in call_graph and caller not in visited:
                        queue.append(caller)

        if domain:
            domains.append(domain)

    # Name each domain by finding the most-called function (likely the entry point)
    domain_info = []
    for domain in domains:
        domain_funcs = []
        for fn_name in domain:
            if fn_name in call_graph:
                info = call_graph[fn_name]
                domain_funcs.append({
                    'name': fn_name,
                    'is_method': info['is_method'],
                    'is_pure': info['is_pure'],
                    'branch_count': info['branch_count'],
                    'calls': [c for c in info['calls'] if c in domain],
                    'called_by': [c for c in info['called_by'] if c in domain],
                })

        # Find entry point: function called by most others in domain, or
        # the public function with the most branches
        best_entry = None
        best_score = -1
        for f in domain_funcs:
            if f['name'].startswith('_'):
                continue
            score = len(f['called_by']) * 10 + f['branch_count']
            if score > best_score:
                best_score = score
                best_entry = f['name']

        if not best_entry and domain_funcs:
            best_entry = domain_funcs[0]['name']

        # Generate domain name from entry function
        domain_name = best_entry or 'misc'
        for c in domain_name:
            if c.isupper() and domain_name:
                domain_name = domain_name.replace(c, '-' + c.lower())
        domain_name = domain_name.lower().replace('_', '-').lstrip('-')

        domain_info.append({
            'name': domain_name,
            'entry': best_entry,
            'functions': domain_funcs,
            'function_count': len(domain_funcs),
            'total_branches': sum(f['branch_count'] for f in domain_funcs),
            'pure_count': sum(1 for f in domain_funcs if f['is_pure']),
            'impure_count': sum(1 for f in domain_funcs if not f['is_pure']),
        })

    # Sort domains by size (largest first)
    domain_info.sort(key=lambda d: d['function_count'], reverse=True)

    return {
        'filepath': filepath,
        'module': result.module,
        'line_count': line_count,
        'total_functions': total_funcs,
        'total_classes': len(result.classes),
        'class_names': list(result.classes.keys()),
        'domains': domain_info,
        'domain_count': len(domain_info),
        'decomposition_needed': True,
        'decomposition_reason': (
            f'{line_count} lines, {total_funcs} functions — '
            f'should be split into {len(domain_info)} domain modules'
        ),
    }


def render_god_module_analysis(analysis: dict):
    """Render god module decomposition analysis to stdout."""
    print(f"\n{'━' * 60}")
    print(f"🔴 GOD MODULE DETECTED")
    print(f"{'━' * 60}")
    print(f"   File: {analysis['filepath']}")
    print(f"   Module: {analysis['module']}")
    print(f"   Lines: {analysis['line_count']}")
    print(f"   Functions: {analysis['total_functions']}")
    print(f"   Classes: {analysis['total_classes']} ({', '.join(analysis['class_names'])})")
    print(f"   Domains identified: {analysis['domain_count']}")
    print(f"\n   📋 {analysis['decomposition_reason']}")

    for i, domain in enumerate(analysis['domains'], 1):
        print(f"\n   Domain {i}: {domain['name']}")
        print(f"     Functions: {domain['function_count']} ({domain['pure_count']} pure, {domain['impure_count']} impure)")
        print(f"     Total branches: {domain['total_branches']}")
        if domain['entry']:
            print(f"     Suggested entry: {domain['entry']}")
        func_names = [f['name'] for f in domain['functions']]
        if len(func_names) <= 10:
            print(f"     Members: {', '.join(func_names)}")
        else:
            print(f"     Members: {', '.join(func_names[:10])}, ... (+{len(func_names) - 10} more)")

    print(f"\n   💡 Decomposition strategy:")
    print(f"      1. Create cluster for each domain's entry function BEFORE refactoring")
    print(f"      2. Run 'regret capture' + 'regret validate' — all must be GREEN")
    print(f"      3. Save truths: 'regret truth'")
    print(f"      4. Move each domain to its own module")
    print(f"      5. Add re-exports in __init__.py to preserve public API")
    print(f"      6. Run 'regret validate' — must still be GREEN")


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

    target = args[0] if args else None
    recursive = '--recursive' in args
    as_manifest = '--manifest' in args
    decompose = '--decompose' in args

    if not target or target.startswith('--'):
        print("""
regret scan — Source code cluster scanner

Usage:
  python scripts/scan.py <file_or_directory>     Scan a Python file or directory
  python scripts/scan.py <path> --recursive       Scan recursively
  python scripts/scan.py <path> --manifest        Output as manifest.json snippet
  python scripts/scan.py <path> --decompose       Detect god modules and suggest decomposition

Analyzes Python source files and suggests:
  - Which functions to cluster
  - Which functions to watch
  - How many branches need coverage
  - Whether functions are pure (ideal for fingerprinting)
  - Whether the file is a god module that needs decomposition
""")
        sys.exit(0)

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

    # God module decomposition analysis
    if decompose:
        print('\n🔍 God Module Decomposition Analysis\n')
        found_god_modules = False
        for result in results:
            analysis = detect_god_module(result.file, result)
            if analysis:
                found_god_modules = True
                render_god_module_analysis(analysis)
        if not found_god_modules:
            print('\n✅ No god modules detected. All files are within healthy size limits.')
        sys.exit(0)

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

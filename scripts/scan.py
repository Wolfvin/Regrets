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
    non_serializable_return: bool  # returns numpy, cv2, openpyxl, etc.
    docstring: str  # first line of docstring, if any
    flow_annotations: dict  # @FLOW, @CALLS, @MUTATES, @BEHAVIOR from docstring


class ScanResult(NamedTuple):
    file: str
    module: str
    functions: list[FunctionInfo]
    classes: dict[str, list[FunctionInfo]]
    suggested_clusters: list[dict]
    dead_imports: list[tuple[str, int]]  # (import_name, line_number) of unused imports
    oversized_functions: list[tuple[str, int, int]]  # (name, lineno, line_count) for fns > 30 lines
    lambdas: list[tuple[str, FunctionInfo]] = []  # (var_name, info) for lambda assignments


# ─── AST Analysis ───────────────────────────────────────────────────────────

class FunctionCollector(ast.NodeVisitor):
    """Collect function definitions and their call relationships."""

    def __init__(self):
        self.functions: list[FunctionInfo] = []
        self.classes: dict[str, list[FunctionInfo]] = {}
        self.lambdas: list[tuple[str, 'FunctionInfo']] = []  # (var_name, info)
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
        """Heuristic purity check: no global, nonlocal, open, print, etc.

        Also flags functions that call `print()` as impure since they
        produce observable side effects (stdout), which matters for
        fingerprint stability in OCR/pipeline projects that use print()
        for timing/logging.

        Extended to detect time-dependent impurity:
        - time.localtime(), time.time(), time.gmtime()
        - datetime.now(), datetime.today()
        - datetime.datetime.now(), datetime.datetime.today()

        These functions produce non-deterministic output, which makes
        fingerprinting unreliable unless freezeTime is used.
        """
        impurities = 0
        impure_names = {
            'open', 'print', 'input', 'exec', 'eval',
            'urllib', 'requests', 'http', 'socket',
            'os.system', 'subprocess', 'shutil',
        }
        # Time-dependent calls that make functions impure
        time_impure_attrs = {
            'localtime', 'time', 'gmtime', 'asctime', 'ctime',
        }
        time_impure_module_attrs = {
            'now', 'today', 'utcnow',
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
                    # time.localtime(), time.time(), time.gmtime() = impure
                    if child.func.attr in time_impure_attrs:
                        if isinstance(child.func.value, ast.Name) and child.func.value.id == 'time':
                            impurities += 1
                    # datetime.now(), datetime.today() = impure
                    if child.func.attr in time_impure_module_attrs:
                        if isinstance(child.func.value, ast.Name) and child.func.value.id in ('datetime', 'dt'):
                            impurities += 1
                        # Also catch datetime.datetime.now()
                        if isinstance(child.func.value, ast.Attribute):
                            if child.func.value.attr in ('datetime', 'date', 'time'):
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

    def _check_non_serializable_return(self, node):
        """Heuristic: detect if a function likely returns a non-JSON-serializable type.

        Checks for:
        - Return type annotations referencing numpy, cv2, openpyxl, PIL, torch
        - Return statements that construct objects from these libraries
        - Variables assigned from these libraries being returned

        This matters because Regrets can't fingerprint non-serializable outputs
        without an outputTransform.
        """
        non_serializable_indicators = {
            'np', 'numpy', 'cv2', 'openpyxl', 'Workbook', 'Worksheet',
            'Image', 'PIL', 'torch', 'Tensor', 'ndarray', 'array',
        }

        # Check return annotation
        if node.returns:
            return_str = ast.dump(node.returns)
            for indicator in non_serializable_indicators:
                if indicator in return_str:
                    return True

        # Check if any return statement returns a call to non-serializable constructor
        for child in ast.walk(node):
            if isinstance(child, ast.Return) and child.value:
                # Direct construction: return np.array(...) / return Workbook(...)
                if isinstance(child.value, ast.Call):
                    if isinstance(child.value.func, ast.Name):
                        if child.value.func.id in non_serializable_indicators:
                            return True
                    if isinstance(child.value.func, ast.Attribute):
                        if child.value.func.attr in ('array', 'ndarray', 'Workbook', 'open', 'imread', 'fromarray'):
                            return True

        return False

    def _detect_arg_mutations(self, node, arg_names):
        """Detect in-place mutations of function arguments.

        Catches patterns like:
          - arg[key] = value       (Subscript assignment)
          - arg.append(...)        (list mutation)
          - arg.extend(...)        (list mutation)
          - arg.update(...)        (dict mutation)
          - arg.insert(...)        (list mutation)
          - arg.pop(...)           (list/dict mutation)
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
        non_serializable = self._check_non_serializable_return(node)

        # Compute line count
        line_count = 0
        if hasattr(node, 'end_lineno') and node.end_lineno:
            line_count = node.end_lineno - node.lineno + 1

        # Detect argument mutations
        mutates_args, mutation_details = self._detect_arg_mutations(node, args)

        # Extract docstring annotations
        docstring = ast.get_docstring(node) or ''
        flow_annotations = _parse_flow_annotations(docstring)

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
            non_serializable_return=non_serializable,
            docstring=docstring.split('\n')[0] if docstring else '',
            flow_annotations=flow_annotations,
        )

        if self._current_class:
            self.classes[self._current_class].append(func_info)
        else:
            self.functions.append(func_info)

        self._current_function = old_func

    visit_AsyncFunctionDef = visit_FunctionDef

    def visit_Assign(self, node):
        """Detect lambda assignments like: my_func = lambda x: x + 1

        Many Python libraries (especially scientific/niche ones) use lambda
        assignments instead of def statements. The AST visitor for FunctionDef
        won't catch these, so we need explicit handling.

        This addresses the gap found in PyJHora's house.py where ~30 key
        functions are lambda-assigned (e.g., quadrants_of_the_raasi = lambda raasi: [...]).
        """
        # Only handle simple assignments (single target, lambda value)
        if not isinstance(node.value, ast.Lambda):
            return
        if len(node.targets) != 1:
            return
        target = node.targets[0]
        if not isinstance(target, ast.Name):
            return

        var_name = target.id
        if var_name.startswith('_'):
            return

        lam = node.value

        # Collect info from the lambda
        args = [a.arg for a in lam.args.args if a.arg != 'self']
        defaults = [ast.literal_eval(d) if isinstance(d, ast.Constant) else None for d in lam.args.defaults]
        calls = self._collect_calls(lam)
        branches = self._count_branches(lam)
        is_pure = self._check_purity(lam)

        func_info = FunctionInfo(
            name=var_name,
            lineno=node.lineno,
            args=args,
            defaults=defaults,
            has_return_annotation=False,
            is_method=False,
            decorators=[],
            calls=calls,
            branch_count=branches,
            is_pure=is_pure,
        )
        self.lambdas.append((var_name, func_info))


# ─── Flow Annotation Parsing ────────────────────────────────────────────────────

def _parse_flow_annotations(docstring: str) -> dict:
    """Parse @FLOW, @CALLS, @MUTATES, @BEHAVIOR, @ENTRY annotations from docstrings.

    Many Python projects (especially OCR/data pipelines) use structured docstring
    annotations to document function contracts:
      @FLOW:     PIPELINE_MAIN > PARSE_AMOUNTS
      @CALLS:    re (stdlib)
      @MUTATES:  nothing (pure function)
      @BEHAVIOR: Converts IDR-formatted string to float.
      @ENTRY:    parse_idr()

    These annotations are extremely valuable for Regrets because:
    - @MUTATES: nothing → confirms purity
    - @CALLS: → reveals internal call graph for watches
    - @BEHAVIOR: → describes the contract being tested
    - @ENTRY: → identifies the entry function for a module
    """
    annotations = {}
    if not docstring:
        return annotations

    tag_patterns = {
        'FLOW': r'@FLOW:\s*(.+)',
        'CALLS': r'@CALLS:\s*(.+)',
        'MUTATES': r'@MUTATES:\s*(.+)',
        'BEHAVIOR': r'@BEHAVIOR:\s*(.+)',
        'ENTRY': r'@ENTRY:\s*(.+)',
    }
    import re
    for tag, pattern in tag_patterns.items():
        match = re.search(pattern, docstring)
        if match:
            annotations[tag] = match.group(1).strip()
    return annotations


# ─── sys.path.insert Detection ────────────────────────────────────────────────

def detect_sys_path_inserts(filepath: str) -> list[str]:
    """Detect sys.path.insert(0, ...) calls in a Python file.

    Many Python projects use sys.path.insert to make shared modules importable.
    When Regrets runs capture/validate, it needs to set pythonPath in the manifest
    to match these insertions.

    Returns list of directory paths that the file adds to sys.path.
    """
    import re
    with open(filepath, 'r', encoding='utf-8') as f:
        source = f.read()

    paths = []
    # Match patterns like: sys.path.insert(0, str(Path(__file__).parent.parent))
    # or: sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))
    # or: sys.path.insert(0, 'some/path')
    for match in re.finditer(r'sys\.path\.insert\([^,]+,\s*(.+?)\)', source):
        path_expr = match.group(1).strip()
        paths.append(path_expr)

    return paths


def compute_python_path_suggestion(filepath: str, base_dir: str) -> str:
    """Compute the pythonPath suggestion for a file based on its sys.path.insert calls.

    Returns the most likely directory that should be used as pythonPath in manifest.
    """
    inserts = detect_sys_path_inserts(filepath)
    if not inserts:
        return ''

    # The most common pattern is: sys.path.insert(0, str(Path(__file__).parent.parent))
    # which means the pythonPath should be the parent of the file's directory
    file_dir = os.path.dirname(os.path.abspath(filepath))
    parent_dir = os.path.dirname(file_dir)
    rel = os.path.relpath(parent_dir, base_dir) if base_dir else parent_dir
    return rel


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

        # Use @BEHAVIOR annotation as description if available
        description = func.flow_annotations.get('BEHAVIOR', '')
        # Use @MUTATES annotation to confirm/override purity
        mutates_note = func.flow_annotations.get('MUTATES', '')
        if mutates_note and 'nothing' in mutates_note.lower() and 'pure' in mutates_note.lower():
            is_pure_confirmed = True
        else:
            is_pure_confirmed = func.is_pure

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
            'isPureConfirmed': is_pure_confirmed,
            'multiArgs': multi_args,
            'args': func.args,
            'suggestedInputs': input_note,
            'coverageNote': branch_note if branch_note else 'All paths covered with single input',
            'description': description,
            'flowAnnotations': func.flow_annotations if func.flow_annotations else None,
            'lineCount': func.line_count,
            'mutatesArgs': func.mutates_args,
            'mutationDetails': func.mutation_details,
            'sizeWarning': f"Function is {func.line_count} lines — consider extracting sub-functions before clustering" if func.line_count > 30 else None,
            'mutationWarning': f"Mutates args in-place: {', '.join(func.mutation_details)} — wrap with deep_copy before fingerprinting" if func.mutates_args else None,
        }
        if func.non_serializable_return:
            suggestion['nonSerializableReturn'] = True
            suggestion['warning'] = 'Needs outputTransform — returns non-JSON-serializable type'
        # If impure due to time dependency, suggest freezeTime
        if not func.is_pure:
            # Check for time-related calls
            time_calls = [c for c in func.calls if c in ('localtime', 'time', 'gmtime', 'now', 'today', 'utcnow')]
            if time_calls:
                suggestion['timeDependent'] = True
                suggestion['freezeTimeHint'] = f"Uses {', '.join(time_calls)} — add freezeTime to manifest for deterministic fingerprinting"
            else:
                suggestion['timeDependent'] = False
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

            description = method.flow_annotations.get('BEHAVIOR', '')

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
                'description': description,
                'flowAnnotations': method.flow_annotations if method.flow_annotations else None,
            }
            suggestions.append(suggestion)

    # Also suggest clusters from lambda-assigned functions
    # Many scientific/niche libraries use lambda assignments (e.g., PyJHora's house.py)
    for var_name, lam_info in result.lambdas:
        if not lam_info.is_pure:
            continue

        # Convert camelCase/PascalCase variable name to kebab-case cluster ID
        cluster_id = ''
        for c in var_name:
            if c.isupper() and cluster_id:
                cluster_id += '-'
            cluster_id += c.lower()

        watches = [var_name]
        for called in lam_info.calls:
            if called in all_func_names and called != var_name:
                watches.append(called)

        suggestion = {
            'id': cluster_id,
            'entry': var_name,
            'watches': watches,
            'file': result.file,
            'module': result.module,
            'stack': 'python',
            'fingerprintLevel': 'entry',
            'branchCount': lam_info.branch_count,
            'isPure': lam_info.is_pure,
            'isLambda': True,
            'multiArgs': len(lam_info.args) > 1,
            'args': lam_info.args,
            'suggestedInputs': f"Lambda function — provide input for args: {', '.join(lam_info.args)}" if lam_info.args else "Provide at least one input",
            'coverageNote': f"Has {lam_info.branch_count} branch(es)" if lam_info.branch_count else 'All paths covered with single input',
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
        functions=collector.functions + [info for _, info in collector.lambdas],
        classes=collector.classes,
        suggested_clusters=[],
        dead_imports=collector.get_dead_imports(),
        oversized_functions=oversized,
        lambdas=collector.lambdas,
    )
    result.suggested_clusters.extend(suggest_clusters(result))

    # Detect sys.path.insert calls and attach pythonPath suggestion
    python_path_suggestion = compute_python_path_suggestion(filepath, base_dir)
    if python_path_suggestion:
        for s in result.suggested_clusters:
            s['pythonPath'] = python_path_suggestion

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

def render_result(result: ScanResult, pure_only: bool = False):
    """Render a scan result to stdout."""
    print(f"\n{'─' * 60}")
    print(f"📁 {result.file}")
    print(f"   Module: {result.module}")

    if not result.functions and not result.classes:
        print("   No functions found.")
        return

    # Show all functions
    displayed_funcs = [f for f in result.functions if not pure_only or f.is_pure]
    print(f"\n   Functions ({len(displayed_funcs)}{' of ' + str(len(result.functions)) if pure_only else ''}):")
    for func in displayed_funcs:
        purity = "✅ pure" if func.is_pure else "⚠️  impure"
        branches = f"{func.branch_count} branch(es)" if func.branch_count else "straight-line"
        args_str = ', '.join(func.args) if func.args else "no args"
        serializable = "" if not func.non_serializable_return else " 🔴non-serializable"
        mutation = "" if not func.mutates_args else " 🔴mutates-args"
        size = f" {func.line_count}L" if func.line_count > 30 else ""
        calls_str = f" → calls: {', '.join(func.calls)}" if func.calls else ""
        docstring_str = f"  📝 {func.docstring[:60]}" if func.docstring else ""
        flow_str = f"  🏷️ @{','.join(func.flow_annotations.keys())}" if func.flow_annotations else ""
        size_flag = f" 📏{func.line_count}L" if func.line_count > 30 else ""
        mutation_flag = ""
        if func.mutates_args:
            mutation_flag = f" 🔄mutates({', '.join(func.mutation_details[:3])})"
        print(f"     {func.name}({args_str})  [{purity}]{serializable}{mutation}  [{branches}]{size_flag}{mutation_flag}{calls_str}{docstring_str}{flow_str}")
        if func.mutation_details:
            for det in func.mutation_details[:3]:
                print(f"       ⚠️  mutates: {det}")

    # Show classes
    for class_name, methods in result.classes.items():
        print(f"\n   Class {class_name} ({len(methods)} methods):")
        for method in methods:
            purity = "✅ pure" if method.is_pure else "⚠️  impure"
            branches = f"{method.branch_count} branch(es)" if method.branch_count else "straight-line"
            args_str = ', '.join(method.args) if method.args else "no args"
            docstring_str = f"  📝 {method.docstring[:60]}" if method.docstring else ""
            size_flag = f" 📏{method.line_count}L" if method.line_count > 30 else ""
            mutation_flag = ""
            if method.mutates_args:
                mutation_flag = f" 🔄mutates({', '.join(method.mutation_details[:3])})"
            print(f"     {method.name}({args_str})  [{purity}]  [{branches}]{size_flag}{mutation_flag}{docstring_str}")

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
            if s.get('warning'):
                print(f"     │  ⚠️  {s['warning']}")
            if s.get('description'):
                print(f"     │  description: {s['description']}")
            if s.get('pythonPath'):
                print(f"     │  pythonPath: {s['pythonPath']}")
            if s.get('flowAnnotations'):
                tags = ', '.join(f"@{k}" for k in s['flowAnnotations'].keys())
                print(f"     │  flow: {tags}")
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


def render_manifest_json(results: list[ScanResult], pure_only: bool = True) -> str:
    """Generate a manifest.json snippet from scan results.

    When pure_only=True (default), only pure functions are included.
    This is the recommended mode for OCR/data pipeline projects where
    impure functions depend on external models or I/O.
    """
    clusters = []
    for result in results:
        for s in result.suggested_clusters:
            if pure_only and not s['isPure']:
                continue  # only suggest pure functions as clusters
            cluster = {
                'id': s['id'],
                'entry': s['entry'],
                'watches': s['watches'],
                'file': s['file'],
                'module': s['module'],
                'stack': 'python',
                'fingerprintLevel': 'entry',
                'description': s.get('description') or f"Auto-suggested cluster for {s['entry']}",
            }
            if s.get('multiArgs'):
                cluster['multiArgs'] = True
            if s['branchCount'] > 0:
                cluster['_coverageNote'] = s['coverageNote']
            if s.get('pythonPath'):
                cluster['pythonPath'] = s['pythonPath']
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
  python scripts/scan.py <path> --json            Same as --manifest (machine-readable JSON)
  python scripts/scan.py <path> --pure            Only suggest pure functions (no I/O, no models)
  python scripts/scan.py <path> --python-path     Detect sys.path.insert and suggest pythonPath
  python scripts/scan.py <path> --decompose       Detect god modules and suggest decomposition

Analyzes Python source files and suggests:
  - Which functions to cluster
  - Which functions to watch
  - How many branches need coverage
  - Whether functions are pure (ideal for fingerprinting)
  - pythonPath from sys.path.insert() patterns
  - @BEHAVIOR annotations as cluster descriptions
  - Whether the file is a god module that needs decomposition

This helps agents set up Regrets on new projects without guessing.
""")
        sys.exit(0)

    target = args[0] if args else None
    recursive = '--recursive' in args
    as_manifest = '--manifest' in args or '--json' in args
    pure_only = '--pure' in args
    show_python_path = '--python-path' in args
    decompose = '--decompose' in args

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

    # Show pythonPath detection results
    if show_python_path or pure_only:
        for result in results:
            for s in result.suggested_clusters:
                pp = s.get('pythonPath', '')
                if pp:
                    print(f"\n  📂 pythonPath detected: {pp} (from sys.path.insert in {result.file})")
                    break

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
        print(render_manifest_json(results, pure_only=pure_only))
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
            render_result(result, pure_only=pure_only)

        if pure_suggestions > 0:
            print(f"\n💡 To generate a manifest.json, run:")
            if pure_only:
                print(f"   python scripts/scan.py {target} --pure --manifest > regrets/manifest.json")
            else:
                print(f"   python scripts/scan.py {target} --manifest > regrets/manifest.json")
                print(f"   python scripts/scan.py {target} --pure --manifest > regrets/manifest.json  (pure functions only)")


if __name__ == '__main__':
    main()

#!/usr/bin/env python3
# mutate_audit.py — Detect functions that mutate their input arguments in-place
#
# This addresses a critical gap discovered when applying Regrets to OCR/pipeline
# projects where key business logic functions (validation, classification, enrichment)
# mutate their input dicts/lists in-place rather than returning new objects.
#
# When a function mutates its input:
# 1. The fingerprint before the call differs from after
# 2. Regrets' trackMutation catches the change but doesn't tell you WHICH keys
#    were added or modified
# 3. The mutation-added keys often need to be in ignoreFields for stable fingerprints
#
# Usage:
#   python scripts/mutate_audit.py <file_or_directory>
#   python scripts/mutate_audit.py src/pipeline.py --detailed
#   python scripts/mutate_audit.py src/ --recursive
#
# This script uses AST analysis to find functions that:
# - Assign to subscript of a parameter (param[key] = value)
# - Call .append(), .extend(), .pop(), .remove(), .insert(), .clear(), .update() on parameters
# - Delete keys from parameters (del param[key])
# - Modify nested attributes of parameters (param.attr[key] = value)
#
# Output includes suggested ignoreFields for each mutating function.

import ast
import json
import os
import sys
from pathlib import Path
from typing import NamedTuple


class MutationInfo(NamedTuple):
    function_name: str
    lineno: int
    mutated_params: list[str]
    mutation_types: list[str]
    mutated_keys: list[str]  # literal key names if detectable
    is_method: bool
    class_name: str | None


class MutationDetector(ast.NodeVisitor):
    """Detect in-place mutations of function parameters."""

    def __init__(self):
        self.mutations: list[MutationInfo] = []
        self._current_function = None
        self._current_params: set[str] = set()
        self._current_mutations: dict[str, set] = {}  # param -> set of mutation types
        self._current_keys: dict[str, set] = {}  # param -> set of literal keys
        self._current_class = None
        self._current_function_lineno = 0

    def visit_ClassDef(self, node):
        old_class = self._current_class
        self._current_class = node.name
        self.generic_visit(node)
        self._current_class = old_class

    def visit_FunctionDef(self, node):
        old_function = self._current_function
        old_params = self._current_params
        old_mutations = self._current_mutations
        old_keys = self._current_keys
        old_lineno = self._current_function_lineno

        self._current_function = node.name
        self._current_function_lineno = node.lineno
        self._current_params = set()
        self._current_mutations = {}
        self._current_keys = {}

        # Collect parameter names
        for arg in node.args.args:
            if arg.arg != 'self':
                self._current_params.add(arg.arg)

        # Visit function body
        self.generic_visit(node)

        # Record mutations found
        if self._current_mutations:
            for param, types in self._current_mutations.items():
                keys = self._current_keys.get(param, set())
                self.mutations.append(MutationInfo(
                    function_name=self._current_function,
                    lineno=self._current_function_lineno,
                    mutated_params=[param],
                    mutation_types=sorted(types),
                    mutated_keys=sorted(keys),
                    is_method=self._current_class is not None,
                    class_name=self._current_class,
                ))

        self._current_function = old_function
        self._current_params = old_params
        self._current_mutations = old_mutations
        self._current_keys = old_keys
        self._current_function_lineno = old_lineno

    visit_AsyncFunctionDef = visit_FunctionDef

    def _check_param_mutation(self, node, param_name):
        """Record that a parameter is being mutated."""
        if param_name not in self._current_mutations:
            self._current_mutations[param_name] = set()
            self._current_keys[param_name] = set()

    def visit_Assign(self, node):
        """Detect: param[key] = value, param.attr[key] = value"""
        for target in node.targets:
            self._check_subscript_assign(target)
        self.generic_visit(node)

    def visit_AugAssign(self, node):
        """Detect: param[key] += value"""
        self._check_subscript_assign(node.target)
        self.generic_visit(node)

    def _check_subscript_assign(self, target):
        """Check if an assignment target is a subscript of a parameter."""
        if isinstance(target, ast.Subscript):
            # param[key] = value
            if isinstance(target.value, ast.Name) and target.value.id in self._current_params:
                param_name = target.value.id
                self._check_param_mutation(target, param_name)
                self._current_mutations[param_name].add('subscript_assign')

                # Try to extract literal key name
                key = self._extract_literal_key(target.slice)
                if key:
                    self._current_keys[param_name].add(key)

            # param.nested[key] = value
            elif isinstance(target.value, ast.Attribute):
                root = self._find_root_name(target.value)
                if root and root in self._current_params:
                    self._check_param_mutation(target, root)
                    self._current_mutations[root].add('nested_subscript_assign')

    def visit_Delete(self, node):
        """Detect: del param[key]"""
        for target in node.targets:
            if isinstance(target, ast.Subscript):
                if isinstance(target.value, ast.Name) and target.value.id in self._current_params:
                    param_name = target.value.id
                    self._check_param_mutation(target, param_name)
                    self._current_mutations[param_name].add('subscript_delete')
        self.generic_visit(node)

    def visit_Call(self, node):
        """Detect: param.append(), param.extend(), etc."""
        mutating_methods = {
            'append', 'extend', 'insert', 'remove', 'pop', 'clear',
            'update', 'setdefault', 'add', 'discard',
        }

        if isinstance(node.func, ast.Attribute):
            method_name = node.func.attr

            if method_name in mutating_methods:
                # Direct: param.append()
                if isinstance(node.func.value, ast.Name):
                    if node.func.value.id in self._current_params:
                        param_name = node.func.value.id
                        self._check_param_mutation(node, param_name)
                        self._current_mutations[param_name].add(f'method_{method_name}')

                        # For .update() with dict literal, extract keys
                        if method_name == 'update' and node.args:
                            keys = self._extract_dict_keys(node.args[0])
                            self._current_keys[param_name].update(keys)

                # Chained: param.nested.append() — still a mutation
                elif isinstance(node.func.value, ast.Attribute):
                    root = self._find_root_name(node.func.value)
                    if root and root in self._current_params:
                        self._check_param_mutation(node, root)
                        self._current_mutations[root].add(f'chained_{method_name}')

        self.generic_visit(node)

    def _extract_literal_key(self, slice_node):
        """Extract a literal key from a subscript slice if possible."""
        if isinstance(slice_node, ast.Constant):
            return str(slice_node.value)
        if isinstance(slice_node, ast.Index):
            # Python 3.8 compat
            if isinstance(slice_node.value, ast.Constant):
                return str(slice_node.value)
        return None

    def _extract_dict_keys(self, node):
        """Extract literal keys from a dict literal node."""
        keys = set()
        if isinstance(node, ast.Dict):
            for key in node.keys:
                if isinstance(key, ast.Constant):
                    keys.add(str(key.value))
        return keys

    def _find_root_name(self, node):
        """Find the root variable name in a chain of attributes."""
        if isinstance(node, ast.Name):
            return node.id
        if isinstance(node, ast.Attribute):
            return self._find_root_name(node.value)
        return None


def scan_file(filepath: str) -> list[MutationInfo]:
    """Scan a single Python file for mutating functions."""
    with open(filepath, 'r', encoding='utf-8') as f:
        source = f.read()

    tree = ast.parse(source, filename=filepath)
    detector = MutationDetector()
    detector.visit(tree)
    return detector.mutations


def scan_directory(dirpath: str, recursive: bool = False) -> dict[str, list[MutationInfo]]:
    """Scan a directory for Python files with mutations."""
    results = {}
    if recursive:
        for root, dirs, files in os.walk(dirpath):
            dirs[:] = [d for d in dirs if not d.startswith(('.', '__'))]
            for f in files:
                if f.endswith('.py') and not f.startswith('__'):
                    full_path = os.path.join(root, f)
                    mutations = scan_file(full_path)
                    if mutations:
                        results[full_path] = mutations
    else:
        for f in os.listdir(dirpath):
            if f.endswith('.py') and not f.startswith('__'):
                full_path = os.path.join(dirpath, f)
                if os.path.isfile(full_path):
                    mutations = scan_file(full_path)
                    if mutations:
                        results[full_path] = mutations
    return results


def render_results(results: dict[str, list[MutationInfo]], detailed: bool = False):
    """Render mutation audit results to stdout."""
    total_mutations = sum(len(m) for m in results.values())

    print("\nMUTATION AUDIT REPORT")
    print('═' * 72)
    print(f"  Files scanned: {len(results)} file(s) with mutations")
    print(f"  Total mutating functions: {total_mutations}")
    print('─' * 72)

    for filepath, mutations in sorted(results.items()):
        print(f"\n📁 {filepath}")

        for m in mutations:
            prefix = f"  {m.class_name}." if m.class_name else "  "
            func_label = f"{prefix}{m.function_name} (line {m.lineno})"

            mutation_str = ", ".join(m.mutation_types)
            param_str = ", ".join(m.mutated_params)
            key_str = ", ".join(m.mutated_keys) if m.mutated_keys else "(dynamic keys)"

            print(f"\n    ⚠️  {func_label}")
            print(f"       Mutates: {param_str}")
            print(f"       Types:   {mutation_str}")
            print(f"       Keys:    {key_str}")

            # Suggest ignoreFields
            if m.mutated_keys:
                suggested = json.dumps(sorted(m.mutated_keys))
                print(f"       💡 Suggested ignoreFields: {suggested}")
            else:
                print(f"       💡 Consider using trackMutation: true in manifest")
                print(f"          and review output diff carefully before refactoring")

            if detailed:
                print(f"       Method: {m.is_method}")
                if m.class_name:
                    print(f"       Class:  {m.class_name}")

    print(f"\n{'─' * 72}")

    if total_mutations > 0:
        print(f"\n⚠️  {total_mutations} function(s) mutate their input arguments.")
        print("   These functions require special attention when defining Regrets clusters:")
        print()
        print("   1. Use trackMutation: true in manifest to detect input changes")
        print("   2. Add mutation-added keys to ignoreFields if they are metadata")
        print("   3. Deep-clone inputs before passing to these functions in capture")
        print("   4. Consider wrapping mutators to return new objects instead")
        print()

        # Summarize all detected keys across all mutations
        all_keys = set()
        for mutations in results.values():
            for m in mutations:
                all_keys.update(m.mutated_keys)
        if all_keys:
            print(f"   All detected mutation keys: {json.dumps(sorted(all_keys))}")
    else:
        print("\n✅ No functions mutate their input arguments. Safe to fingerprint directly.")


def main():
    args = sys.argv[1:]
    if not args:
        print("""
regret mutate-audit — Detect functions that mutate their input arguments

Usage:
  python scripts/mutate_audit.py <file_or_directory>     Scan for input mutations
  python scripts/mutate_audit.py <path> --detailed       Show detailed info
  python scripts/mutate_audit.py <path> --recursive      Scan recursively

Finds functions that mutate their input arguments in-place:
  - Subscript assignment: param[key] = value
  - Mutating method calls: param.append(), param.update(), etc.
  - Key deletion: del param[key]

For each mutation, suggests ignoreFields for Regrets manifest configuration.
""")
        sys.exit(0)

    target = args[0]
    detailed = '--detailed' in args
    recursive = '--recursive' in args

    if not os.path.exists(target):
        print(f"❌ Path not found: {target}")
        sys.exit(1)

    results = {}

    if os.path.isfile(target):
        mutations = scan_file(target)
        if mutations:
            results[target] = mutations
    elif os.path.isdir(target):
        results = scan_directory(target, recursive=recursive)
    else:
        print(f"❌ Not a file or directory: {target}")
        sys.exit(1)

    render_results(results, detailed=detailed)


if __name__ == '__main__':
    main()

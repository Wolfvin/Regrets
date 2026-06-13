#!/usr/bin/env python3
# coverage.py — Branch coverage analyzer for Regrets clusters
# Reads manifest + .regret files + source code to estimate branch coverage
# and warn about uncovered execution paths.
#
# Usage:
#   python scripts/coverage.py
#   python scripts/coverage.py --cluster my-cluster
#   python scripts/coverage.py --detailed
#
# This addresses the gap where Regrets captures ONE execution path per input
# but doesn't warn the agent that other branches exist untested.

import ast
import json
import os
import sys
from pathlib import Path


# ─── AST Branch Counter ────────────────────────────────────────────────────

class BranchCounter(ast.NodeVisitor):
    """Count branches in a function definition."""

    def __init__(self):
        self.branches = []
        self._depth = 0

    def visit_If(self, node):
        self.branches.append({
            'type': 'if',
            'line': node.lineno,
            'has_else': len(node.orelse) > 0,
            'has_elif': len(node.orelse) == 1 and isinstance(node.orelse[0], ast.If),
        })
        self.generic_visit(node)

    def visit_Match(self, node):
        self.branches.append({
            'type': 'match',
            'line': node.lineno,
            'cases': len(node.cases),
        })
        self.generic_visit(node)

    def visit_For(self, node):
        self.branches.append({
            'type': 'for',
            'line': node.lineno,
            'has_else': len(node.orelse) > 0,
        })
        self.generic_visit(node)

    def visit_While(self, node):
        self.branches.append({
            'type': 'while',
            'line': node.lineno,
            'has_else': len(node.orelse) > 0,
        })
        self.generic_visit(node)

    def visit_Try(self, node):
        self.branches.append({
            'type': 'try',
            'line': node.lineno,
            'handlers': len(node.handlers),
        })
        self.generic_visit(node)

    def visit_BoolOp(self, node):
        # and/or short-circuit creates implicit branches
        self.branches.append({
            'type': 'boolop',
            'line': node.lineno,
            'operands': len(node.values),
        })
        self.generic_visit(node)


def count_branches_in_function(source: str, function_name: str) -> list[dict]:
    """Count branches in a specific function within source code."""
    tree = ast.parse(source)
    for node in ast.walk(tree):
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
            if node.name == function_name:
                counter = BranchCounter()
                counter.visit(node)
                return counter.branches
        elif isinstance(node, ast.ClassDef):
            for item in node.body:
                if isinstance(item, (ast.FunctionDef, ast.AsyncFunctionDef)):
                    if item.name == function_name:
                        counter = BranchCounter()
                        counter.visit(item)
                        return counter.branches
    return []


def estimate_paths(branches: list[dict]) -> int:
    """Estimate minimum number of execution paths based on branches.

    Uses a linear heuristic instead of multiplicative to avoid
    false alarms on functions with many sequential (not independent)
    branches. For example, a function with 10 sequential if/else
    branches doesn't need 2^10=1024 test inputs — it needs roughly
    2*branches inputs to cover true+false for each branch.

    The multiplicative approach (paths *= 2 per branch) assumes all
    branches are independent, which is almost never true for real code.
    Sequential branches in the same function are usually mutually
    exclusive (early returns, elif chains, sequential checks).
    """
    if not branches:
        return 1

    # Count branch decision points (each needs at least one true + one false test)
    decision_points = 0
    for b in branches:
        if b['type'] == 'if':
            decision_points += 1
        elif b['type'] == 'match':
            decision_points += b['cases'] - 1  # N cases = N-1 extra paths
        elif b['type'] == 'try':
            decision_points += b['handlers']  # each handler is a path
        elif b['type'] == 'boolop':
            decision_points += b['operands'] - 1  # and/or short circuits

    # Minimum: 2 inputs per decision point (true + false)
    # Plus 1 for the base path
    min_paths = max(2 * decision_points + 1, len(branches))
    return min(min_paths, 64)  # cap at 64 to avoid explosion


def find_source_file(module_path: str, python_path: str = '') -> str | None:
    """Find the source file for a module path."""
    # Convert module path to file path
    parts = module_path.split('.')
    candidates = []

    if python_path:
        base = python_path
    else:
        base = os.getcwd()

    # Try direct file path
    file_path = os.path.join(base, *parts) + '.py'
    if os.path.isfile(file_path):
        return file_path

    # Try as package
    pkg_init = os.path.join(base, *parts, '__init__.py')
    if os.path.isfile(pkg_init):
        return pkg_init

    # Try with src/ prefix
    src_path = os.path.join(base, 'src', *parts) + '.py'
    if os.path.isfile(src_path):
        return src_path

    return None


# ─── Main ───────────────────────────────────────────────────────────────────

def main():
    args = sys.argv[1:]
    cluster_filter = None
    detailed = '--detailed' in args

    i = 0
    while i < len(args):
        if args[i] == '--cluster' and i + 1 < len(args):
            cluster_filter = args[i + 1]
            i += 2
        else:
            i += 1

    # Load manifest
    manifest_path = os.path.join(os.getcwd(), 'regrets', 'manifest.json')
    try:
        with open(manifest_path, 'r', encoding='utf-8') as f:
            manifest = json.load(f)
    except (FileNotFoundError, json.JSONDecodeError):
        print("❌ regrets/manifest.json not found. Run `regret init` first.")
        sys.exit(1)

    # Load .regret files for input counts
    regret_dir = os.path.join(os.getcwd(), 'regrets')
    regret_data = {}
    try:
        for f in os.listdir(regret_dir):
            if f.endswith('.regret'):
                cluster_id = os.path.splitext(f)[0]
                with open(os.path.join(regret_dir, f), 'r', encoding='utf-8') as fh:
                    content = fh.read()
                    # Parse input count from .regret file
                    # Count inputs by looking at the manifest inputs array
                    regret_data[cluster_id] = content
    except FileNotFoundError:
        pass

    # Analyze each cluster
    clusters = manifest.get('clusters', [])
    if cluster_filter:
        clusters = [c for c in clusters if c['id'] == cluster_filter]

    if not clusters:
        print("No clusters found.")
        sys.exit(0)

    print("\nBRANCH COVERAGE REPORT")
    print('─' * 72)

    COL = {'cluster': 35, 'branches': 10, 'paths': 10, 'inputs': 8, 'coverage': 12}
    print(
        f"{'cluster':<{COL['cluster']}}"
        f"{'branches':<{COL['branches']}}"
        f"{'min_paths':<{COL['paths']}}"
        f"{'inputs':<{COL['inputs']}}"
        f"{'coverage'}"
    )
    print('─' * 72)

    total_clusters = 0
    undercovered = 0
    warnings = []

    for cluster in clusters:
        cid = cluster['id']
        entry = cluster['entry']
        stack = cluster.get('stack', 'js')

        # Only analyze Python clusters with this tool
        if stack != 'python':
            print(f"  ⏭️  {cid:<{COL['cluster']}}stack={stack} — use JS coverage tool")
            continue

        total_clusters += 1

        # Find source file
        module_path = cluster.get('module', cluster.get('file', ''))
        python_path = cluster.get('pythonPath', '')
        src_file = find_source_file(module_path, python_path)

        if not src_file or not os.path.isfile(src_file):
            # Try file path directly
            file_path = cluster.get('file', '')
            if os.path.isabs(file_path):
                src_file = file_path
            else:
                src_file = os.path.join(os.getcwd(), file_path)

        if not src_file or not os.path.isfile(src_file):
            print(f"  ⚠️  {cid:<{COL['cluster']}}source file not found")
            continue

        # Read and analyze source
        try:
            with open(src_file, 'r', encoding='utf-8') as f:
                source = f.read()
        except Exception as e:
            print(f"  ❌ {cid:<{COL['cluster']}}error reading source: {e}")
            continue

        branches = count_branches_in_function(source, entry)
        min_paths = estimate_paths(branches)
        input_count = len(cluster.get('inputs', [])) or 1

        # Coverage estimate
        if min_paths <= 1:
            coverage = "✅ FULL"
            coverage_pct = 100
        elif input_count >= min_paths:
            coverage = "✅ LIKELY FULL"
            coverage_pct = 100
        elif input_count >= min_paths * 0.5:
            coverage = f"🟡 PARTIAL ~{int(input_count / min_paths * 100)}%"
            coverage_pct = int(input_count / min_paths * 100)
            undercovered += 1
        else:
            coverage = f"🔴 LOW ~{int(input_count / min_paths * 100)}%"
            coverage_pct = int(input_count / min_paths * 100)
            undercovered += 1

        branch_str = str(len(branches)) if branches else "0"
        print(
            f"  {cid:<{COL['cluster']}}"
            f"{branch_str:<{COL['branches']}}"
            f"{min_paths:<{COL['paths']}}"
            f"{input_count:<{COL['inputs']}}"
            f"{coverage}"
        )

        if detailed and branches:
            print(f"     Branch details for {entry}:")
            for b in branches:
                if b['type'] == 'if':
                    else_str = " + else" if b['has_else'] else ""
                    elif_str = " + elif" if b['has_elif'] else ""
                    print(f"       Line {b['line']}: if{else_str}{elif_str}")
                elif b['type'] == 'match':
                    print(f"       Line {b['line']}: match with {b['cases']} cases")
                elif b['type'] == 'try':
                    print(f"       Line {b['line']}: try with {b['handlers']} handler(s)")
                elif b['type'] == 'boolop':
                    print(f"       Line {b['line']}: short-circuit with {b['operands']} operands")

        if coverage_pct < 100:
            watches = cluster.get('watches', [])
            # Also check watches for branches
            watch_branches = {}
            for watch in watches:
                wb = count_branches_in_function(source, watch)
                if wb:
                    watch_branches[watch] = len(wb)

            warnings.append({
                'cluster': cid,
                'entry_branches': len(branches),
                'min_paths': min_paths,
                'inputs': input_count,
                'coverage_pct': coverage_pct,
                'watch_branches': watch_branches,
            })

    # Summary
    print('─' * 72)
    if undercovered > 0:
        print(f"\n⚠️  {undercovered}/{total_clusters} cluster(s) may have uncovered branches.")
        print(f"   These clusters could pass all GREEN but miss execution paths.")
        print(f"   Add more inputs to cover all branches.\n")
        print("Recommendations:")
        for w in warnings:
            print(f"  {w['cluster']}:")
            print(f"    Entry has {w['entry_branches']} branch(es), needs ≥{w['min_paths']} inputs, has {w['inputs']}")
            if w['watch_branches']:
                for fn, bc in w['watch_branches'].items():
                    print(f"    Watch '{fn}' has {bc} branch(es)")
        print()
    else:
        print(f"\n✅ All {total_clusters} cluster(s) appear to have full branch coverage.")
        print("   Note: this is an estimate based on static analysis.\n")


if __name__ == '__main__':
    main()

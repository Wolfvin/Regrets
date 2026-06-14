#!/usr/bin/env python3
# coverage.py — Branch coverage analyzer for Regrets clusters
# Reads manifest + .regret files + source code to estimate branch coverage
# and warn about uncovered execution paths.
#
# Usage:
#   python scripts/coverage.py
#   python scripts/coverage.py --cluster my-cluster
#   python scripts/coverage.py --detailed
#   python scripts/coverage.py --verbose              (show detail per branch)
#   python scripts/coverage.py --suggest-inputs       (suggest inputs for uncovered branches)
#   python scripts/coverage.py --suggest-inputs --cluster my-cluster
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
            'condition': self._extract_condition(node.test),
        })
        self.generic_visit(node)

    def visit_Match(self, node):
        self.branches.append({
            'type': 'match',
            'line': node.lineno,
            'cases': len(node.cases),
            'condition': None,
        })
        self.generic_visit(node)

    def visit_For(self, node):
        self.branches.append({
            'type': 'for',
            'line': node.lineno,
            'has_else': len(node.orelse) > 0,
            'condition': self._extract_condition(node.iter),
        })
        self.generic_visit(node)

    def visit_While(self, node):
        self.branches.append({
            'type': 'while',
            'line': node.lineno,
            'has_else': len(node.orelse) > 0,
            'condition': self._extract_condition(node.test),
        })
        self.generic_visit(node)

    def visit_Try(self, node):
        self.branches.append({
            'type': 'try',
            'line': node.lineno,
            'handlers': len(node.handlers),
            'condition': None,
        })
        self.generic_visit(node)

    def visit_BoolOp(self, node):
        # and/or short-circuit creates implicit branches
        self.branches.append({
            'type': 'boolop',
            'line': node.lineno,
            'operands': len(node.values),
            'condition': self._extract_boolop(node),
        })
        self.generic_visit(node)

    def visit_ExceptHandler(self, node):
        # Track except clauses as branches
        self.branches.append({
            'type': 'except',
            'line': node.lineno,
            'name': node.name,
            'condition': f"except {node.name}" if node.name else "except",
        })
        self.generic_visit(node)

    @staticmethod
    def _extract_condition(node):
        """Extract a readable condition string from an AST node."""
        if isinstance(node, ast.Name):
            return node.id
        if isinstance(node, ast.Constant):
            return repr(node.value)
        if isinstance(node, ast.Compare):
            left = BranchCounter._extract_condition(node.left)
            parts = [left]
            for op, comp in zip(node.ops, node.comparators):
                op_str = {ast.Eq: '==', ast.NotEq: '!=', ast.Lt: '<', ast.LtE: '<=',
                          ast.Gt: '>', ast.GtE: '>=', ast.Is: 'is', ast.IsNot: 'is not',
                          ast.In: 'in', ast.NotIn: 'not in'}.get(type(op), '?')
                parts.append(op_str)
                parts.append(BranchCounter._extract_condition(comp))
            return ' '.join(parts)
        if isinstance(node, ast.UnaryOp) and isinstance(node.op, ast.Not):
            return f"not {BranchCounter._extract_condition(node.operand)}"
        if isinstance(node, ast.BoolOp):
            return BranchCounter._extract_boolop(node)
        if isinstance(node, ast.Attribute):
            return f"{BranchCounter._extract_condition(node.value)}.{node.attr}"
        if isinstance(node, ast.Call):
            if isinstance(node.func, ast.Name):
                return f"{node.func.id}(...)"
            if isinstance(node.func, ast.Attribute):
                return f"{BranchCounter._extract_condition(node.func.value)}.{node.func.attr}(...)"
        return None

    @staticmethod
    def _extract_boolop(node):
        """Extract a readable boolean operation string."""
        if not isinstance(node, ast.BoolOp):
            return BranchCounter._extract_condition(node)
        op = 'and' if isinstance(node.op, ast.And) else 'or'
        parts = [BranchCounter._extract_condition(v) for v in node.values]
        parts = [p for p in parts if p is not None]
        return f" {op} ".join(parts) if parts else None


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
        elif b['type'] == 'except':
            decision_points += 1  # each except clause is a path

    # Minimum: 2 inputs per decision point (true + false)
    # Plus 1 for the base path
    min_paths = max(2 * decision_points + 1, len(branches))
    return min(min_paths, 64)  # cap at 64 to avoid explosion


def find_source_file(module_path: str, python_path: str = '') -> str | None:
    """Find the source file for a module path."""
    # Convert module path to file path
    parts = module_path.split('.')

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


# ─── Suggest inputs for uncovered branches ──────────────────────────────────

def suggest_input_for_branch(branch: dict, existing_inputs: list) -> dict | None:
    """Generate a heuristic input suggestion for an uncovered branch.

    This is a minimal implementation: it analyzes the branch condition
    and produces a generic input that might cover it. Not perfect AI
    generation — just heuristics based on the condition pattern.
    """
    cond = branch.get('condition')
    btype = branch.get('type', '')

    # No condition to analyze (else, try, match, etc.)
    if not cond:
        if btype == 'if' and branch.get('has_else'):
            return {'_note': 'Fallback input — ensure no prior if-condition is true', 'value': ''}
        if btype == 'except':
            exc_name = branch.get('name', 'Exception')
            return {'_note': f'Input that triggers {exc_name}', 'value': None}
        return {'_note': 'Generic input for this branch', 'value': ''}

    # Pattern: not x / not x.prop
    if cond.startswith('not '):
        var = cond[4:].strip().split('.')[0]
        return {var: False}

    # Pattern: x == "literal" / x != "literal"
    eq_match = __import__('re').match(r'(\w+)\s*==\s*["\'](.+)["\']', cond)
    if eq_match:
        return {eq_match.group(1): eq_match.group(2)}

    neq_match = __import__('re').match(r'(\w+)\s*!=\s*["\'](.+)["\']', cond)
    if neq_match:
        return {neq_match.group(1): f'NOT_{neq_match.group(2)}'}

    # Pattern: x > N / x >= N / x < N / x <= N
    cmp_match = __import__('re').match(r'(\w+)\s*(>|>=|<|<=)\s*(\d+)', cond)
    if cmp_match:
        var, op, num_str = cmp_match.group(1), cmp_match.group(2), cmp_match.group(3)
        num = int(num_str)
        if op == '>': return {var: num + 1}
        if op == '>=': return {var: num}
        if op == '<': return {var: num - 1}
        if op == '<=': return {var: num}

    # Pattern: x (simple boolean truth)
    simple_match = __import__('re').match(r'^(\w+)$', cond)
    if simple_match:
        return {simple_match.group(1): True}

    # Pattern: x.prop
    prop_match = __import__('re').match(r'(\w+)\.(\w+)', cond)
    if prop_match:
        return {prop_match.group(2): True}

    # Fallback: can't parse condition, provide generic suggestion
    return {'_note': f'Could not auto-suggest input for: "{cond}". Analyze manually.', '_condition': cond}


def check_if_covered(branch: dict, existing_inputs: list) -> bool:
    """Check if any existing input likely covers this branch.

    Simple heuristic: checks if an existing input satisfies the branch condition.
    """
    cond = branch.get('condition')
    if not cond or not existing_inputs:
        return False

    import re

    for inp in existing_inputs:
        if inp is None:
            continue

        # For primitive inputs (strings, numbers)
        if isinstance(inp, str):
            eq_match = re.match(r'(\w+)\s*===?\s*["\'](.+)["\']', cond)
            if eq_match and eq_match.group(2) == inp:
                return True

        if isinstance(inp, (int, float)):
            cmp_match = re.match(r'(\w+)\s*(>|>=|<|<=)\s*(\d+)', cond)
            if cmp_match:
                num = int(cmp_match.group(3))
                op = cmp_match.group(2)
                if op == '>' and inp > num: return True
                if op == '>=' and inp >= num: return True
                if op == '<' and inp < num: return True
                if op == '<=' and inp <= num: return True

        # For object/dict inputs
        if isinstance(inp, dict):
            # !x.prop → input has prop: false
            neg_prop_match = re.match(r'not\s+(\w+)\.(\w+)', cond)
            if neg_prop_match and inp.get(neg_prop_match.group(2)) is False:
                return True

            # x.prop → input has prop: true
            prop_match = re.match(r'(\w+)\.(\w+)', cond)
            if prop_match and 'not' not in cond and inp.get(prop_match.group(2)) is True:
                return True

            # x == "literal"
            eq_match = re.match(r'(\w+)\s*==\s*["\'](.+)["\']', cond)
            if eq_match and inp.get(eq_match.group(1)) == eq_match.group(2):
                return True

            # x > N etc.
            cmp_match = re.match(r'(\w+)\s*(>|>=|<|<=)\s*(\d+)', cond)
            if cmp_match:
                val = inp.get(cmp_match.group(1))
                num = int(cmp_match.group(3))
                op = cmp_match.group(2)
                if isinstance(val, (int, float)):
                    if op == '>' and val > num: return True
                    if op == '>=' and val >= num: return True
                    if op == '<' and val < num: return True
                    if op == '<=' and val <= num: return True

            # !param (simple negation)
            simple_neg = re.match(r'^not\s+(\w+)$', cond)
            if simple_neg and inp.get(simple_neg.group(1)) is False:
                return True

            # param (simple truth)
            simple_match = re.match(r'^(\w+)$', cond)
            if simple_match and inp.get(simple_match.group(1)) is True:
                return True

    return False


# ─── Main ───────────────────────────────────────────────────────────────────

def main():
    args = sys.argv[1:]
    cluster_filter = None
    detailed = '--detailed' in args
    verbose = '--verbose' in args
    suggest_inputs = '--suggest-inputs' in args

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
        inputs = cluster.get('inputs', [])
        input_count = len(inputs) or 1

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

        # --verbose: show detail per branch
        if verbose and branches:
            print(f"     Branch details for {entry}:")
            for b in branches:
                cond_str = f" ({b['condition']})" if b.get('condition') else ''
                if b['type'] == 'if':
                    else_str = " + else" if b['has_else'] else ""
                    elif_str = " + elif" if b['has_elif'] else ""
                    print(f"       Line {b['line']}: if{else_str}{elif_str}{cond_str}")
                elif b['type'] == 'match':
                    print(f"       Line {b['line']}: match with {b['cases']} cases{cond_str}")
                elif b['type'] == 'try':
                    print(f"       Line {b['line']}: try with {b['handlers']} handler(s){cond_str}")
                elif b['type'] == 'except':
                    name = b.get('name', '')
                    print(f"       Line {b['line']}: except {name}{cond_str}")
                elif b['type'] == 'boolop':
                    print(f"       Line {b['line']}: short-circuit with {b['operands']} operands{cond_str}")
                elif b['type'] == 'for':
                    else_str = " + else" if b.get('has_else') else ""
                    print(f"       Line {b['line']}: for-loop{else_str}{cond_str}")
                elif b['type'] == 'while':
                    else_str = " + else" if b.get('has_else') else ""
                    print(f"       Line {b['line']}: while-loop{else_str}{cond_str}")
            print()

        # Also show detailed info with the --detailed flag (backward compat)
        if detailed and branches and not verbose:
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
                'branches': branches,
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

    # ─── --suggest-inputs mode ──────────────────────────────────────────────
    # Analyze each uncovered branch and suggest concrete inputs that might
    # exercise it. This is heuristic-based — not perfect AI generation.

    if suggest_inputs:
        print('\n' + '═' * 72)
        print('SUGGESTED INPUTS — Heuristic inputs for uncovered branches')
        print('═' * 72)

        for cluster in clusters:
            cid = cluster['id']
            entry = cluster['entry']
            stack = cluster.get('stack', 'js')

            if stack != 'python':
                continue

            module_path = cluster.get('module', cluster.get('file', ''))
            python_path = cluster.get('pythonPath', '')
            src_file = find_source_file(module_path, python_path)

            if not src_file or not os.path.isfile(src_file):
                file_path = cluster.get('file', '')
                if os.path.isabs(file_path):
                    src_file = file_path
                else:
                    src_file = os.path.join(os.getcwd(), file_path)

            if not src_file or not os.path.isfile(src_file):
                print(f"\n📦 {cid}: source file not found — skipping suggestion")
                continue

            try:
                with open(src_file, 'r', encoding='utf-8') as f:
                    source = f.read()
            except Exception:
                print(f"\n📦 {cid}: could not read source — skipping suggestion")
                continue

            branches = count_branches_in_function(source, entry)
            inputs = cluster.get('inputs', [])

            if not branches:
                print(f"\n📦 {cid} (entry: {entry})")
                print(f"   No branches detected in entry function — single input sufficient")
                continue

            print(f"\n📦 {cid} (entry: {entry})")
            print(f"   {len(branches)} branch(es) detected in {entry}:\n")

            suggested = []
            for i, b in enumerate(branches):
                covered = check_if_covered(b, inputs)
                suggestion = suggest_input_for_branch(b, inputs)

                cond_str = f" ({b.get('condition')})" if b.get('condition') else ''
                btype = b['type']
                line = b['line']

                if btype == 'if':
                    else_str = " + else" if b.get('has_else') else ""
                    print(f"   Branch {i + 1} (line {line}): if{else_str}{cond_str}")
                elif btype == 'match':
                    print(f"   Branch {i + 1} (line {line}): match with {b['cases']} cases")
                elif btype == 'try':
                    print(f"   Branch {i + 1} (line {line}): try with {b['handlers']} handler(s)")
                elif btype == 'except':
                    print(f"   Branch {i + 1} (line {line}): except {b.get('name', '')}")
                elif btype == 'boolop':
                    print(f"   Branch {i + 1} (line {line}): short-circuit {cond_str}")
                elif btype == 'for':
                    print(f"   Branch {i + 1} (line {line}): for-loop{cond_str}")
                elif btype == 'while':
                    print(f"   Branch {i + 1} (line {line}): while-loop{cond_str}")
                else:
                    print(f"   Branch {i + 1} (line {line}): {btype}{cond_str}")

                if covered:
                    print(f"     ✅ Already covered by existing input")
                else:
                    if suggestion:
                        suggestion_str = json.dumps(suggestion, ensure_ascii=False)
                        print(f"     🆕 Suggested input: {suggestion_str}")
                        suggested.append(suggestion)
                    else:
                        print(f"     🆕 No suggestion available — analyze manually")

            # Also check watches if --verbose
            if verbose:
                watches = cluster.get('watches', [])
                for watch_fn in watches:
                    if watch_fn == entry:
                        continue
                    wb = count_branches_in_function(source, watch_fn)
                    if wb:
                        print(f"\n   {watch_fn} ({len(wb)} branches):")
                        for i, b in enumerate(wb):
                            covered = check_if_covered(b, inputs)
                            cond_str = f" ({b.get('condition')})" if b.get('condition') else ''
                            print(f"     Branch {i + 1}: {b['type']} line {b['line']}{cond_str}")
                            if not covered:
                                s = suggest_input_for_branch(b, inputs)
                                if s:
                                    print(f"       🆕 Suggested: {json.dumps(s, ensure_ascii=False)}")
                                else:
                                    print(f"       🆕 No suggestion available")
                            else:
                                print(f"       ✅ Covered")

            # Output manifest-ready input array
            if suggested:
                print(f"\n   ── Manifest inputs snippet ──")
                all_inputs = [*inputs, *suggested]
                inputs_json = json.dumps(all_inputs, ensure_ascii=False, indent=2)
                for line in inputs_json.split('\n'):
                    print(f"   {line}")

        print()


if __name__ == '__main__':
    main()

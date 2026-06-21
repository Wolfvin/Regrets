#!/usr/bin/env python3
# regret.py — unified runner for regret-based regression testing (Python)
# Auto-detects stack from manifest and dispatches to the appropriate handler.
#
# Usage:
#   python scripts/regret.py capture [--cluster <id>]
#   python scripts/regret.py validate [--cluster <id>] [--runs 5] [--fail-fast]
#   python scripts/regret.py health [--sort fragile]
#   python scripts/regret.py update <cluster-id> --reason "specific reason"
#   python scripts/regret.py drift
#   python scripts/regret.py ci
#   python scripts/regret.py guard
#   python scripts/regret.py list
#   python scripts/regret.py verify-kebenaran
#   python scripts/regret.py structure
#   python scripts/regret.py branch-map
#   python scripts/regret.py diagnose <file>
#   python scripts/regret.py compare --pre <dir> --post <dir>
#   python scripts/regret.py mutate-audit <path>
#   python scripts/regret.py discover --entry <fn> --file <path>

import sys
import os
import json
import subprocess

SCRIPTS_DIR = os.path.dirname(os.path.abspath(__file__))


def detect_stacks():
    """Detect which stacks are present in manifest.json."""
    manifest_path = os.path.join(os.getcwd(), 'regrets', 'manifest.json')
    try:
        with open(manifest_path, 'r', encoding='utf-8') as f:
            manifest = json.load(f)
        stacks = set()
        for cluster in manifest.get('clusters', []):
            stacks.add(cluster.get('stack', 'js'))
        return list(stacks)
    except (FileNotFoundError, json.JSONDecodeError):
        return ['js']


def run(cmd):
    """Run a command and return True if successful."""
    print(f'\n$ {cmd}')
    try:
        result = subprocess.run(cmd, shell=True, cwd=os.getcwd())
        return result.returncode == 0
    except Exception:
        return False


def delegate_to_js(command, args_list):
    """Delegate a command to regret.js (JS counterpart).

    Used for commands that only have JS implementations or where
    regret.js handles the full stack dispatch logic.
    Returns the process return code.
    """
    result = subprocess.run(
        ['node', os.path.join(SCRIPTS_DIR, 'regret.js'), command] + args_list,
        cwd=os.getcwd()
    )
    return result.returncode


def main():
    args = sys.argv[1:]
    if not args:
        command = 'help'
    else:
        command = args[0]

    extra_args = ' '.join(args[1:])
    extra_args_list = args[1:]
    success = True

    if command == 'capture':
        stacks = detect_stacks()
        for stack in stacks:
            if stack in ('js', 'ts', 'css'):
                success = run(f'node {SCRIPTS_DIR}/capture.js {extra_args}') and success
            elif stack == 'python':
                success = run(f'python3 {SCRIPTS_DIR}/capture.py {extra_args}') and success
            elif stack == 'react':
                success = run(f'node {SCRIPTS_DIR}/capture_react.mjs {extra_args}') and success
            elif stack == 'php':
                success = run(f'php {SCRIPTS_DIR}/capture_php.php {extra_args}') and success
            elif stack == 'rust':
                success = run(f'bash {SCRIPTS_DIR}/capture_rust.sh capture {extra_args}') and success
            elif stack == 'go':
                success = run(f'bash {SCRIPTS_DIR}/capture_go.sh capture {extra_args}') and success
            elif stack == 'bash':
                success = run(f'bash {SCRIPTS_DIR}/capture_bash.sh {extra_args}') and success

    elif command == 'validate':
        stacks = detect_stacks()
        for stack in stacks:
            if stack in ('js', 'ts', 'react', 'css'):
                success = run(f'node {SCRIPTS_DIR}/validate.js {extra_args}') and success
            elif stack == 'python':
                success = run(f'python3 {SCRIPTS_DIR}/validate.py {extra_args}') and success
            elif stack == 'php':
                success = run(f'php {SCRIPTS_DIR}/validate_php.php {extra_args}') and success
            elif stack == 'rust':
                success = run(f'bash {SCRIPTS_DIR}/capture_rust.sh validate {extra_args}') and success
            elif stack == 'go':
                success = run(f'bash {SCRIPTS_DIR}/capture_go.sh validate {extra_args}') and success
            elif stack == 'bash':
                success = run(f'bash {SCRIPTS_DIR}/validate_bash.sh {extra_args}') and success

    elif command == 'health':
        success = run(f'node {SCRIPTS_DIR}/health.js {extra_args}')

    elif command == 'update':
        # Find which stack the target cluster belongs to
        target_cluster = None
        for arg in args[1:]:
            if not arg.startswith('-'):
                target_cluster = arg
                break
        target_stack = 'js'
        manifest_path = os.path.join(os.getcwd(), 'regrets', 'manifest.json')
        try:
            with open(manifest_path, 'r', encoding='utf-8') as f:
                manifest = json.load(f)
            for cluster in manifest.get('clusters', []):
                if cluster.get('id') == target_cluster:
                    target_stack = cluster.get('stack', 'js')
                    break
        except (FileNotFoundError, json.JSONDecodeError):
            pass

        if target_stack == 'python':
            success = run(f'python3 {SCRIPTS_DIR}/validate.py {extra_args}')
        elif target_stack == 'php':
            success = run(f'php {SCRIPTS_DIR}/validate_php.php {extra_args}')
        elif target_stack == 'rust':
            success = run(f'bash {SCRIPTS_DIR}/capture_rust.sh validate {extra_args}')
        elif target_stack == 'go':
            success = run(f'bash {SCRIPTS_DIR}/capture_go.sh validate {extra_args}')
        elif target_stack == 'bash':
            success = run(f'bash {SCRIPTS_DIR}/validate_bash.sh {extra_args}')
        else:
            # js, ts, css all use validate.js
            success = run(f'node {SCRIPTS_DIR}/validate.js {extra_args}')

    elif command == 'drift':
        stacks = detect_stacks()
        # Pass --drift-mode so validate knows to use driftRuns || 5 as default
        # If user explicitly provides --runs, it takes priority over driftRuns
        if '--runs' in extra_args_list:
            drift_extra = extra_args
        else:
            drift_extra = '--drift-mode ' + extra_args
        for stack in stacks:
            if stack in ('js', 'ts', 'react', 'css'):
                success = run(f'node {SCRIPTS_DIR}/validate.js {drift_extra}') and success
            elif stack == 'python':
                success = run(f'python3 {SCRIPTS_DIR}/validate.py {drift_extra}') and success
            elif stack == 'php':
                success = run(f'php {SCRIPTS_DIR}/validate_php.php {drift_extra}') and success
            elif stack == 'rust':
                success = run(f'bash {SCRIPTS_DIR}/capture_rust.sh validate {extra_args}') and success
            elif stack == 'go':
                print('  ⏭️  Go drift detection: run capture_go.sh with --runs flag manually')
            elif stack == 'bash':
                print('  ⏭️  Bash drift detection: not yet supported (bash output is deterministic by default)')

    elif command == 'ci':
        stacks = detect_stacks()
        for stack in stacks:
            if stack in ('js', 'ts', 'react', 'css'):
                success = run(f'node {SCRIPTS_DIR}/validate.js --fail-fast {extra_args}') and success
            elif stack == 'python':
                success = run(f'python3 {SCRIPTS_DIR}/validate.py --fail-fast {extra_args}') and success
            elif stack == 'php':
                success = run(f'php {SCRIPTS_DIR}/validate_php.php --fail-fast {extra_args}') and success
            elif stack == 'rust':
                success = run(f'bash {SCRIPTS_DIR}/capture_rust.sh validate {extra_args}') and success
            elif stack == 'go':
                success = run(f'bash {SCRIPTS_DIR}/capture_go.sh validate {extra_args}') and success
            elif stack == 'bash':
                success = run(f'bash {SCRIPTS_DIR}/validate_bash.sh --fail-fast {extra_args}') and success

    elif command == 'rollback':
        target_cluster = None
        for arg in args[1:]:
            if not arg.startswith('-'):
                target_cluster = arg
                break
        if not target_cluster:
            print('❌ Usage: regret rollback <cluster-id>')
            sys.exit(1)
        print(f'\n🔄 Rolling back: {target_cluster}')
        print('   Re-capturing fingerprint with current code...\n')
        # Detect stack for the target cluster to dispatch correctly
        target_stack = 'js'
        manifest_path = os.path.join(os.getcwd(), 'regrets', 'manifest.json')
        try:
            with open(manifest_path, 'r', encoding='utf-8') as f:
                manifest = json.load(f)
            for cluster in manifest.get('clusters', []):
                if cluster.get('id') == target_cluster:
                    target_stack = cluster.get('stack', 'js')
                    break
        except (FileNotFoundError, json.JSONDecodeError):
            pass

        if target_stack == 'python':
            success = run(f'python3 {SCRIPTS_DIR}/capture.py --cluster {target_cluster}')
            if success:
                success = run(f'python3 {SCRIPTS_DIR}/validate.py --cluster {target_cluster}')
        else:
            success = run(f'node {SCRIPTS_DIR}/capture.js --cluster {target_cluster}')
            if success:
                success = run(f'node {SCRIPTS_DIR}/validate.js --cluster {target_cluster}')

    elif command == 'guard':
        stacks = detect_stacks()
        for stack in stacks:
            if stack in ('js', 'ts', 'react', 'css'):
                success = run(f'node {SCRIPTS_DIR}/validate.js --fail-fast {extra_args}') and success
            elif stack == 'python':
                success = run(f'python3 {SCRIPTS_DIR}/validate.py --fail-fast {extra_args}') and success
            elif stack == 'php':
                success = run(f'php {SCRIPTS_DIR}/validate_php.php --fail-fast {extra_args}') and success
            elif stack == 'rust':
                success = run(f'bash {SCRIPTS_DIR}/capture_rust.sh validate {extra_args}') and success
            elif stack == 'go':
                success = run(f'bash {SCRIPTS_DIR}/capture_go.sh validate {extra_args}') and success
            elif stack == 'bash':
                success = run(f'bash {SCRIPTS_DIR}/validate_bash.sh --fail-fast {extra_args}') and success
        if success:
            print('\n✅ Regret guard passed — all clusters green.')
        else:
            print('\n❌ Regret guard FAILED — some clusters are red.')

    elif command == 'check':
        stacks_for_check = detect_stacks()
        if 'python' in stacks_for_check:
            success = run(f'python3 {SCRIPTS_DIR}/check.py {extra_args}')
        else:
            success = run(f'node {SCRIPTS_DIR}/check.js {extra_args}')

    elif command == 'chain':
        stacks = detect_stacks()
        for stack in stacks:
            if stack == 'python':
                success = run(f'python3 {SCRIPTS_DIR}/contest.py {extra_args}') and success
            else:
                success = run(f'node {SCRIPTS_DIR}/contest.mjs {extra_args}') and success

    elif command == 'scan':
        stacks = detect_stacks()
        for stack in stacks:
            if stack in ('js', 'ts', 'react', 'css'):
                success = run(f'node {SCRIPTS_DIR}/scan.js {extra_args}') and success
            elif stack == 'python':
                success = run(f'python3 {SCRIPTS_DIR}/scan.py {extra_args}') and success
            else:
                # Default to JS scanner for unknown stacks
                success = run(f'node {SCRIPTS_DIR}/scan.js {extra_args}') and success

    elif command == 'coverage':
        stacks = detect_stacks()
        for stack in stacks:
            if stack in ('js', 'ts', 'react', 'css'):
                success = run(f'node {SCRIPTS_DIR}/coverage.js {extra_args}') and success
            elif stack == 'python':
                success = run(f'python3 {SCRIPTS_DIR}/coverage.py {extra_args}') and success
            else:
                # Default to JS coverage for unknown stacks
                success = run(f'node {SCRIPTS_DIR}/coverage.js {extra_args}') and success

    elif command == 'audit':
        stacks_for_audit = detect_stacks()
        if 'python' in stacks_for_audit:
            success = run(f'python3 {SCRIPTS_DIR}/audit.py {extra_args}')
        else:
            success = run(f'node {SCRIPTS_DIR}/audit.js {extra_args}')

    elif command == 'analyze':
        success = run(f'python3 {SCRIPTS_DIR}/analyze.py {extra_args}')

    elif command == 'truth':
        stacks = detect_stacks()
        for stack in stacks:
            if stack in ('js', 'ts', 'react', 'css'):
                success = run(f'node {SCRIPTS_DIR}/truth.js {extra_args}') and success
            elif stack == 'python':
                success = run(f'python3 {SCRIPTS_DIR}/truth.py {extra_args}') and success
            elif stack == 'php':
                success = run(f'php {SCRIPTS_DIR}/truth_php.php {extra_args}') and success
            elif stack == 'rust':
                success = run(f'bash {SCRIPTS_DIR}/capture_rust.sh validate {extra_args}') and success
            elif stack == 'go':
                success = run(f'bash {SCRIPTS_DIR}/capture_go.sh validate {extra_args}') and success
            elif stack == 'bash':
                success = run(f'bash {SCRIPTS_DIR}/validate_bash.sh {extra_args}') and success
            else:
                print(f'  ⏭️  Stack "{stack}" — truth capture not yet supported')

    elif command == 'diff':
        diff_stacks = detect_stacks()
        for stack in diff_stacks:
            if stack == 'python':
                success = run(f'python3 {SCRIPTS_DIR}/diff.py {extra_args}') and success
            else:
                success = run(f'node {SCRIPTS_DIR}/diff.js {extra_args}') and success

    elif command == 'status':
        success = run(f'python3 {SCRIPTS_DIR}/status.py {extra_args}')

    # ─── Commands delegated to regret.js ─────────────────────────────
    # These commands either only have JS implementations, or regret.js
    # handles the full multi-stack dispatch logic internally.

    elif command == 'list':
        # No list.py yet — delegate to regret.js which runs list.js
        sys.exit(delegate_to_js('list', extra_args_list))

    elif command == 'verify-kebenaran':
        # regret.js handles Python + JS dispatch for verify-kebenaran
        sys.exit(delegate_to_js('verify-kebenaran', extra_args_list))

    elif command == 'structure':
        sys.exit(delegate_to_js('structure', extra_args_list))

    elif command == 'branch-map':
        sys.exit(delegate_to_js('branch-map', extra_args_list))

    elif command == 'diagnose':
        sys.exit(delegate_to_js('diagnose', extra_args_list))

    elif command == 'compare':
        sys.exit(delegate_to_js('compare', extra_args_list))

    elif command == 'mutate-audit':
        # regret.js dispatches to mutate_audit.py for Python
        sys.exit(delegate_to_js('mutate-audit', extra_args_list))

    elif command == 'discover':
        # regret.js handles --static flag dispatch to discover-static.js
        sys.exit(delegate_to_js('discover', extra_args_list))

    elif command == 'help':
        print("""
regret.py — Unified Regret Runner (Python)

Usage:
  python scripts/regret.py capture [--cluster <id>]     Capture fingerprints
                                 [--only-new]          Only capture clusters without .regret files
                                 [--stale [hours]]     Re-capture clusters older than N hours (default: 24)
  python scripts/regret.py validate [--cluster <id>]    Validate against golden
  python scripts/regret.py health [--sort fragile]      Health report
  python scripts/regret.py update <id> --reason "..."   Safe update with audit trail
  python scripts/regret.py drift [--cluster <id>]       Drift detection (5 runs)
  python scripts/regret.py ci                            CI mode (fail-fast)
  python scripts/regret.py rollback <id>                Rollback cluster (re-capture + validate)
  python scripts/regret.py chain [--capture|--validate]  Chain testing
  python scripts/regret.py scan <path> [--manifest]      Scan source, suggest clusters
  python scripts/regret.py coverage [--cluster <id>]     Branch coverage analysis
  python scripts/regret.py audit [--strict]              Pre-refactor readiness audit
  python scripts/regret.py guard                         Pre-build gate
  python scripts/regret.py check [--cluster <id>]       Pre-flight manifest validation
  python scripts/regret.py truth [--outdir ./proof]      Save dual-truth baselines
  python scripts/regret.py diff [--cluster <id>]         Deep-compare live vs golden output
  python scripts/regret.py status [--json]              Snapshot: safe to refactor?
  python scripts/regret.py list                       List all clusters with status
  python scripts/regret.py verify-kebenaran            Verify KEBENARAN 1 vs KEBENARAN 2
  python scripts/regret.py structure                  Structural analysis of regrets
  python scripts/regret.py branch-map [--ts]           Generate branch-map.md with input suggestions
  python scripts/regret.py diagnose <file>             Diagnose module exports & recommend mode
  python scripts/regret.py compare --pre <dir> --post <dir>  Compare pre vs post truth baselines
  python scripts/regret.py mutate-audit <path>        Detect functions that mutate input args
  python scripts/regret.py discover --entry <fn> --file <path>  Discover call graph & draft manifest
                                   [--inputs '[null, {}]']        Custom inputs (JSON array)
                                   [--out regrets/manifest.json]  Write to file (default: stdout)
  python scripts/regret.py discover --static --entry <fn> --file <path>  Zero-execution static analysis

Auto-detects stack from manifest.json and dispatches to the right handler:
  js/ts/css → capture.js / validate.js
  python    → capture.py / validate.py / truth.py
  php       → capture_php.php / validate_php.php
  react     → capture_react.mjs / validate.js
  rust      → capture_rust.sh (capture + validate via cargo test)
  go        → capture_go.sh (Community Preview)
  bash      → capture_bash.sh / validate_bash.sh (Community Preview)

Commands: list, verify-kebenaran, structure, branch-map, diagnose, compare,
mutate-audit, discover — delegated through regret.js.
""")

    else:
        print(f"Unknown command: {command}")
        print("Run 'python scripts/regret.py help' for usage.")
        success = False

    sys.exit(0 if success else 1)


if __name__ == '__main__':
    main()

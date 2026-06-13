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


def main():
    args = sys.argv[1:]
    if not args:
        command = 'help'
    else:
        command = args[0]

    extra_args = ' '.join(args[1:])
    success = True

    if command == 'capture':
        stacks = detect_stacks()
        for stack in stacks:
            if stack in ('js', 'ts'):
                success = run(f'node {SCRIPTS_DIR}/capture.js {extra_args}') and success
            elif stack == 'python':
                success = run(f'python3 {SCRIPTS_DIR}/capture.py {extra_args}') and success
            elif stack == 'react':
                success = run(f'node {SCRIPTS_DIR}/capture_react.mjs {extra_args}') and success
            elif stack == 'rust':
                success = run(f'bash {SCRIPTS_DIR}/capture_rust.sh capture {extra_args}') and success

    elif command == 'validate':
        stacks = detect_stacks()
        for stack in stacks:
            if stack in ('js', 'ts', 'react'):
                success = run(f'node {SCRIPTS_DIR}/validate.js {extra_args}') and success
            elif stack == 'python':
                success = run(f'python3 {SCRIPTS_DIR}/validate.py {extra_args}') and success
            elif stack == 'rust':
                success = run(f'bash {SCRIPTS_DIR}/capture_rust.sh validate {extra_args}') and success

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
        else:
            success = run(f'node {SCRIPTS_DIR}/validate.js {extra_args}')

    elif command == 'drift':
        stacks = detect_stacks()
        for stack in stacks:
            if stack in ('js', 'ts', 'react'):
                success = run(f'node {SCRIPTS_DIR}/validate.js --runs 5 {extra_args}') and success
            elif stack == 'python':
                success = run(f'python3 {SCRIPTS_DIR}/validate.py --runs 5 {extra_args}') and success

    elif command == 'ci':
        stacks = detect_stacks()
        for stack in stacks:
            if stack in ('js', 'ts', 'react'):
                success = run(f'node {SCRIPTS_DIR}/validate.js --fail-fast {extra_args}') and success
            elif stack == 'python':
                success = run(f'python3 {SCRIPTS_DIR}/validate.py --fail-fast {extra_args}') and success

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
        success = run(f'python3 {SCRIPTS_DIR}/capture.py --cluster {target_cluster}') and success
        if success:
            success = run(f'python3 {SCRIPTS_DIR}/validate.py --cluster {target_cluster}') and success

    elif command == 'guard':
        stacks = detect_stacks()
        for stack in stacks:
            if stack in ('js', 'ts', 'react'):
                success = run(f'node {SCRIPTS_DIR}/validate.js --fail-fast {extra_args}') and success
            elif stack == 'python':
                success = run(f'python3 {SCRIPTS_DIR}/validate.py --fail-fast {extra_args}') and success
        if success:
            print('\n✅ Regret guard passed — all clusters green.')
        else:
            print('\n❌ Regret guard FAILED — some clusters are red.')

    elif command == 'help':
        print("""
regret.py — Unified Regret Runner (Python)

Usage:
  python scripts/regret.py capture [--cluster <id>]     Capture fingerprints
  python scripts/regret.py validate [--cluster <id>]    Validate against golden
  python scripts/regret.py health [--sort fragile]      Health report
  python scripts/regret.py update <id> --reason "..."   Safe update with audit trail
  python scripts/regret.py drift [--cluster <id>]       Drift detection (5 runs)
  python scripts/regret.py ci                            CI mode (fail-fast)
  python scripts/regret.py rollback <id>                Rollback cluster (re-capture + validate)
  python scripts/regret.py guard                         Pre-build gate

Auto-detects stack from manifest.json and dispatches to the right handler.
""")
    else:
        print(f"Unknown command: {command}")
        print("Run 'python scripts/regret.py help' for usage.")
        success = False

    sys.exit(0 if success else 1)


if __name__ == '__main__':
    main()

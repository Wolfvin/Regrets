#!/usr/bin/env python3
# chain.py — Chain testing MVP for regret-based regression (Python version)
# Executes multi-step flows (chains) and fingerprints the combined output.
#
# Usage:
#   python scripts/chain.py --capture [--chain <id>]
#   python scripts/chain.py --validate [--chain <id>]

import sys
import os
import json
import hashlib
import importlib
from pathlib import Path

# Import shared fingerprint module
sys.path.insert(0, os.path.dirname(__file__))
from fingerprint import fingerprint, stable_dumps, deep_clone
from capture import create_ghost


def get_arg(args, flag):
    i = args.index(flag) if flag in args else -1
    return args[i + 1] if i >= 0 and i + 1 < len(args) else None


def main():
    args = sys.argv[1:]
    capture_mode = '--capture' in args
    validate_mode = '--validate' in args or not capture_mode
    chain_filter = get_arg(args, '--chain')

    CWD = os.getcwd()
    CHAINS_DIR = os.path.join(CWD, 'regrets', 'chains')
    CHAIN_FILE = os.path.join(CWD, 'regrets', 'chains.json')
    MANIFEST_PATH = os.path.join(CWD, 'regrets', 'manifest.json')

    # Load manifest
    if not os.path.exists(MANIFEST_PATH):
        print('❌ regrets/manifest.json not found. Run `regret init` first.')
        sys.exit(1)

    with open(MANIFEST_PATH, 'r') as f:
        manifest = json.load(f)

    # Load chains
    if not os.path.exists(CHAIN_FILE):
        print('❌ regrets/chains.json not found. Create it to define chain flows.')
        sys.exit(1)

    with open(CHAIN_FILE, 'r') as f:
        chains_data = json.load(f)

    chains = chains_data.get('chains', [])

    if chain_filter:
        chains = [c for c in chains if c['id'] == chain_filter]

    if not chains:
        print('No chains to run.')
        sys.exit(0)

    # Add pythonPath to sys.path if specified
    for cluster in manifest.get('clusters', []):
        python_path = cluster.get('pythonPath', '')
        if python_path and python_path not in sys.path:
            abs_python_path = os.path.join(CWD, python_path)
            if abs_python_path not in sys.path:
                sys.path.insert(0, abs_python_path)

    print('📡 CHAIN CAPTURE MODE (Python)\n' if capture_mode else '🔍 CHAIN VALIDATE MODE (Python)\n')

    passed = 0
    failed = 0

    for chain_def in chains:
        chain_id = chain_def['id']
        print(f'\n⛓  Chain: {chain_id} ({len(chain_def["steps"])} steps)')

        try:
            step_results = []

            for step in chain_def['steps']:
                cluster_id = step['cluster']
                cluster = next((c for c in manifest['clusters'] if c['id'] == cluster_id), None)
                if not cluster:
                    raise ValueError(f'Cluster "{cluster_id}" not found in manifest')

                # Import module
                module_path = cluster.get('module', cluster.get('file', ''))
                mod = importlib.import_module(module_path)

                # Get entry function
                entry = cluster['entry']
                entry_fn = getattr(mod, entry, None)
                if entry_fn is None or not callable(entry_fn):
                    raise TypeError(f'Entry "{entry}" not found or not callable in {module_path}')

                # Run with input
                input_val = step.get('input')
                multi_args = cluster.get('multiArgs', False)

                if multi_args and isinstance(input_val, list):
                    output = entry_fn(*deep_clone(input_val))
                else:
                    output = entry_fn(deep_clone(input_val)) if input_val is not None else entry_fn()

                fp = fingerprint(
                    input_val,
                    deep_clone(output),
                    cluster.get('normalize', []),
                    cluster.get('ignoreFields', [])
                )

                step_results.append({
                    'cluster': cluster_id,
                    'input': input_val,
                    'output': deep_clone(output),
                    'fingerprint': fp
                })

            # Compute chain hash
            combined = '|'.join(f'{r["cluster"]}:{r["fingerprint"]}' for r in step_results)
            chain_hash = hashlib.sha256(combined.encode('utf-8')).hexdigest()
            chain_hash = ''.join(c if c < 'a' else c for c in format(int(chain_hash, 16), '36'))[:7]

            for i, s in enumerate(step_results):
                print(f'   Step {i + 1}: {s["cluster"]} → {s["fingerprint"]}')
            print(f'   Chain hash: {chain_hash}')

            if capture_mode:
                os.makedirs(CHAINS_DIR, exist_ok=True)
                lines = [
                    f'chain: {chain_id}',
                    f'chain_hash: {chain_hash}',
                    f'captured: {__import__("datetime").datetime.now(__import__("datetime").timezone.utc).isoformat()}',
                    'steps:'
                ]
                for i, s in enumerate(step_results):
                    lines.append(f'  {i + 1}. cluster: {s["cluster"]}')
                    lines.append(f'     fingerprint: {s["fingerprint"]}')
                lines.append('---')
                for i, s in enumerate(step_results):
                    lines.append(f'STEP {i + 1}  {s["cluster"]}')
                    lines.append(f'  INPUT  {stable_dumps(s["input"])}')
                    lines.append(f'  OUTPUT {stable_dumps(s["output"])}')
                    lines.append(f'  HASH   {s["fingerprint"]}')

                out_path = os.path.join(CHAINS_DIR, f'{chain_id}.chain')
                with open(out_path, 'w') as f:
                    f.write('\n'.join(lines))
                print(f'   ✅ Captured → {out_path}')
                passed += 1
            else:
                # Validate against golden
                golden_path = os.path.join(CHAINS_DIR, f'{chain_id}.chain')
                if not os.path.exists(golden_path):
                    print(f'   ❌ No golden file found')
                    failed += 1
                    continue

                with open(golden_path, 'r') as f:
                    golden_content = f.read()

                import re
                stored_hash = re.search(r'^chain_hash:\s+(\S+)', golden_content, re.MULTILINE)
                if not stored_hash:
                    print(f'   ❌ Malformed golden file (no chain_hash)')
                    failed += 1
                    continue

                if chain_hash == stored_hash.group(1):
                    print('   ✅ Match')
                    passed += 1
                else:
                    print(f'   ❌ Mismatch — expected {stored_hash.group(1)}, got {chain_hash}')
                    failed += 1

        except Exception as err:
            print(f'   ❌ Chain failed: {err}')
            import traceback
            traceback.print_exc()
            failed += 1

    print(f'\n{"─" * 50}')
    print(f'Chain {"capture" if capture_mode else "validate"}: {passed} passed, {failed} failed')
    sys.exit(1 if failed > 0 else 0)


if __name__ == '__main__':
    main()

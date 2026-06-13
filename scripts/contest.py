#!/usr/bin/env python3
# contest.py — Chain testing for Python clusters
# Mirrors contest.mjs functionality for Python stack clusters.
#
# Usage:
#   python scripts/contest.py --capture [--chain <id>]
#   python scripts/contest.py --validate [--chain <id>]

import sys
import os
import json
import re
import importlib
import hashlib
from datetime import datetime, timezone

# Import shared fingerprint module
from fingerprint import (
    normalize, strip_fields, to_base36,
    deep_clone, fingerprint, extract_schema
)


def parse_args():
    args = sys.argv[1:]
    result = {
        'capture': False,
        'validate': False,
        'chain': None,
    }
    i = 0
    while i < len(args):
        if args[i] == '--capture':
            result['capture'] = True; i += 1
        elif args[i] == '--validate':
            result['validate'] = True; i += 1
        elif args[i] == '--chain' and i + 1 < len(args):
            result['chain'] = args[i + 1]; i += 2
        else:
            i += 1
    return result


class ContestRunner:
    def __init__(self):
        self.manifest = None
        self.chains = []

    def load_chains(self, chain_file):
        with open(chain_file, 'r', encoding='utf-8') as f:
            self.chains = json.load(f).get('chains', [])
        return self

    def load_manifest(self, manifest_path):
        with open(manifest_path, 'r', encoding='utf-8') as f:
            self.manifest = json.load(f)
        # Add pythonPath to sys.path
        for cluster in self.manifest.get('clusters', []):
            python_path = cluster.get('pythonPath', '')
            if python_path:
                abs_path = os.path.join(os.getcwd(), python_path)
                if abs_path not in sys.path:
                    sys.path.insert(0, abs_path)
        return self

    def find_cluster(self, cluster_id):
        return next((c for c in self.manifest['clusters'] if c['id'] == cluster_id), None)

    def run_step(self, step):
        cluster = self.find_cluster(step['cluster'])
        if not cluster:
            raise ValueError(f'Cluster "{step["cluster"]}" not found in manifest')

        module_path = cluster.get('module', cluster.get('file', ''))
        entry_name = cluster['entry']
        norm_rules = cluster.get('normalize', [])
        ign_fields = cluster.get('ignoreFields', [])
        multi_args = cluster.get('multiArgs', False)
        kwargs_mode = cluster.get('kwargs', False)
        class_method = cluster.get('classMethod', None)
        constructor = cluster.get('constructor', None)
        constructor_args = cluster.get('constructorArgs', [])
        setup = cluster.get('setup', [])
        output_transform = cluster.get('outputTransform', None)
        instance_methods = cluster.get('instanceMethods', {})

        mod = importlib.import_module(module_path)

        # Handle class-based clusters (stateful instance testing)
        if class_method:
            cls_name = constructor or entry_name
            Cls = getattr(mod, cls_name, None)
            if Cls is None:
                raise TypeError(f'Class "{cls_name}" not found in {module_path}')
            instance = Cls(*deep_clone(constructor_args))

            # Run setup steps on the instance
            for step_setup in setup:
                method_fn = getattr(instance, step_setup.get('method', ''), None)
                if method_fn:
                    step_args = step_setup.get('args', [])
                    method_fn(*deep_clone(step_args))

            # Run any pre-step setup defined in the chain step
            if 'setupSteps' in step:
                for chain_setup in step['setupSteps']:
                    method_name = chain_setup.get('method', '')
                    method_fn = getattr(instance, method_name, None)
                    if method_fn:
                        setup_args = chain_setup.get('args', [])
                        method_fn(*deep_clone(setup_args))

            # Call the classMethod
            input_val = step['input']
            if multi_args and isinstance(input_val, list):
                output = getattr(instance, class_method)(*input_val)
            elif kwargs_mode and isinstance(input_val, dict):
                output = getattr(instance, class_method)(**input_val)
            elif input_val is not None:
                output = getattr(instance, class_method)(input_val)
            else:
                output = getattr(instance, class_method)()
        else:
            entry_fn = getattr(mod, entry_name, None)
            if entry_fn is None or not callable(entry_fn):
                raise TypeError(f'Entry "{entry_name}" not found in {module_path}')

            input_val = step['input']
            if multi_args and isinstance(input_val, list):
                output = entry_fn(*input_val)
            elif kwargs_mode and isinstance(input_val, dict):
                output = entry_fn(**input_val)
            elif input_val is None:
                output = entry_fn()
            else:
                output = entry_fn(input_val)

        # Apply output transform if specified
        if output_transform:
            from capture import apply_output_transform
            output = apply_output_transform(deep_clone(output), output_transform)

        fp = fingerprint(deep_clone(input_val), deep_clone(output), norm_rules, ign_fields)
        return {
            'cluster': step['cluster'],
            'input': input_val,
            'output': output,
            'fingerprint': fp
        }

    def run_chain(self, chain_id):
        chain = next((c for c in self.chains if c['id'] == chain_id), None)
        if not chain:
            raise ValueError(f'Chain "{chain_id}" not found in chains.json')
        step_results = []
        for step in chain['steps']:
            step_results.append(self.run_step(step))
        return {
            'id': chain_id,
            'steps': step_results,
            'chain_hash': self.compute_chain_hash(step_results)
        }

    def compute_chain_hash(self, step_results):
        combined = '|'.join(f'{r["cluster"]}:{r["fingerprint"]}' for r in step_results)
        hash_hex = hashlib.sha256(combined.encode('utf-8')).hexdigest()
        return to_base36(int(hash_hex, 16))[:7]

    def compare_chains(self, chain_id, result):
        golden_path = os.path.join(os.getcwd(), 'regrets', 'chains', f'{chain_id}.chain')
        if not os.path.isfile(golden_path):
            return {'match': False, 'reason': 'no golden file'}
        with open(golden_path, 'r', encoding='utf-8') as f:
            content = f.read()

        m = re.search(r'^chain_hash:\s+(\S+)', content, re.MULTILINE)
        if not m:
            return {'match': False, 'reason': 'malformed golden file (no chain_hash)'}
        stored_hash = m.group(1)
        return {
            'match': result['chain_hash'] == stored_hash,
            'expected': stored_hash,
            'got': result['chain_hash']
        }

    def write_chain_file(self, result):
        chains_dir = os.path.join(os.getcwd(), 'regrets', 'chains')
        os.makedirs(chains_dir, exist_ok=True)

        lines = [
            f'chain: {result["id"]}',
            f'chain_hash: {result["chain_hash"]}',
            f'captured: {datetime.now(timezone.utc).isoformat()}',
            'steps:'
        ]
        for i, s in enumerate(result['steps']):
            lines.append(f'  {i + 1}. cluster: {s["cluster"]}')
            lines.append(f'     fingerprint: {s["fingerprint"]}')
        lines.append('---')
        for i, s in enumerate(result['steps']):
            lines.append(f'STEP {i + 1}  {s["cluster"]}')
            lines.append(f'  INPUT  {json.dumps(s["input"], ensure_ascii=False)}')
            lines.append(f'  OUTPUT {json.dumps(deep_clone(s["output"]), ensure_ascii=False)}')
            lines.append(f'  HASH   {s["fingerprint"]}')

        out_path = os.path.join(chains_dir, f'{result["id"]}.chain')
        with open(out_path, 'w', encoding='utf-8') as f:
            f.write('\n'.join(lines))
        return out_path


def main():
    cli = parse_args()
    capture_mode = cli['capture']
    validate_mode = cli['validate'] or not capture_mode
    chain_filter = cli['chain']

    manifest_path = os.path.join(os.getcwd(), 'regrets', 'manifest.json')
    chain_file = os.path.join(os.getcwd(), 'regrets', 'chains.json')

    if not os.path.isfile(manifest_path):
        print('❌ regrets/manifest.json not found. Run `regret init` first.')
        sys.exit(1)
    if not os.path.isfile(chain_file):
        print('❌ regrets/chains.json not found. Create it to define chain flows.')
        sys.exit(1)

    runner = ContestRunner()
    runner.load_manifest(manifest_path).load_chains(chain_file)

    chains_to_run = [c for c in runner.chains if not chain_filter or c['id'] == chain_filter]
    if not chains_to_run:
        print('No chains to run.')
        sys.exit(0)

    print('📡 CHAIN CAPTURE MODE\n' if capture_mode else '🔍 CHAIN VALIDATE MODE\n')

    passed = 0
    failed = 0

    for chain_def in chains_to_run:
        print(f'\n⛓  Chain: {chain_def["id"]} ({len(chain_def["steps"])} steps)')
        try:
            result = runner.run_chain(chain_def['id'])
            for i, s in enumerate(result['steps']):
                print(f'   Step {i + 1}: {s["cluster"]} → {s["fingerprint"]}')
            print(f'   Chain hash: {result["chain_hash"]}')

            if capture_mode:
                out_path = runner.write_chain_file(result)
                print(f'   ✅ Captured → {out_path}')
                passed += 1
            else:
                comparison = runner.compare_chains(chain_def['id'], result)
                if comparison['match']:
                    print('   ✅ Match')
                    passed += 1
                else:
                    reason = comparison.get('reason') or f"expected {comparison.get('expected')}, got {comparison.get('got')}"
                    print(f'   ❌ Mismatch — {reason}')
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

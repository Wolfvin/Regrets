#!/usr/bin/env python3
# contest.py — Chain testing runner for Python clusters
# Executes multi-step flows (chains) and fingerprints the combined output.
# Mirrors the algorithm and file format of contest.mjs for cross-stack parity.
#
# Usage:
#   python3 scripts/contest.py --capture [--chain <id>]
#   python3 scripts/contest.py --validate [--chain <id>]

import sys
import os
import json
import importlib
import hashlib
from datetime import datetime, timezone

from fingerprint import fingerprint, stable_dumps, deep_clone


# ─── CLI args ────────────────────────────────────────────────────────────────

def parse_args():
    args = sys.argv[1:]
    capture_mode = '--capture' in args
    chain_filter = None
    for i, arg in enumerate(args):
        if arg == '--chain' and i + 1 < len(args):
            chain_filter = args[i + 1]
    return capture_mode, chain_filter


# ─── Paths ───────────────────────────────────────────────────────────────────

CWD = os.getcwd()
CHAINS_DIR = os.path.join(CWD, 'regrets', 'chains')
CHAIN_FILE = os.path.join(CWD, 'regrets', 'chains.json')
MANIFEST_PATH = os.path.join(CWD, 'regrets', 'manifest.json')


# ─── ContestRunner ──────────────────────────────────────────────────────────

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
        # Add pythonPath entries to sys.path
        for cluster in self.manifest.get('clusters', []):
            if cluster.get('stack') == 'python':
                python_path = cluster.get('pythonPath', '')
                if python_path:
                    abs_path = os.path.join(CWD, python_path)
                    if abs_path not in sys.path:
                        sys.path.insert(0, abs_path)
        return self

    def find_cluster(self, cluster_id):
        for c in self.manifest.get('clusters', []):
            if c['id'] == cluster_id:
                return c
        return None

    def run_step(self, step):
        """Run a single chain step and return the fingerprint."""
        cluster = self.find_cluster(step['cluster'])
        if not cluster:
            raise ValueError(f"Cluster '{step['cluster']}' not found in manifest")

        module_path = cluster.get('module', '')
        mod = importlib.import_module(module_path)

        entry_name = cluster['entry']
        entry_fn = getattr(mod, entry_name, None)
        if entry_fn is None or not callable(entry_fn):
            raise TypeError(f"Entry '{entry_name}' not callable in {module_path}")

        # Run the entry function
        step_input = step.get('input')
        input_for_args = deep_clone(step_input)
        multi_args = cluster.get('multiArgs', False)

        if multi_args and isinstance(input_for_args, list):
            output = entry_fn(*input_for_args)
        else:
            output = entry_fn(input_for_args) if input_for_args is not None else entry_fn()

        # Compute fingerprint
        norm_rules = cluster.get('normalize', [])
        ign_fields = cluster.get('ignoreFields', [])

        fp_input = deep_clone(step_input)
        fp = fingerprint(fp_input, output, norm_rules, ign_fields)

        return {
            'cluster': step['cluster'],
            'input': step_input,
            'output': output,
            'fingerprint': fp,
        }

    def run_chain(self, chain_id):
        """Run all steps in a chain and compute the chain hash."""
        chain = None
        for c in self.chains:
            if c['id'] == chain_id:
                chain = c
                break
        if not chain:
            raise ValueError(f"Chain '{chain_id}' not found in chains.json")

        step_results = []
        for step in chain['steps']:
            step_results.append(self.run_step(step))

        return {
            'id': chain_id,
            'steps': step_results,
            'chain_hash': self.compute_chain_hash(step_results),
        }

    def compute_chain_hash(self, step_results):
        """Compute chain hash from step fingerprints (same algorithm as contest.mjs)."""
        combined = '|'.join(f"{r['cluster']}:{r['fingerprint']}" for r in step_results)
        hash_hex = hashlib.sha256(combined.encode('utf-8')).hexdigest()
        big_num = int(hash_hex, 16)

        # Base36 conversion (matching JS BigInt.toString(36))
        chars = '0123456789abcdefghijklmnopqrstuvwxyz'
        if big_num == 0:
            return '0'
        result = ''
        while big_num:
            result = chars[big_num % 36] + result
            big_num //= 36
        return result[:7]

    def compare_chains(self, chain_id, result):
        """Compare chain result against golden .chain file."""
        golden_path = os.path.join(CHAINS_DIR, f'{chain_id}.chain')
        if not os.path.isfile(golden_path):
            return {'match': False, 'reason': 'no golden file'}
        with open(golden_path, 'r', encoding='utf-8') as f:
            content = f.read()
        for line in content.split('\n'):
            if line.startswith('chain_hash:'):
                stored_hash = line.split(':', 1)[1].strip()
                return {
                    'match': result['chain_hash'] == stored_hash,
                    'expected': stored_hash,
                    'got': result['chain_hash'],
                }
        return {'match': False, 'reason': 'malformed golden file (no chain_hash)'}

    def write_chain_file(self, result):
        """Write a .chain file capturing the chain's golden state."""
        os.makedirs(CHAINS_DIR, exist_ok=True)
        lines = [
            f'chain: {result["id"]}',
            f'chain_hash: {result["chain_hash"]}',
            f'captured: {datetime.now(timezone.utc).isoformat()}',
            'steps:',
        ]
        for i, s in enumerate(result['steps']):
            lines.append(f'  {i + 1}. cluster: {s["cluster"]}')
            lines.append(f'     fingerprint: {s["fingerprint"]}')
        lines.append('---')
        for i, s in enumerate(result['steps']):
            lines.append(f'STEP {i + 1}  {s["cluster"]}')
            lines.append(f'  INPUT  {json.dumps(s["input"], sort_keys=True, ensure_ascii=False)}')
            lines.append(f'  OUTPUT {json.dumps(s["output"], sort_keys=True, ensure_ascii=False)}')
            lines.append(f'  HASH   {s["fingerprint"]}')

        out_path = os.path.join(CHAINS_DIR, f'{result["id"]}.chain')
        with open(out_path, 'w', encoding='utf-8') as f:
            f.write('\n'.join(lines))
        return out_path


# ─── Main ────────────────────────────────────────────────────────────────────

def main():
    if not os.path.isfile(MANIFEST_PATH):
        print('❌ regrets/manifest.json not found. Run `regret init` first.')
        sys.exit(1)

    if not os.path.isfile(CHAIN_FILE):
        print('❌ regrets/chains.json not found. Create it to define chain flows.')
        sys.exit(1)

    capture_mode, chain_filter = parse_args()

    runner = ContestRunner()
    runner.load_manifest(MANIFEST_PATH).load_chains(CHAIN_FILE)

    chains_to_run = (
        [c for c in runner.chains if c['id'] == chain_filter]
        if chain_filter else runner.chains
    )

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
                if comparison.get('match'):
                    print('   ✅ Match')
                    passed += 1
                else:
                    reason = comparison.get('reason') or \
                        f"expected {comparison.get('expected')}, got {comparison.get('got')}"
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

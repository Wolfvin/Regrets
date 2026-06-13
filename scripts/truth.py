#!/usr/bin/env python3
# truth.py — Save dual truth baselines before refactoring (Python version)
#
# Usage:
#   python scripts/truth.py
#   python scripts/truth.py --outdir ./proof
#
# Generates:
#   KEBENARAN_1_raw_output.json — Raw output from every entry function
#   KEBENARAN_2_fingerprints.json — Fingerprint contracts from .regret files + chain hashes

import sys
import os
import json
import importlib
import glob
from datetime import datetime

# Import shared fingerprint module
from fingerprint import deep_clone

# ─── CLI args ─────────────────────────────────────────────────────────────────

def parse_args():
    args = sys.argv[1:]
    outdir = './proof'
    manifest_path = None

    i = 0
    while i < len(args):
        if args[i] == '--outdir' and i + 1 < len(args):
            outdir = args[i + 1]
            i += 2
        elif args[i] == '--manifest' and i + 1 < len(args):
            manifest_path = args[i + 1]
            i += 2
        else:
            i += 1

    if manifest_path is None:
        manifest_path = os.path.join(os.getcwd(), 'regrets', 'manifest.json')

    return outdir, manifest_path


# ─── KEBENARAN 1: Raw output ─────────────────────────────────────────────────

def save_kebenaran_1(manifest, outdir):
    """Run every entry function with every input and save raw output."""
    clusters = manifest.get('clusters', [])
    python_clusters = [c for c in clusters if c.get('stack') == 'python']

    if not python_clusters:
        print("No Python clusters found in manifest.")
        return {}

    # Add pythonPath to sys.path
    for cluster in python_clusters:
        raw_python_path = cluster.get('pythonPath', '')
        if isinstance(raw_python_path, str):
            python_paths = [raw_python_path] if raw_python_path else []
        elif isinstance(raw_python_path, list):
            python_paths = raw_python_path
        else:
            python_paths = []
        for python_path in python_paths:
            if python_path:
                abs_python_path = os.path.join(os.getcwd(), python_path)
                if abs_python_path not in sys.path:
                    sys.path.insert(0, abs_python_path)

    truth = {}

    for cluster in python_clusters:
        cid = cluster['id']
        entry = cluster['entry']
        module_path = cluster.get('module', cluster.get('file', ''))
        inputs = cluster.get('inputs', [None])
        multi_args = cluster.get('multiArgs', False)
        kwargs_mode = cluster.get('kwargs', False)

        print(f"  📡 {cid}: {entry} ({len(inputs)} inputs)")

        try:
            mod = importlib.import_module(module_path)
            entry_fn = getattr(mod, entry, None)
            if entry_fn is None or not callable(entry_fn):
                print(f"     ⚠️  Entry function '{entry}' not found in {module_path}")
                continue

            cluster_results = {}

            for input_val in inputs:
                input_for_args = deep_clone(input_val)

                try:
                    if multi_args and isinstance(input_for_args, list):
                        raw_output = entry_fn(*input_for_args)
                    elif kwargs_mode and isinstance(input_for_args, dict):
                        raw_output = entry_fn(**input_for_args)
                    else:
                        raw_output = entry_fn(input_for_args) if input_for_args is not None else entry_fn()

                    # Serialize output (use deep_clone to handle custom objects)
                    serialized = deep_clone(raw_output)

                    # Create a key for this input
                    input_key = json.dumps(input_val, sort_keys=True, default=str) if input_val is not None else 'null'
                    cluster_results[input_key] = serialized

                except Exception as err:
                    print(f"     ❌ Input {input_val}: {err}")
                    input_key = json.dumps(input_val, sort_keys=True, default=str) if input_val is not None else 'null'
                    cluster_results[input_key] = {'__error__': str(err)}

            truth[cid] = cluster_results

        except Exception as err:
            print(f"     ❌ Failed: {err}")
            truth[cid] = {'__error__': str(err)}

    return truth


# ─── KEBENARAN 2: Fingerprint contracts ───────────────────────────────────────

def save_kebenaran_2(outdir):
    """Collect fingerprints from .regret files and chain hashes."""
    regret_dir = os.path.join(os.getcwd(), 'regrets')
    fingerprints = {}

    # Collect cluster fingerprints
    for f in sorted(glob.glob(os.path.join(regret_dir, '*.regret'))):
        with open(f, 'r', encoding='utf-8') as fh:
            content = fh.read()
        cluster_id = os.path.splitext(os.path.basename(f))[0]
        fp = None
        for line in content.split('---')[0].split('\n'):
            if line.startswith('fingerprint:'):
                fp = line.split(':', 1)[1].strip()
        if fp:
            fingerprints[cluster_id] = fp
            print(f"  ✅ {cluster_id}: {fp}")

    # Collect chain hashes
    chains_dir = os.path.join(regret_dir, 'chains')
    if os.path.isdir(chains_dir):
        for f in sorted(glob.glob(os.path.join(chains_dir, '*.chain'))):
            with open(f, 'r', encoding='utf-8') as fh:
                content = fh.read().strip()
            chain_id = os.path.splitext(os.path.basename(f))[0]
            chain_hash = None
            for line in content.split('\n'):
                if line.startswith('chain_hash:'):
                    chain_hash = line.split(':', 1)[1].strip()
            if chain_hash:
                fingerprints[f'chain/{chain_id}'] = chain_hash
                print(f"  ✅ chain/{chain_id}: {chain_hash}")

    return fingerprints


# ─── Verification ──────────────────────────────────────────────────────────────

def verify_consistency(kebenaran_1, kebenaran_2):
    """Check that KEBENARAN 1 and KEBENARAN 2 are consistent."""
    k1_clusters = set(kebenaran_1.keys())
    k2_clusters = {k for k in kebenaran_2.keys() if not k.startswith('chain/')}

    only_in_k1 = k1_clusters - k2_clusters
    only_in_k2 = k2_clusters - k1_clusters

    if only_in_k1 or only_in_k2:
        print(f"\n❌ INCONSISTENCY between KEBENARAN 1 and KEBENARAN 2:")
        if only_in_k1:
            print(f"   In K1 but not K2: {', '.join(sorted(only_in_k1))}")
        if only_in_k2:
            print(f"   In K2 but not K1: {', '.join(sorted(only_in_k2))}")
        print(f"   Fix this before refactoring — it indicates a false negative.")
        return False

    print(f"\n✅ KEBENARAN 1 and KEBENARAN 2 are consistent ({len(k1_clusters)} clusters)")
    return True


# ─── Main ─────────────────────────────────────────────────────────────────────

def main():
    outdir, manifest_path = parse_args()

    print(f"\n📡 Saving KEBENARAN 1 — Raw output from entry functions\n")

    # Load manifest
    try:
        with open(manifest_path, 'r', encoding='utf-8') as f:
            manifest = json.load(f)
    except (FileNotFoundError, json.JSONDecodeError) as e:
        print(f"❌ Could not read manifest: {manifest_path}")
        print(f"   Error: {e}")
        sys.exit(1)

    # KEBENARAN 1
    kebenaran_1 = save_kebenaran_1(manifest, outdir)

    print(f"\n📡 Saving KEBENARAN 2 — Fingerprint contracts from .regret files\n")

    # KEBENARAN 2
    kebenaran_2 = save_kebenaran_2(outdir)

    # Save both
    os.makedirs(outdir, exist_ok=True)

    k1_path = os.path.join(outdir, 'KEBENARAN_1_raw_output.json')
    with open(k1_path, 'w', encoding='utf-8') as f:
        json.dump(kebenaran_1, f, indent=2, ensure_ascii=False, default=str)
    print(f"\n📄 KEBENARAN 1 saved → {k1_path}")

    k2_path = os.path.join(outdir, 'KEBENARAN_2_fingerprints.json')
    with open(k2_path, 'w', encoding='utf-8') as f:
        json.dump(kebenaran_2, f, indent=2, ensure_ascii=False)
    print(f"📄 KEBENARAN 2 saved → {k2_path}")

    # Verify consistency
    consistent = verify_consistency(kebenaran_1, kebenaran_2)

    if not consistent:
        sys.exit(1)

    print(f"\n🛡️  Dual truth baselines saved. Safe to refactor.")


if __name__ == '__main__':
    main()

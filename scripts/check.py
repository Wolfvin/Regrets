#!/usr/bin/env python3
# check.py — Pre-flight manifest validation
# Verifies that the manifest is valid and all clusters can be loaded
# without actually computing fingerprints.
#
# Usage:
#   python scripts/check.py
#   python scripts/check.py --cluster my-cluster

import sys
import os
import json
import importlib

def parse_args():
    args = sys.argv[1:]
    cluster_filter = None
    i = 0
    while i < len(args):
        if args[i] == '--cluster' and i + 1 < len(args):
            cluster_filter = args[i + 1]
            i += 2
        else:
            i += 1
    return cluster_filter


def main():
    cluster_filter = parse_args()
    manifest_path = os.path.join(os.getcwd(), 'regrets', 'manifest.json')
    
    # ─── Check manifest file ─────────────────────────────────────────────────
    if not os.path.exists(manifest_path):
        print('❌ regrets/manifest.json not found')
        print('   Run `regret init` to create it')
        sys.exit(1)
    
    try:
        with open(manifest_path, 'r', encoding='utf-8') as f:
            manifest = json.load(f)
    except json.JSONDecodeError as e:
        print(f'❌ manifest.json is invalid JSON: {e}')
        sys.exit(1)
    
    if 'clusters' not in manifest:
        print('❌ manifest.json missing "clusters" key')
        sys.exit(1)
    
    clusters = manifest['clusters']
    if cluster_filter:
        clusters = [c for c in clusters if c['id'] == cluster_filter]
    
    if not clusters:
        print(f'❌ No clusters found{f" matching {cluster_filter}" if cluster_filter else ""}')
        sys.exit(1)
    
    print(f'\n🔍 Checking {len(clusters)} cluster(s)...\n')
    
    # ─── Add pythonPath entries ──────────────────────────────────────────────
    python_paths = set()
    for cluster in clusters:
        pp = cluster.get('pythonPath', '')
        if pp:
            abs_path = os.path.join(os.getcwd(), pp)
            if abs_path not in sys.path:
                sys.path.insert(0, abs_path)
                python_paths.add(abs_path)
    
    # Support multiple pythonPaths (comma-separated or list)
    # This is a new feature: pythonPath can be a list of directories
    for cluster in clusters:
        pp = cluster.get('pythonPaths', [])
        if isinstance(pp, str):
            pp = [p.strip() for p in pp.split(',')]
        for p in pp:
            abs_path = os.path.join(os.getcwd(), p)
            if abs_path not in sys.path:
                sys.path.insert(0, abs_path)
                python_paths.add(abs_path)
    
    passed = 0
    failed = 0
    warnings = 0
    
    for cluster in clusters:
        cid = cluster.get('id', '')
        entry = cluster.get('entry', '')
        module_path = cluster.get('module', cluster.get('file', ''))
        stack = cluster.get('stack', 'js')
        watches = cluster.get('watches', [])
        
        print(f'  Checking: {cid}')
        errors = []
        warns = []
        
        # Check required fields
        if not cid:
            errors.append('missing "id"')
        if not entry:
            errors.append('missing "entry"')
        if not module_path:
            errors.append('missing "module" or "file"')
        
        # Check Python stack specifics
        if stack == 'python':
            # Check module can be imported
            try:
                mod = importlib.import_module(module_path)
            except ImportError as e:
                errors.append(f'module "{module_path}" import failed: {e}')
            except Exception as e:
                errors.append(f'module "{module_path}" load error: {e}')
            else:
                # Check entry function exists
                entry_fn = getattr(mod, entry, None)
                if entry_fn is None or not callable(entry_fn):
                    # Check if it's a class that needs instantiation
                    entry_cls = getattr(mod, entry, None)
                    if entry_cls is not None and isinstance(entry_cls, type):
                        warns.append(f'entry "{entry}" is a class, not a function — consider using outputTransform')
                    else:
                        errors.append(f'entry "{entry}" not found or not callable in {module_path}')
                
                # Check watches exist in module
                for watch in watches:
                    watch_attr = getattr(mod, watch, None)
                    if watch_attr is None:
                        warns.append(f'watch "{watch}" not found in {module_path}')
                    elif not callable(watch_attr) and not isinstance(watch_attr, type):
                        warns.append(f'watch "{watch}" is not callable (type: {type(watch_attr).__name__})')
        
        # Check outputTransform validity
        output_transform = cluster.get('outputTransform')
        if output_transform and isinstance(output_transform, str):
            valid_transforms = ['get_val_d', 'to_dict', 'to_bytes', 'repr', 'hex']
            if output_transform not in valid_transforms:
                warns.append(f'outputTransform "{output_transform}" is not a known named transform (valid: {valid_transforms})')
        
        # Report results
        if errors:
            print(f'    ❌ FAIL')
            for e in errors:
                print(f'       {e}')
            for w in warns:
                print(f'       ⚠️  {w}')
            failed += 1
        elif warns:
            print(f'    ⚠️  WARN')
            for w in warns:
                print(f'       {w}')
            warnings += 1
            passed += 1
        else:
            print(f'    ✅ OK')
            passed += 1
    
    # ─── Summary ─────────────────────────────────────────────────────────────
    print(f'\n{"─" * 50}')
    print(f'Check complete: {passed} OK, {warnings} warnings, {failed} failed')
    
    if failed > 0:
        print(f'\n⚠️  Fix errors before running capture.')
        sys.exit(1)
    
    print(f'\n✅ All clusters pass pre-flight check. Safe to run capture.')
    sys.exit(0)


if __name__ == '__main__':
    main()

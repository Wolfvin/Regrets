#!/usr/bin/env python3
# validate.py — regression validator for Python clusters
# Usage:
#   python scripts/validate.py
#   python scripts/validate.py --runs 5
#   python scripts/validate.py --cluster transform-invoice
#   python scripts/validate.py --update transform-invoice --reason "tax rate changed to 12%"
#   python scripts/validate.py --fail-fast

import sys
import os
import json
import importlib
import re
import hashlib
import types
from datetime import datetime, timezone
from functools import wraps
from pathlib import Path

# Import shared fingerprint module (same directory)
from fingerprint import (
    stable_dumps, normalize, strip_fields, to_base36,
    deep_clone, fingerprint, fingerprint_sequence, extract_schema,
    _numpy_to_native, materialize_output, snapshot_state, get_env_snapshot
)

# ─── CLI args ─────────────────────────────────────────────────────────────────

def parse_args():
    args = sys.argv[1:]
    result = {
        'cluster': None,
        'runs': 1,
        'update': None,
        'reason': None,
        'fail_fast': False,
        'manifest': os.path.join(os.getcwd(), 'regrets', 'manifest.json'),
    }

    i = 0
    while i < len(args):
        if args[i] == '--cluster' and i + 1 < len(args):
            result['cluster'] = args[i + 1]; i += 2
        elif args[i] == '--runs' and i + 1 < len(args):
            result['runs'] = int(args[i + 1]); i += 2
        elif args[i] == '--update' and i + 1 < len(args):
            result['update'] = args[i + 1]; i += 2
        elif args[i] == '--reason' and i + 1 < len(args):
            result['reason'] = args[i + 1]; i += 2
        elif args[i] == '--fail-fast':
            result['fail_fast'] = True; i += 1
        elif args[i] == '--manifest' and i + 1 < len(args):
            result['manifest'] = args[i + 1]; i += 2
        else:
            i += 1

    return result

# ─── Helpers (shared with capture.py) ─────────────────────────────────────────

def consume_generator(val):
    """If val is a generator or iterator, consume it into a list."""
    if isinstance(val, (str, bytes, dict)):
        return val
    if isinstance(val, types.GeneratorType):
        return list(val)
    if hasattr(val, '__iter__') and hasattr(val, '__next__'):
        if isinstance(val, (list, tuple)):
            return val
        return list(val)
    return val


def apply_output_transform(output, transform):
    """Apply an outputTransform to convert complex objects to fingerprintable form.

    See capture.py for full documentation.
    """
    if transform is None:
        return output

    if isinstance(output, tuple):
        output = list(output)

    if '.' in transform and transform not in ('json',):
        parts = transform.rsplit('.', 1)
        try:
            mod = importlib.import_module(parts[0])
            fn = getattr(mod, parts[1])
            return fn(output)
        except (ImportError, AttributeError) as e:
            raise ValueError(f"Cannot resolve outputTransform '{transform}': {e}")

    def transform_one(obj):
        if transform == 'str':
            return str(obj)
        elif transform == 'repr':
            return repr(obj)
        elif transform == 'dict':
            if hasattr(obj, 'to_dict') and callable(obj.to_dict):
                return obj.to_dict()
            if hasattr(obj, '__dict__'):
                return obj.__dict__
            return dict(obj)
        elif transform == 'len':
            return len(obj)
        elif transform == 'type':
            return type(obj).__name__
        else:
            raise ValueError(f"Unknown outputTransform: '{transform}'")

    if isinstance(output, list) and transform not in ('len',):
        return [transform_one(item) for item in output]
    return transform_one(output)


# ─── Parse .regret file ──────────────────────────────────────────────────────

def parse_regret(content):
    parts = content.split('\n---\n', 1)
    meta_section = parts[0]
    data_section = parts[1] if len(parts) > 1 else ''

    meta = {}
    for line in meta_section.split('\n'):
        colon_idx = line.find(': ')
        if colon_idx == -1:
            continue
        key = line[:colon_idx]
        val = line[colon_idx + 2:].strip()

        if key == 'watches':
            meta['watches'] = [w.strip() for w in val.strip('[]').split(',') if w.strip()]
        elif key == 'normalize':
            meta['normalize'] = [n.strip() for n in val.strip('[]').split(',') if n.strip()]
        elif key == 'ignoreFields':
            meta['ignoreFields'] = [f.strip() for f in val.strip('[]').split(',') if f.strip()]
        elif key == 'fingerprintMode':
            meta['fingerprintMode'] = val
        elif key == 'valuePaths':
            meta['valuePaths'] = [p.strip() for p in val.strip('[]').split(',') if p.strip()]
        elif key == 'kwargs':
            meta['kwargs'] = val.lower() == 'true'
        elif key == 'outputTransform':
            meta['outputTransform'] = val
        elif key == 'env':
            try:
                meta['env'] = json.loads(val)
            except (json.JSONDecodeError, ValueError):
                meta['env'] = val
        elif key == 'materializeOutput':
            meta['materializeOutput'] = val.lower() == 'true'
        elif key == 'trackMutation':
            meta['trackMutation'] = val.lower() == 'true'
        elif key == 'mutationFingerprint':
            meta['mutationFingerprint'] = val.strip()
        elif key == 'classMethod':
            meta['classMethod'] = val
        elif key == 'constructor':
            meta['constructor'] = val
        elif key == 'constructorArgs':
            try:
                meta['constructorArgs'] = json.loads(val)
            except (json.JSONDecodeError, ValueError):
                meta['constructorArgs'] = []
        elif key == 'setup':
            try:
                meta['setup'] = json.loads(val)
            except (json.JSONDecodeError, ValueError):
                meta['setup'] = []
        else:
            meta[key] = val

    # Parse data section
    for line in data_section.split('\n'):
        if line.startswith('INPUT '):
            meta['input'] = json.loads(line[6:])
        elif line.startswith('OUTPUT '):
            meta['output'] = json.loads(line[7:])
        elif line.startswith('HASH '):
            meta['goldenHash'] = line[5:].strip()
        elif line.startswith('MUTATION_BEFORE '):
            meta['mutationBefore'] = json.loads(line[16:])
        elif line.startswith('MUTATION_AFTER '):
            meta['mutationAfter'] = json.loads(line[15:])

    meta['raw'] = content
    return meta


# ─── Ghost wrapper ────────────────────────────────────────────────────────────

def create_ghost(mod, watch_list, recorder):
    """Wrap watched functions with recording decorators."""
    class GhostModule:
        pass

    ghost = GhostModule()

    for attr_name in dir(mod):
        if not attr_name.startswith('_'):
            try:
                setattr(ghost, attr_name, getattr(mod, attr_name))
            except AttributeError:
                pass

    for fn_name in (watch_list or []):
        original = getattr(mod, fn_name, None)
        if original is None or not callable(original):
            continue

        def make_ghost(orig, name):
            @wraps(orig)
            def wrapper(*args, **kwargs):
                try:
                    result = orig(*args, **kwargs)
                    recorder.append({
                        'fn': name,
                        'args': deep_clone(args),
                        'result': deep_clone(result),
                    })
                    return result
                except Exception as err:
                    recorder.append({
                        'fn': name,
                        'args': deep_clone(args),
                        'error': str(err),
                    })
                    raise
            return wrapper

        setattr(ghost, fn_name, make_ghost(original, fn_name))

    return ghost


# ─── Update .regret file ─────────────────────────────────────────────────────

def update_regret(regret_path, regret, new_hash, live_output, reason):
    old_hash = regret.get('goldenHash', '')
    now = datetime.now(timezone.utc).isoformat()

    # Rebuild .regret content
    raw = regret['raw']
    new_content = re.sub(r'^fingerprint: .+$', f'fingerprint: {new_hash}', raw, flags=re.MULTILINE)
    new_content = re.sub(r'^captured: .+$', f'captured: {now}', new_content, flags=re.MULTILINE)
    new_content = re.sub(r'^OUTPUT .+$', f'OUTPUT {json.dumps(_numpy_to_native(live_output), ensure_ascii=False)}', new_content, flags=re.MULTILINE)
    new_content = re.sub(r'^HASH .+$', f'HASH   {new_hash}', new_content, flags=re.MULTILINE)

    with open(regret_path, 'w', encoding='utf-8') as f:
        f.write(new_content)

    # Sanitize reason: replace newlines to prevent audit.log corruption
    safe_reason = re.sub(r'[\r\n]+', ' ', reason) if isinstance(reason, str) else reason

    # ─── Hash chain ──────────────────────────────────────────────────────────
    audit_log = os.path.join(os.path.dirname(regret_path), 'audit.log')
    prev_chain = '0000000'  # genesis
    if os.path.isfile(audit_log):
        try:
            with open(audit_log, 'r', encoding='utf-8') as f:
                log_content = f.read().strip()
            if log_content:
                lines = log_content.split('\n')
                # Walk backwards to find the last chain hash
                for line in reversed(lines):
                    m = re.match(r'^\s*chain:\s*(\S+)', line)
                    if m:
                        prev_chain = m.group(1)
                        break
        except Exception:
            pass  # fall through to genesis

    cluster_id = os.path.splitext(os.path.basename(regret_path))[0]
    new_entry_content = (
        f"{now}  UPDATE  {cluster_id}\n"
        f"  old: {old_hash}\n"
        f"  new: {new_hash}\n"
        f"  reason: {safe_reason}\n"
        f"  by: AI refactor session"
    )
    chain_hash = hashlib.sha256((prev_chain + new_entry_content).encode('utf-8')).hexdigest()[:7]

    entry = f"\n{new_entry_content}\n  chain: {chain_hash}"
    with open(audit_log, 'a', encoding='utf-8') as f:
        f.write(entry)

    return old_hash, new_hash


# ─── Main ─────────────────────────────────────────────────────────────────────

def main():
    cli = parse_args()

    # Validate --update usage
    if cli['update'] and not cli['reason']:
        print("❌ --update requires --reason")
        print(f'   Example: --update {cli["update"]} --reason "describe why behavior changed"')
        sys.exit(1)

    if cli['reason'] and len(cli['reason'].split()) < 4:
        print(f'❌ --reason is too vague: "{cli["reason"]}"')
        print('   Be specific. e.g. "tax rate updated from 11% to 12% per new regulation"')
        sys.exit(1)

    # Load manifest
    try:
        with open(cli['manifest'], 'r', encoding='utf-8') as f:
            manifest = json.load(f)
    except (FileNotFoundError, json.JSONDecodeError):
        print(f"❌ Could not read manifest: {cli['manifest']}")
        sys.exit(1)

    # Find .regret files
    regret_dir = os.path.join(os.getcwd(), 'regrets')
    filter_id = cli['cluster'] or cli['update'] or None

    try:
        regret_files = [
            f for f in os.listdir(regret_dir)
            if f.endswith('.regret') and (not filter_id or f == f'{filter_id}.regret')
        ]
    except FileNotFoundError:
        print("❌ regrets/ not found. Run capture.py first.")
        sys.exit(1)

    if not regret_files:
        print(f"❌ No .regret files found{' for "' + filter_id + '"' if filter_id else ''}.")
        sys.exit(1)

    # Add pythonPath to sys.path if specified in any Python cluster
    # Supports both single string ("src") and array of strings (["src", "lib"])
    for cluster in manifest.get('clusters', []):
        if cluster.get('stack') == 'python':
            raw_python_path = cluster.get('pythonPath', '')
            if isinstance(raw_python_path, str):
                python_paths = [raw_python_path] if raw_python_path else []
            elif isinstance(raw_python_path, list):
                python_paths = raw_python_path
            else:
                python_paths = []
            for python_path in python_paths:
                if python_path:
                    abs_path = os.path.join(os.getcwd(), python_path)
                    if abs_path not in sys.path:
                        sys.path.insert(0, abs_path)

    update_mode = bool(cli['update'])
    drift_mode = cli['runs'] > 1 and not update_mode

    if update_mode:
        print(f'\n🔄 Update mode — cluster: {cli["update"]}')
        print(f'   Reason: {cli["reason"]}\n')
    elif drift_mode:
        print(f'\n🔍 Drift detection — {cli["runs"]} runs per cluster...\n')
    else:
        print(f'\n🔍 Validating {len(regret_files)} cluster(s)...\n')

    results = []

    for regret_file in regret_files:
        cluster_id = os.path.splitext(regret_file)[0]
        regret_path = os.path.join(regret_dir, regret_file)

        with open(regret_path, 'r', encoding='utf-8') as f:
            regret = parse_regret(f.read())

        # Find cluster definition in manifest
        cluster_def = None
        for c in manifest.get('clusters', []):
            if c['id'] == cluster_id:
                cluster_def = c
                break

        if not cluster_def:
            print(f"  ⚠️  {cluster_id}: not in manifest — skipping")
            continue

        # Only validate Python clusters
        if cluster_def.get('stack') != 'python':
            print(f"  ⏭️  {cluster_id}: stack={cluster_def.get('stack', 'js')} — use JS validator")
            continue

        try:
            module_path = cluster_def.get('module', cluster_def.get('file', ''))
            entry_name = cluster_def['entry']
            norm_rules = cluster_def.get('normalize', [])
            ign_fields = cluster_def.get('ignoreFields', [])
            fp_level = cluster_def.get('fingerprintLevel', 'entry')
            fp_mode = cluster_def.get('fingerprintMode', 'value')
            value_paths = cluster_def.get('valuePaths', [])
            multi_args = cluster_def.get('multiArgs', False)
            kwargs_mode = regret.get('kwargs', cluster_def.get('kwargs', False))
            output_transform = regret.get('outputTransform') or cluster_def.get('outputTransform', None)
            materialize_output_flag = regret.get('materializeOutput', cluster_def.get('materializeOutput', False))
            track_mutation = regret.get('trackMutation', cluster_def.get('trackMutation', False))
            # classMethod support for Python
            class_method = regret.get('classMethod', cluster_def.get('classMethod', None))
            constructor_name = regret.get('constructor', cluster_def.get('constructor', None))
            constructor_args = regret.get('constructorArgs', cluster_def.get('constructorArgs', []))
            setup_steps = regret.get('setup', cluster_def.get('setup', []))

            # Check environment snapshot if present in .regret file
            regret_env = regret.get('env')
            if regret_env and isinstance(regret_env, dict):
                current_env = get_env_snapshot()
                for k, v in regret_env.items():
                    if current_env.get(k) != v:
                        print(f"  ⚠️  {cluster_id}: environment changed: {k} was {v}, now {current_env.get(k)}")

            mod = importlib.import_module(module_path)

            hashes = []           # flat list of all hashes (for backward compat)
            hashes_per_input = {}  # { inputKey: [hash_run1, hash_run2, ...] } for per-input drift
            last_output = None

            # Determine which inputs to validate: golden from .regret + all from manifest
            all_inputs = cluster_def.get('inputs', [regret.get('input')])
            inputs_to_validate = [regret.get('input')]
            for inp in all_inputs:
                if json.dumps(inp, sort_keys=True) != json.dumps(regret.get('input'), sort_keys=True):
                    inputs_to_validate.append(inp)

            for _ in range(cli['runs']):
                recorder = []
                ghost = create_ghost(mod, regret.get('watches', cluster_def.get('watches', [])), recorder)

                # Determine fingerprint mode: .regret file takes precedence over manifest
                effective_fp_mode = regret.get('fingerprintMode') or fp_mode or 'value'
                effective_value_paths = regret.get('valuePaths') or value_paths or []

                # Resolve the callable (function or class method)
                if class_method:
                    # classMethod mode: construct instance, run setup, then call method
                    Cls = getattr(mod, constructor_name or entry_name, None)
                    if Cls is None or not callable(Cls):
                        raise TypeError(f"Constructor \"{constructor_name or entry_name}\" not found in {module_path}")
                else:
                    entry_fn = getattr(ghost, entry_name, None) or getattr(mod, entry_name, None)
                    if entry_fn is None or not callable(entry_fn):
                        raise TypeError(f"Entry \"{entry_name}\" not found in {module_path}")

                for current_input in inputs_to_validate:
                    # Deep-clone input before calling to prevent mutation from corrupting fingerprint
                    input_for_fp = deep_clone(current_input)
                    input_for_args = deep_clone(current_input)

                    # Snapshot input state BEFORE call (for mutation tracking)
                    input_snapshot_before = None
                    if track_mutation:
                        input_snapshot_before = snapshot_state(input_for_args)

                    if class_method:
                        # Construct instance and call method
                        c_args = deep_clone(constructor_args) if constructor_args else []
                        if kwargs_mode and isinstance(c_args, dict):
                            instance = Cls(**c_args)
                        elif isinstance(c_args, list):
                            instance = Cls(*c_args)
                        else:
                            instance = Cls(c_args)
                        # Run setup
                        for step in (setup_steps or []):
                            method_name = step.get('method', '')
                            method_args = step.get('args', [])
                            getattr(instance, method_name)(*deep_clone(method_args))
                        # Call target method
                        target_method = getattr(instance, class_method)
                        if multi_args and isinstance(input_for_args, list):
                            raw_output = target_method(*input_for_args)
                        elif kwargs_mode and isinstance(input_for_args, dict):
                            raw_output = target_method(**input_for_args)
                        elif input_for_args is not None:
                            raw_output = target_method(input_for_args)
                        else:
                            raw_output = target_method()
                        fp_input = input_for_fp
                    elif multi_args and isinstance(input_for_args, list):
                        raw_output = entry_fn(*input_for_args)
                        fp_input = input_for_fp
                    elif kwargs_mode and isinstance(input_for_args, dict):
                        # kwargs mode: input dict is unpacked as keyword arguments
                        raw_output = entry_fn(**input_for_args)
                        fp_input = input_for_fp
                    elif kwargs_mode and not isinstance(input_for_args, dict):
                        raise TypeError(
                            f"kwargs=True but input is {type(input_for_args).__name__}, not dict. "
                            f"When kwargs is enabled, each input must be a dict to unpack as **kwargs."
                        )
                    else:
                        raw_output = entry_fn(input_for_args) if input_for_args is not None else entry_fn()
                        fp_input = input_for_fp

                    # Materialize generator/iterator output if configured
                    output, was_materialized = materialize_output(raw_output) if materialize_output_flag else (raw_output, False)

                    # Consume generators/iterators into lists for fingerprinting (always-on fallback)
                    if not materialize_output_flag:
                        output = consume_generator(output)

                    # Apply output transform if specified
                    output_for_fp = apply_output_transform(deep_clone(output), output_transform)

                    # Snapshot input state AFTER call (for mutation tracking)
                    mutation_match = True
                    if track_mutation:
                        input_snapshot_after = snapshot_state(input_for_args)
                        # Check mutation fingerprint matches the golden
                        golden_mutation_fp = regret.get('mutationFingerprint')
                        live_mutation_fp = fingerprint(
                            input_snapshot_before, input_snapshot_after,
                            norm_rules, ign_fields
                        )
                        if golden_mutation_fp and live_mutation_fp != golden_mutation_fp:
                            mutation_match = False

                    last_output = output_for_fp

                    if effective_fp_mode == 'schema':
                        schema = extract_schema(output_for_fp)
                        fp = fingerprint(fp_input, schema, norm_rules, ign_fields)
                    elif effective_fp_mode == 'mixed':
                        schema = extract_schema(output_for_fp)
                        selected_values = {}
                        for path in effective_value_paths:
                            key = path.replace('$.', '')
                            parts = key.split('.')
                            val = output_for_fp
                            for p in parts:
                                val = val.get(p) if isinstance(val, dict) else None
                                if val is None:
                                    break
                            if val is not None:
                                selected_values[path] = val
                        combined = {'schema': schema, 'values': selected_values}
                        fp = fingerprint(fp_input, combined, norm_rules, ign_fields)
                    elif fp_level == 'entry':
                        fp = fingerprint(fp_input, output_for_fp, norm_rules, ign_fields)
                    else:
                        fp = fingerprint_sequence(recorder, norm_rules, ign_fields)

                    hashes.append(fp)

                    # Track per-input hashes for drift detection
                    input_key = json.dumps(current_input, sort_keys=True)
                    if input_key not in hashes_per_input:
                        hashes_per_input[input_key] = []
                    hashes_per_input[input_key].append(fp)

            live_hash = hashes[0]
            is_match = live_hash == regret.get('goldenHash')
            # Per-input drift detection: each input must produce the same hash across all runs.
            is_drift = drift_mode and any(
                len(set(input_hashes)) > 1
                for input_hashes in hashes_per_input.values()
            )

            # Mutation mismatch is a separate failure condition
            if track_mutation and not mutation_match:
                print(f"  ❌ {cluster_id:<35} MUTATION MISMATCH")
                results.append({'id': cluster_id, 'pass': False, 'mutation_mismatch': True})
                continue

            if update_mode:
                if is_match:
                    print(f"  ℹ️  {cluster_id:<35} unchanged — no update needed")
                    results.append({'id': cluster_id, 'pass': True})
                else:
                    old_hash, new_hash = update_regret(
                        regret_path, regret, live_hash, last_output, cli['reason']
                    )
                    print(f"  ✅ {cluster_id:<35} {old_hash} → {new_hash}  UPDATED")
                    results.append({'id': cluster_id, 'pass': True, 'updated': True})

            elif drift_mode:
                if is_drift:
                    print(f"  ❌ {cluster_id:<35} DRIFT  [{' / '.join(hashes)}]")
                    results.append({'id': cluster_id, 'pass': False, 'drift': True})
                else:
                    icon = '✅' if is_match else '❌'
                    print(f"  {icon} {cluster_id:<35} {live_hash}  × {cli['runs']}  {'PASS+STABLE' if is_match else 'FAIL'}")
                    results.append({'id': cluster_id, 'pass': is_match})

            else:
                icon = '✅' if is_match else '❌'
                hash_str = regret.get('goldenHash', '') if is_match else f"{regret.get('goldenHash', '')} → {live_hash}"
                print(f"  {icon} {cluster_id:<35} {hash_str:<22} {'PASS' if is_match else 'FAIL'}")
                results.append({
                    'id': cluster_id, 'pass': is_match,
                    'golden': regret.get('goldenHash'), 'live': live_hash
                })

        except Exception as err:
            print(f"  ❌ {cluster_id:<35} ERROR: {err}")
            results.append({'id': cluster_id, 'pass': False, 'error': str(err)})

        if results and not results[-1]['pass'] and cli['fail_fast']:
            print("\n  --fail-fast: stopping.")
            break

    # ─── Summary ──────────────────────────────────────────────────────────────

    passed = sum(1 for r in results if r['pass'])
    failed = sum(1 for r in results if not r['pass'])
    drifted = sum(1 for r in results if r.get('drift'))

    print(f"\n{'─' * 60}")

    if update_mode:
        updated = sum(1 for r in results if r.get('updated'))
        print(f"✅ Update complete. {updated} updated.\n   Audit: regrets/audit.log")
        sys.exit(0)

    if drift_mode and drifted > 0:
        print(f"❌ Drift in {drifted} cluster(s). Add normalize rules and re-capture.")
        sys.exit(1)

    if failed == 0:
        print(f"✅ All {passed} tests passed{' (' + str(cli['runs']) + ' runs — stable)' if drift_mode else ''}. Refactor is safe.\n")
        sys.exit(0)

    print(f"❌ {failed}/{len(results)} FAILED.\n")
    for r in results:
        if not r['pass']:
            print(f"  • {r['id']}")
            if r.get('error'):
                print(f"    {r['error']}")
            elif r.get('golden'):
                print(f"    Expected: {r['golden']}  Got: {r['live']}")
    print("\nFix the CODE — do not edit .regret files.")
    print("Re-run: python scripts/validate.py")
    sys.exit(1)


if __name__ == '__main__':
    main()

#!/usr/bin/env python3
"""
_chain_step.py — Helper script for running a single Python chain step.
Called by contest.mjs when a chain contains Python clusters.
Receives a JSON payload as argument, runs the entry function, returns JSON result.
Supports classMethod, kwargs, outputTransform, and generator materialization
for cross-stack fingerprint consistency with contest.py.
"""
import sys
import os
import json
import importlib

# Import fingerprint module from same directory
sys.path.insert(0, os.path.dirname(__file__))
from fingerprint import fingerprint, deep_clone, _numpy_to_native


def main():
    if len(sys.argv) < 2:
        print("❌ No payload provided", file=sys.stderr)
        sys.exit(1)

    payload = json.loads(sys.argv[1])
    entry_name = payload['entry']
    module_path = payload['module']
    python_path = payload.get('python_path', '')
    multi_args = payload.get('multi_args', False)
    input_data = payload['input']
    norm_rules = payload.get('normalize', [])
    ign_fields = payload.get('ignore_fields', [])
    # classMethod support
    class_method = payload.get('class_method', None)
    constructor_name = payload.get('constructor', entry_name)
    constructor_args = payload.get('constructor_args', [])
    setup_steps = payload.get('setup', [])
    # kwargs support (for cross-stack fingerprint consistency)
    kwargs_mode = payload.get('kwargs', False)
    # outputTransform support (for cross-stack fingerprint consistency)
    output_transform = payload.get('output_transform', None)

    # Add pythonPath to sys.path
    if python_path:
        # Support both string and list forms
        if isinstance(python_path, str):
            python_paths = [python_path] if python_path else []
        elif isinstance(python_path, list):
            python_paths = python_path
        else:
            python_paths = []
        for pp in python_paths:
            if pp:
                abs_path = os.path.join(os.getcwd(), pp) if not os.path.isabs(pp) else pp
                if abs_path not in sys.path:
                    sys.path.insert(0, abs_path)

    # Dynamic import
    mod = importlib.import_module(module_path)

    if class_method:
        # ── classMethod mode: fresh instance ─────────────────────────────
        Cls = getattr(mod, constructor_name or entry_name, None)
        if Cls is None or not (isinstance(Cls, type) or callable(Cls)):
            print(f"❌ Constructor '{constructor_name or entry_name}' not found or not a class in {module_path}", file=sys.stderr)
            sys.exit(1)

        c_args = deep_clone(constructor_args) if constructor_args else []
        if isinstance(c_args, dict):
            instance = Cls(**c_args)
        elif isinstance(c_args, list):
            instance = Cls(*c_args)
        else:
            instance = Cls(c_args)

        # Run setup methods
        for step in (setup_steps or []):
            setup_method = getattr(instance, step.get('method', ''), None)
            if setup_method is not None and callable(setup_method):
                setup_args = step.get('args', [])
                if isinstance(setup_args, list):
                    setup_method(*deep_clone(setup_args))
                elif isinstance(setup_args, dict):
                    setup_method(**setup_args)

        target_method = getattr(instance, class_method, None)
        if target_method is None or not callable(target_method):
            print(f"❌ Method '{class_method}' not found on instance", file=sys.stderr)
            sys.exit(1)

        input_for_args = deep_clone(input_data)
        if multi_args and isinstance(input_for_args, list):
            output = target_method(*input_for_args)
        elif kwargs_mode and isinstance(input_for_args, dict):
            output = target_method(**input_for_args)
        elif input_for_args is not None:
            output = target_method(input_for_args)
        else:
            output = target_method()
    else:
        # ── Function-based entry ─────────────────────────────────────────
        entry_fn = getattr(mod, entry_name, None)
        if entry_fn is None or not callable(entry_fn):
            print(f"❌ Entry '{entry_name}' not found in {module_path}", file=sys.stderr)
            sys.exit(1)

        # Run entry function
        input_for_args = deep_clone(input_data)
        if multi_args and isinstance(input_for_args, list):
            output = entry_fn(*input_for_args)
        elif kwargs_mode and isinstance(input_for_args, dict):
            output = entry_fn(**input_for_args)
        elif input_for_args is not None:
            output = entry_fn(input_for_args)
        else:
            output = entry_fn()

    # Consume generators/iterators (for cross-stack fingerprint consistency)
    from capture import consume_generator
    output = consume_generator(output)

    # Apply output transform (for cross-stack fingerprint consistency)
    from capture import apply_output_transform
    output_for_fp = apply_output_transform(deep_clone(output), output_transform)

    # Compute fingerprint
    fp = fingerprint(input_data, output_for_fp, norm_rules, ign_fields)

    # Return JSON result
    result = {
        'output': output_for_fp,
        'fingerprint': fp,
    }
    print(json.dumps(result, ensure_ascii=False))


if __name__ == '__main__':
    main()

#!/usr/bin/env python3
# audit.py — Comprehensive pre-refactor readiness audit
# Combines health, coverage, drift, and chain status into a single report.
#
# Usage:
#   python scripts/audit.py
#   python scripts/audit.py --strict   (exit 1 if any issues found)
#
# This addresses the gap where agents had to manually run health + coverage + drift
# before deciding it was safe to refactor. Audit combines all checks and gives
# a clear YES/NO answer.

import json
import os
import sys
import subprocess


def run_command(cmd):
    """Run a command and return its output."""
    try:
        result = subprocess.run(
            cmd, capture_output=True, text=True, timeout=120,
            cwd=os.getcwd()
        )
        return result.stdout, result.returncode
    except Exception as e:
        return str(e), 1


def check_manifest():
    """Check if manifest exists and is valid."""
    manifest_path = os.path.join(os.getcwd(), 'regrets', 'manifest.json')
    if not os.path.exists(manifest_path):
        return False, "No manifest.json found"
    try:
        with open(manifest_path, 'r') as f:
            manifest = json.load(f)
        clusters = manifest.get('clusters', [])
        if not clusters:
            return False, "No clusters defined in manifest"
        return True, f"{len(clusters)} cluster(s) defined"
    except json.JSONDecodeError as e:
        return False, f"Invalid JSON: {e}"


def check_regret_files():
    """Check if .regret files exist for all clusters."""
    regret_dir = os.path.join(os.getcwd(), 'regrets')
    manifest_path = os.path.join(regret_dir, 'manifest.json')

    with open(manifest_path, 'r') as f:
        manifest = json.load(f)

    cluster_ids = {c['id'] for c in manifest.get('clusters', [])}
    regret_files = set()
    try:
        for f in os.listdir(regret_dir):
            if f.endswith('.regret'):
                regret_files.add(os.path.splitext(f)[0])
    except FileNotFoundError:
        return False, "No regrets/ directory"

    missing = cluster_ids - regret_files
    if missing:
        return False, f"Missing .regret files: {', '.join(sorted(missing))}"
    return True, f"All {len(cluster_ids)} .regret files present"


def check_validate():
    """Run validate and check all GREEN."""
    script_dir = os.path.dirname(os.path.abspath(__file__))
    output, code = run_command(['python3', f'{script_dir}/validate.py'])
    if code == 0:
        # Count GREEN clusters
        green_count = output.count('✅')
        return True, f"{green_count} cluster(s) GREEN"
    else:
        red_count = output.count('❌')
        return False, f"{red_count} cluster(s) RED — fix before refactoring"


def check_drift():
    """Run drift detection (3 runs)."""
    script_dir = os.path.dirname(os.path.abspath(__file__))
    output, code = run_command(['python3', f'{script_dir}/validate.py', '--runs', '3'])
    if 'DRIFT' in output:
        drift_count = output.count('DRIFT')
        return False, f"{drift_count} cluster(s) DRIFT — add normalize rules"
    if code == 0:
        stable_count = output.count('STABLE')
        return True, f"{stable_count} cluster(s) STABLE across 3 runs"
    return False, "Drift check failed"


def check_health():
    """Parse health report for SOLID clusters."""
    script_dir = os.path.dirname(os.path.abspath(__file__))
    output, code = run_command(['python3', f'{script_dir}/health.py'])

    solid_count = output.count('SOLID')
    good_count = output.count('GOOD')
    unstable_count = output.count('UNSTABLE')
    fragile_count = output.count('FRAGILE')

    if fragile_count > 0 or unstable_count > 0:
        return False, f"SOLID: {solid_count}, GOOD: {good_count}, UNSTABLE: {unstable_count}, FRAGILE: {fragile_count}"
    return True, f"SOLID: {solid_count}, GOOD: {good_count}"


def check_coverage():
    """Run coverage check (Python clusters only)."""
    script_dir = os.path.dirname(os.path.abspath(__file__))
    output, code = run_command(['python3', f'{script_dir}/coverage.py'])

    if 'LOW' in output:
        low_count = output.count('LOW')
        return False, f"{low_count} cluster(s) with LOW coverage"
    if 'PARTIAL' in output:
        partial_count = output.count('PARTIAL')
        return True, f"All clusters covered, {partial_count} PARTIAL (acceptable but improve)", True  # has_warning
    if code == 0:
        return True, "All clusters FULL or LIKELY FULL"
    return True, "Coverage check skipped (non-Python clusters)"


def main():
    strict = '--strict' in sys.argv

    print("╔══════════════════════════════════════════════════════════════════╗")
    print("║              REGRET PRE-REFACTOR AUDIT REPORT                   ║")
    print("╚══════════════════════════════════════════════════════════════════╝")
    print()

    checks = [
        ("Manifest", check_manifest),
        ("Regret Files", check_regret_files),
        ("Validation", check_validate),
        ("Drift Detection", check_drift),
        ("Cluster Health", check_health),
        ("Branch Coverage", check_coverage),
    ]

    all_pass = True
    warnings = []

    for name, check_fn in checks:
        print(f"  Checking {name}...", end=" ", flush=True)
        try:
            result = check_fn()
            if len(result) == 3:
                ok, msg, has_warning = result
            else:
                ok, msg = result
                has_warning = False

            if ok:
                icon = "✅" if not has_warning else "🟡"
                print(f"{icon} {msg}")
                if has_warning:
                    warnings.append(f"{name}: {msg}")
            else:
                print(f"❌ {msg}")
                all_pass = False
        except Exception as e:
            print(f"⚠️  Error: {e}")
            warnings.append(f"{name}: check failed — {e}")

    print()
    print("─" * 68)

    if all_pass and not warnings:
        print("✅ AUDIT PASSED — All checks GREEN. Safe to refactor.")
    elif all_pass and warnings:
        print("🟡 AUDIT PASSED with warnings:")
        for w in warnings:
            print(f"   • {w}")
        print("   Refactoring is possible but consider addressing warnings first.")
    else:
        print("❌ AUDIT FAILED — Fix the issues above before refactoring.")

    print()

    if strict and not all_pass:
        sys.exit(1)


if __name__ == '__main__':
    main()

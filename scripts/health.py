#!/usr/bin/env python3
# health.py — cluster health score report for Python + all stacks
# Reads audit.log + .regret files to score cluster stability
#
# Usage:
#   python scripts/health.py
#   python scripts/health.py --sort fragile

import sys
import os
import json
import re
from datetime import datetime, timezone

# ─── CLI args ─────────────────────────────────────────────────────────────────

def parse_args():
    args = sys.argv[1:]
    sort_by = 'health'

    i = 0
    while i < len(args):
        if args[i] == '--sort' and i + 1 < len(args):
            sort_by = args[i + 1]
            i += 2
        else:
            i += 1

    return sort_by


# ─── Parse audit.log ──────────────────────────────────────────────────────────

def parse_audit_log(audit_path):
    if not os.path.exists(audit_path):
        return {}

    try:
        with open(audit_path, 'r', encoding='utf-8') as f:
            content = f.read().strip()
    except FileNotFoundError:
        return {}

    if not content:
        return {}

    events = {}
    blocks = re.split(r'\n\n+', content)

    for block in blocks:
        lines = block.strip().split('\n')
        if not lines:
            continue

        header = lines[0].strip()
        parts = header.split()
        if len(parts) < 3:
            continue

        event_type = parts[1]
        cluster_id = parts[2]

        if cluster_id not in events:
            events[cluster_id] = {'updates': 0, 'drifts': 0, 'history': []}

        if event_type == 'UPDATE':
            events[cluster_id]['updates'] += 1
        if event_type == 'DRIFT':
            events[cluster_id]['drifts'] += 1

        events[cluster_id]['history'].append({
            'type': event_type,
            'date': parts[0],
        })

    return events


# ─── Parse .regret metadata ──────────────────────────────────────────────────

def parse_regret_meta(content):
    meta = {}
    meta_section = content.split('\n---\n')[0]
    for line in meta_section.split('\n'):
        colon_idx = line.find(': ')
        if colon_idx == -1:
            continue
        key = line[:colon_idx]
        val = line[colon_idx + 2:].strip()
        meta[key] = val
    return meta


# ─── Health score (0–100) ─────────────────────────────────────────────────────

def score_cluster(updates, drifts, age_days):
    score = 100
    score -= updates * 15   # each intentional update = -15
    score -= drifts * 25    # each drift = -25 (worse, indicates hidden bugs)
    if age_days < 3:
        score -= 10  # brand new, not proven yet
    if age_days > 30:
        score += 5   # old and stable = bonus
    return max(0, min(100, score))


def health_label(score, *, is_new=False):
    if is_new:
        return {'label': 'NEW',      'bar': '░░░░░░', 'color': '🩵', 'note': '(newly captured — run drift to verify)'}
    if score >= 90:
        return {'label': 'SOLID',    'bar': '██████', 'color': '✅'}
    if score >= 70:
        return {'label': 'GOOD',     'bar': '█████░', 'color': '🟢'}
    if score >= 50:
        return {'label': 'UNSTABLE', 'bar': '███░░░', 'color': '🟡'}
    return              {'label': 'FRAGILE',   'bar': '██░░░░', 'color': '🔴'}


# ─── Main ─────────────────────────────────────────────────────────────────────

def main():
    sort_by = parse_args()
    regret_dir = os.path.join(os.getcwd(), 'regrets')
    audit_log = os.path.join(regret_dir, 'audit.log')

    # Find .regret files
    try:
        regret_files = [f for f in os.listdir(regret_dir) if f.endswith('.regret')]
    except FileNotFoundError:
        print("❌ regrets/ directory not found. Run capture first.")
        sys.exit(1)

    if not regret_files:
        print("No .regret files found. Nothing to report.")
        sys.exit(0)

    audit_data = parse_audit_log(audit_log)
    now = datetime.now(timezone.utc).timestamp()

    clusters = []
    for f in regret_files:
        cluster_id = os.path.splitext(f)[0]
        with open(os.path.join(regret_dir, f), 'r', encoding='utf-8') as fh:
            meta = parse_regret_meta(fh.read())

        audit = audit_data.get(cluster_id, {'updates': 0, 'drifts': 0, 'history': []})

        captured_str = meta.get('captured', '')
        if captured_str:
            try:
                captured = datetime.fromisoformat(captured_str.replace('Z', '+00:00')).timestamp()
            except ValueError:
                captured = now
        else:
            captured = now

        age_hours = (now - captured) / 3600
        age_days = int(age_hours / 24)
        is_new = age_hours < 72 and audit['updates'] == 0 and audit['drifts'] == 0
        score = score_cluster(audit['updates'], audit['drifts'], age_days)
        health = health_label(score, is_new=is_new)

        clusters.append({
            'id': cluster_id,
            'ageDays': age_days,
            'score': score,
            'health': health,
            'isNew': is_new,
            'updates': audit['updates'],
            'drifts': audit['drifts'],
        })

    # Sort
    if sort_by == 'fragile':
        sorted_clusters = sorted(clusters, key=lambda c: c['score'])
    elif sort_by == 'age':
        sorted_clusters = sorted(clusters, key=lambda c: c['ageDays'], reverse=True)
    else:
        sorted_clusters = sorted(clusters, key=lambda c: c['score'], reverse=True)

    # ─── Render ───────────────────────────────────────────────────────────────

    COL = {'id': 30, 'updates': 8, 'drifts': 7, 'age': 9}

    print('\nCLUSTER HEALTH REPORT')
    print('─' * 72)
    print(
        f"{'cluster':<{COL['id']}}"
        f"{'updates':<{COL['updates']}}"
        f"{'drifts':<{COL['drifts']}}"
        f"{'age':<{COL['age']}}"
        'health'
    )
    print('─' * 72)

    for c in sorted_clusters:
        age = 'today' if c['ageDays'] == 0 else f"{c['ageDays']}d"
        note = f"  {c['health']['note']}" if c['health'].get('note') else ''
        print(
            f"{c['id']:<{COL['id']}}"
            f"{c['updates']:<{COL['updates']}}"
            f"{c['drifts']:<{COL['drifts']}}"
            f"{age:<{COL['age']}}"
            f"{c['health']['bar']} {c['health']['label']}{note}"
        )

    print('─' * 72)

    # ─── Legend ─────────────────────────────────────────────────────────────

    print('\nLegend:')
    print('  🩵 NEW      = recently captured, not yet verified')
    print('  ✅ SOLID    = stable, no changes detected')
    print('  🟢 GOOD     = minor changes, still healthy')
    print('  🟡 UNSTABLE = frequent changes, needs attention')
    print('  🔴 FRAGILE  = critical, high drift or update rate')

    # ─── Recommendations ──────────────────────────────────────────────────────

    fragile = [c for c in sorted_clusters if c['score'] < 50]
    unstable = [c for c in sorted_clusters if 50 <= c['score'] < 70]

    if fragile or unstable:
        print('\nRecommendations:')
        for c in fragile:
            if c['updates'] >= 3:
                print(f"  {c['id']:<{COL['id']}} → high update rate, consider splitting this cluster")
            if c['drifts'] >= 1:
                print(f"  {c['id']:<{COL['id']}} → drift detected, add normalize rules to manifest")
        for c in unstable:
            print(f"  {c['id']:<{COL['id']}} → monitor closely, {c['updates']} update(s), {c['drifts']} drift(s)")
    else:
        print('\n✅ All clusters are healthy. Safe to refactor.')

    solid = [c for c in sorted_clusters if c['score'] >= 90 and not c.get('isNew')]
    if solid:
        print('\nDo not touch (SOLID contracts):')
        for c in solid:
            print(f"  {c['id']}")

    print()


if __name__ == '__main__':
    main()

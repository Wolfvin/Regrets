#!/usr/bin/env python3
# status.py — Quick snapshot of Regrets state for "is it safe to refactor?"
#
# Usage:
#   python scripts/status.py
#   python scripts/status.py --json
#
# Reads manifest + .regret files + audit.log to compute coverage, health,
# confidence, and safeToRefactor — without running any captures/validates.
# Also reads chains.json + chains/*.chain for chain-aware status.
#
# safeToRefactor logic:
#   YES:    all clusters SOLID + HIGH confidence + all chains captured
#   PARTIAL: has GOOD/MEDIUM clusters, or chains not captured (or NEW)
#   NO:     has FRAGILE/UNSTABLE or LOW confidence clusters

import sys
import os
import json
from datetime import datetime, timezone

# ─── CLI args ────────────────────────────────────────────────────────────────

args = sys.argv[1:]
json_output = '--json' in args
regret_dir = os.path.join(os.getcwd(), 'regrets')
manifest_path = os.path.join(regret_dir, 'manifest.json')
audit_log_path = os.path.join(regret_dir, 'audit.log')
chains_json_path = os.path.join(regret_dir, 'chains.json')
chains_dir = os.path.join(regret_dir, 'chains')

# ─── Check if installed ──────────────────────────────────────────────────────

is_installed = os.path.exists(manifest_path)

if not is_installed:
    if json_output:
        print(json.dumps({
            'installed': False, 'clusters': 0, 'captured': 0,
            'lastCapture': None, 'health': {}, 'confidence': {},
            'safeToRefactor': 'NO'
        }))
    else:
        print(f'\n📊 Regrets Status\n\nInstalled: NO\n\nRun \'regret install\' to get started.')
    sys.exit(0)

# ─── Load manifest ──────────────────────────────────────────────────────────

try:
    with open(manifest_path, 'r', encoding='utf-8') as f:
        manifest = json.load(f)
except (json.JSONDecodeError, OSError):
    if json_output:
        print(json.dumps({
            'installed': False, 'clusters': 0, 'captured': 0,
            'lastCapture': None, 'health': {}, 'confidence': {},
            'safeToRefactor': 'NO'
        }))
    else:
        print('\n📊 Regrets Status\n\nInstalled: NO (manifest corrupt)\n')
    sys.exit(1)

clusters = manifest.get('clusters', [])
cluster_count = len(clusters)

# ─── Parse .regret files ────────────────────────────────────────────────────

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


regret_metas = {}
regret_files = []
try:
    regret_files = [f for f in os.listdir(regret_dir) if f.endswith('.regret')]
    for f in regret_files:
        with open(os.path.join(regret_dir, f), 'r', encoding='utf-8') as fh:
            content = fh.read()
        regret_metas[f.replace('.regret', '')] = parse_regret_meta(content)
except (FileNotFoundError, OSError):
    pass

# ─── Compute metrics ────────────────────────────────────────────────────────

def parse_audit_for_drift(audit_path):
    """Parse audit.log and return a map of cluster-id -> hasDriftOrUpdate."""
    result = {}
    try:
        if not os.path.exists(audit_path):
            return result
        with open(audit_path, 'r', encoding='utf-8') as f:
            content = f.read().strip()
        if not content:
            return result
        blocks = content.split('\n\n')
        for block in blocks:
            lines = block.strip().split('\n')
            if not lines:
                continue
            header = lines[0]
            parts = header.strip().split()
            if len(parts) < 3:
                continue
            event_type = parts[1].lower()
            cluster_id = parts[2]
            if not cluster_id:
                continue
            if 'drift' in event_type or 'update' in event_type:
                result[cluster_id] = True
    except (OSError, ValueError):
        pass
    return result


def input_count_factor(input_count):
    if input_count <= 1:
        return 0.1
    if input_count <= 3:
        return 0.4
    if input_count <= 6:
        return 0.7
    return 1.0


def capture_age_factor(age_days):
    if age_days < 1:
        return 0.5
    if age_days <= 7:
        return 0.8
    return 1.0


def drift_history_factor(has_drift_or_update):
    return 0.6 if has_drift_or_update else 1.0


def confidence_label(score):
    if score >= 0.8:
        return 'HIGH'
    if score >= 0.5:
        return 'MEDIUM'
    return 'LOW'


def compute_confidence(input_count, age_days, has_drift_or_update):
    f1 = input_count_factor(input_count)
    f2 = capture_age_factor(age_days)
    f3 = drift_history_factor(has_drift_or_update)
    score = f1 * 0.5 + f2 * 0.2 + f3 * 0.3
    score = round(score, 3)
    return {'score': score, 'label': confidence_label(score)}


drift_map = parse_audit_for_drift(audit_log_path)
now = datetime.now(timezone.utc).timestamp() * 1000  # ms, matching JS Date.now()

# Parse audit.log for updates/drifts per cluster
audit_data = {}
if os.path.exists(audit_log_path):
    try:
        with open(audit_log_path, 'r', encoding='utf-8') as f:
            content = f.read().strip()
        blocks = content.split('\n\n')
        for block in blocks:
            lines = block.strip().split('\n')
            if not lines:
                continue
            header = lines[0]
            parts = header.strip().split()
            if len(parts) < 3:
                continue
            event_type = parts[1]
            cluster_id = parts[2]
            if not cluster_id:
                continue
            if cluster_id not in audit_data:
                audit_data[cluster_id] = {'updates': 0, 'drifts': 0}
            if event_type == 'UPDATE':
                audit_data[cluster_id]['updates'] += 1
            if event_type == 'DRIFT':
                audit_data[cluster_id]['drifts'] += 1
    except (OSError, ValueError):
        pass

# Health scoring
def score_cluster(updates, drifts, age_days):
    score = 100
    score -= updates * 15
    score -= drifts * 25
    if age_days < 3:
        score -= 10
    if age_days > 30:
        score += 5
    return max(0, min(100, score))


def health_label_for(score, is_new):
    if is_new:
        return 'NEW'
    if score >= 90:
        return 'SOLID'
    if score >= 70:
        return 'GOOD'
    if score >= 50:
        return 'UNSTABLE'
    return 'FRAGILE'


# Compute per-cluster health + confidence
latest_capture_time = 0
health_counts = {'SOLID': 0, 'GOOD': 0, 'UNSTABLE': 0, 'FRAGILE': 0, 'NEW': 0}
confidence_counts = {'HIGH': 0, 'MEDIUM': 0, 'LOW': 0}
skipped_clusters = []
fragile_list = []
low_conf_list = []

for cluster in clusters:
    meta = regret_metas.get(cluster['id'])
    has_regret = bool(meta and meta.get('fingerprint'))

    if not has_regret:
        skipped_clusters.append(cluster['id'])
        health_counts['FRAGILE'] += 1
        confidence_counts['LOW'] += 1
        low_conf_list.append({'id': cluster['id'], 'reason': 'not captured'})
        fragile_list.append({'id': cluster['id'], 'reason': 'not captured'})
        continue

    # Parse capture time
    captured_str = meta.get('captured', '')
    if captured_str:
        try:
            captured = datetime.fromisoformat(captured_str.replace('Z', '+00:00')).timestamp() * 1000
        except ValueError:
            captured = now
    else:
        captured = now

    if captured > latest_capture_time:
        latest_capture_time = captured

    age_hours = (now - captured) / (1000 * 60 * 60)
    age_days = int(age_hours / 24)
    audit = audit_data.get(cluster['id'], {'updates': 0, 'drifts': 0})
    is_new = age_hours < 72 and audit['updates'] == 0 and audit['drifts'] == 0

    # Health
    score = score_cluster(audit['updates'], audit['drifts'], age_days)
    health = health_label_for(score, is_new)
    health_counts[health] = health_counts.get(health, 0) + 1

    if health in ('FRAGILE', 'UNSTABLE'):
        fragile_list.append({'id': cluster['id'], 'reason': f'{health} (score: {score})'})

    # Confidence
    input_count = len(cluster.get('inputs', []))
    has_drift_or_update = bool(drift_map.get(cluster['id']))
    confidence = compute_confidence(input_count, age_days, has_drift_or_update)
    confidence_counts[confidence['label']] = confidence_counts.get(confidence['label'], 0) + 1

    if confidence['label'] == 'LOW':
        low_conf_list.append({
            'id': cluster['id'],
            'reason': f"{input_count} input{'s' if input_count != 1 else ''}, {age_days}d old"
        })

# Coverage
captured_count = cluster_count - len(skipped_clusters)
coverage_pct = round((captured_count / cluster_count) * 100) if cluster_count > 0 else 0

# Last capture time
last_capture_iso = datetime.fromtimestamp(latest_capture_time / 1000, tz=timezone.utc).isoformat() if latest_capture_time > 0 else None


def format_time_ago(ms):
    seconds = int(ms / 1000)
    if seconds < 60:
        return 'just now'
    minutes = seconds // 60
    if minutes < 60:
        return f'{minutes}m ago'
    hours = minutes // 60
    if hours < 24:
        return f'{hours}h ago'
    days = hours // 24
    if days < 30:
        return f'{days}d ago'
    months = days // 30
    return f'{months}mo ago'


last_capture_ago = format_time_ago(now - latest_capture_time) if latest_capture_time > 0 else 'never'

# ─── Chain awareness ────────────────────────────────────────────────────────

chains_defined = 0
chains_captured = 0
chains_uncaptured = []
chains_section = False

if os.path.exists(chains_json_path):
    chains_section = True
    try:
        with open(chains_json_path, 'r', encoding='utf-8') as f:
            chains_json = json.load(f)
        chain_list = chains_json.get('chains', [])
        chains_defined = len(chain_list)
        for chain in chain_list:
            chain_file = os.path.join(chains_dir, f"{chain['id']}.chain")
            if os.path.exists(chain_file):
                chains_captured += 1
            else:
                chains_uncaptured.append(chain['id'])
    except (json.JSONDecodeError, OSError):
        # chains.json corrupt — treat as no chains
        chains_section = False

has_uncaptured_chains = chains_section and len(chains_uncaptured) > 0

# safeToRefactor
has_fragile = health_counts.get('FRAGILE', 0) > 0 or health_counts.get('UNSTABLE', 0) > 0
has_low = confidence_counts.get('LOW', 0) > 0
has_good = health_counts.get('GOOD', 0) > 0 or health_counts.get('NEW', 0) > 0
has_medium = confidence_counts.get('MEDIUM', 0) > 0

if has_fragile or has_low:
    safe_to_refactor = 'NO'
elif has_good or has_medium or has_uncaptured_chains:
    safe_to_refactor = 'PARTIAL'
elif cluster_count > 0 and captured_count == cluster_count:
    safe_to_refactor = 'YES'
else:
    safe_to_refactor = 'NO'

# If uncaptured chains exist, max PARTIAL
if has_uncaptured_chains and safe_to_refactor == 'YES':
    safe_to_refactor = 'PARTIAL'

# ─── Output ─────────────────────────────────────────────────────────────────

if json_output:
    json_result = {
        'installed': True,
        'clusters': cluster_count,
        'captured': captured_count,
        'skipped': len(skipped_clusters),
        'lastCapture': last_capture_iso,
        'coverage': coverage_pct,
        'health': health_counts,
        'confidence': confidence_counts,
        'safeToRefactor': safe_to_refactor,
    }
    if chains_section:
        json_result['chains'] = {'defined': chains_defined, 'captured': chains_captured}
    print(json.dumps(json_result, separators=(',', ':')))
else:
    print(f'\n📊 Regrets Status\n')
    print(f"Installed: YES ({cluster_count} cluster{'s' if cluster_count != 1 else ''})")
    print(f'Last capture: {last_capture_ago}')
    skipped_msg = f", {len(skipped_clusters)} skipped" if skipped_clusters else ""
    print(f'Coverage: {coverage_pct}% ({captured_count}/{cluster_count} captured{skipped_msg})')

    # Health summary
    health_parts = []
    if health_counts.get('SOLID'):
        health_parts.append(f"{health_counts['SOLID']} SOLID")
    if health_counts.get('GOOD'):
        health_parts.append(f"{health_counts['GOOD']} GOOD")
    if health_counts.get('UNSTABLE'):
        health_parts.append(f"{health_counts['UNSTABLE']} UNSTABLE")
    if health_counts.get('FRAGILE'):
        health_parts.append(f"{health_counts['FRAGILE']} FRAGILE")
    if health_counts.get('NEW'):
        health_parts.append(f"{health_counts['NEW']} NEW")
    print(f"Health: {', '.join(health_parts)}")

    # Confidence summary
    conf_parts = []
    if confidence_counts.get('HIGH'):
        conf_parts.append(f"{confidence_counts['HIGH']} HIGH")
    if confidence_counts.get('MEDIUM'):
        conf_parts.append(f"{confidence_counts['MEDIUM']} MEDIUM")
    if confidence_counts.get('LOW'):
        conf_parts.append(f"{confidence_counts['LOW']} LOW")
    print(f"Confidence: {', '.join(conf_parts)}")

    # Chain summary
    if chains_section:
        if chains_uncaptured:
            print(f'Chains: {len(chains_uncaptured)} uncaptured (of {chains_defined} defined)')
        else:
            print(f'Chains: {chains_captured} captured (of {chains_defined} defined)')

    # Action needed
    actions = []
    if fragile_list:
        actions.append(f"{len(fragile_list)} cluster{'s' if len(fragile_list) != 1 else ''} FRAGILE/UNSTABLE — add more inputs or fix drift")
    if low_conf_list:
        actions.append(f"{len(low_conf_list)} cluster{'s' if len(low_conf_list) != 1 else ''} LOW confidence — too few inputs")
    if skipped_clusters:
        actions.append(f"{len(skipped_clusters)} cluster{'s' if len(skipped_clusters) != 1 else ''} not captured — run 'regret capture'")
    if has_uncaptured_chains:
        actions.append(f"{len(chains_uncaptured)} chain{'s' if len(chains_uncaptured) != 1 else ''} not captured — run 'regret chain --capture'")

    if actions:
        print(f'\n⚠️  Action needed:')
        for a in actions:
            print(f'  • {a}')

    # Safe to refactor verdict
    if safe_to_refactor == 'YES':
        verdict_icon = '✅'
        verdict_detail = ''
    elif safe_to_refactor == 'PARTIAL':
        verdict_icon = '🟡'
        verdict_detail = ' (see fragile clusters)'
    else:
        verdict_icon = '🔴'
        verdict_detail = ' (fix issues first)'

    print(f'\nSafe to refactor: {safe_to_refactor}{verdict_detail}')
    print()



#!/usr/bin/env python3
"""
Probability-based issue picker for Regrets repo.

Reads all open issues from GitHub, filters out [CLAIM]-title-only (no REVIEW tag)
and [SUCCESS] issues, determines status of remaining issues, then randomly selects
from the pool with weighted probability based on urgency.

Usage:
    GH_TOKEN=<token> python3 scripts/issue_probability_picker.py [--count N] [--seed S]

Weights:
  - [REVIEW] with >1 PR/issue duplicate -> most urgent (weight 5)
  - [REVIEW] with 1 PR/issue            -> urgent (weight 3)
  - Untouched (no status comment)        -> moderate (weight 2)
  - [CONSOLIDATED] meta-issue            -> low (weight 1)
"""

import subprocess
import json
import random
import argparse
import sys

REPO = "Wolfvin/Regrets"


def run_gh_json(args):
    """Run a gh CLI command and return parsed JSON."""
    cmd = ["gh"] + args
    result = subprocess.run(cmd, capture_output=True, text=True)
    if result.returncode != 0:
        print(f"Error running gh: {result.stderr}", file=sys.stderr)
        return None
    return json.loads(result.stdout)


def get_all_open_issues():
    """Get all open issues with full details."""
    return run_gh_json([
        "issue", "list", "--repo", REPO, "--state", "open",
        "--json", "number,title,createdAt,comments", "--limit", "100"
    ]) or []


def determine_status(issue):
    """
    Determine the status of an issue based on its title and last comment.
    Returns: 'CLAIM', 'REVIEW', 'SUCCESS', 'CONSOLIDATED', or 'UNTOUCHED'
    """
    title = issue.get("title", "")
    comments = issue.get("comments", [])

    if comments:
        sorted_c = sorted(comments, key=lambda c: c.get("createdAt", ""), reverse=True)
        for c in sorted_c:
            header = c.get("body", "")[:500]
            positions = []
            for tag, name in [("[REVIEW]", "REVIEW"), ("[SUCCESS]", "SUCCESS"), ("[CLAIM]", "CLAIM")]:
                pos = header.find(tag)
                if pos >= 0:
                    positions.append((pos, name))
            if positions:
                positions.sort(key=lambda x: x[0])
                return positions[0][1]
            if "DONE" in header:
                return "REVIEW"

    if "[CONSOLIDATED]" in title:
        return "CONSOLIDATED"
    if "[CLAIM]" in title:
        return "CLAIM"  # implied from title, no status comments yet
    return "UNTOUCHED"


def count_prs(issue_number):
    """Count PRs related to this issue."""
    result = run_gh_json([
        "pr", "list", "--repo", REPO, "--state", "all",
        "--search", f"#{issue_number}", "--json", "number", "--limit", "20"
    ])
    return len(result) if result else 0


def assign_weight(status, pr_count=0):
    if status == "REVIEW" and pr_count > 1:
        return 5
    elif status == "REVIEW":
        return 3
    elif status == "UNTOUCHED":
        return 2
    elif status == "CONSOLIDATED":
        return 1
    return 1


def build_pool(issues):
    pool = []
    for issue in issues:
        status = determine_status(issue)
        if status in ("CLAIM", "SUCCESS"):
            continue
        pr_count = count_prs(issue["number"])
        weight = assign_weight(status, pr_count)
        pool.append({
            "number": issue["number"],
            "title": issue.get("title", ""),
            "status": status,
            "weight": weight,
            "pr_count": pr_count,
            "createdAt": issue.get("createdAt", ""),
        })
    pool.sort(key=lambda x: x["createdAt"])
    return pool


def weighted_random_select(pool, count=1, seed=None):
    if seed is not None:
        random.seed(seed)
    if not pool:
        return []
    if count >= len(pool):
        return pool

    remaining_pool = list(pool)
    remaining_weights = [item["weight"] for item in remaining_pool]
    selected = []

    for _ in range(count):
        if not remaining_pool:
            break
        total = sum(remaining_weights)
        if total == 0:
            pick = random.choice(range(len(remaining_pool)))
        else:
            r = random.uniform(0, total)
            cumulative = 0
            pick = 0
            for i, w in enumerate(remaining_weights):
                cumulative += w
                if r <= cumulative:
                    pick = i
                    break
        selected.append(remaining_pool.pop(pick))
        remaining_weights.pop(pick)

    return selected


def main():
    parser = argparse.ArgumentParser(description="Probability-based issue picker for Regrets")
    parser.add_argument("--count", "-n", type=int, default=1, help="Number of issues to select")
    parser.add_argument("--seed", "-s", type=int, default=None, help="Random seed for reproducibility")
    parser.add_argument("--json", action="store_true", help="Output as JSON")
    parser.add_argument("--list-pool", action="store_true", help="List full pool without selecting")
    parser.add_argument("--oldest", action="store_true", help="Pick the N oldest instead of random")
    args = parser.parse_args()

    print("Fetching open issues from Wolfvin/Regrets...")
    issues = get_all_open_issues()
    if not issues:
        print("No open issues found.")
        sys.exit(1)

    pool = build_pool(issues)
    if not pool:
        print("No eligible issues in pool.")
        sys.exit(0)

    if args.list_pool:
        print(f"\nPROBABILITY POOL — {len(pool)} eligible issues")
        print("=" * 100)
        print(f"{'#':<6} {'Status':<15} {'Weight':<8} {'PRs':<5} {'Created':<22} Title")
        print("-" * 100)
        for item in pool:
            print(f"#{item['number']:<5} {item['status']:<15} {item['weight']:<8} "
                  f"{item['pr_count']:<5} {item['createdAt'][:19]:<22} {item['title'][:60]}")
        total_w = sum(i["weight"] for i in pool)
        print(f"\nTotal weight: {total_w}")
        for item in pool:
            pct = (item["weight"] / total_w) * 100
            print(f"  #{item['number']} ({item['status']}, weight={item['weight']}): {pct:.1f}%")
        return

    if args.oldest:
        selected = pool[:args.count]
        method = "oldest-first"
    else:
        selected = weighted_random_select(pool, args.count, args.seed)
        method = "weighted-random"

    if args.json:
        print(json.dumps(selected, indent=2))
    else:
        print(f"\nSELECTED {len(selected)} issue(s) via {method}")
        print("=" * 80)
        for i, item in enumerate(selected, 1):
            print(f"\n  {i}. #{item['number']} — {item['title']}")
            print(f"     Status: {item['status']}  |  Weight: {item['weight']}  |  PRs: {item['pr_count']}")
            print(f"     Created: {item['createdAt'][:19]}")


if __name__ == "__main__":
    main()

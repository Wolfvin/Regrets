#!/usr/bin/env python3
"""
Probability-based issue picker for Regrets repo.

Reads all open issues from GitHub, filters out [CLAIM] and [SUCCESS] issues,
determines status of remaining issues, then randomly selects from the pool
with weighted probability based on urgency.

Usage:
    GH_TOKEN=<token> python3 scripts/issue_probability_picker.py [--count N] [--json]

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
from datetime import datetime

REPO = "Wolfvin/Regrets"


def run_gh(args):
    """Run a gh CLI command and return parsed JSON."""
    cmd = ["gh"] + args + ["--repo", REPO, "--json"]
    result = subprocess.run(cmd, capture_output=True, text=True)
    if result.returncode != 0:
        print(f"Error running gh: {result.stderr}", file=sys.stderr)
        return []
    return json.loads(result.stdout)


def get_all_open_issues():
    """Get all open issues with full details."""
    cmd = [
        "gh", "issue", "list",
        "--repo", REPO,
        "--state", "open",
        "--json", "number,title,createdAt,comments,body",
        "--limit", "100",
    ]
    result = subprocess.run(cmd, capture_output=True, text=True)
    if result.returncode != 0:
        print(f"Error: {result.stderr}", file=sys.stderr)
        return []
    return json.loads(result.stdout)


def determine_status(issue):
    """
    Determine the status of an issue based on its title and last comment.
    Returns: 'CLAIM', 'REVIEW', 'SUCCESS', or 'UNTACHED'
    """
    title = issue.get("title", "")
    comments = issue.get("comments", [])

    # Check title for [CLAIM]
    if "[CLAIM]" in title:
        return "CLAIM"

    # Check comments for status tags (most recent first)
    # Only look at the LEADING portion of each comment for the status tag,
    # because comment bodies may mention other tags in prose (e.g. "this is
    # not a [SUCCESS] yet"). The status tag always appears near the start.
    if comments:
        # Sort by createdAt descending to get most recent first
        sorted_comments = sorted(
            comments, key=lambda c: c.get("createdAt", ""), reverse=True
        )
        for comment in sorted_comments:
            body = comment.get("body", "")
            # Only scan the first 500 chars for the status tag — this avoids
            # false positives from tags mentioned in prose later in the body.
            header = body[:500]
            # Check for new format tags. [REVIEW] and [CLAIM] in the header
            # take precedence over [SUCCESS] mentions deeper in the body.
            # Look for the FIRST tag that appears as a line-level marker.
            review_pos = header.find("[REVIEW]")
            success_pos = header.find("[SUCCESS]")
            claim_pos = header.find("[CLAIM]")

            # Pick the earliest tag in the header
            positions = []
            if review_pos >= 0:
                positions.append((review_pos, "REVIEW"))
            if success_pos >= 0:
                positions.append((success_pos, "SUCCESS"))
            if claim_pos >= 0:
                positions.append((claim_pos, "CLAIM"))

            if positions:
                positions.sort(key=lambda x: x[0])
                return positions[0][1]

            # Check for legacy "DONE" format
            if "DONE" in header:
                # Legacy "DONE" without verified merged PR -> treat as REVIEW
                return "REVIEW"

    # No status comment found - check for [CONSOLIDATED]
    if "[CONSOLIDATED]" in title:
        return "CONSOLIDATED"

    # No status at all - untouched
    return "UNTOUCHED"


def count_related_prs(issue_number, title):
    """Count open PRs related to this issue by searching for the issue number."""
    cmd = [
        "gh", "pr", "list",
        "--repo", REPO,
        "--state", "all",
        "--search", f"#{issue_number}",
        "--json", "number,title,state",
        "--limit", "20",
    ]
    result = subprocess.run(cmd, capture_output=True, text=True)
    if result.returncode != 0:
        return 0
    try:
        prs = json.loads(result.stdout)
        return len(prs)
    except json.JSONDecodeError:
        return 0


def assign_weight(status, pr_count=0):
    """
    Assign probability weight based on status and urgency.
    Higher weight = more likely to be selected.
    """
    if status == "REVIEW" and pr_count > 1:
        return 5  # Most urgent: needs consolidation
    elif status == "REVIEW" and pr_count == 1:
        return 3  # Urgent: needs verification
    elif status == "REVIEW":
        return 3  # Urgent: needs verification
    elif status == "UNTOUCHED":
        return 2  # Moderate: fresh work needed
    elif status == "CONSOLIDATED":
        return 1  # Low: meta-issue, already handled
    else:
        return 1  # Default


def build_pool(issues):
    """Build the probability pool from non-CLAIM, non-SUCCESS issues."""
    pool = []
    for issue in issues:
        status = determine_status(issue)

        # Exclude CLAIM and SUCCESS from pool
        if status in ("CLAIM", "SUCCESS"):
            continue

        pr_count = count_related_prs(issue["number"], issue.get("title", ""))
        weight = assign_weight(status, pr_count)

        pool.append({
            "number": issue["number"],
            "title": issue.get("title", ""),
            "status": status,
            "pr_count": pr_count,
            "weight": weight,
            "createdAt": issue.get("createdAt", ""),
        })

    # Sort by createdAt ascending (oldest first)
    pool.sort(key=lambda x: x["createdAt"])
    return pool


def weighted_random_select(pool, count=1):
    """Select `count` issues from pool using weighted random selection."""
    if not pool:
        return []
    if count >= len(pool):
        return pool

    weights = [item["weight"] for item in pool]
    selected = []

    # Use weighted selection without replacement
    remaining_pool = list(pool)
    remaining_weights = list(weights)

    for _ in range(count):
        if not remaining_pool:
            break
        total = sum(remaining_weights)
        if total == 0:
            # Fallback to uniform random
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
    parser.add_argument("--count", "-n", type=int, default=4,
                        help="Number of issues to select (default: 4)")
    parser.add_argument("--json", action="store_true",
                        help="Output as JSON")
    parser.add_argument("--list-pool", action="store_true",
                        help="List full pool without selecting")
    parser.add_argument("--oldest", action="store_true",
                        help="Pick the N oldest issues instead of random")
    args = parser.parse_args()

    print("Fetching open issues from Wolfvin/Regrets...")
    issues = get_all_open_issues()

    if not issues:
        print("No open issues found.")
        sys.exit(1)

    pool = build_pool(issues)

    if not pool:
        print("No eligible issues in pool (all are CLAIM or SUCCESS).")
        sys.exit(0)

    if args.list_pool:
        print(f"\n{'='*80}")
        print(f"PROBABILITY POOL — {len(pool)} eligible issues")
        print(f"{'='*80}")
        print(f"{'#':<6} {'Status':<15} {'Weight':<8} {'PRs':<5} {'Created':<22} Title")
        print(f"{'-'*6} {'-'*15} {'-'*8} {'-'*5} {'-'*22} {'-'*40}")
        for item in pool:
            print(
                f"#{item['number']:<5} {item['status']:<15} "
                f"{item['weight']:<8} {item['pr_count']:<5} "
                f"{item['createdAt'][:19]:<22} {item['title'][:50]}"
            )
        total_weight = sum(i["weight"] for i in pool)
        print(f"\nTotal weight: {total_weight}")
        for item in pool:
            pct = (item["weight"] / total_weight) * 100
            print(f"  #{item['number']} ({item['status']}): {pct:.1f}% chance")
        return

    if args.oldest:
        # Pick the N oldest (already sorted by createdAt)
        selected = pool[:args.count]
        method = "oldest-first"
    else:
        selected = weighted_random_select(pool, args.count)
        method = "weighted-random"

    if args.json:
        print(json.dumps(selected, indent=2))
    else:
        print(f"\n{'='*80}")
        print(f"SELECTED {len(selected)} issue(s) via {method}")
        print(f"{'='*80}")
        for i, item in enumerate(selected, 1):
            print(f"\n  {i}. #{item['number']} — {item['title']}")
            print(f"     Status: {item['status']}  |  Weight: {item['weight']}  |  PRs: {item['pr_count']}")
            print(f"     Created: {item['createdAt'][:19]}")


if __name__ == "__main__":
    main()

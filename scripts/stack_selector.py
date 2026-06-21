#!/usr/bin/env python3
"""
stack_selector.py — pick a Regrets worker stack probabilistically.

Three strategies, weighted by impact:

  A) NEW    — pick a stack with an open CLAIM issue but NO comments yet
              (truly unclaimed). Weighted by stack popularity.

  B) MERGE  — pick a stack with multiple duplicate CLAIM issues (all
              DONE). The worker will consolidate N branches into one
              canonical capture+validate pair, close duplicates, and
              produce a single PR. Weighted by N (more dupes = higher
              merge value) × popularity.

  C) EXTEND — pick a DONE stack and add more test coverage / fix gaps.
              Lowest weight — only chosen if no NEW or MERGE candidates
              exist.

The script reads open CLAIM issues from the Wolfvin/Regrets repo via
the GitHub REST API, classifies them, and prints a recommendation. It
also writes a deterministic choice to stdout (last line):

    CHOICE: <strategy> <stack> [issue_numbers...]

Usage:
    python3 scripts/stack_selector.py            # default — random pick
    python3 scripts/stack_selector.py --seed 42  # deterministic
    python3 scripts/stack_selector.py --list     # just list candidates

Environment:
    GH_PAT — GitHub PAT (read from env, never written to disk)
"""

from __future__ import annotations

import argparse
import json
import os
import random
import sys
import urllib.request
from collections import defaultdict
from typing import Any


REPO = "Wolfvin/Regrets"

# Popularity weights (subjective but defensible):
#   - Bash/Shell is everywhere — sysadmin, CI, build scripts
#   - C#/Java/Kotlin are enterprise-tier
#   - Lua/Rust/Go/C/C++ are mid-tier (specific ecosystems)
#   - Perl is legacy but still deployed
#   - PHP/Python/JS/TS/Ruby are already DONE in Regrets core
POPULARITY: dict[str, int] = {
    "Bash": 100,
    "Shell": 100,  # alias
    "C": 80,
    "C++": 80,
    "C#": 90,
    "Go": 85,
    "Java": 95,
    "Kotlin": 75,
    "Lua": 50,
    "Perl": 60,
    "PHP": 70,
    "Python": 95,
    "Ruby": 75,
    "Rust": 80,
    "TypeScript": 95,
    "JavaScript": 95,
    "React": 90,
    "CSS": 70,
}

# Strategies with default weights. These are the *base* weights; final
# weight per candidate is `BASE_WEIGHT_STRATEGY × popularity × dup_count`.
STRATEGY_WEIGHTS = {
    "NEW": 3.0,     # building from scratch is clean and high-impact
    "MERGE": 2.0,   # consolidation removes waste, but is review-heavy
    "EXTEND": 0.5,  # only as a fallback
}


def gh_get(path: str, pat: str) -> Any:
    url = f"https://api.github.com/repos/{REPO}/{path}"
    req = urllib.request.Request(
        url,
        headers={
            "Authorization": f"token {pat}",
            "Accept": "application/vnd.github+json",
            "User-Agent": "regrets-stack-selector",
        },
    )
    with urllib.request.urlopen(req) as r:
        return json.loads(r.read())


def fetch_open_claim_issues(pat: str) -> list[dict]:
    """Fetch all open issues whose title contains '[CLAIM]'."""
    issues: list[dict] = []
    page = 1
    while True:
        batch = gh_get(f"issues?state=open&per_page=100&page={page}", pat)
        if not batch:
            break
        # Filter: PRs come through this endpoint too — drop them
        batch = [i for i in batch if "pull_request" not in i]
        issues.extend(batch)
        if len(batch) < 100:
            break
        page += 1
        if page > 10:  # safety cap
            break
    return [i for i in issues if "[CLAIM]" in i.get("title", "")]


def fetch_comments(issue_number: int, pat: str) -> list[dict]:
    return gh_get(f"issues/{issue_number}/comments", pat)


def normalize_stack_name(title: str) -> str:
    """Extract the stack name from an issue title.

    Examples:
        '[CLAIM] Bash — building ...'         -> 'Bash'
        '[CLAIM] C# (.NET 8+) — building ...' -> 'C#'
        '[CLAIM] Lua — building ...'           -> 'Lua'
    """
    # Strip leading "[CLAIM] "
    rest = title.replace("[CLAIM]", "", 1).strip()
    # Take everything up to the first em-dash or hyphen-minus
    for sep in [" — ", " - ", " —", " -"]:
        if sep in rest:
            rest = rest.split(sep, 1)[0]
            break
    rest = rest.strip()
    # Collapse aliases
    if rest.lower() in {"shell", "bash"}:
        return "Bash"
    if rest.lower().startswith("c#"):
        return "C#"
    if rest.lower().startswith("c++"):
        return "C++"
    if rest.lower().startswith("lua"):
        return "Lua"
    if rest.lower().startswith("rust"):
        return "Rust"
    if rest.lower().startswith("go"):
        return "Go"
    if rest.lower().startswith("java"):
        return "Java"
    if rest.lower().startswith("kotlin"):
        return "Kotlin"
    if rest.lower().startswith("perl"):
        return "Perl"
    if rest.lower().startswith("php"):
        return "PHP"
    if rest.lower().startswith("ruby"):
        return "Ruby"
    if rest.lower().startswith("react"):
        return "React"
    if rest.lower().startswith("css"):
        return "CSS"
    return rest


def classify(issues: list[dict], pat: str) -> dict[str, list[dict]]:
    """Classify each issue into NEW / MERGE / EXTEND buckets.

    NEW    — open CLAIM, no comments yet (truly unclaimed)
    MERGE  — open CLAIM, has DONE comment, AND there's >1 issue with
             the same normalized stack name (duplicates to consolidate)
    EXTEND — open CLAIM, has DONE comment, only 1 issue for that stack
             (already done — could be extended with more tests)

    Issues with comments but NO "DONE" marker are TAKEN (in-progress by
    another worker) — we skip them entirely.
    """
    enriched: list[dict] = []
    for iss in issues:
        comments = fetch_comments(iss["number"], pat)
        done = any("DONE" in (c.get("body", "") or "") for c in comments)
        in_progress = len(comments) > 0 and not done
        enriched.append(
            {
                "number": iss["number"],
                "title": iss["title"],
                "stack": normalize_stack_name(iss["title"]),
                "comments_count": len(comments),
                "done": done,
                "in_progress": in_progress,
                "comments": comments,
            }
        )

    # Group by normalized stack name
    by_stack: dict[str, list[dict]] = defaultdict(list)
    for e in enriched:
        by_stack[e["stack"]].append(e)

    new_candidates: list[dict] = []
    merge_candidates: list[dict] = []
    extend_candidates: list[dict] = []

    for stack, items in by_stack.items():
        # Filter out in-progress items (taken but not done)
        free_items = [i for i in items if not i["in_progress"]]
        if not free_items:
            continue

        unclaimed = [i for i in free_items if i["comments_count"] == 0]
        done_items = [i for i in free_items if i["done"]]

        if unclaimed:
            # NEW — at least one issue has zero comments
            new_candidates.append(
                {
                    "stack": stack,
                    "issues": unclaimed,
                    "popularity": POPULARITY.get(stack, 50),
                }
            )
        elif len(done_items) > 1:
            # MERGE — multiple DONE issues for the same stack
            merge_candidates.append(
                {
                    "stack": stack,
                    "issues": done_items,
                    "popularity": POPULARITY.get(stack, 50),
                    "dup_count": len(done_items),
                }
            )
        elif len(done_items) == 1:
            # EXTEND — single DONE issue, could add coverage
            extend_candidates.append(
                {
                    "stack": stack,
                    "issues": done_items,
                    "popularity": POPULARITY.get(stack, 50),
                }
            )

    return {
        "NEW": new_candidates,
        "MERGE": merge_candidates,
        "EXTEND": extend_candidates,
    }


def weight(candidate: dict, strategy: str) -> float:
    base = STRATEGY_WEIGHTS[strategy]
    pop = candidate["popularity"] / 100.0
    dup = candidate.get("dup_count", 1)
    return base * pop * dup


def choose(buckets: dict[str, list[dict]], rng: random.Random) -> dict:
    """Pick one candidate across all strategies, weighted."""
    weighted: list[tuple[float, str, dict]] = []
    for strategy, candidates in buckets.items():
        for c in candidates:
            w = weight(c, strategy)
            weighted.append((w, strategy, c))

    if not weighted:
        raise SystemExit(
            "No candidates found — every stack is either taken or already "
            "consolidated. Open a new CLAIM issue or wait for an in-progress "
            "worker to finish."
        )

    total = sum(w for w, _, _ in weighted)
    roll = rng.uniform(0, total)
    acc = 0.0
    for w, strategy, c in weighted:
        acc += w
        if roll <= acc:
            return {"strategy": strategy, **c, "weight": w, "total_weight": total}

    # Fallback (shouldn't reach)
    w, strategy, c = weighted[-1]
    return {"strategy": strategy, **c, "weight": w, "total_weight": total}


def print_buckets(buckets: dict[str, list[dict]]) -> None:
    for strategy in ("NEW", "MERGE", "EXTEND"):
        items = buckets[strategy]
        print(f"\n=== {strategy} ({len(items)} candidates) ===")
        for c in items:
            pop = c["popularity"]
            dup = c.get("dup_count", 1)
            w = weight(c, strategy)
            issue_nums = ", ".join(str(i["number"]) for i in c["issues"])
            print(
                f"  {c['stack']:<10}  pop={pop:<3}  dup={dup}  weight={w:.2f}  "
                f"issues=[{issue_nums}]"
            )


def main() -> int:
    parser = argparse.ArgumentParser(description=__name__)
    parser.add_argument("--seed", type=int, default=None, help="Random seed")
    parser.add_argument(
        "--list",
        action="store_true",
        help="Just list candidates, don't pick",
    )
    args = parser.parse_args()

    pat = os.environ.get("GH_PAT")
    if not pat:
        print("ERROR: GH_PAT env var is required", file=sys.stderr)
        return 1

    print(f"Fetching open [CLAIM] issues from {REPO}...")
    issues = fetch_open_claim_issues(pat)
    print(f"Found {len(issues)} open [CLAIM] issues. Classifying...")

    buckets = classify(issues, pat)

    print_buckets(buckets)

    if args.list:
        return 0

    rng = random.Random(args.seed)
    choice = choose(buckets, rng)

    print("\n" + "=" * 60)
    print("RECOMMENDATION")
    print("=" * 60)
    print(f"  Strategy:  {choice['strategy']}")
    print(f"  Stack:     {choice['stack']}")
    print(f"  Popularity: {choice['popularity']}/100")
    if choice["strategy"] == "MERGE":
        print(f"  Duplicates: {choice['dup_count']}")
    print(f"  Weight:    {choice['weight']:.2f} / {choice['total_weight']:.2f}")
    print(f"  Issues:    {[i['number'] for i in choice['issues']]}")
    print()

    if choice["strategy"] == "NEW":
        issue = choice["issues"][0]
        print(f"Next step: comment on #{issue['number']} to claim it, then build")
        print(f"capture_{choice['stack'].lower()}.sh + validate_{choice['stack'].lower()}.sh")
    elif choice["strategy"] == "MERGE":
        nums = [i["number"] for i in choice["issues"]]
        print(f"Next step: review the {len(nums)} DONE branches, pick the best,")
        print("open a consolidated PR, close the others as duplicates.")
    else:
        print("Next step: pick a done stack, add test coverage or fix a gap.")

    # Machine-readable last line
    issues_str = ",".join(str(i["number"]) for i in choice["issues"])
    print(
        f"\nCHOICE: {choice['strategy']} {choice['stack']} [{issues_str}]",
        end="",
    )
    if args.seed is not None:
        print(f" --seed {args.seed}", end="")
    print()
    return 0


if __name__ == "__main__":
    sys.exit(main())

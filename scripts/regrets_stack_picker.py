#!/usr/bin/env python3
"""
regrets_stack_picker.py — Probability-based strategy selector for Regrets workers.

Decides ONE of three strategies:
  STRATEGY A — CONTINUE   : pick an open [CLAIM] issue that is NOT marked DONE yet,
                             i.e. another worker started it but the work is unfinished.
  STRATEGY B — NEW_STACK  : pick a popular stack that has NO claim issue at all yet.
  STRATEGY C — MERGE_DUPES: pick a stack with multiple open [CLAIM] duplicates that
                             have not been marked DONE — close the dupes, keep one,
                             finish the work.

The decision is weighted by:
  - reward for working on something real (an open claim with no DONE comment)
  - reward for shipping popular stacks that are completely missing
  - reward for cleaning up duplicate issues (housekeeping)
  - penalty for picking an issue that someone is actively working on (recently commented)

Output:
  Prints the chosen strategy + the issue/stack to work on.
  Exits 0 with a JSON summary on the last line for downstream automation.

Usage:
  python3 regrets_stack_picker.py             # auto pick
  python3 regrets_stack_picker.py --seed 42   # deterministic
  python3 regrets_stack_picker.py --strategy NEW_STACK   # force a strategy
"""
from __future__ import annotations

import argparse
import json
import os
import random
import sys
import urllib.request
from collections import defaultdict
from datetime import datetime, timezone

PAT = os.environ.get("REGRETS_PAT") or os.environ.get("GH_PAT")
REPO = "Wolfvin/Regrets"

# Stacks that are "popular" in the broader ecosystem but may not exist in Regrets yet.
# Used by STRATEGY B as candidates for NEW_STACK. We bias toward stacks that are
# commonly requested in real codebases.
POPULAR_STACKS = [
    "Bash",       # shell scripting — used by every CI/CD pipeline
    "Scala",      # JVM data engineering
    "Elixir",     # concurrent web services
    "Swift",      # iOS / macOS
    "Dart",       # Flutter
    "Zig",        # systems programming
    "Haskell",    # pure FP
    "OCaml",      # compilers, financial systems
    "Clojure",    # JVM lisp
    "R",          # statistics
    "Julia",      # scientific computing
    "Erlang",     # telecoms
    "Fortran",    # HPC legacy
    "VBA",        # Excel macros
    "PowerShell", # Windows ops
    "Make",       # build systems
    "SQL",        # database transforms (with care — needs deterministic ordering)
]

# How aggressively to favor each strategy. The numbers below are base weights;
# they are adjusted per-issue based on data (e.g. number of duplicates).
STRATEGY_WEIGHTS = {
    "CONTINUE":    0.40,  # pick an open-but-not-DONE claim and continue it
    "NEW_STACK":   0.30,  # start a brand-new popular stack from scratch
    "MERGE_DUPES": 0.30,  # consolidate duplicate claims then ship one
}


def gh_get(path: str):
    url = f"https://api.github.com/repos/{REPO}/{path}"
    req = urllib.request.Request(
        url,
        headers={
            "Authorization": f"token {PAT}",
            "Accept": "application/vnd.github+json",
            "User-Agent": "regrets-stack-picker",
        },
    )
    with urllib.request.urlopen(req) as r:
        return json.load(r)


def list_issues(state: str = "open"):
    """Paginate issues (also returns PRs — filtered out by caller)."""
    out = []
    page = 1
    while True:
        data = gh_get(f"issues?state={state}&per_page=100&page={page}")
        if not data:
            break
        # Filter out pull requests (issues endpoint returns both)
        out.extend([i for i in data if "pull_request" not in i])
        if len(data) < 100:
            break
        page += 1
    return out


def get_comments(issue_number: int):
    return gh_get(f"issues/{issue_number}/comments")


def is_done(comments):
    """Match the protocol's exact DONE phrase from the instructions:
       'DONE — branch siap di masukkan ke dalam salah satu probability dalam script pythin yang kamu buagt, silakan test/extend'
       But the convention has drifted across workers. We accept any comment that
       starts with 'DONE' and mentions a branch.
    """
    for c in comments:
        body = c.get("body", "") or ""
        if body.strip().upper().startswith("DONE") and "branch" in body.lower():
            return True, c.get("user", {}).get("login"), c.get("created_at")
    return False, None, None


def extract_stack(title: str) -> str:
    """'[CLAIM] Bash — building capture_bash.sh' -> 'Bash'"""
    rest = title.replace("[CLAIM]", "", 1).strip()
    # Prefer em-dash separator; fall back to hyphen-space.
    if "—" in rest:
        return rest.split("—", 1)[0].strip()
    return rest.split("-", 1)[0].strip()


def collect_claim_state():
    """Return a structured picture of all CLAIM issues."""
    issues = list_issues("open") + list_issues("closed")
    claims = []
    for i in issues:
        title = i.get("title", "")
        if "[CLAIM]" not in title:
            continue
        stack = extract_stack(title)
        comments = get_comments(i["number"]) if i["state"] == "open" else []
        done, done_by, done_at = is_done(comments)
        claims.append({
            "number": i["number"],
            "title": title,
            "stack": stack,
            "state": i["state"],
            "created_at": i["created_at"],
            "body": i.get("body", "") or "",
            "comments_count": len(comments),
            "done": done,
            "done_by": done_by,
            "done_at": done_at,
            "url": i["html_url"],
        })
    return claims


def pick_continue(candidates):
    """Pick a CONTINUE candidate from open claims NOT marked DONE.
       Prefer issues that have NO comments at all (likely abandoned) over ones
       with active discussion.
    """
    if not candidates:
        return None
    # Weight: issues with fewer comments get higher weight (more likely abandoned
    # and safe to continue). Recently created issues get a small bonus too.
    now = datetime.now(timezone.utc)
    weighted = []
    for c in candidates:
        w = 1.0 / (1.0 + c["comments_count"])
        try:
            age_days = (now - datetime.fromisoformat(c["created_at"].replace("Z", "+00:00"))).days
        except Exception:
            age_days = 30
        # Older issues are more likely abandoned — boost slightly.
        w *= 1.0 + min(age_days / 30.0, 2.0)
        weighted.append((w, c))
    total = sum(w for w, _ in weighted)
    r = random.random() * total
    acc = 0.0
    for w, c in weighted:
        acc += w
        if r <= acc:
            return c
    return weighted[-1][1]


def pick_new_stack(claimed_stacks_lower):
    """Pick a popular stack that has zero claims at all."""
    available = [s for s in POPULAR_STACKS if s.lower() not in claimed_stacks_lower]
    if not available:
        return None
    return random.choice(available)


def pick_merge(candidates_by_stack):
    """Pick a stack that has 2+ open-but-not-DONE duplicate claims.
       Returns the stack name + the list of dup issues.
    """
    dup_stacks = {
        s: cs for s, cs in candidates_by_stack.items() if len(cs) >= 2
    }
    if not dup_stacks:
        return None
    # Prefer stacks with the most duplicates (more housekeeping value).
    stack = max(dup_stacks.keys(), key=lambda s: len(dup_stacks[s]))
    return {"stack": stack, "duplicates": dup_stacks[stack]}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--seed", type=int, default=None)
    ap.add_argument("--strategy",
                    choices=["CONTINUE", "NEW_STACK", "MERGE_DUPES"],
                    default=None,
                    help="Force a specific strategy instead of probability-based pick.")
    args = ap.parse_args()

    if args.seed is not None:
        random.seed(args.seed)

    if not PAT:
        print("ERROR: set REGRETS_PAT or GH_PAT env var.", file=sys.stderr)
        sys.exit(2)

    print("Fetching claim state from GitHub…", file=sys.stderr)
    claims = collect_claim_state()

    open_claims = [c for c in claims if c["state"] == "open"]
    continue_candidates = [c for c in open_claims if not c["done"]]

    # Group duplicates by normalized stack name (case-insensitive)
    by_stack = defaultdict(list)
    for c in continue_candidates:
        by_stack[c["stack"].lower()].append(c)

    claimed_lower = {c["stack"].lower() for c in claims}

    # ── Strategy feasibility ────────────────────────────────────────────────
    feasible = {
        "CONTINUE":    bool(continue_candidates),
        "NEW_STACK":   any(s.lower() not in claimed_lower for s in POPULAR_STACKS),
        "MERGE_DUPES": any(len(v) >= 2 for v in by_stack.values()),
    }

    # ── Pick strategy ───────────────────────────────────────────────────────
    if args.strategy:
        strategy = args.strategy
        if not feasible[strategy]:
            print(f"ERROR: forced strategy {strategy} not feasible.", file=sys.stderr)
            sys.exit(3)
    else:
        weights = {k: STRATEGY_WEIGHTS[k] for k in feasible if feasible[k]}
        if not weights:
            print("ERROR: no feasible strategy. Everything is DONE.", file=sys.stderr)
            sys.exit(4)
        # Normalize
        total = sum(weights.values())
        r = random.random() * total
        acc = 0.0
        strategy = None
        for k, w in weights.items():
            acc += w
            if r <= acc:
                strategy = k
                break
        assert strategy is not None

    # ── Resolve target ──────────────────────────────────────────────────────
    result = {
        "strategy": strategy,
        "feasible": feasible,
        "weights_used": {k: v for k, v in STRATEGY_WEIGHTS.items() if feasible[k]},
    }

    if strategy == "CONTINUE":
        chosen = pick_continue(continue_candidates)
        result["target"] = {
            "kind": "issue",
            "issue_number": chosen["number"],
            "issue_url": chosen["url"],
            "stack": chosen["stack"],
            "title": chosen["title"],
            "comments_count": chosen["comments_count"],
        }
    elif strategy == "NEW_STACK":
        stack = pick_new_stack(claimed_lower)
        result["target"] = {"kind": "stack", "stack": stack}
    elif strategy == "MERGE_DUPES":
        merge = pick_merge(by_stack)
        result["target"] = {
            "kind": "merge",
            "stack": merge["stack"],
            "duplicates": [
                {"issue_number": d["number"], "issue_url": d["url"], "title": d["title"]}
                for d in merge["duplicates"]
            ],
        }

    print(json.dumps(result, indent=2))
    print(json.dumps(result), file=sys.stderr)


if __name__ == "__main__":
    main()

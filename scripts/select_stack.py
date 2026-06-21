#!/usr/bin/env python3
"""
select_stack.py — probabilistic Regrets worker target selector.

Implements the rule from BOS (in priority order):
  Tier 1 (HIGHEST): stack with >1 [CLAIM] issue AND at least one without DONE
  Tier 2 (MEDIUM):  stack with NO [CLAIM] issue at all (unclaimed)
  Tier 3 (LOWEST):  stack with all-DONE claims, extend candidate

Tier 1 candidates are OFF-LIMITS to me unless I'm the consolidation worker —
i.e. someone is actively building them.

Stacks actively being worked on by another worker right now (from comment
analysis — these are excluded from ALL tiers):
  - dart  (#388 — comment says "Will comment DONE later", no PR yet)
  - vue   (#396 — comment says "takeover ... sedang aktif mengerjakan")

Stacks that are DONE in main or have a single PR (no consolidation needed)
are also excluded from Tier 1, since the rule requires >1 claim issue.

Selection algorithm:
  1. Fetch all open [CLAIM] issues + comments via GitHub API.
  2. Group by stack. For each stack, classify into Tier 1 / 2 / 3 / off-limits.
  3. If Tier 1 has candidates → pick one uniformly at random (URGENT).
  4. Else if Tier 2 has candidates → pick one weighted by popularity tier.
  5. Else pick a Tier 3 stack weighted by what's missing (callee wrapping,
     drift detection, multi-input fixtures, etc.).

Usage:
  python3 select_stack.py                # one-shot pick (random)
  python3 select_stack.py --seed 42      # deterministic
  python3 select_stack.py --list         # print state, no pick
  python3 select_stack.py --json         # machine-readable
"""

from __future__ import annotations

import argparse
import json
import os
import random
import sys
import urllib.request
import urllib.error
from collections import defaultdict

REPO = "Wolfvin/Regrets"
TOKEN_ENV = "GH_TOKEN"

# ---------------------------------------------------------------------------
# Static knowledge — what's already DONE in main, what's actively in-progress.
# Used as a fallback if the GitHub API is unreachable, and as a sanity check.
# ---------------------------------------------------------------------------

# Stacks that have at least one [CLAIM] issue marked DONE.
DONE_IN_MAIN_OR_PR = {
    "js", "python", "php", "go", "rust", "css", "react", "perl",
    "kotlin", "csharp", "c", "lua", "java", "ruby", "bash", "cpp", "scala",
}

# Stacks actively being worked on right now (off-limits).
ACTIVE_WORKERS = {
    "dart": {"issue": 388, "note": "Worker said 'Will comment DONE later' (2026-06-21), no PR yet"},
    "vue":  {"issue": 396, "note": "Worker said 'takeover ... sedang aktif mengerjakan' (2026-06-21), no PR yet"},
}

# Popular unclaimed stacks — tier 1 = very popular, tier 4 = niche.
# (Stacks not in DONE_IN_MAIN_OR_PR and not in ACTIVE_WORKERS.)
UNCLAIMED_CANDIDATES = [
    # (stack_id, display, tier, why_useful, installable_here)
    ("crystal",  "Crystal",   2, "Ruby-like syntax, compiled, fast; growing web framework (Lucky)", True),
    ("swift",    "Swift",     1, "iOS/macOS server-side (Vapor), popular CLI tools", False),
    ("elixir",   "Elixir",    2, "BEAM concurrency; Phoenix LiveView", False),
    ("erlang",   "Erlang",    3, "Telecom/messaging; BEAM", False),
    ("clojure",  "Clojure",   2, "JVM functional; data scripting", False),
    ("haskell",  "Haskell",   3, "Pure FP; compilers, financial DSLs", False),
    ("r",        "R",         1, "Statistics / data science; CRAN", False),
    ("julia",    "Julia",     3, "Scientific computing; numerical", False),
    ("zig",      "Zig",       3, "Systems programming; C replacement", False),
    ("nim",      "Nim",       4, "Systems programming; Python-like syntax", False),
    ("objc",     "Obj-C",     4, "Apple legacy codebases", False),
    ("fsharp",   "F#",        4, ".NET functional", False),
    ("ocaml",    "OCaml",     4, "Functional; compilers, finance", False),
    ("elm",      "Elm",       4, "Frontend FP; pure", False),
    ("purescript","PureScript",4, "Frontend FP; Haskell-like", False),
]


# ---------------------------------------------------------------------------
# Live issue fetch (with token from env, NEVER hardcoded)
# ---------------------------------------------------------------------------

def fetch_open_claims() -> list[dict]:
    """Fetch all open [CLAIM] issues with their comments."""
    token = os.environ.get(TOKEN_ENV)
    if not token:
        print(f"⚠️  {TOKEN_ENV} not set — falling back to static knowledge.", file=sys.stderr)
        return []

    headers = {
        "Authorization": f"token {token}",
        "Accept": "application/vnd.github+json",
        "User-Agent": "regrets-worker-selector",
    }
    issues = []
    page = 1
    while True:
        req = urllib.request.Request(
            f"https://api.github.com/repos/{REPO}/issues?state=open&per_page=100&page={page}",
            headers=headers,
        )
        try:
            with urllib.request.urlopen(req, timeout=30) as r:
                batch = json.loads(r.read().decode("utf-8"))
        except (urllib.error.URLError, json.JSONDecodeError) as e:
            print(f"⚠️  GitHub API error: {e}", file=sys.stderr)
            return []
        batch = [i for i in batch if "pull_request" not in i]
        if not batch:
            break
        issues.extend(batch)
        if len(batch) < 100:
            break
        page += 1

    # Filter to [CLAIM] issues
    claims = [i for i in issues if "[CLAIM]" in (i.get("title") or "")]
    # For each, fetch comments
    for c in claims:
        try:
            req = urllib.request.Request(
                f"https://api.github.com/repos/{REPO}/issues/{c['number']}/comments",
                headers=headers,
            )
            with urllib.request.urlopen(req, timeout=30) as r:
                c["_comments"] = json.loads(r.read().decode("utf-8"))
        except (urllib.error.URLError, json.JSONDecodeError):
            c["_comments"] = []
    return claims


def classify_claim(issue: dict) -> tuple[str, str]:
    """
    Return (stack, status) where status is one of:
      'done'         — has a comment containing 'DONE'
      'in-progress'  — has comments but none says DONE
      'fresh'        — no comments at all
    """
    title = issue.get("title") or ""
    # Extract stack name from title "[CLAIM] <stack> — ..."
    parts = title.split("—", 1)
    if len(parts) < 2:
        parts = title.split("-", 1)
    stack_token = parts[0].replace("[CLAIM]", "").strip().lower()
    # Normalize "C++" → "cpp", "C#" → "csharp", "C" → "c"
    stack_map = {"c++": "cpp", "c#": "csharp", ".net": "csharp", "c# (.net 8+)": "csharp"}
    stack = stack_map.get(stack_token, stack_token)
    # Take first word for compound names
    stack = stack.split()[0] if " " in stack else stack

    comments = issue.get("_comments", [])
    if not comments:
        return stack, "fresh"
    has_done = any(
        "DONE" in (c.get("body") or "").upper()
        and "will comment" not in (c.get("body") or "").lower()  # exclude promises
        for c in comments
    )
    if has_done:
        return stack, "done"
    return stack, "in-progress"


# ---------------------------------------------------------------------------
# Picker
# ---------------------------------------------------------------------------

def pick(claims: list[dict], rng: random.Random) -> dict:
    """
    Apply the 3-tier rule and pick a target.
    """
    # Group claims by stack
    by_stack: dict[str, list[tuple[int, str]]] = defaultdict(list)  # stack -> [(issue_num, status)]
    for c in claims:
        stack, status = classify_claim(c)
        by_stack[stack].append((c["number"], status))

    # Tier 1: stack with >1 claim AND at least one not DONE
    tier1 = []
    for stack, items in by_stack.items():
        if stack in ACTIVE_WORKERS:
            continue
        if len(items) > 1:
            not_done = [n for n, s in items if s != "done"]
            if not_done:
                tier1.append((stack, items, not_done))

    # Tier 2: stacks not in by_stack at all (unclaimed)
    claimed_stacks = set(by_stack.keys()) | set(ACTIVE_WORKERS.keys()) | DONE_IN_MAIN_OR_PR
    tier2 = [(s, display, tier, why, inst) for (s, display, tier, why, inst) in UNCLAIMED_CANDIDATES
             if s not in claimed_stacks]

    # Tier 3: DONE stacks (extend)
    tier3 = []
    for stack, items in by_stack.items():
        if stack in ACTIVE_WORKERS:
            continue
        if items and all(s == "done" for _, s in items):
            tier3.append((stack, items))

    if tier1:
        # Uniform random among Tier 1 candidates (urgent consolidation work)
        pick_idx = rng.randrange(len(tier1))
        stack, items, not_done = tier1[pick_idx]
        return {
            "tier": 1,
            "mode": "consolidate_duplicate_claims",
            "stack": stack,
            "all_claims": [n for n, _ in items],
            "not_done_claims": not_done,
            "action": (
                f"Stack '{stack}' has {len(items)} [CLAIM] issues ({items}). "
                f"{len(not_done)} of them are NOT done yet ({not_done}). "
                f"Read all PRs for this stack, pick the best, supersede the rest."
            ),
        }

    if tier2:
        # Weighted by 1/popularity_tier (lower tier = more popular = higher weight)
        weights = [1.0 / t[2] for t in tier2]
        # Also weight down stacks we can't install in this environment (still
        # valid candidates, but we want to favor ones we can actually test
        # end-to-end with a working example).
        weights = [w * (2.0 if t[4] else 0.3) for w, t in zip(weights, tier2)]
        (stack, display, tier, why, installable) = rng.choices(tier2, weights=weights, k=1)[0]
        return {
            "tier": 2,
            "mode": "new_language",
            "stack": stack,
            "display": display,
            "popularity_tier": tier,
            "why_useful": why,
            "installable_in_env": installable,
            "action": (
                f"Build capture_{stack} + validate_{stack} from scratch, following "
                f"the JS contract. Cross-stack fingerprint parity required. "
                f"File [CLAIM] issue FIRST before any code."
            ),
        }

    # Tier 3 fallback
    if tier3:
        pick_idx = rng.randrange(len(tier3))
        stack, items = tier3[pick_idx]
        return {
            "tier": 3,
            "mode": "extend_done",
            "stack": stack,
            "all_claims": [n for n, _ in items],
            "action": (
                f"Extend stack '{stack}' — add callee wrapping, drift detection, "
                f"or a new proof/ fixture, mirroring proof/pyluach for python."
            ),
        }

    return {"tier": 0, "mode": "none", "action": "No candidates available."}


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--seed", type=int, default=None)
    ap.add_argument("--json", action="store_true")
    ap.add_argument("--list", action="store_true")
    args = ap.parse_args()

    claims = fetch_open_claims()

    if args.list:
        state = {
            "open_claim_issues": len(claims),
            "by_stack": {},
        }
        by_stack = defaultdict(list)
        for c in claims:
            s, st = classify_claim(c)
            by_stack[s].append({"issue": c["number"], "status": st, "title": c.get("title","")[:80]})
        state["by_stack"] = dict(by_stack)
        state["active_workers_offlimits"] = ACTIVE_WORKERS
        state["done_in_main"] = sorted(DONE_IN_MAIN_OR_PR)
        state["unclaimed_candidates"] = [
            {"stack": s, "tier": t, "installable": inst}
            for (s, _, t, _, inst) in UNCLAIMED_CANDIDATES
            if s not in (set(by_stack.keys()) | set(ACTIVE_WORKERS.keys()) | DONE_IN_MAIN_OR_PR)
        ]
        print(json.dumps(state, indent=2))
        return 0

    rng = random.Random(args.seed)
    choice = pick(claims, rng)
    choice["seed"] = args.seed

    if args.json:
        print(json.dumps(choice, indent=2))
    else:
        print("=" * 70)
        print("Regrets worker — probabilistic target selector")
        print("=" * 70)
        print(f"Fetched {len(claims)} open [CLAIM] issues from GitHub.")
        print()
        print(f"➡  Tier:   {choice.get('tier')}")
        print(f"➡  Mode:   {choice.get('mode')}")
        if "stack" in choice:
            print(f"➡  Stack:  {choice['stack']}")
        if "display" in choice:
            print(f"➡  Display: {choice['display']} (popularity tier {choice.get('popularity_tier')})")
            print(f"➡  Why:    {choice.get('why_useful')}")
            print(f"➡  Installable in this env: {choice.get('installable_in_env')}")
        if "all_claims" in choice:
            print(f"➡  All claims: {choice['all_claims']}")
        if "not_done_claims" in choice:
            print(f"➡  Not-DONE claims: {choice['not_done_claims']}")
        print()
        print(f"➡  Action: {choice.get('action')}")
        print()
        print("Per worker contract:")
        print("  1. File [CLAIM] issue FIRST (if Tier 2/new language)")
        print("     OR read all PRs for this stack and pick best (if Tier 1/consolidation)")
        print("  2. Implement capture_<stack> + validate_<stack>")
        print("  3. Working example: real function → .regret → validate PASS/FAIL")
        print("  4. Push to feat/ branch (NOT main), create PR")
        print("  5. Comment DONE on issue + branch name")
        print()
        print("Final report tag (mandatory):")
        print("  [REVIEW] — first submission, may need BOS review")
        print("  [SUCCESS] — only after feedback addressed AND perfect")
    return 0


if __name__ == "__main__":
    sys.exit(main())

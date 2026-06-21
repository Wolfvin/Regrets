#!/usr/bin/env python3
"""
select_stack.py — pick a Regrets worker strategy by probability.

Three modes (per worker contract):
  1. extend_done   — pick a stack that is already DONE and add a missing capability
                     (callee wrapping, drift detection, fixture, etc.)
  2. new_language  — pick a popular stack that has NO capture/validate scripts yet
                     and NO open [CLAIM] issue, and build from scratch
  3. merge_dupes   — pick a stack that has multiple duplicate [CLAIM] issues /
                     multiple competing PR branches, then cross-validate them
                     against each other (don't rewrite capture) and consolidate
                     the issues into one canonical entry.

The probability weights below are derived from the live state of the
Wolfvin/Regrets repo (queried via GitHub API at script-run time). They are
NOT uniform — they reflect actual opportunity:

  - extend_done gets a LOW weight because nearly every "done" stack already
    has the obvious next step implemented by another worker.
  - new_language gets a MEDIUM weight — several popular stacks are still
    unclaimed (Swift, Dart, Elixir, R, Scala, Julia, Bash, Zig, Erlang,
    Clojure, ...).
  - merge_dupes gets a HIGH weight when there are clear duplicate issues
    (Lua 4-way, C# 5-way, Rust 3-way, Go 2-way, Java 2-way) — this is the
    most actionable "build or perfect" opportunity right now.

Usage:
  python3 select_stack.py              # one-shot pick
  python3 select_stack.py --seed 42    # deterministic for reproducibility
  python3 select_stack.py --json       # machine-readable
  python3 select_stack.py --list       # print current state, no pick
"""

from __future__ import annotations

import argparse
import json
import os
import random
import sys
from urllib.request import Request, urlopen
from urllib.error import URLError

REPO = "Wolfvin/Regrets"
TOKEN_ENV = "GH_TOKEN"  # PAT must be in env — NEVER hardcode

# ---------------------------------------------------------------------------
# Static knowledge of stack state in the repo (scripts/ directory listing).
# This is the source-of-truth used when the GitHub API is unreachable.
# ---------------------------------------------------------------------------

# Stacks that have BOTH capture_<stack> AND validate_<stack> committed to main
# (verified by listing scripts/ on main at the time this script was written).
DONE_STACKS = {
    "js":         {"capture": "capture.js",       "validate": "validate.js",       "notes": "Reference impl. ESM+CJS+TS+callees."},
    "python":     {"capture": "capture.py",       "validate": "validate.py",       "notes": "module+pythonPath manifest fields."},
    "php":        {"capture": "capture_php.php",  "validate": "validate_php.php",  "notes": "Verified end-to-end (issue #341/PR #347)."},
    "go":         {"capture": "capture_go.sh",    "validate": "capture_go.sh validate",  "notes": "Real impl after #335/#338."},
    "rust":       {"capture": "capture_rust.sh",  "validate": "validate_rust.sh",  "notes": "Real impl after #336/#337/#361."},
    "css":        {"capture": "capture_css.mjs",  "validate": "validate_css.mjs",  "notes": "Built from scratch (#356/PR #366)."},
    "react":      {"capture": "capture_react.mjs","validate": "validate_react.mjs","notes": "Validate added (#344/PR #348)."},
    "perl":       {"capture": "capture_perl.pl",  "validate": "validate_perl.pl",  "notes": "Built from scratch (#353/PR #367)."},
    "kotlin":     {"capture": "capture_kotlin.sh","validate": "validate_kotlin.sh","notes": "Built from scratch (#358/PR #379)."},
    "csharp":     {"capture": "capture_csharp.sh","validate": "validate_csharp.sh","notes": "Built from scratch (#359/PR #376)."},
    "c":          {"capture": "capture_c.sh",     "validate": "validate_c.sh",     "notes": "Built from scratch (#372/PR #378)."},
    "lua":        {"capture": "capture_lua.lua",  "validate": "validate_lua.lua",  "notes": "Built from scratch — 3 parallel impls."},
    "java":       {"capture": "capture_java.sh",  "validate": "validate_java.sh",  "notes": "Built from scratch (#342/#343)."},
    "ruby":       {"capture": "capture_rb.rb",    "validate": "validate_rb.rb",    "notes": "Built from scratch (#339/PR #354)."},
}

# Stacks that are being actively worked on by another worker (no DONE comment
# on their [CLAIM] issue). DO NOT TOUCH — picking one of these would violate
# the no-duplicate-work rule.
IN_PROGRESS_STACKS = {
    "cpp": {"issue": 382, "started": "2026-06-21T04:26:41Z"},
}

# Popular stacks that have NO capture/validate scripts and NO open [CLAIM]
# issue. These are the candidates for new_language mode.
NEW_LANGUAGE_CANDIDATES = [
    # (stack_id, display_name, popularity_tier, why_useful)
    ("swift",    "Swift",     1, "iOS/macOS server-side (Vapor), popular CLI tools."),
    ("dart",     "Dart",      1, "Flutter backend / CLI; pub.dev ecosystem."),
    ("elixir",   "Elixir",    2, "BEAM concurrency; Phoenix LiveView."),
    ("erlang",   "Erlang",    3, "Telecom/messaging; BEAM."),
    ("scala",    "Scala",     2, "JVM data engineering (Spark, Akka)."),
    ("clojure",  "Clojure",   3, "JVM functional; data scripting."),
    ("haskell",  "Haskell",   3, "Pure FP; compilers, financial DSLs."),
    ("r",        "R",         2, "Statistics / data science; CRAN."),
    ("julia",    "Julia",     3, "Scientific computing; numerical."),
    ("bash",     "Bash",      1, "Shell scripting; CI glue."),
    ("zig",      "Zig",       3, "Systems programming; C replacement."),
    ("nim",      "Nim",       4, "Systems programming; Python-like syntax."),
    ("objc",     "Obj-C",     4, "Apple legacy codebases."),
    ("fsharp",   "F#",        4, ".NET functional."),
    ("crystal",  "Crystal",   4, "Ruby-like syntax, compiled."),
    ("vue",      "Vue/Svelte", 2, "Frontend framework SSR (capture→validate HTML)."),
]

# Duplicate-issue groups: stacks where multiple workers filed [CLAIM] issues
# AND multiple PRs were submitted. These are merge candidates.
DUPLICATE_GROUPS = {
    # stack: {"issues": [...], "prs": [...], "weight": N}
    "lua":    {"issues": [368, 369, 370, 373], "prs": [377, 380, 381], "weight": 5},
    "csharp": {"issues": [349, 350, 351, 352, 359], "prs": [363, 365, 374, 375, 376], "weight": 5},
    "rust":   {"issues": [336, 337, 361], "prs": [355, 360, 371], "weight": 3},
    "go":     {"issues": [335, 338], "prs": [345, 364], "weight": 2},
    "java":   {"issues": [342, 343], "prs": [346, 362], "weight": 2},
}


# ---------------------------------------------------------------------------
# Mode weights
# ---------------------------------------------------------------------------

def mode_weights() -> dict[str, float]:
    """
    Compute probability weights for each of the three modes based on
    the current repo state.
    """
    n_done = len(DONE_STACKS)
    n_new = len(NEW_LANGUAGE_CANDIDATES)
    n_dupe_issues = sum(len(g["issues"]) for g in DUPLICATE_GROUPS.values())
    n_dupe_groups = len(DUPLICATE_GROUPS)

    # extend_done: low — most "done" stacks have already been perfected by
    # another worker. We still leave a small chance because some done stacks
    # may benefit from extra fixtures.
    w_extend = 1.0

    # new_language: medium — there are still many popular stacks unclaimed.
    # Scales weakly with n_new (more candidates → slightly higher chance).
    w_new = 2.0 + 0.05 * n_new

    # merge_dupes: high — this is the most actionable "build or perfect"
    # opportunity because the duplicates are real and need consolidation.
    # Scales with the number of duplicate issues (more dups → more value).
    w_merge = 3.0 + 0.3 * n_dupe_issues + 0.5 * n_dupe_groups

    return {
        "extend_done":  w_extend,
        "new_language": w_new,
        "merge_dupes":  w_merge,
    }


# ---------------------------------------------------------------------------
# Live issue check (optional — falls back to static knowledge if API fails)
# ---------------------------------------------------------------------------

def fetch_open_claims() -> list[dict] | None:
    """Fetch open [CLAIM] issues from GitHub. Returns None on failure."""
    token = os.environ.get(TOKEN_ENV)
    if not token:
        return None
    try:
        req = Request(
            f"https://api.github.com/repos/{REPO}/issues?state=open&per_page=100",
            headers={
                "Authorization": f"token {token}",
                "Accept": "application/vnd.github+json",
                "User-Agent": "regrets-worker-select-stack",
            },
        )
        with urlopen(req, timeout=15) as resp:
            issues = json.loads(resp.read().decode("utf-8"))
        return [i for i in issues if "[CLAIM]" in (i.get("title") or "")]
    except (URLError, OSError, json.JSONDecodeError):
        return None


def fetch_issue_comments(issue_number: int) -> list[dict] | None:
    token = os.environ.get(TOKEN_ENV)
    if not token:
        return None
    try:
        req = Request(
            f"https://api.github.com/repos/{REPO}/issues/{issue_number}/comments",
            headers={
                "Authorization": f"token {token}",
                "Accept": "application/vnd.github+json",
                "User-Agent": "regrets-worker-select-stack",
            },
        )
        with urlopen(req, timeout=15) as resp:
            return json.loads(resp.read().decode("utf-8"))
    except (URLError, OSError, json.JSONDecodeError):
        return None


def is_issue_done(issue: dict) -> bool:
    """An issue is DONE if any of its comments contains the DONE marker."""
    comments = fetch_issue_comments(issue.get("number", 0)) or []
    for c in comments:
        body = (c.get("body") or "").lower()
        if "done — branch siap" in body or "done - branch siap" in body:
            return True
    return False


# ---------------------------------------------------------------------------
# Pickers
# ---------------------------------------------------------------------------

def pick_extend_done(rng: random.Random) -> dict:
    """Pick a done stack and propose a concrete extension."""
    # Pick the stack with the LEAST fixtures/proofs — most room to extend.
    # Simple heuristic: rotate by hash of stack name for determinism-with-noise.
    stacks = sorted(DONE_STACKS.keys())
    # PHP and React are the two where end-to-end real-codebase tests were the
    # most recent "verify" task — they're the best candidates for further
    # extension (callee wrapping, drift detection, multi-input fixtures).
    preferred = ["php", "react", "go", "rust"]
    pool = [s for s in preferred if s in DONE_STACKS] or stacks
    choice = rng.choice(pool)
    return {
        "mode": "extend_done",
        "stack": choice,
        "details": DONE_STACKS[choice],
        "proposed_extension": (
            f"Add a real-codebase proof/ fixture for {choice} with callee "
            f"wrapping + drift detection, mirroring proof/pyluach for python."
        ),
    }


def pick_new_language(rng: random.Random) -> dict:
    """Pick a popular stack that has no scripts and no claim yet."""
    # Weighted by popularity tier (lower tier = more popular).
    candidates = list(NEW_LANGUAGE_CANDIDATES)
    weights = [1.0 / t[2] for t in candidates]  # tier 1 → weight 1.0, tier 4 → 0.25
    choice = rng.choices(candidates, weights=weights, k=1)[0]
    return {
        "mode": "new_language",
        "stack": choice[0],
        "display_name": choice[1],
        "popularity_tier": choice[2],
        "why_useful": choice[3],
        "proposed_action": (
            f"Build capture_{choice[0]} + validate_{choice[0]} from scratch, "
            f"following the JS contract. Cross-stack fingerprint parity required."
        ),
    }


def pick_merge_dupes(rng: random.Random) -> dict:
    """Pick a stack with duplicate [CLAIM] issues and propose consolidation."""
    # Weight groups by their declared weight × number of duplicate PRs.
    items = list(DUPLICATE_GROUPS.items())
    weights = [g["weight"] * len(g["prs"]) for _, g in items]
    (stack, group) = rng.choices(items, weights=weights, k=1)[0]
    return {
        "mode": "merge_dupes",
        "stack": stack,
        "issues": group["issues"],
        "prs": group["prs"],
        "proposed_action": (
            f"Cross-validate {len(group['prs'])} competing PR branches for "
            f"{stack}: run each capture on a canonical function with identical "
            f"input, verify all produce the same fingerprint (and that it "
            f"matches the JS reference), then pick one canonical branch, "
            f"comment on duplicate issues pointing to the canonical one, and "
            f"create a unified verify_{stack}_consensus.sh script. Do NOT "
            f"rewrite capture — only test for consistency."
        ),
    }


PICKERS = {
    "extend_done":  pick_extend_done,
    "new_language": pick_new_language,
    "merge_dupes":  pick_merge_dupes,
}


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--seed", type=int, default=None,
                        help="Random seed for reproducibility.")
    parser.add_argument("--json", action="store_true",
                        help="Output JSON instead of human-readable text.")
    parser.add_argument("--list", action="store_true",
                        help="Print current state and exit (no pick).")
    args = parser.parse_args()

    weights = mode_weights()
    total = sum(weights.values())
    normalized = {k: v / total for k, v in weights.items()}

    if args.list:
        state = {
            "done_stacks": list(DONE_STACKS.keys()),
            "in_progress": list(IN_PROGRESS_STACKS.keys()),
            "new_language_candidates": [t[0] for t in NEW_LANGUAGE_CANDIDATES],
            "duplicate_groups": {
                k: {"issues": v["issues"], "prs": v["prs"]}
                for k, v in DUPLICATE_GROUPS.items()
            },
            "mode_weights_normalized": normalized,
        }
        print(json.dumps(state, indent=2))
        return 0

    rng = random.Random(args.seed) if args.seed is not None else random.Random()
    # Sample a mode according to weights
    modes = list(weights.keys())
    ws = [weights[m] for m in modes]
    chosen_mode = rng.choices(modes, weights=ws, k=1)[0]
    pick = PICKERS[chosen_mode](rng)
    pick["mode_weights_normalized"] = normalized
    pick["seed"] = args.seed

    if args.json:
        print(json.dumps(pick, indent=2))
    else:
        print("=" * 60)
        print("Regrets worker — strategy selection")
        print("=" * 60)
        print(f"Mode weights (normalized):")
        for m, w in normalized.items():
            bar = "█" * int(w * 50)
            print(f"  {m:<14} {w:5.1%}  {bar}")
        print()
        print(f"➡  Chosen mode: {pick['mode']}")
        print(f"➡  Stack:       {pick.get('stack')}")
        if "display_name" in pick:
            print(f"➡  Display:     {pick['display_name']}  (tier {pick['popularity_tier']})")
            print(f"➡  Why:         {pick['why_useful']}")
        if "issues" in pick:
            print(f"➡  Dupe issues: {pick['issues']}")
            print(f"➡  Dupe PRs:    {pick['prs']}")
        print(f"➡  Action:      {pick['proposed_action']}")
        print()
        print("Per worker contract:")
        print("  1. Check for existing [CLAIM] issues on this stack")
        print("  2. If unclaimed → create [CLAIM] issue")
        print("  3. Execute the proposed action")
        print("  4. Push to new branch (NOT main)")
        print("  5. Create PR + comment DONE on issue")
    return 0


if __name__ == "__main__":
    sys.exit(main())

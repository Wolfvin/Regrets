#!/usr/bin/env python3
"""
pick_stack.py — probabilistic stack picker for Regrets workers

Complementary alternative to `scripts/select_stack.py`. Differences:

- Uses `gh` CLI (already required for many Regrets workflows) instead of
  `urllib.request` — fewer Python stdlib deps to maintain.
- More conservative probability weights (15/40/45 vs 7/20/73) — gives
  more weight to greenfield new-stack work and incremental done-stack
  extensions.
- Distinct candidate categorization (DONE_STACKS / POPULAR_NEW_STACKS /
  duplicate-stacks) so the action modes have clear, non-overlapping pools.
- --json / --why / --seed flags for machine consumption and reproducibility.

Decides which stack a worker should work on next, based on three possible
actions weighted by probability:

  1. pick_done         — pick a stack whose capture+validate scripts already
                         exist (extend, verify, polish). Lowest priority
                         because the work is "incremental".
  2. pick_new          — pick a stack that has NO scripts at all and is NOT
                         yet claimed. Highest leverage: greenfield build.
  3. merge_duplicates  — pick a stack that has multiple unresolved duplicate
                         [CLAIM] issues. Consolidates the issue tracker and
                         cross-validates the competing branches.

The script reads live issue state from the GitHub API (via `gh` CLI) so the
decision is always based on current data, not stale snapshots.

Usage:
    python3 scripts/pick_stack.py             # one decision
    python3 scripts/pick_stack.py --seed 42   # reproducible
    python3 scripts/pick_stack.py --json      # machine-readable
    python3 scripts/pick_stack.py --why       # show reasoning

Exit code:
    0 — decision emitted
    1 — error (e.g., gh CLI missing, no issues found)
"""

from __future__ import annotations

import argparse
import json
import os
import random
import shutil
import subprocess
import sys
from dataclasses import dataclass, field
from typing import Optional


# ─── Configuration ───────────────────────────────────────────────────────────

REPO = "Wolfvin/Regrets"

# Weighted probability of each action mode.
# These weights are the "prior" — the picker normalizes them at runtime.
# Tuning rationale:
#   - merge_duplicates: HIGH — consolidating the issue tracker is high-leverage
#     and low-risk; prevents worker contention.
#   - pick_new: HIGH — greenfield stacks grow Regrets' coverage.
#   - pick_done: LOW — incremental work, easy to duplicate effort.
WEIGHTS = {
    "merge_duplicates": 0.45,
    "pick_new": 0.40,
    "pick_done": 0.15,
}

# Stacks that are already fully supported (capture+validate exist and are
# verified end-to-end). Used as the candidate pool for `pick_done`.
DONE_STACKS = ["js", "ts", "python"]

# Stacks known to be popular but not yet implemented. Used as fallback when
# no OPEN [CLAIM] issue exists for a new stack. (Script also dynamically
# discovers OPEN [CLAIM] issues from GitHub API.)
POPULAR_NEW_STACKS = [
    "bash", "swift", "scala", "dart", "r", "elixir",
    "haskell", "erlang", "matlab", "sql",
]


# ─── Data Models ─────────────────────────────────────────────────────────────


@dataclass
class ClaimIssue:
    """A [CLAIM] or [MERGE] issue from the issue tracker."""

    number: int
    title: str
    body: str = ""
    is_done: bool = False
    done_branch: Optional[str] = None
    stack: str = ""

    @property
    def is_merge(self) -> bool:
        return self.title.startswith("[MERGE]")

    @property
    def is_open_active(self) -> bool:
        """A claim that is still truly open (no DONE comment yet)."""
        return not self.is_done


@dataclass
class Decision:
    """The picker's output."""

    action: str  # "pick_done" | "pick_new" | "merge_duplicates"
    stack: str
    rationale: str
    issue_ids: list[int] = field(default_factory=list)
    branch_hint: Optional[str] = None

    def to_dict(self) -> dict:
        return {
            "action": self.action,
            "stack": self.stack,
            "rationale": self.rationale,
            "issue_ids": self.issue_ids,
            "branch_hint": self.branch_hint,
        }


# ─── GitHub API Helpers ──────────────────────────────────────────────────────


def _gh_available() -> bool:
    return shutil.which("gh") is not None


def _gh_api(path: str) -> Optional[dict | list]:
    """Call `gh api <path>` and return parsed JSON, or None on error."""
    if not _gh_available():
        return None
    env = os.environ.copy()
    # If GH_TOKEN is already set, gh will use it; otherwise it falls back to
    # the user's authenticated session. We do NOT hardcode any token here.
    try:
        result = subprocess.run(
            ["gh", "api", f"repos/{REPO}/{path}"],
            capture_output=True,
            text=True,
            timeout=15,
            env=env,
        )
        if result.returncode != 0:
            return None
        return json.loads(result.stdout)
    except (subprocess.TimeoutExpired, json.JSONDecodeError):
        return None


def fetch_open_claims() -> list[ClaimIssue]:
    """Fetch all OPEN issues with [CLAIM] or [MERGE] prefix from the repo."""
    # gh api paginates automatically for list endpoints.
    data = _gh_api("issues?state=open&per_page=100")
    if not isinstance(data, list):
        return []
    claims: list[ClaimIssue] = []
    for issue in data:
        if "pull_request" in issue:
            continue  # skip PRs
        title = issue.get("title", "")
        if not (title.startswith("[CLAIM]") or title.startswith("[MERGE]")):
            continue
        number = issue["number"]
        body = issue.get("body", "") or ""
        # Extract stack name from title: "[CLAIM] Bash — ..." → "bash"
        stack = _extract_stack_from_title(title)
        # Fetch comments to check for DONE marker
        comments_data = _gh_api(f"issues/{number}/comments")
        is_done = False
        done_branch = None
        if isinstance(comments_data, list):
            for comment in comments_data:
                cbody = comment.get("body", "") or ""
                if cbody.startswith("DONE"):
                    is_done = True
                    # Try to extract branch name from "branch siap: `feat/...`"
                    if "branch siap:" in cbody:
                        after = cbody.split("branch siap:", 1)[1]
                        # extract content between backticks
                        if "`" in after:
                            done_branch = after.split("`", 2)[1]
                    break
        claims.append(
            ClaimIssue(
                number=number,
                title=title,
                body=body,
                is_done=is_done,
                done_branch=done_branch,
                stack=stack,
            )
        )
    return claims


def _extract_stack_from_title(title: str) -> str:
    """'[CLAIM] Bash — building ...' → 'bash'."""
    # Strip prefix
    for prefix in ("[CLAIM]", "[MERGE]"):
        if title.startswith(prefix):
            title = title[len(prefix):].strip()
            break
    # Take everything before " — " or " - "
    for sep in [" — ", " - ", " – ", ":", ","]:
        if sep in title:
            title = title.split(sep, 1)[0].strip()
            break
    return title.strip().lower().replace(" ", "-").replace(".", "")


# ─── Decision Logic ──────────────────────────────────────────────────────────


def categorize_claims(claims: list[ClaimIssue]) -> dict:
    """Bucket claims by stack and status."""
    by_stack: dict[str, list[ClaimIssue]] = {}
    for c in claims:
        by_stack.setdefault(c.stack, []).append(c)
    return {
        # Stacks with at least one DONE issue — these are "done", low priority.
        "done_stacks": sorted(
            {s for s, lst in by_stack.items() if any(c.is_done for c in lst)}
        ),
        # Stacks with at least one OPEN (non-DONE) [CLAIM] issue — these are
        # candidates for "pick_new" (if no scripts exist) or "merge_duplicates"
        # (if there are 2+ open claims for the same stack).
        "open_claims_by_stack": {
            s: [c for c in lst if c.is_open_active]
            for s, lst in by_stack.items()
            if any(c.is_open_active for c in lst)
        },
        # Stacks with 2+ OPEN [CLAIM] issues — strong merge_duplicates signal.
        "duplicate_stacks": {
            s: lst
            for s, lst in by_stack.items()
            if len([c for c in lst if c.is_open_active]) >= 2
        },
    }


def pick_merge_duplicates(cats: dict, rng: random.Random) -> Decision:
    """Pick a stack with multiple unresolved duplicate claims."""
    dups = cats["duplicate_stacks"]
    if not dups:
        # Fallback: if no duplicates, fall through to pick_new.
        return pick_new(cats, rng)
    # Weight by number of duplicate issues — more duplicates = higher priority.
    stacks = list(dups.keys())
    weights = [len(dups[s]) for s in stacks]
    chosen = rng.choices(stacks, weights=weights, k=1)[0]
    issues = dups[chosen]
    issue_ids = sorted(c.number for c in issues)
    rationale = (
        f"Stack '{chosen}' has {len(issues)} unresolved duplicate [CLAIM] "
        f"issues: {issue_ids}. Consolidate them: cross-validate any "
        f"competing branches, pick the best, close the rest with a comment "
        f"pointing to the chosen branch's PR. Also check if there's an "
        f"existing [MERGE] issue for this stack."
    )
    return Decision(
        action="merge_duplicates",
        stack=chosen,
        rationale=rationale,
        issue_ids=issue_ids,
    )


def pick_new(cats: dict, rng: random.Random) -> Decision:
    """Pick a stack to build from scratch — prefer OPEN [CLAIM] issues,
    fall back to popular stacks not yet claimed."""
    open_claims = cats["open_claims_by_stack"]
    # Filter to single-claim stacks (otherwise it's a merge_duplicates case).
    single_open = [s for s, lst in open_claims.items() if len(lst) == 1]
    candidates = single_open if single_open else POPULAR_NEW_STACKS
    if not candidates:
        # Last-resort: pick a popular stack that's not in done_stacks.
        candidates = [
            s for s in POPULAR_NEW_STACKS if s not in cats["done_stacks"]
        ]
    if not candidates:
        return Decision(
            action="pick_done",
            stack=rng.choice(DONE_STACKS),
            rationale="No open new-stack claims and no popular stacks left — falling back to pick_done.",
        )
    chosen = rng.choice(candidates)
    issue_id = None
    if chosen in open_claims and open_claims[chosen]:
        issue_id = open_claims[chosen][0].number
    rationale = (
        f"Stack '{chosen}' has an OPEN [CLAIM] issue "
        f"(#{issue_id}) with no DONE comment — worker should pick this up, "
        f"verify it's truly not started (no branch pushed), and build "
        f"capture_<stack> + validate_<stack> from scratch following the "
        f"JS reference architecture in scripts/capture.js + validate.js."
    ) if issue_id else (
        f"Stack '{chosen}' is popular but has no [CLAIM] issue yet — "
        f"create one before starting work, then build capture+validate "
        f"from scratch."
    )
    return Decision(
        action="pick_new",
        stack=chosen,
        rationale=rationale,
        issue_ids=[issue_id] if issue_id else [],
    )


def pick_done(cats: dict, rng: random.Random) -> Decision:
    """Pick an already-done stack to extend/verify."""
    done = cats["done_stacks"]
    if not done:
        done = DONE_STACKS
    chosen = rng.choice(done)
    rationale = (
        f"Stack '{chosen}' is already fully supported (capture+validate "
        f"exist). Pick this if you want to extend it (e.g., add callee "
        f"wrapping, multi-input contracts, drift detection). Lower priority "
        f"because the work is incremental — make sure you're not duplicating "
        f"another worker's effort."
    )
    return Decision(
        action="pick_done",
        stack=chosen,
        rationale=rationale,
    )


def decide(seed: Optional[int] = None) -> Decision:
    """Main entry: fetch live issue state, pick an action weighted by
    probability, then pick a concrete stack within that action."""
    rng = random.Random(seed) if seed is not None else random.Random()

    claims = fetch_open_claims()
    if not claims:
        # gh CLI missing or no issues — fall back to picking a popular new stack.
        chosen = rng.choice(POPULAR_NEW_STACKS)
        return Decision(
            action="pick_new",
            stack=chosen,
            rationale=(
                "Could not fetch live issue state (gh CLI missing or no "
                f"issues found). Defaulting to popular new stack '{chosen}'. "
                "Create a [CLAIM] issue before starting work."
            ),
        )

    cats = categorize_claims(claims)

    # Apply weights. If a category is empty, redistribute its weight
    # proportionally across the other categories.
    weights = dict(WEIGHTS)
    if not cats["duplicate_stacks"]:
        # No duplicates to merge — redistribute merge_duplicates weight.
        w = weights.pop("merge_duplicates", 0)
        remaining = sum(weights.values())
        if remaining > 0:
            for k in weights:
                weights[k] += w * (weights[k] / remaining)
    if not cats["open_claims_by_stack"] and not POPULAR_NEW_STACKS:
        # Nothing new to pick — redistribute pick_new weight.
        w = weights.pop("pick_new", 0)
        remaining = sum(weights.values())
        if remaining > 0:
            for k in weights:
                weights[k] += w * (weights[k] / remaining)

    actions = list(weights.keys())
    weights_list = [weights[a] for a in actions]
    chosen_action = rng.choices(actions, weights=weights_list, k=1)[0]

    if chosen_action == "merge_duplicates":
        return pick_merge_duplicates(cats, rng)
    if chosen_action == "pick_new":
        return pick_new(cats, rng)
    return pick_done(cats, rng)


# ─── CLI ─────────────────────────────────────────────────────────────────────


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Probabilistic stack picker for Regrets workers.",
    )
    parser.add_argument(
        "--seed",
        type=int,
        default=None,
        help="Random seed for reproducible decision.",
    )
    parser.add_argument(
        "--json",
        action="store_true",
        help="Emit machine-readable JSON.",
    )
    parser.add_argument(
        "--why",
        action="store_true",
        help="Show detailed reasoning (action + rationale).",
    )
    args = parser.parse_args()

    decision = decide(seed=args.seed)

    if args.json:
        print(json.dumps(decision.to_dict(), indent=2))
    else:
        print(f"ACTION:   {decision.action}")
        print(f"STACK:    {decision.stack}")
        if decision.issue_ids:
            print(f"ISSUES:   {decision.issue_ids}")
        if decision.branch_hint:
            print(f"BRANCH:   {decision.branch_hint}")
        if args.why:
            print()
            print("RATIONALE:")
            print(f"  {decision.rationale}")
        else:
            print(f"RATIONALE: {decision.rationale[:120]}...")

    return 0


if __name__ == "__main__":
    sys.exit(main())

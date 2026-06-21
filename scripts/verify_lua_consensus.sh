#!/usr/bin/env bash
# verify_lua_consensus.sh — cross-validate the 3 competing Lua stack
# implementations (PRs #377, #380, #381) and verify they all produce
# fingerprints identical to each other AND to the JS reference impl.
#
# This script is the deliverable of [MERGE] Lua issue #383. It does NOT
# rewrite any capture_lua implementation — it only TESTS that all 3
# branches agree, and that their agreement extends to the JS reference.
#
# What it does, step by step:
#   1. Ensure a Lua 5.4 interpreter is available (system lua, or built
#      from source into /tmp/lua-5.4.7).
#   2. Stand up a canonical fixture (strings.lua + manifest.json) under
#      /tmp/lua-consensus-fixture/.
#   3. For each of the 3 branches:
#        a. git fetch the branch into a temp worktree
#        b. Run capture_<lua> on the canonical fixture
#        c. Extract the fingerprints
#        d. Run validate on a deliberately-broken fixture (must FAIL)
#   4. Compute JS reference fingerprints using scripts/fingerprint.js.
#   5. Compare all 4 sets — print PASS/FAIL summary.
#
# Usage:
#   bash scripts/verify_lua_consensus.sh
#   bash scripts/verify_lua_consensus.sh --keep-worktrees  # don't clean up
#   GH_TOKEN=xxx bash scripts/verify_lua_consensus.sh      # for private repo
#
# Exit codes:
#   0 — all consensus checks PASS
#   1 — at least one consensus check FAILED
#   2 — environment error (lua/git/node missing)

set -euo pipefail

# ─── Config ───────────────────────────────────────────────────────────────────

REPO="Wolfvin/Regrets"
GIT_REMOTE="${REGRET_GIT_REMOTE:-https://github.com/${REPO}.git}"
BRANCHES=("feat/lua-stack" "feat/lua-stack-373" "feat/lua-stack-370")
BRANCH_LABELS=("PR #377 (claims #368+#369)" "PR #380 (claim #373)" "PR #381 (claim #370)")

KEEP_WORKTREES=0
for arg in "$@"; do
  case "$arg" in
    --keep-worktrees) KEEP_WORKTREES=1 ;;
    *) ;;
  esac
done

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SKILL_DIR="$(dirname "$SCRIPT_DIR")"
TMP_BASE="${TMPDIR:-/tmp}/lua-consensus"
FIXTURE_DIR="$TMP_BASE/fixture"
WORKTREE_BASE="$TMP_BASE/worktrees"
RESULTS_DIR="$TMP_BASE/results"
JS_PARITY_SCRIPT="$TMP_BASE/js_parity.mjs"

# ─── Helpers ──────────────────────────────────────────────────────────────────

color_red()    { printf '\033[31m%s\033[0m\n' "$*"; }
color_green()  { printf '\033[32m%s\033[0m\n' "$*"; }
color_yellow() { printf '\033[33m%s\033[0m\n' "$*"; }
color_blue()   { printf '\033[34m%s\033[0m\n' "$*"; }
color_bold()   { printf '\033[1m%s\033[0m\n' "$*"; }

hr() { printf '─%.0s' {1..70}; printf '\n'; }

# ─── Cleanup (defined here so it's available from any exit path) ──────────────

do_cleanup() {
  if [ "$KEEP_WORKTREES" -eq 0 ]; then
    # Remove worktrees we created
    for wt in "$WORKTREE_BASE"/*; do
      [ -d "$wt" ] || continue
      git -C "$REGRETS_ROOT" worktree remove --force "$wt" 2>/dev/null || true
    done
    rm -rf "$TMP_BASE"
  else
    echo "ℹ️  Worktrees kept at $WORKTREE_BASE (use --keep-worktrees)"
  fi
}

# ─── Preflight: lua, git, node ────────────────────────────────────────────────

echo
color_bold "Regrets — Lua stack cross-branch consensus verification"
echo "Issue #383: [MERGE] Lua — cross-validate 3 competing PR branches"
hr

# Locate Lua interpreter (priority: system > /tmp build)
LUA_BIN=""
if command -v lua &>/dev/null; then
  LUA_BIN="lua"
elif command -v lua5.4 &>/dev/null; then
  LUA_BIN="lua5.4"
elif [ -x "/tmp/lua-5.4.7/src/lua" ]; then
  LUA_BIN="/tmp/lua-5.4.7/src/lua"
fi

if [ -z "$LUA_BIN" ]; then
  echo "ℹ️  Lua interpreter not found — building Lua 5.4.7 from source..."
  if ! command -v gcc &>/dev/null; then
    color_red "❌ gcc not available. Install lua5.4 via your package manager, or install gcc to build from source."
    exit 2
  fi
  cd /tmp
  if [ ! -d lua-5.4.7 ]; then
    curl -sSL https://www.lua.org/ftp/lua-5.4.7.tar.gz -o lua-5.4.7.tar.gz
    tar xzf lua-5.4.7.tar.gz
  fi
  ( cd lua-5.4.7 && make linux >/dev/null 2>&1 )
  LUA_BIN="/tmp/lua-5.4.7/src/lua"
fi
echo "✅ Using Lua: $LUA_BIN  ($($LUA_BIN -v 2>&1))"

if ! command -v git &>/dev/null; then
  color_red "❌ git not found"
  exit 2
fi
if ! command -v node &>/dev/null; then
  color_red "❌ node not found (needed for JS reference fingerprint parity check)"
  exit 2
fi

# Locate the Regrets repo root — we need scripts/fingerprint.js for the parity check
REGRETS_ROOT=""
for candidate in "$SKILL_DIR" "$PWD" "$(cd "$(dirname "$0")/../.." && pwd)"; do
  if [ -f "$candidate/scripts/fingerprint.js" ] && [ -d "$candidate/.git" ]; then
    REGRETS_ROOT="$candidate"
    break
  fi
done
if [ -z "$REGRETS_ROOT" ]; then
  color_red "❌ Could not locate Regrets repo root (containing scripts/fingerprint.js + .git)."
  echo "   Run this script from inside the Regrets repo, e.g.:"
  echo "   bash scripts/verify_lua_consensus.sh"
  exit 2
fi
echo "✅ Regrets repo: $REGRETS_ROOT"
echo

# ─── Reset workspace ──────────────────────────────────────────────────────────

if [ "$KEEP_WORKTREES" -eq 0 ]; then
  rm -rf "$TMP_BASE"
fi
mkdir -p "$FIXTURE_DIR" "$WORKTREE_BASE" "$RESULTS_DIR"

# ─── Stand up the canonical fixture ───────────────────────────────────────────
# This is the SHARED test input — every branch must process the same fixture
# and produce the same fingerprints.

cat > "$FIXTURE_DIR/strings.lua" << 'LUA'
-- Canonical test module for cross-branch Lua consensus check.
-- Pure functions with deterministic output, no side effects.

local M = {}

function M.reverse(s)
    return string.reverse(s)
end

function M.count_vowels(s)
    local _, n = string.gsub(s, "[aeiouAEIOU]", "")
    return n
end

function M.ascii_sum(s)
    local sum = 0
    for i = 1, #s do
        sum = sum + s:byte(i)
    end
    return sum
end

return M
LUA

mkdir -p "$FIXTURE_DIR/regrets"
cat > "$FIXTURE_DIR/regrets/manifest.json" << 'JSON'
{
  "clusters": [
    {
      "id": "reverse",
      "entry": "reverse",
      "watches": ["reverse"],
      "file": "strings.lua",
      "stack": "lua",
      "fingerprintLevel": "entry",
      "luaModule": "strings",
      "luaPath": "./?.lua",
      "inputs": ["hello", "regrets", "level"]
    },
    {
      "id": "count-vowels",
      "entry": "count_vowels",
      "watches": ["count_vowels"],
      "file": "strings.lua",
      "stack": "lua",
      "fingerprintLevel": "entry",
      "luaModule": "strings",
      "luaPath": "./?.lua",
      "inputs": ["hello", "aeiou", "xyz"]
    },
    {
      "id": "ascii-sum",
      "entry": "ascii_sum",
      "watches": ["ascii_sum"],
      "file": "strings.lua",
      "stack": "lua",
      "fingerprintLevel": "entry",
      "luaModule": "strings",
      "luaPath": "./?.lua",
      "inputs": ["abc", "hello", "Lua"]
    }
  ]
}
JSON

echo "✅ Canonical fixture ready at $FIXTURE_DIR"
echo "   3 clusters: reverse, count-vowels, ascii-sum"
echo

# ─── Compute JS reference fingerprints ────────────────────────────────────────

cat > "$JS_PARITY_SCRIPT" << 'EOF'
import { fingerprint } from process.argv[2] + '/scripts/fingerprint.js'

const cases = [
  { id: 'reverse',      input: 'hello', output: 'olleh' },
  { id: 'count-vowels', input: 'hello', output: 2 },
  { id: 'ascii-sum',    input: 'abc',   output: 294 },
  { id: 'BREAKING-reverse', input: 'hello', output: 'hello' },
]

const out = {}
for (const c of cases) {
  out[c.id] = fingerprint(c.input, c.output, {})
}
console.log(JSON.stringify(out))
EOF

JS_FP_JSON=$(node --input-type=module -e "
import { fingerprint } from '$REGRETS_ROOT/scripts/fingerprint.js'
const cases = [
  { id: 'reverse',      input: 'hello', output: 'olleh' },
  { id: 'count-vowels', input: 'hello', output: 2 },
  { id: 'ascii-sum',    input: 'abc',   output: 294 },
  { id: 'BREAKING-reverse', input: 'hello', output: 'hello' },
]
const out = {}
for (const c of cases) out[c.id] = fingerprint(c.input, c.output, {})
console.log(JSON.stringify(out))
")
echo "✅ JS reference fingerprints computed:"
echo "$JS_FP_JSON" | python3 -c "import json,sys; d=json.load(sys.stdin); [print(f'   {k:<22} = {v}') for k,v in d.items()]"
echo

# ─── For each branch: fetch, capture, validate, collect fingerprints ─────────

# We use git fetch + git show to extract files into temp dirs (worktrees
# require committing, but we just want to inspect each branch's scripts/
# directory without modifying anything).

declare -A BRANCH_FP    # BRANCH_FP[branch_id][cluster_id] = fingerprint
declare -A BRANCH_BREAK # BRANCH_BREAK[branch] = breaking fingerprint
declare -A BRANCH_VALIDATE_OK  # "1" if validate correctly detected FAIL

for i in "${!BRANCHES[@]}"; do
  branch="${BRANCHES[$i]}"
  label="${BRANCH_LABELS[$i]}"
  # Sanitize branch name for use in file paths (replace / with _)
  branch_slug=$(echo "$branch" | tr '/' '_')
  wt="$WORKTREE_BASE/$branch_slug"

  color_blue "▶ Branch: $branch  ($label)"

  # Fetch the branch from origin
  if ! git -C "$REGRETS_ROOT" rev-parse --verify "origin/$branch" >/dev/null 2>&1; then
    echo "   git fetch origin $branch..."
    git -C "$REGRETS_ROOT" fetch origin "$branch" >/dev/null 2>&1 || {
      color_red "   ❌ Failed to fetch $branch"
      continue
    }
  fi

  # Create a clean worktree at this branch
  if [ -d "$wt" ]; then
    rm -rf "$wt"
  fi
  git -C "$REGRETS_ROOT" worktree add --force --detach "$wt" "origin/$branch" >/dev/null 2>&1 || {
    color_red "   ❌ Failed to create worktree for $branch"
    continue
  }

  # Set up the canonical fixture inside the worktree (so the branch's own
  # scripts/ can be invoked against it).
  rm -rf "$wt/_consensus_run"
  mkdir -p "$wt/_consensus_run/regrets"
  cp "$FIXTURE_DIR/strings.lua" "$wt/_consensus_run/"
  cp "$FIXTURE_DIR/regrets/manifest.json" "$wt/_consensus_run/regrets/manifest.json"

  # Find the branch's capture script. We invoke via a bash function to avoid
  # quoting nightmares with LUA_PATH's semicolons.
  run_capture() {
    if [ -f "$wt/scripts/capture_lua.lua" ]; then
      LUA_PATH="$wt/scripts/?.lua;$wt/scripts/?/?.lua;./?.lua" "$LUA_BIN" "$wt/scripts/capture_lua.lua"
    elif [ -f "$wt/scripts/capture_lua.sh" ]; then
      bash "$wt/scripts/capture_lua.sh"
    else
      echo "NO_CAPTURE_SCRIPT" >&2
      return 2
    fi
  }

  run_validate() {
    if [ -f "$wt/scripts/validate_lua.lua" ]; then
      LUA_PATH="$wt/scripts/?.lua;$wt/scripts/?/?.lua;./?.lua" "$LUA_BIN" "$wt/scripts/validate_lua.lua"
    elif [ -f "$wt/scripts/capture_lua.sh" ]; then
      bash "$wt/scripts/capture_lua.sh" validate
    elif [ -f "$wt/scripts/validate_lua.sh" ]; then
      bash "$wt/scripts/validate_lua.sh"
    else
      echo "NO_VALIDATE_SCRIPT" >&2
      return 2
    fi
  }

  if [ ! -f "$wt/scripts/capture_lua.lua" ] && [ ! -f "$wt/scripts/capture_lua.sh" ]; then
    color_red "   ❌ No capture_lua.{lua,sh} found in $branch"
    continue
  fi

  # Run capture (cwd = _consensus_run)
  pushd "$wt/_consensus_run" >/dev/null
  echo "   Capture: $(type run_capture | head -1)"
  if ! run_capture > "$RESULTS_DIR/$branch_slug.capture.log" 2>&1; then
    color_red "   ❌ Capture failed for $branch"
    cat "$RESULTS_DIR/$branch_slug.capture.log" | sed 's/^/      /' | head -20
    popd >/dev/null
    continue
  fi
  popd >/dev/null

  # Extract fingerprints from each .regret file
  echo "   Fingerprints captured:"
  for cluster in reverse count-vowels ascii-sum; do
    regret_file="$wt/_consensus_run/regrets/$cluster.regret"
    if [ ! -f "$regret_file" ]; then
      color_red "      ❌ $cluster.regret not generated"
      continue
    fi
    fp=$(grep -E '^fingerprint:' "$regret_file" | head -1 | awk '{print $2}')
    echo "      $cluster = $fp"
    BRANCH_FP["$branch::$cluster"]="$fp"
  done

  # Test breaking change detection: replace strings.lua with broken version
  # (reverse returns input unchanged), then run validate. It MUST FAIL.
  echo "   Breaking-change detection test..."
  cat > "$wt/_consensus_run/strings.lua" << 'BROKENLUA'
local M = {}
function M.reverse(s) return s end  -- BROKEN
function M.count_vowels(s) local _, n = string.gsub(s, "[aeiouAEIOU]", "") return n end
function M.ascii_sum(s) local sum = 0 for i = 1, #s do sum = sum + s:byte(i) end return sum end
return M
BROKENLUA

  # Find validate script (already defined as run_validate function above)

  pushd "$wt/_consensus_run" >/dev/null
  if [ -f "$wt/scripts/validate_lua.lua" ] || [ -f "$wt/scripts/validate_lua.sh" ] || [ -f "$wt/scripts/capture_lua.sh" ]; then
    set +e
    run_validate > "$RESULTS_DIR/$branch_slug.validate.log" 2>&1
    validate_exit=$?
    set -e
    if [ "$validate_exit" -ne 0 ]; then
      color_green "      ✅ validate correctly detected breaking change (exit $validate_exit)"
      BRANCH_VALIDATE_OK["$branch"]=1
    else
      color_red "      ❌ validate did NOT detect breaking change (exit $validate_exit)"
      BRANCH_VALIDATE_OK["$branch"]=0
    fi
  fi
  popd >/dev/null

  # Capture the breaking fingerprint (what the broken code produces)
  pushd "$wt/_consensus_run" >/dev/null
  rm -rf regrets/*.regret
  run_capture > "$RESULTS_DIR/$branch_slug.capture-broken.log" 2>&1 || true
  popd >/dev/null
  if [ -f "$wt/_consensus_run/regrets/reverse.regret" ]; then
    broken_fp=$(grep -E '^fingerprint:' "$wt/_consensus_run/regrets/reverse.regret" | head -1 | awk '{print $2}')
    BRANCH_BREAK["$branch"]="$broken_fp"
    echo "      broken-reverse fingerprint = $broken_fp"
  fi

  echo
done

# ─── Compare all fingerprints ─────────────────────────────────────────────────

color_bold "Consensus results"
hr

# Parse JS fingerprints
JS_REVERSE=$(echo "$JS_FP_JSON" | python3 -c "import json,sys; print(json.load(sys.stdin)['reverse'])")
JS_COUNT=$(echo "$JS_FP_JSON" | python3 -c "import json,sys; print(json.load(sys.stdin)['count-vowels'])")
JS_ASCII=$(echo "$JS_FP_JSON" | python3 -c "import json,sys; print(json.load(sys.stdin)['ascii-sum'])")
JS_BREAKING=$(echo "$JS_FP_JSON" | python3 -c "import json,sys; print(json.load(sys.stdin)['BREAKING-reverse'])")

printf "%-30s %-12s %-12s %-12s %-12s\n" "Branch" "reverse" "count-vowels" "ascii-sum" "breaking"
printf "%-30s %-12s %-12s %-12s %-12s\n" "───" "───" "───" "───" "───"
printf "%-30s %-12s %-12s %-12s %-12s\n" "JS reference (target)" "$JS_REVERSE" "$JS_COUNT" "$JS_ASCII" "$JS_BREAKING"

consensus_pass=1
for i in "${!BRANCHES[@]}"; do
  branch="${BRANCHES[$i]}"
  short_label=$(echo "$branch" | sed 's|feat/lua-stack|branch-1|; s|feat/lua-stack-373|branch-2|; s|feat/lua-stack-370|branch-3|')
  r="${BRANCH_FP[$branch::reverse]:-MISSING}"
  c="${BRANCH_FP[$branch::count-vowels]:-MISSING}"
  a="${BRANCH_FP[$branch::ascii-sum]:-MISSING}"
  b="${BRANCH_BREAK[$branch]:-MISSING}"
  printf "%-30s %-12s %-12s %-12s %-12s\n" "$short_label ($branch)" "$r" "$c" "$a" "$b"

  # Check consensus vs JS reference
  for kv in "reverse::$r:$JS_REVERSE" "count-vowels::$c:$JS_COUNT" "ascii-sum::$a:$JS_ASCII" "breaking::$b:$JS_BREAKING"; do
    cluster="${kv%%::*}"
    rest="${kv#*::}"
    got="${rest%%:*}"
    want="${rest##*:}"
    if [ "$got" != "$want" ]; then
      color_red "  ❌ MISMATCH: $short_label $cluster got=$got want=$want"
      consensus_pass=0
    fi
  done
done

echo
echo "Validate breaking-change detection:"
for i in "${!BRANCHES[@]}"; do
  branch="${BRANCHES[$i]}"
  if [ "${BRANCH_VALIDATE_OK[$branch]:-0}" = "1" ]; then
    color_green "  ✅ $branch — correctly FAILed on breaking change"
  else
    color_red "  ❌ $branch — did NOT FAIL on breaking change"
    consensus_pass=0
  fi
done

echo
hr
if [ "$consensus_pass" = "1" ]; then
  color_green "✅ ALL CONSENSUS CHECKS PASSED — 3 Lua branches agree with each other and with the JS reference fingerprint."
  echo
  echo "Conclusion: PRs #377, #380, #381 are functionally equivalent. Any of them"
  echo "can be merged — the other two can be closed as duplicates of the canonical."
  echo
  echo "Recommended canonical: PR #377 (feat/lua-stack) — integrates with npm test"
  echo "and the unified regret.js CLI; preserves the most detailed .regret format"
  echo "(includes INPUTS array of all input hashes for multi-input clusters)."
  do_cleanup
  exit 0
else
  color_red "❌ Consensus FAILED — see mismatches above."
  do_cleanup
  exit 1
fi

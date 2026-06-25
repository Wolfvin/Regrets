#!/usr/bin/env bash
# capture_crystal.sh — compile + run regret capture for Crystal clusters
#
# Reads regrets/manifest.json, filters stack:"crystal" clusters, generates
# a temp Crystal runner per cluster that `require`s the user's source file
# and invokes the entry function with each input, computes a fingerprint
# (identical algorithm to JS/Python/PHP/Go/Lua), and writes a standard
# .regret file per cluster.
#
# Usage:
#   bash scripts/capture_crystal.sh                  # capture all Crystal clusters
#   bash scripts/capture_crystal.sh validate         # validate all Crystal clusters
#   bash scripts/capture_crystal.sh --cluster <id>   # single-cluster capture/validate
#   bash scripts/capture_crystal.sh --fail-fast      # stop on first failure (validate only)
#   bash scripts/capture_crystal.sh --update <id> --reason "..."   # re-capture golden
#   bash scripts/capture_crystal.sh health           # health report (delegates to health.js)
#
# Exit codes:
#   0 — all clusters captured/validated successfully
#   1 — at least one cluster failed
#   2 — environment error (crystal not installed, manifest missing, etc.)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SKILL_DIR="$(dirname "$SCRIPT_DIR")"
PROJECT_DIR="$(pwd)"
MANIFEST="${PROJECT_DIR}/regrets/manifest.json"

# Node.js (native Windows binary) does not resolve POSIX-style paths the way
# Git Bash does -- /c/Users/... gets misread as a relative path under the
# current drive, producing nonsense like C:\c\Users\.... Convert via cygpath
# when available (Git Bash / MSYS2 / Cygwin) so every `node -e` call below
# gets a path Node actually understands. No-op on Linux/Mac.
node_path() {
  if command -v cygpath &> /dev/null; then
    cygpath -m "$1"
  else
    echo "$1"
  fi
}
NODE_MANIFEST="$(node_path "$MANIFEST")"
REGRET_DIR="${PROJECT_DIR}/regrets"

CRYSTAL_DIR="${SCRIPT_DIR}/crystal"
FINGERPRINT_CR="${CRYSTAL_DIR}/fingerprint.cr"
RUNNER_CR="${CRYSTAL_DIR}/runner.cr"

# ─── Parse args ───────────────────────────────────────────────────────────────

MODE="capture"
CLUSTER_FILTER=""
FAIL_FAST=0
UPDATE_TARGET=""
UPDATE_REASON=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --cluster)
      CLUSTER_FILTER="$2"; shift 2 ;;
    --fail-fast)
      FAIL_FAST=1; shift ;;
    --update)
      UPDATE_TARGET="$2"; shift 2 ;;
    --reason)
      UPDATE_REASON="$2"; shift 2 ;;
    capture|validate|health)
      MODE="$1"; shift ;;
    *)
      # Skip unknown args (forward compat with pass-through from regret.js)
      shift ;;
  esac
done
NODE_MANIFEST="$(node_path "$MANIFEST")"  # recompute after flag parsing (--manifest/--project may have changed MANIFEST)

# If --update was provided, force validate mode with --update
if [[ -n "$UPDATE_TARGET" ]]; then
  MODE="validate"
  if [[ -z "$UPDATE_REASON" ]]; then
    echo "❌ --update requires --reason"
    echo "   Example: --update my-cluster --reason \"describe why behavior changed\""
    exit 1
  fi
  # Word count check (matches validate.php convention)
  word_count=$(echo "$UPDATE_REASON" | wc -w)
  if [[ $word_count -lt 4 ]]; then
    echo "❌ --reason is too vague: \"$UPDATE_REASON\""
    echo "   Be specific. e.g. \"tax rate updated from 11% to 12% per new regulation\""
    exit 1
  fi
fi

if [[ "$MODE" == "health" ]]; then
  node "$SKILL_DIR/scripts/health.js" 2>/dev/null || true
  exit 0
fi

# ─── Locate Crystal interpreter ───────────────────────────────────────────────
# Priority:
#   1. $CRYSTAL_INTERPRETER env var
#   2. `crystal` on PATH
#   3. /tmp/stack-install/crystal-*/bin/crystal (built-in fallback)

CRYSTAL_BIN="${CRYSTAL_INTERPRETER:-}"
if [[ -z "$CRYSTAL_BIN" ]]; then
  if command -v crystal &>/dev/null; then
    CRYSTAL_BIN="crystal"
  else
    for p in /tmp/stack-install/crystal-*/bin/crystal /opt/crystal/bin/crystal; do
      if [[ -x "$p" ]]; then CRYSTAL_BIN="$p"; break; fi
    done
  fi
fi

if [[ -z "$CRYSTAL_BIN" ]]; then
  echo "❌ Crystal interpreter not found."
  echo "   Install Crystal (https://crystal-lang.org/install/) or set CRYSTAL_INTERPRETER=/path/to/crystal"
  echo "   Prebuilt binary: https://github.com/crystal-lang/crystal/releases"
  exit 2
fi

if ! "$CRYSTAL_BIN" --version &>/dev/null; then
  echo "❌ Crystal interpreter at $CRYSTAL_BIN is not executable or broken."
  exit 2
fi

# ─── Check manifest ───────────────────────────────────────────────────────────

if [[ ! -f "$MANIFEST" ]]; then
  echo "❌ regrets/manifest.json not found at $MANIFEST"
  echo "   Run 'regret init --stack crystal' first, or create the manifest manually."
  exit 2
fi

mkdir -p "$REGRET_DIR"

# ─── Helper: read Crystal clusters from manifest ──────────────────────────────

read_crystal_clusters() {
  node -e "
    const m = JSON.parse(require('fs').readFileSync('$NODE_MANIFEST', 'utf8'));
    let clusters = (m.clusters || []).filter(c => c.stack === 'crystal');
    const filter = process.argv[1];
    if (filter) clusters = clusters.filter(c => c.id === filter);
    console.log(JSON.stringify(clusters));
  " "$CLUSTER_FILTER"
}

CLUSTERS_JSON=$(read_crystal_clusters)

if [[ "$CLUSTERS_JSON" == "[]" ]]; then
  echo "No Crystal clusters found in manifest.$([[ -n "$CLUSTER_FILTER" ]] && echo " Matching cluster id: $CLUSTER_FILTER")"
  exit 0
fi

# ─── Helper: build a per-cluster runner .cr file ──────────────────────────────
#
# The generated file:
#   1. `require`s ./fingerprint.cr and ./runner.cr (shared modules)
#   2. `require`s the user's source file (relative to PROJECT_DIR)
#   3. Defines an entry_invoker that calls the user's entry function
#   4. Calls RegretRunner.capture or RegretRunner.validate
#
# We use JSON::Any for input/output so we can pass arbitrary JSON values through.

build_runner_file() {
  # Delegate to a separate node script to avoid bash quoting issues.
  # The node script writes the runner .cr file to scripts/crystal/_runner_<pid>_<id>_<mode>.cr
  # (Crystal's `require` only accepts relative paths, so the runner MUST live
  # in the same directory as fingerprint.cr and runner.cr.)
  # Stdout = the actual path written.
  node "${CRYSTAL_DIR}/build_runner.cjs" "$1" "$2" "$3" "$PROJECT_DIR" "$SCRIPT_DIR" "$REGRET_DIR"
}

# ─── Main dispatch ────────────────────────────────────────────────────────────

if [[ "$MODE" == "capture" ]]; then
  echo "📡 Capturing Crystal clusters..."
  echo "   Interpreter: $CRYSTAL_BIN"
  echo

  passed=0
  failed=0

  # Iterate clusters one by one (node emits an array)
  n_clusters=$(echo "$CLUSTERS_JSON" | node -e "console.log(JSON.parse(require('fs').readFileSync(0,'utf8')).length)")

  for ((i=0; i<n_clusters; i++)); do
    cluster_json=$(echo "$CLUSTERS_JSON" | node -e "console.log(JSON.stringify(JSON.parse(require('fs').readFileSync(0,'utf8'))[$i]))")
    cluster_id=$(echo "$cluster_json" | node -e "console.log(JSON.parse(require('fs').readFileSync(0,'utf8')).id)")

    runner_file="/tmp/regret_crystal_runner_${cluster_id}.cr"
    actual_runner=$(build_runner_file "$cluster_json" "capture" "$runner_file")

    # Compile + run
    set +e
    "$CRYSTAL_BIN" run --no-color "$actual_runner" 2>&1
    rc=$?
    set -e

    if [[ $rc -eq 0 ]]; then
      passed=$((passed + 1))
    else
      failed=$((failed + 1))
    fi
    rm -f "$actual_runner"
  done

  echo
  echo "────────────────────────────────────────────────────────────────"
  if [[ $failed -eq 0 ]]; then
    echo "✅ Capture complete: $passed captured, $failed failed"
    echo
    echo "Next: bash scripts/capture_crystal.sh validate"
    echo "If all green → you are clear to refactor."
    exit 0
  else
    echo "❌ Capture complete: $passed captured, $failed failed"
    echo
    echo "   Fix failed captures before proceeding to PHASE 2."
    exit 1
  fi

elif [[ "$MODE" == "validate" ]]; then
  echo "🔍 Validating Crystal clusters..."
  echo "   Interpreter: $CRYSTAL_BIN"
  if [[ -n "$UPDATE_TARGET" ]]; then
    echo "   Update mode: $UPDATE_TARGET"
    echo "   Reason: $UPDATE_REASON"
  fi
  echo

  passed=0
  failed=0

  n_clusters=$(echo "$CLUSTERS_JSON" | node -e "console.log(JSON.parse(require('fs').readFileSync(0,'utf8')).length)")

  for ((i=0; i<n_clusters; i++)); do
    cluster_json=$(echo "$CLUSTERS_JSON" | node -e "console.log(JSON.stringify(JSON.parse(require('fs').readFileSync(0,'utf8'))[$i]))")
    cluster_id=$(echo "$cluster_json" | node -e "console.log(JSON.parse(require('fs').readFileSync(0,'utf8')).id)")

    # If --update was specified, only validate that cluster, then re-capture
    if [[ -n "$UPDATE_TARGET" && "$cluster_id" != "$UPDATE_TARGET" ]]; then
      continue
    fi

    runner_file="/tmp/regret_crystal_runner_${cluster_id}_validate.cr"

    if [[ -n "$UPDATE_TARGET" ]]; then
      # Update mode: re-capture (write new .regret file with new golden hash)
      # then append audit.log entry
      actual_runner=$(build_runner_file "$cluster_json" "capture" "$runner_file")
      set +e
      "$CRYSTAL_BIN" run --no-color "$actual_runner" 2>&1
      rc=$?
      set -e

      if [[ $rc -eq 0 ]]; then
        # Append audit.log entry
        audit_log="$REGRET_DIR/audit.log"
        prev_chain="0000000"
        if [[ -f "$audit_log" ]]; then
          prev_chain=$(grep -oE 'chain: [a-z0-9]+' "$audit_log" | tail -1 | awk '{print $2}' || echo "0000000")
        fi
        now=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
        new_entry="${now}  UPDATE  ${cluster_id}\n  reason: ${UPDATE_REASON}\n  by: AI refactor session"
        chain_hash=$(printf "%s%s" "$prev_chain" "$new_entry" | sha256sum | awk '{print $1}' | cut -c1-7)
        printf "\n%s\n  chain: %s\n" "$new_entry" "$chain_hash" >> "$audit_log"
        echo "  ✅ $cluster_id updated (audit logged)"
        passed=$((passed + 1))
      else
        failed=$((failed + 1))
      fi
    else
      # Regular validate mode
      actual_runner=$(build_runner_file "$cluster_json" "validate" "$runner_file")
      set +e
      "$CRYSTAL_BIN" run --no-color "$actual_runner" 2>&1
      rc=$?
      set -e

      if [[ $rc -eq 0 ]]; then
        passed=$((passed + 1))
      else
        failed=$((failed + 1))
        if [[ $FAIL_FAST -eq 1 ]]; then
          echo
          echo "  --fail-fast: stopping."
          break
        fi
      fi
    fi
    rm -f "$actual_runner"
  done

  echo
  echo "────────────────────────────────────────────────────────────────"
  if [[ $failed -eq 0 ]]; then
    echo "✅ All $passed tests passed. Refactor is safe."
    exit 0
  else
    echo "❌ $failed/$(($passed + $failed)) FAILED."
    echo
    echo "Fix the CODE — do not edit .regret files."
    echo "Re-run: bash scripts/capture_crystal.sh validate"
    exit 1
  fi
fi

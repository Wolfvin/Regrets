#!/usr/bin/env bash
# validate_nim.sh — regression validator for Nim clusters
#
# Reads .regret files, regenerates a Nim harness per cluster that re-invokes
# the entry proc with the .regret's INPUT, computes a new hash, and compares
# it with the golden HASH. Reports PASS/FAIL.
#
# Usage:
#   bash scripts/validate_nim.sh
#   bash scripts/validate_nim.sh --cluster slugify
#   bash scripts/validate_nim.sh --manifest ./manifest.json
#   bash scripts/validate_nim.sh --fail-fast        # stop on first FAIL
#   bash scripts/validate_nim.sh --runs 5           # drift detection (5 runs per cluster)
#   bash scripts/validate_nim.sh --update <id> --reason "specific reason"
#
# Exit code: 0 if all clusters PASS, 1 if any FAIL.

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

# ─── Parse CLI args ───────────────────────────────────────────────────────────
CLUSTER_FILTER=""
MANIFEST_FLAG=""
FAIL_FAST=0
RUNS=1
UPDATE_TARGET=""
UPDATE_REASON=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --cluster)
      CLUSTER_FILTER="$2"
      shift 2
      ;;
    --manifest)
      MANIFEST_FLAG="$2"
      shift 2
      ;;
    --fail-fast)
      FAIL_FAST=1
      shift
      ;;
    --runs)
      RUNS="$2"
      shift 2
      ;;
    --update)
      UPDATE_TARGET="$2"
      shift 2
      ;;
    --reason)
      UPDATE_REASON="$2"
      shift 2
      ;;
    *)
      shift
      ;;
  esac
done

[[ -n "$MANIFEST_FLAG" ]] && MANIFEST="$MANIFEST_FLAG"
NODE_MANIFEST="$(node_path "$MANIFEST")"  # recompute after flag parsing (--manifest/--project may have changed MANIFEST)

if [[ ! -f "$MANIFEST" ]]; then
  echo "❌ Could not read manifest: $MANIFEST" >&2
  exit 1
fi

# ─── Validate --update usage ──────────────────────────────────────────────────
if [[ -n "$UPDATE_TARGET" && -z "$UPDATE_REASON" ]]; then
  echo "❌ --update requires --reason" >&2
  echo "   Example: --update slugify --reason \"describe why behavior changed\""
  exit 1
fi

if [[ -n "$UPDATE_REASON" ]]; then
  # Count words in UPDATE_REASON — must be at least 4 words
  WORD_COUNT=$(echo "$UPDATE_REASON" | wc -w)
  if [[ "$WORD_COUNT" -lt 4 ]]; then
    echo "❌ --reason is too vague: \"$UPDATE_REASON\"" >&2
    echo "   Be specific. e.g. \"tax rate updated from 11% to 12% per new regulation\""
    exit 1
  fi
fi

# ─── Locate Nim compiler ──────────────────────────────────────────────────────
NIM="${NIM:-nim}"
if ! command -v "$NIM" >/dev/null 2>&1; then
  echo "❌ Nim compiler not found on PATH." >&2
  echo "   Install Nim (https://nim-lang.org/install.html) or set NIM=/path/to/nim" >&2
  exit 1
fi

# ─── Build a synthetic cluster JSON for the harness from a .regret file ───────
# Args: regret_path  → outputs cluster_json on stdout
regret_to_cluster_json() {
  local raw_path="$1"
  local regret_path
  regret_path="$(node_path "$raw_path")"
  node -e "
    const fs = require('fs');
    const path = require('path');
    const manifest = JSON.parse(fs.readFileSync('$NODE_MANIFEST', 'utf8'));
    // CRLF -> LF guard: git core.autocrlf=true (Windows default) rewrites
    // .regret files to CRLF on checkout, turning the separator into
    // '\r\n---\r\n', which the regex below (anchored on literal \n) would
    // not match, breaking every cluster (same root cause as #522).
    const regretContent = fs.readFileSync('$regret_path', 'utf8').replace(/\r\n/g, '\n');

    // Parse .regret file: metadata section + data section (split by '---' line)
    const sections = regretContent.split(/\n---\n/, 2);
    const metaSection = sections[0];
    const dataSection = sections[1] || '';

    const meta = {};
    for (const line of metaSection.split('\n')) {
      const m = line.match(/^([a-zA-Z]+):\s(.*)$/);
      if (m) meta[m[1]] = m[2];
    }

    let inputJSON = 'null';
    let outputJSON = 'null';
    let goldenHash = '';
    for (const line of dataSection.split('\n')) {
      if (line.startsWith('INPUT ')) inputJSON = line.slice(6);
      if (line.startsWith('OUTPUT ')) outputJSON = line.slice(7);
      if (line.startsWith('HASH ')) goldenHash = line.slice(5).trim();
    }

    const clusterId = meta.cluster;
    if (!clusterId) throw new Error('regret file missing cluster: field');

    // Find matching cluster in manifest
    const def = (manifest.clusters || []).find(c => c.id === clusterId);
    if (!def) throw new Error('cluster \"' + clusterId + '\" not found in manifest');

    // Build synthetic cluster JSON for the harness — only first input is used
    const parsedInput = JSON.parse(inputJSON);
    const cluster = {
      id: def.id,
      entry: def.entry,
      file: def.file,
      stack: 'nim',
      fingerprintLevel: def.fingerprintLevel || 'entry',
      watches: def.watches || [],
      normalize: def.normalize || [],
      ignoreFields: def.ignoreFields || [],
      inputs: [parsedInput],
    };

    process.stdout.write(JSON.stringify(cluster));
  "
}

# ─── Run harness and return new hash ──────────────────────────────────────────
# Args: cluster_json  → prints new hash on stdout, returns 0 on success
run_harness_for_cluster() {
  local cluster_json="$1"

  local cluster_id cluster_safe
  cluster_id=$(echo "$cluster_json" | node -e "
    const c = JSON.parse(require('fs').readFileSync(0,'utf8'));
    process.stdout.write(c.id);
  ")
  cluster_safe=$(echo "$cluster_id" | sed 's/[^A-Za-z0-9_]/_/g')

  local harness_file="/tmp/regret_validate_${cluster_safe}_$$.nim"
  local compile_log="/tmp/regret_validate_${cluster_safe}_$$.compile.log"
  local harness_bin="/tmp/regret_validate_${cluster_safe}_$$"
  local run_log="/tmp/regret_validate_${cluster_safe}_$$.run.log"

  if ! node "$SCRIPT_DIR/_nim_harness_gen.cjs" "$cluster_json" "$harness_file" 2>&1; then
    return 1
  fi

  if ! "$NIM" c -d:release --path:"$SCRIPT_DIR" \
                -o:"$harness_bin" \
                "$harness_file" > "$compile_log" 2>&1; then
    cat "$compile_log" | sed 's/^/      /' >&2
    rm -f "$harness_file" "$compile_log"
    return 1
  fi

  if ! "$harness_bin" > "$run_log" 2>&1; then
    cat "$run_log" | sed 's/^/      /' >&2
    rm -f "$harness_file" "$harness_bin" "$compile_log" "$run_log"
    return 1
  fi

  local new_hash
  new_hash=$(grep '^REGRET_HASH ' "$run_log" | sed 's/^REGRET_HASH //')

  rm -f "$harness_file" "$harness_bin" "$compile_log" "$run_log"

  if [[ -z "$new_hash" ]]; then
    return 1
  fi

  echo "$new_hash"
}

# ─── Find .regret files ───────────────────────────────────────────────────────
FILTER_ID="${CLUSTER_FILTER:-$UPDATE_TARGET}"

REGRET_FILES=()
if [[ -n "$FILTER_ID" ]]; then
  REGRET_FILES=("$REGRET_DIR/$FILTER_ID.regret")
else
  for f in "$REGRET_DIR"/*.regret; do
    # Skip callee files (.calls.X.regret) — those are JS-only
    base=$(basename "$f" .regret)
    if [[ "$base" != *".calls."* ]]; then
      REGRET_FILES+=("$f")
    fi
  done
fi

# Filter to Nim clusters only
NIM_REGRET_FILES=()
for f in "${REGRET_FILES[@]}"; do
  if [[ -f "$f" ]]; then
    stack=$(grep -m1 '^stack:' "$f" | awk '{print $2}')
    if [[ "$stack" == "nim" ]]; then
      NIM_REGRET_FILES+=("$f")
    fi
  fi
done

if [[ ${#NIM_REGRET_FILES[@]} -eq 0 ]]; then
  echo "❌ No Nim .regret files found${FILTER_ID:+ matching \"$FILTER_ID\"}."
  exit 1
fi

# ─── Mode detection ───────────────────────────────────────────────────────────
UPDATE_MODE=0
DRIFT_MODE=0
if [[ -n "$UPDATE_TARGET" ]]; then
  UPDATE_MODE=1
  echo
  echo "🔄 Update mode — cluster: $UPDATE_TARGET"
  echo "   Reason: $UPDATE_REASON"
  echo
elif [[ "$RUNS" -gt 1 ]]; then
  DRIFT_MODE=1
  echo
  echo "🔍 Drift detection — $RUNS runs per cluster..."
  echo
else
  echo
  echo "🔍 Validating ${#NIM_REGRET_FILES[@]} Nim cluster(s)..."
  echo
fi

# ─── Main loop ────────────────────────────────────────────────────────────────
PASS=0
FAIL=0
DRIFTED=0
declare -a FAILED_IDS

for regret_path in "${NIM_REGRET_FILES[@]}"; do
  cluster_id=$(basename "$regret_path" .regret)
  regret_path_node="$(node_path "$regret_path")"
  printf "  "

  # Parse .regret file
  golden_hash=$(grep -m1 '^HASH ' "$regret_path" | sed 's/^HASH \+//')

  if [[ -z "$golden_hash" ]]; then
    echo "❌ $(printf '%-35s' "$cluster_id") ERROR: missing HASH line"
    FAIL=$((FAIL + 1))
    FAILED_IDS+=("$cluster_id")
    if [[ $FAIL_FAST -eq 1 ]]; then
      echo
      echo "  --fail-fast: stopping."
      break
    fi
    continue
  fi

  # Build cluster JSON from .regret + manifest
  if ! cluster_json=$(regret_to_cluster_json "$regret_path"); then
    echo "❌ $(printf '%-35s' "$cluster_id") ERROR: cluster not in manifest or .regret malformed"
    FAIL=$((FAIL + 1))
    FAILED_IDS+=("$cluster_id")
    if [[ $FAIL_FAST -eq 1 ]]; then
      echo
      echo "  --fail-fast: stopping."
      break
    fi
    continue
  fi

  # For drift mode, run harness N times
  if [[ $DRIFT_MODE -eq 1 ]]; then
    hashes_per_run=()
    for ((r=1; r<=RUNS; r++)); do
      if ! new_hash=$(run_harness_for_cluster "$cluster_json"); then
        echo "❌ $(printf '%-35s' "$cluster_id") ERROR: harness failed on run $r"
        FAIL=$((FAIL + 1))
        FAILED_IDS+=("$cluster_id")
        continue 2
      fi
      hashes_per_run+=("$new_hash")
    done

    # Check drift
    unique_hashes=$(printf '%s\n' "${hashes_per_run[@]}" | sort -u | wc -l)
    if [[ "$unique_hashes" -gt 1 ]]; then
      echo "❌ $(printf '%-35s' "$cluster_id") DRIFT  [${hashes_per_run[*]}]"
      DRIFTED=$((DRIFTED + 1))
      FAIL=$((FAIL + 1))
      FAILED_IDS+=("$cluster_id")
    else
      new_hash="${hashes_per_run[0]}"
      if [[ "$new_hash" == "$golden_hash" ]]; then
        echo "✅ $(printf '%-35s' "$cluster_id") $new_hash  × $RUNS  PASS+STABLE"
        PASS=$((PASS + 1))
      else
        echo "❌ $(printf '%-35s' "$cluster_id") $golden_hash → $new_hash  × $RUNS  FAIL"
        FAIL=$((FAIL + 1))
        FAILED_IDS+=("$cluster_id")
      fi
    fi
    continue
  fi

  # Single-run mode (validate or update)
  if ! new_hash=$(run_harness_for_cluster "$cluster_json" 2>&1); then
    echo "❌ $(printf '%-35s' "$cluster_id") ERROR: harness failed"
    FAIL=$((FAIL + 1))
    FAILED_IDS+=("$cluster_id")
    if [[ $FAIL_FAST -eq 1 ]]; then
      echo
      echo "  --fail-fast: stopping."
      break
    fi
    continue
  fi

  if [[ $UPDATE_MODE -eq 1 ]]; then
    if [[ "$new_hash" == "$golden_hash" ]]; then
      echo "ℹ️  $(printf '%-35s' "$cluster_id") unchanged — no update needed"
      PASS=$((PASS + 1))
    else
      # Rewrite .regret with new hash + new OUTPUT, append to audit.log
      new_output=$(node -e "
        const fs = require('fs');
        const path = require('path');
        const manifest = JSON.parse(fs.readFileSync('$NODE_MANIFEST', 'utf8'));
        const regretContent = fs.readFileSync('$regret_path_node', 'utf8');
        // Build a synthetic cluster with the existing input and re-run to get fresh output.
        // Actually, we already ran the harness and got the new hash. We just need to also
        // know the new OUTPUT. The harness outputs that on stdout — but we already
        // discarded it. For simplicity, just bump the hash and timestamp; the OUTPUT
        // stays as-is (it was already correct from the last capture — this is the
        // same convention as the Ruby adapter).
        process.exit(0);
      ")
      # Actually: re-run harness and capture full output
      cluster_safe=$(echo "$cluster_id" | sed 's/[^A-Za-z0-9_]/_/g')
      harness_file="/tmp/regret_update_${cluster_safe}_$$.nim"
      compile_log="/tmp/regret_update_${cluster_safe}_$$.compile.log"
      harness_bin="/tmp/regret_update_${cluster_safe}_$$"
      run_log="/tmp/regret_update_${cluster_safe}_$$.run.log"

      node "$SCRIPT_DIR/_nim_harness_gen.cjs" "$cluster_json" "$harness_file" >/dev/null 2>&1
      "$NIM" c -d:release --path:"$SCRIPT_DIR" -o:"$harness_bin" "$harness_file" > "$compile_log" 2>&1
      "$harness_bin" > "$run_log" 2>&1
      new_input_line=$(grep '^REGRET_INPUT ' "$run_log" || true)
      new_output_line=$(grep '^REGRET_OUTPUT ' "$run_log" || true)
      new_hash_full=$(grep '^REGRET_HASH ' "$run_log" | sed 's/^REGRET_HASH //')
      rm -f "$harness_file" "$harness_bin" "$compile_log" "$run_log"

      # Update .regret
      node -e "
        const fs = require('fs');
        const path = require('path');
        const oldHash = '$golden_hash';
        const newHash = '$new_hash_full';
        const newInput = '${new_input_line#REGRET_INPUT }';
        const newOutput = '${new_output_line#REGRET_OUTPUT }';
        const now = new Date().toISOString();
        const reason = process.argv[1];
        const clusterId = '$cluster_id';

        let content = fs.readFileSync('$regret_path_node', 'utf8');
        content = content.replace(/^fingerprint: .+$/m, 'fingerprint: ' + newHash);
        content = content.replace(/^captured: .+$/m, 'captured: ' + now);
        content = content.replace(/^OUTPUT .+$/m, 'OUTPUT ' + newOutput);
        content = content.replace(/^HASH .+$/m, 'HASH   ' + newHash);
        fs.writeFileSync('$regret_path_node', content);

        // Append to audit.log
        const auditPath = path.join(process.cwd(), 'regrets', 'audit.log');
        let prevChain = '0000000';
        if (fs.existsSync(auditPath)) {
          const log = fs.readFileSync(auditPath, 'utf8');
          const lines = log.split('\n').reverse();
          for (const line of lines) {
            const m = line.match(/^\s*chain:\s*(\S+)/);
            if (m) { prevChain = m[1]; break; }
          }
        }
        const entry = now + '  UPDATE  ' + clusterId +
                      '\n  old: ' + oldHash +
                      '\n  new: ' + newHash +
                      '\n  reason: ' + reason +
                      '\n  by: AI refactor session';
        const crypto = require('crypto');
        const chainHash = crypto.createHash('sha256').update(prevChain + entry).digest('hex').slice(0, 7);
        fs.appendFileSync(auditPath, '\n' + entry + '\n  chain: ' + chainHash);
      " "$UPDATE_REASON"

      echo "✅ $(printf '%-35s' "$cluster_id") $golden_hash → $new_hash_full  UPDATED"
      PASS=$((PASS + 1))
    fi
    continue
  fi

  # Plain validate
  if [[ "$new_hash" == "$golden_hash" ]]; then
    echo "✅ $(printf '%-35s' "$cluster_id") $(printf '%-22s' "$golden_hash") PASS"
    PASS=$((PASS + 1))
  else
    echo "❌ $(printf '%-35s' "$cluster_id") $(printf '%-22s' "$golden_hash → $new_hash") FAIL"
    FAIL=$((FAIL + 1))
    FAILED_IDS+=("$cluster_id")
    if [[ $FAIL_FAST -eq 1 ]]; then
      echo
      echo "  --fail-fast: stopping."
      break
    fi
  fi
done

# ─── Summary ──────────────────────────────────────────────────────────────────
echo
echo "────────────────────────────────────────────────────────────────"

if [[ $UPDATE_MODE -eq 1 ]]; then
  echo "✅ Update complete. $PASS cluster(s) processed."
  echo "   Audit: regrets/audit.log"
  exit 0
fi

if [[ $DRIFT_MODE -eq 1 && $DRIFTED -gt 0 ]]; then
  echo "❌ Drift in $DRIFTED cluster(s). Add normalize rules and re-capture."
  exit 1
fi

if [[ $FAIL -eq 0 ]]; then
  if [[ $DRIFT_MODE -eq 1 ]]; then
    echo "✅ All $PASS tests passed ($RUNS runs — stable). Refactor is safe."
  else
    echo "✅ All $PASS tests passed. Refactor is safe."
  fi
  echo
  exit 0
fi

echo "❌ $FAIL/${#NIM_REGRET_FILES[@]} FAILED."
echo
for id in "${FAILED_IDS[@]}"; do
  echo "  • $id"
done
echo
echo "Fix the CODE — do not edit .regret files."
echo "Re-run: bash scripts/validate_nim.sh"
exit 1

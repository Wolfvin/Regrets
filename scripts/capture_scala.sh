#!/usr/bin/env bash
# capture_scala.sh — capture/validate Scala clusters via scala-cli.
#
# Reads regrets/manifest.json, filters clusters with stack="scala", and for each
# cluster:
#   1. Reads the user's Scala source file (cluster.file)
#   2. Compiles & runs regret_harness.scala + user source together via scala-cli
#   3. The harness calls <object>.<entry>(inputs), computes the fingerprint,
#      and writes (capture) or compares (validate) a .regret file.
#
# Usage:
#   bash scripts/capture_scala.sh                  # capture all Scala clusters
#   bash scripts/capture_scala.sh validate         # validate all Scala clusters
#   bash scripts/capture_scala.sh --cluster <id>   # operate on one cluster
#   bash scripts/capture_scala.sh --fail-fast      # stop on first failure (validate only)
#
# Requirements:
#   - scala-cli on PATH (https://scala-cli.virtuslab.org)
#   - JDK 11+ (scala-cli bundles Scala 3)
#
# Fingerprint parity: the algorithm in regret_fingerprint.scala is byte-identical
# to scripts/fingerprint.js (JS), fingerprint.py (Python), fingerprint_php.php (PHP).
# Cross-stack parity verified by proof/scala_slugify/run_demo.sh.

set -uo pipefail

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

mkdir -p "$REGRET_DIR"

MODE="capture"
CLUSTER_FILTER=""
FAIL_FAST=0

# Parse args
while [[ $# -gt 0 ]]; do
  case "$1" in
    capture|validate|health)
      MODE="$1"
      shift
      ;;
    --cluster)
      CLUSTER_FILTER="$2"
      shift 2
      ;;
    --fail-fast)
      FAIL_FAST=1
      shift
      ;;
    --help|-h)
      echo "Usage: bash scripts/capture_scala.sh [capture|validate] [--cluster <id>] [--fail-fast]"
      exit 0
      ;;
    *)
      # Ignore unknown args (passed through from regret.js)
      shift
      ;;
  esac
done
NODE_MANIFEST="$(node_path "$MANIFEST")"  # recompute after flag parsing (--manifest/--project may have changed MANIFEST)

if [[ "$MODE" == "health" ]]; then
  node "$SKILL_DIR/scripts/health.js"
  exit 0
fi

# ─── Check toolchain ────────────────────────────────────────────────────────

if ! command -v scala-cli &> /dev/null; then
  echo "❌ scala-cli not found on PATH."
  echo "   Install: https://scala-cli.virtuslab.org/install"
  exit 1
fi

if ! command -v node &> /dev/null; then
  echo "❌ node not found on PATH (needed to parse manifest.json)"
  exit 1
fi

if [[ ! -f "$MANIFEST" ]]; then
  echo "❌ $MANIFEST not found"
  exit 1
fi

# ─── Read Scala clusters from manifest ─────────────────────────────────────

# Use node to emit one cluster per line as TSV (id, object, entry, file, inputs, multiArgs, fingerprintLevel, watches)
mapfile -t CLUSTER_ROWS < <(node -e "
  const m = JSON.parse(require('fs').readFileSync('$NODE_MANIFEST', 'utf8'));
  let clusters = (m.clusters || []).filter(c => c.stack === 'scala');
  if ('$CLUSTER_FILTER') {
    clusters = clusters.filter(c => c.id === '$CLUSTER_FILTER');
  }
  // Emit one TSV row per cluster, with each field base64-encoded to survive shell quoting
  for (const c of clusters) {
    const fields = [
      c.id || '',
      c.object || '',
      c.entry || '',
      c.file || '',
      JSON.stringify(c.inputs || []),
      String(c.multiArgs === true),
      c.fingerprintLevel || 'entry',
      (c.watches || []).join(', '),
    ];
    console.log(fields.map(f => Buffer.from(f).toString('base64')).join('\t'));
  }
")

if [[ ${#CLUSTER_ROWS[@]} -eq 0 ]]; then
  echo "ℹ️  No Scala clusters found in manifest."
  exit 0
fi

echo ""
if [[ "$MODE" == "capture" ]]; then
  echo "📡 Capturing Scala clusters (${#CLUSTER_ROWS[@]} total)..."
else
  echo "🔍 Validating Scala clusters (${#CLUSTER_ROWS[@]} total)..."
fi
echo ""

# ─── Process each cluster ──────────────────────────────────────────────────

OVERALL_PASS=1
TMPDIR_BASE=$(mktemp -d -t regret-scala-XXXXXX)
trap 'rm -rf "$TMPDIR_BASE"' EXIT

for row in "${CLUSTER_ROWS[@]}"; do
  # Split TSV and base64-decode each field
  IFS=$'\t' read -r B_ID B_OBJECT B_ENTRY B_FILE B_INPUTS B_MULTIARGS B_FP_LEVEL B_WATCHES <<< "$row"
  decode() { echo "$1" | base64 -d; }

  CLUSTER_ID=$(decode "$B_ID")
  CLUSTER_OBJECT=$(decode "$B_OBJECT")
  CLUSTER_ENTRY=$(decode "$B_ENTRY")
  CLUSTER_FILE=$(decode "$B_FILE")
  CLUSTER_INPUTS=$(decode "$B_INPUTS")
  CLUSTER_MULTIARGS=$(decode "$B_MULTIARGS")
  CLUSTER_FP_LEVEL=$(decode "$B_FP_LEVEL")
  CLUSTER_WATCHES=$(decode "$B_WATCHES")

  if [[ -z "$CLUSTER_OBJECT" ]]; then
    echo "❌ Cluster '$CLUSTER_ID' missing required 'object' field (Scala companion object name)"
    OVERALL_PASS=0
    [[ "$FAIL_FAST" == "1" ]] && exit 1
    continue
  fi

  if [[ -z "$CLUSTER_FILE" ]]; then
    echo "❌ Cluster '$CLUSTER_ID' missing required 'file' field (path to .scala source)"
    OVERALL_PASS=0
    [[ "$FAIL_FAST" == "1" ]] && exit 1
    continue
  fi

  SOURCE_PATH="$PROJECT_DIR/$CLUSTER_FILE"
  if [[ ! -f "$SOURCE_PATH" ]]; then
    echo "❌ Cluster '$CLUSTER_ID': source file not found: $SOURCE_PATH"
    OVERALL_PASS=0
    [[ "$FAIL_FAST" == "1" ]] && exit 1
    continue
  fi

  REGRET_FILE="$REGRET_DIR/$CLUSTER_ID.regret"

  echo "  • $CLUSTER_ID"
  echo "    object: $CLUSTER_OBJECT"
  echo "    entry:  $CLUSTER_ENTRY"
  echo "    file:   $CLUSTER_FILE"
  echo "    inputs: $CLUSTER_INPUTS"

  # Per-cluster tmpdir
  TMPDIR_CLUSTER="$TMPDIR_BASE/$(echo "$CLUSTER_ID" | tr -c 'A-Za-z0-9_' '_')"
  mkdir -p "$TMPDIR_CLUSTER"

  # Copy user source so scala-cli can compile everything as one project
  cp "$SOURCE_PATH" "$TMPDIR_CLUSTER/user_source.scala"

  # Build args for harness
  HARNESS_ARGS=(
    "--mode" "$MODE"
    "--cluster" "$CLUSTER_ID"
    "--object" "$CLUSTER_OBJECT"
    "--entry" "$CLUSTER_ENTRY"
    "--inputs" "$CLUSTER_INPUTS"
    "--regret-file" "$REGRET_FILE"
    "--source-file" "$SOURCE_PATH"
    "--fingerprint-level" "$CLUSTER_FP_LEVEL"
    "--watches" "$CLUSTER_WATCHES"
  )
  if [[ "$CLUSTER_MULTIARGS" == "true" ]]; then
    HARNESS_ARGS+=("--multi-args")
  fi

  # Run scala-cli with both source dirs
  if ! (cd "$TMPDIR_CLUSTER" && scala-cli run "$SCRIPT_DIR/scala" "$TMPDIR_CLUSTER/user_source.scala" -- "${HARNESS_ARGS[@]}"); then
    echo "    ❌ $MODE failed for $CLUSTER_ID"
    OVERALL_PASS=0
    [[ "$FAIL_FAST" == "1" ]] && exit 1
    continue
  fi

  if [[ "$MODE" == "capture" ]]; then
    echo "    ✅ Captured: $REGRET_FILE"
  else
    echo "    ✅ Validated: PASS"
  fi
  echo ""
done

if [[ "$OVERALL_PASS" == "1" ]]; then
  echo "✅ All Scala clusters: $MODE succeeded"
  exit 0
else
  echo "❌ Some Scala clusters failed $MODE"
  exit 1
fi

#!/usr/bin/env bash
# capture_dart.sh — capture Dart clusters from regrets/manifest.json
#
# Generates a Dart runner script per cluster that imports the target file,
# invokes the entry function with each declared `inputs[]` value, captures
# the return value as OUTPUT, computes the SHA-256 → base36 → 7-char
# fingerprint (IDENTICAL algorithm to fingerprint.js / fingerprint.py /
# fingerprint.go), and writes a `.regret` file with the standard format:
#
#   cluster: <id>
#   version: 1
#   fingerprint: <7-char>
#   captured: <ISO-8601>
#   watches: [a, b]
#   entry: <fn-name>
#   stack: dart
#   fingerprintLevel: entry
#   ---
#   INPUT  <json>
#   OUTPUT <json>
#   HASH   <7-char>
#
# Usage:
#   bash scripts/capture_dart.sh                    # capture all Dart clusters
#   bash scripts/capture_dart.sh --cluster <id>     # capture one cluster
#   bash scripts/capture_dart.sh --manifest <path>  # override manifest path
#   bash scripts/capture_dart.sh --quiet            # only print summary
#
# Trivial-output guard: null / NaN / throws → skip cluster (matches
# CONTEXT.md "Trivial Input Guard" rule).

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(pwd)"
MANIFEST="${PROJECT_DIR}/regrets/manifest.json"
REGRET_DIR="${PROJECT_DIR}/regrets"

QUIET=0
CLUSTER_FILTER=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --cluster)
      CLUSTER_FILTER="$2"
      shift 2
      ;;
    --manifest)
      MANIFEST="$2"
      shift 2
      ;;
    --quiet)
      QUIET=1
      shift
      ;;
    *)
      echo "Unknown arg: $1" >&2
      exit 1
      ;;
  esac
done

if [[ ! -f "$MANIFEST" ]]; then
  echo "❌ regrets/manifest.json not found at $MANIFEST" >&2
  exit 1
fi

mkdir -p "$REGRET_DIR"

if ! command -v dart &> /dev/null; then
  echo "❌ Dart SDK not found on PATH. Install from https://dart.dev/get-dart" >&2
  exit 1
fi

# Extract Dart clusters via node (manifest is JSON).
CLUSTERS_JSON=$(node -e "
  const fs = require('fs');
  const m = JSON.parse(fs.readFileSync('$MANIFEST', 'utf8'));
  let clusters = (m.clusters || []).filter(c => c.stack === 'dart');
  if ('$CLUSTER_FILTER') {
    clusters = clusters.filter(c => c.id === '$CLUSTER_FILTER');
  }
  console.log(JSON.stringify(clusters));
")

if [[ "$CLUSTERS_JSON" == "[]" ]]; then
  echo "No Dart clusters found in manifest."
  exit 0
fi

COUNT=$(echo "$CLUSTERS_JSON" | node -e "console.log(JSON.parse(require('fs').readFileSync('/dev/stdin','utf8')).length)")
if [[ $QUIET -eq 0 ]]; then
  echo "📡 Capturing $COUNT Dart cluster(s)…"
fi

# Build the helper pub package once (matches validate_dart.sh layout).
TMP_PKG="$(mktemp -d -t regret-dart-XXXXXX)"
trap 'rm -rf "$TMP_PKG"' EXIT

cat > "$TMP_PKG/pubspec.yaml" <<'YAML'
name: regret_dart_runner
environment:
  sdk: ^3.0.0
dependencies:
  crypto: ^3.0.3
YAML

# Copy the fingerprint helper into the package so we can import it by absolute path.
cp "$SCRIPT_DIR/fingerprint_dart.dart" "$TMP_PKG/fingerprint_dart.dart"
FINGERPRINT_HELPER_ABS="$TMP_PKG/fingerprint_dart.dart"

( cd "$TMP_PKG" && dart pub get >/dev/null 2>&1 ) || {
  echo "❌ dart pub get failed in $TMP_PKG" >&2
  exit 1
}

PROCESSED=0
SKIPPED=0

# Iterate clusters via NUL-delimited blobs.
echo "$CLUSTERS_JSON" | node -e "
  const fs = require('fs');
  const clusters = JSON.parse(fs.readFileSync('/dev/stdin', 'utf8'));
  for (const c of clusters) {
    process.stdout.write(JSON.stringify(c) + '\\u0000');
  }
" | while IFS= read -r -d '' cluster_blob; do
  CLUSTER_FILE="$TMP_PKG/cluster.json"
  printf '%s' "$cluster_blob" > "$CLUSTER_FILE"

  RUNNER="$TMP_PKG/capture_runner.dart"
  node "$SCRIPT_DIR/_dart_capture_gen.cjs" "$CLUSTER_FILE" "$RUNNER" "$FINGERPRINT_HELPER_ABS" >&2

  if [[ ! -s "$RUNNER" ]]; then
    echo "❌ Failed to generate runner for cluster" >&2
    continue
  fi

  # Run the capture. Suppress dart's stderr (it's noisy); if the run fails,
  # the JSON output will be empty — we re-run with stderr captured to a log.
  RAW_OUTPUT="$( cd "$TMP_PKG" && dart run --enable-asserts capture_runner.dart 2>/dev/null )" || true
  if [[ -z "$RAW_OUTPUT" ]]; then
    ERR_LOG="$TMP_PKG/dart_err.log"
    ( cd "$TMP_PKG" && dart run --enable-asserts capture_runner.dart 2>"$ERR_LOG" ) || true
    if [[ -s "$ERR_LOG" ]]; then
      echo "❌ Dart runner failed for cluster (see below)" >&2
      head -15 "$ERR_LOG" >&2
      continue
    fi
  fi

  # Write .regret file(s) via node (bash string ops are brittle for JSON).
  printf '%s' "$RAW_OUTPUT" | node -e "
    const fs = require('fs');
    const path = require('path');
    const cluster = JSON.parse(fs.readFileSync('$CLUSTER_FILE', 'utf8'));
    let results;
    try { results = JSON.parse(require('fs').readFileSync('/dev/stdin','utf8')); }
    catch (e) { console.error('Could not parse runner output as JSON: ' + e.message); process.exit(3); }
    if (results.length === 0) {
      console.error('[capture_dart] cluster ' + cluster.id + ': all inputs skipped (trivial output guard).');
      process.exit(0);
    }
    const captured = new Date().toISOString();
    const watches = '[' + (cluster.watches || []).join(', ') + ']';
    for (let i = 0; i < results.length; i++) {
      const r = results[i];
      const regretPath = results.length === 1
        ? path.join('$REGRET_DIR', cluster.id + '.regret')
        : path.join('$REGRET_DIR', cluster.id + '.input' + i + '.regret');
      const lines = [
        'cluster: ' + cluster.id,
        'version: 1',
        'fingerprint: ' + r.hash,
        'captured: ' + captured,
        'watches: ' + watches,
        'entry: ' + cluster.entry,
        'stack: dart',
        'fingerprintLevel: entry',
        '---',
        'INPUT  ' + JSON.stringify(r.input),
        'OUTPUT ' + JSON.stringify(r.output),
        'HASH   ' + r.hash,
      ];
      fs.writeFileSync(regretPath, lines.join('\\n') + '\\n');
      console.log('✅ wrote ' + regretPath + '  (hash=' + r.hash + ')');
    }
  "
  PROCESSED=$((PROCESSED + 1))
done

if [[ $QUIET -eq 0 ]]; then
  echo "🎯 capture_dart: done"
fi

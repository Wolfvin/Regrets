#!/usr/bin/env bash
# capture_dart.sh — capture regret fingerprints for Dart clusters
# Reads regrets/manifest.json, invokes Dart functions, computes fingerprints,
# and writes .regret files.
#
# Usage:
#   bash scripts/capture_dart.sh                         # capture all Dart clusters
#   bash scripts/capture_dart.sh --cluster my-cluster    # capture specific cluster
#   bash scripts/capture_dart.sh --manifest ./path/to/manifest.json

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(pwd)"
MANIFEST="${PROJECT_DIR}/regrets/manifest.json"
REGRET_DIR="${PROJECT_DIR}/regrets"
FINGERPRINT_LIB="${SCRIPT_DIR}/regret_dart/regret_fingerprint.dart"
CLUSTER_FLAG=""

# ─── Parse CLI args ─────────────────────────────────────────────────────────

while [[ $# -gt 0 ]]; do
  case "$1" in
    --cluster)  shift; CLUSTER_FLAG="$1"; shift ;;
    --manifest) shift; MANIFEST="$1"; shift ;;
    *) shift ;;
  esac
done

# ─── Check prerequisites ────────────────────────────────────────────────────

if ! command -v dart &> /dev/null; then
  echo "⚠️  Dart is not installed. Install Dart SDK to use the Dart stack."
  echo "   See: https://dart.dev/get-dart"
  exit 0
fi

if [[ ! -f "$MANIFEST" ]]; then
  echo "❌ Manifest not found at $MANIFEST"
  exit 1
fi

if [[ ! -f "$FINGERPRINT_LIB" ]]; then
  echo "❌ regret_fingerprint.dart not found at $FINGERPRINT_LIB"
  exit 1
fi

# ─── Read Dart clusters from manifest ───────────────────────────────────────

CLUSTER_FLAG_SAFE=$(echo "$CLUSTER_FLAG" | node -e "
  const s = require('fs').readFileSync('/dev/stdin','utf8').trim();
  process.stdout.write(s.replace(/[^a-zA-Z0-9_-]/g,''));
" 2>/dev/null || echo "")

CLUSTERS_JSON=$(node -e "
  const m = JSON.parse(require('fs').readFileSync('$MANIFEST', 'utf8'));
  let clusters = m.clusters.filter(c => c.stack === 'dart');
  if ('$CLUSTER_FLAG_SAFE') {
    clusters = clusters.filter(c => c.id === '$CLUSTER_FLAG_SAFE');
  }
  console.log(JSON.stringify(clusters));
")

if [[ "$CLUSTERS_JSON" == "[]" ]]; then
  echo "No Dart clusters found in manifest."
  exit 0
fi

# Ensure regrets directory exists
mkdir -p "$REGRET_DIR"

# ─── Capture each cluster ───────────────────────────────────────────────────

CAPTURED=0
SKIPPED=0

echo "$CLUSTERS_JSON" | node -e "
  const clusters = JSON.parse(require('fs').readFileSync('/dev/stdin', 'utf8'));
  clusters.forEach(c => process.stdout.write(JSON.stringify(c) + '\n'));
" | while IFS= read -r CLUSTER_LINE; do

  # Extract cluster fields via node
  ID=$(echo "$CLUSTER_LINE" | node -e "process.stdout.write(JSON.parse(require('fs').readFileSync('/dev/stdin','utf8')).id)")
  ENTRY=$(echo "$CLUSTER_LINE" | node -e "process.stdout.write(JSON.parse(require('fs').readFileSync('/dev/stdin','utf8')).entry)")
  FILE=$(echo "$CLUSTER_LINE" | node -e "const c=JSON.parse(require('fs').readFileSync('/dev/stdin','utf8'));process.stdout.write(c.file||'')")
  MULTI_ARGS=$(echo "$CLUSTER_LINE" | node -e "const c=JSON.parse(require('fs').readFileSync('/dev/stdin','utf8'));process.stdout.write(String(c.multiArgs||false))")
  INPUTS=$(echo "$CLUSTER_LINE" | node -e "const c=JSON.parse(require('fs').readFileSync('/dev/stdin','utf8'));process.stdout.write(JSON.stringify(c.inputs||[null]))")
  WATCHES=$(echo "$CLUSTER_LINE" | node -e "const c=JSON.parse(require('fs').readFileSync('/dev/stdin','utf8'));process.stdout.write(JSON.stringify(c.watches||[]))")
  FP_LEVEL=$(echo "$CLUSTER_LINE" | node -e "const c=JSON.parse(require('fs').readFileSync('/dev/stdin','utf8'));process.stdout.write(c.fingerprintLevel||'')")
  # Determine arg count for multiArgs functions (from first input)
  ARG_COUNT=1
  if [[ "$MULTI_ARGS" == "true" ]]; then
    ARG_COUNT=$(echo "$INPUTS" | node -e "
      const inputs = JSON.parse(require('fs').readFileSync('/dev/stdin','utf8'));
      const first = inputs[0];
      process.stdout.write(String(Array.isArray(first) ? first.length : 1));
    ")
  fi

  echo ""
  echo "📡 Capturing: $ID ($ENTRY)"

  if [[ -z "$FILE" ]]; then
    echo "  ⚠️  SKIP: no 'file' field in manifest (Dart requires a file path)"
    SKIPPED=$((SKIPPED + 1))
    continue
  fi

  # Resolve the target file path
  TARGET_FILE="${PROJECT_DIR}/${FILE}"
  if [[ ! -f "$TARGET_FILE" ]]; then
    TARGET_FILE="$FILE"
  fi
  if [[ ! -f "$TARGET_FILE" ]]; then
    echo "  ⚠️  SKIP: file not found: $FILE"
    SKIPPED=$((SKIPPED + 1))
    continue
  fi

  # ─── Generate capture harness ──────────────────────────────────────────

  HARNESS_DIR=$(mktemp -d)
  HARNESS_FILE="${HARNESS_DIR}/capture_harness.dart"
  INPUTS_FILE="${HARNESS_DIR}/inputs.json"
  TARGET_URI=$(readlink -f "$TARGET_FILE")

  # Write inputs to a temp file (avoids shell quoting issues)
  echo "$INPUTS" > "$INPUTS_FILE"

  # Read fingerprint library content (strip imports to avoid duplicates)
  FINGERPRINT_CONTENT=$(cat "$FINGERPRINT_LIB" | sed '/^import /d')

  # Generate the function call code based on multiArgs
  # For multiArgs: each input is a list of positional args → Function.apply
  # For single-arg: direct call with input as argument
  if [[ "$MULTI_ARGS" == "true" ]]; then
    INVOKE_CODE="output = Function.apply(target.${ENTRY}, (input as List).cast<Object?>().toList());"
  else
    INVOKE_CODE="output = target.${ENTRY}(input);"
  fi

  # Generate the Dart harness script
  cat > "$HARNESS_FILE" << DARTCODE
// Auto-generated capture harness — DO NOT EDIT
// Cluster: $ID, Entry: $ENTRY

import 'dart:convert';
import 'dart:io';
import 'dart:typed_data';
import 'file://${TARGET_URI}' as target;

// ─── Embedded fingerprint library ──────────────────────────────────────

${FINGERPRINT_CONTENT}

// ─── Main ──────────────────────────────────────────────────────────────

void main() async {
  final inputsData = await File('${INPUTS_FILE}').readAsString();
  final inputs = jsonDecode(inputsData) as List;

  final results = <Map<String, dynamic>>[];

  for (final input in inputs) {
    try {
      dynamic output;
      ${INVOKE_CODE}

      if (output == null) {
        stderr.writeln('  SKIP input: function returned null');
        continue;
      }

      final fp = fingerprint(input, output);
      results.add({
        'input': input,
        'output': output,
        'fingerprint': fp,
      });
    } catch (e) {
      stderr.writeln('  ERROR invoking ${ENTRY}: \$e');
      continue;
    }
  }

  print('REGRET_RESULTS::' + jsonEncode(results));
}
DARTCODE

  # ─── Run the harness ──────────────────────────────────────────────────

  DART_OUTPUT=$(dart run "$HARNESS_FILE" 2>&1) || {
    echo "  ⚠️  Capture failed for $ID"
    echo "  $DART_OUTPUT"
    rm -rf "$HARNESS_DIR"
    SKIPPED=$((SKIPPED + 1))
    continue
  }

  # ─── Parse results and write .regret file ─────────────────────────────

  RESULTS_LINE=$(echo "$DART_OUTPUT" | grep "^REGRET_RESULTS::" || true)

  if [[ -z "$RESULTS_LINE" ]]; then
    echo "  ⚠️  No results captured for $ID"
    rm -rf "$HARNESS_DIR"
    SKIPPED=$((SKIPPED + 1))
    continue
  fi

  RESULTS_JSON="${RESULTS_LINE#REGRET_RESULTS::}"
  REGRET_FILE="${REGRET_DIR}/${ID}.regret"

  # Write .regret file using node for safe JSON handling
  RESULTS_TEMP="${HARNESS_DIR}/results.json"
  CLUSTER_TEMP="${HARNESS_DIR}/cluster.json"
  echo "$RESULTS_JSON" > "$RESULTS_TEMP"
  echo "$CLUSTER_LINE" > "$CLUSTER_TEMP"

  node -e "
    const fs = require('fs');
    const results = JSON.parse(fs.readFileSync('${RESULTS_TEMP}', 'utf8'));
    const cluster = JSON.parse(fs.readFileSync('${CLUSTER_TEMP}', 'utf8'));
    const captured = new Date().toISOString();

    if (results.length === 0) {
      console.error('  No valid results for cluster ${ID}');
      process.exit(1);
    }

    const primary = results[0];
    const fp = primary.fingerprint;
    const watches = cluster.watches || [];

    let content = '';
    content += 'cluster: ${ID}\n';
    content += 'version: 1\n';
    content += 'fingerprint: ' + fp + '\n';
    content += 'captured: ' + captured + '\n';
    content += 'watches: ' + JSON.stringify(watches) + '\n';
    content += 'entry: ${ENTRY}\n';
    content += 'stack: dart\n';
    content += 'file: ${FILE}\n';
    if (cluster.fingerprintLevel) {
      content += 'fingerprintLevel: ' + cluster.fingerprintLevel + '\n';
    }
    content += '---\n';

    for (const r of results) {
      const inputStr = formatRegretValue(r.input);
      const outputStr = formatRegretValue(r.output);
      content += 'INPUT  ' + inputStr + '\n';
      content += 'OUTPUT ' + outputStr + '\n';
      content += 'HASH   ' + r.fingerprint + '\n';
    }

    fs.writeFileSync('${REGRET_FILE}', content);
    console.log('  Written: ${REGRET_FILE}');
    console.log('  Fingerprint: ' + fp);
    for (const r of results) {
      console.log('    input=' + JSON.stringify(r.input) + ' output=' + JSON.stringify(r.output) + ' hash=' + r.fingerprint);
    }

    function formatRegretValue(v) {
      if (v === null) return 'null';
      if (typeof v === 'string') return v;
      if (typeof v === 'number' || typeof v === 'boolean') return String(v);
      return JSON.stringify(v);
    }
  " || {
    echo "  ⚠️  Failed to write .regret file for $ID"
    rm -rf "$HARNESS_DIR"
    SKIPPED=$((SKIPPED + 1))
    continue
  }

  CAPTURED=$((CAPTURED + 1))
  rm -rf "$HARNESS_DIR"
done

echo ""
echo "✅ Capture complete: $CAPTURED cluster(s) captured, $SKIPPED skipped."

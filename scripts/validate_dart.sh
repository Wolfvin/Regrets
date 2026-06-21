#!/usr/bin/env bash
# validate_dart.sh — validate regret fingerprints for Dart clusters
# Reads .regret files, re-invokes Dart functions, compares fingerprints,
# and reports PASS/FAIL.
#
# Usage:
#   bash scripts/validate_dart.sh                         # validate all Dart clusters
#   bash scripts/validate_dart.sh --cluster my-cluster    # validate specific cluster
#   bash scripts/validate_dart.sh --manifest ./path/to/manifest.json
#   bash scripts/validate_dart.sh --update my-cluster --reason "behavior changed"

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(pwd)"
MANIFEST="${PROJECT_DIR}/regrets/manifest.json"
REGRET_DIR="${PROJECT_DIR}/regrets"
FINGERPRINT_LIB="${SCRIPT_DIR}/regret_dart/regret_fingerprint.dart"
CLUSTER_FLAG=""
UPDATE_TARGET=""
UPDATE_REASON=""

# ─── Parse CLI args ─────────────────────────────────────────────────────────

while [[ $# -gt 0 ]]; do
  case "$1" in
    --cluster)  shift; CLUSTER_FLAG="$1"; shift ;;
    --manifest) shift; MANIFEST="$1"; shift ;;
    --update)   shift; UPDATE_TARGET="$1"; shift ;;
    --reason)   shift; UPDATE_REASON="$1"; shift ;;
    *) shift ;;
  esac
done

# ─── Check prerequisites ────────────────────────────────────────────────────

if ! command -v dart &> /dev/null; then
  echo "⚠️  Dart is not installed. Cannot validate Dart clusters."
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

# ─── Validate --update requires --reason ────────────────────────────────────

if [[ -n "$UPDATE_TARGET" && -z "$UPDATE_REASON" ]]; then
  echo "❌ --update requires --reason"
  echo "   Example: --update my-cluster --reason \"describe why behavior changed\""
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

# ─── Validate each cluster ──────────────────────────────────────────────────

PASSED=0
FAILED=0
SKIPPED=0

echo "$CLUSTERS_JSON" | node -e "
  const clusters = JSON.parse(require('fs').readFileSync('/dev/stdin', 'utf8'));
  clusters.forEach(c => process.stdout.write(JSON.stringify(c) + '\n'));
" | while IFS= read -r CLUSTER_LINE; do

  # Extract cluster fields
  ID=$(echo "$CLUSTER_LINE" | node -e "process.stdout.write(JSON.parse(require('fs').readFileSync('/dev/stdin','utf8')).id)")
  ENTRY=$(echo "$CLUSTER_LINE" | node -e "process.stdout.write(JSON.parse(require('fs').readFileSync('/dev/stdin','utf8')).entry)")
  FILE=$(echo "$CLUSTER_LINE" | node -e "const c=JSON.parse(require('fs').readFileSync('/dev/stdin','utf8'));process.stdout.write(c.file||'')")
  MULTI_ARGS=$(echo "$CLUSTER_LINE" | node -e "const c=JSON.parse(require('fs').readFileSync('/dev/stdin','utf8'));process.stdout.write(String(c.multiArgs||false))")

  echo ""
  echo "🔍 Validating: $ID ($ENTRY)"

  # ─── Read .regret file ────────────────────────────────────────────────

  REGRET_FILE="${REGRET_DIR}/${ID}.regret"

  if [[ ! -f "$REGRET_FILE" ]]; then
    echo "  ❌ FAIL: .regret file not found: $REGRET_FILE"
    FAILED=$((FAILED + 1))
    continue
  fi

  # ─── If --update mode, re-capture ─────────────────────────────────────

  if [[ "$ID" == "$UPDATE_TARGET" ]]; then
    echo "  🔄 UPDATE: re-capturing $ID with reason: $UPDATE_REASON"
    bash "${SCRIPT_DIR}/capture_dart.sh" --cluster "$ID" --manifest "$MANIFEST"
    echo "  ✅ Updated: $ID"
    PASSED=$((PASSED + 1))
    continue
  fi

  # ─── Extract expected hashes from .regret file ────────────────────────

  EXPECTED_HASHES=$(node -e "
    const fs = require('fs');
    const content = fs.readFileSync('${REGRET_FILE}', 'utf8');
    const lines = content.split('\n');
    const hashes = [];
    for (const line of lines) {
      if (line.startsWith('HASH')) {
        hashes.push(line.replace(/^HASH\s+/, '').trim());
      }
    }
    process.stdout.write(JSON.stringify(hashes));
  ")

  # ─── Extract inputs from .regret file ─────────────────────────────────

  INPUTS_JSON=$(node -e "
    const fs = require('fs');
    const content = fs.readFileSync('${REGRET_FILE}', 'utf8');
    const parts = content.split('---');
    if (parts.length < 2) { console.log('[]'); process.exit(0); }
    const body = parts[1].trim();
    const lines = body.split('\n');
    const inputs = [];
    for (const line of lines) {
      if (line.startsWith('INPUT')) {
        const val = line.substring(5).trim();
        try { inputs.push(JSON.parse(val)); } catch(_) { inputs.push(val); }
      }
    }
    console.log(JSON.stringify(inputs));
  ")

  if [[ -z "$FILE" ]]; then
    echo "  ⚠️  SKIP: no 'file' field in manifest"
    SKIPPED=$((SKIPPED + 1))
    continue
  fi

  TARGET_FILE="${PROJECT_DIR}/${FILE}"
  if [[ ! -f "$TARGET_FILE" ]]; then
    TARGET_FILE="$FILE"
  fi
  if [[ ! -f "$TARGET_FILE" ]]; then
    echo "  ⚠️  SKIP: file not found: $FILE"
    SKIPPED=$((SKIPPED + 1))
    continue
  fi

  # ─── Generate validate harness ────────────────────────────────────────

  HARNESS_DIR=$(mktemp -d)
  HARNESS_FILE="${HARNESS_DIR}/validate_harness.dart"
  INPUTS_FILE="${HARNESS_DIR}/inputs.json"
  TARGET_URI=$(readlink -f "$TARGET_FILE")
  FINGERPRINT_CONTENT=$(cat "$FINGERPRINT_LIB" | sed '/^import /d')

  # Write inputs to temp file
  echo "$INPUTS_JSON" > "$INPUTS_FILE"

  # Generate invocation code based on multiArgs
  if [[ "$MULTI_ARGS" == "true" ]]; then
    INVOKE_CODE="output = Function.apply(target.${ENTRY}, (input as List).cast<Object?>().toList());"
  else
    INVOKE_CODE="output = target.${ENTRY}(input);"
  fi

  cat > "$HARNESS_FILE" << DARTCODE
// Auto-generated validate harness — DO NOT EDIT
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
        stderr.writeln('  SKIP: function returned null');
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
    echo "  ❌ FAIL: validation harness failed to run"
    echo "  $DART_OUTPUT"
    rm -rf "$HARNESS_DIR"
    FAILED=$((FAILED + 1))
    continue
  }

  RESULTS_LINE=$(echo "$DART_OUTPUT" | grep "^REGRET_RESULTS::" || true)

  if [[ -z "$RESULTS_LINE" ]]; then
    echo "  ❌ FAIL: no results from validation harness"
    rm -rf "$HARNESS_DIR"
    FAILED=$((FAILED + 1))
    continue
  fi

  RESULTS_JSON="${RESULTS_LINE#REGRET_RESULTS::}"

  # ─── Compare fingerprints ─────────────────────────────────────────────

  RESULTS_TEMP="${HARNESS_DIR}/results.json"
  HASHES_TEMP="${HARNESS_DIR}/hashes.json"
  echo "$RESULTS_JSON" > "$RESULTS_TEMP"
  echo "$EXPECTED_HASHES" > "$HASHES_TEMP"

  VALIDATE_OUTPUT=$(node -e "
    const fs = require('fs');
    const results = JSON.parse(fs.readFileSync('${RESULTS_TEMP}', 'utf8'));
    const expectedHashes = JSON.parse(fs.readFileSync('${HASHES_TEMP}', 'utf8'));

    let allPass = true;

    for (let i = 0; i < results.length; i++) {
      const r = results[i];
      const actualFp = r.fingerprint;
      const expectedHash = i < expectedHashes.length ? expectedHashes[i] : null;

      if (expectedHash === null) {
        console.log('  ⚠️  No expected hash for input #' + i);
        allPass = false;
        continue;
      }

      if (actualFp !== expectedHash) {
        console.log('  ❌ FAIL: input=' + JSON.stringify(r.input) +
          ' expected=' + expectedHash + ' actual=' + actualFp);
        allPass = false;
      } else {
        console.log('  ✅ PASS: input=' + JSON.stringify(r.input) + ' hash=' + actualFp);
      }
    }

    if (allPass) {
      console.log('REGRET_VALIDATE::PASS');
    } else {
      console.log('REGRET_VALIDATE::FAIL');
    }
  ")

  echo "$VALIDATE_OUTPUT"

  if echo "$VALIDATE_OUTPUT" | grep -q "REGRET_VALIDATE::PASS"; then
    PASSED=$((PASSED + 1))
  else
    FAILED=$((FAILED + 1))
  fi

  rm -rf "$HARNESS_DIR"
done

echo ""
if [[ $FAILED -gt 0 ]]; then
  echo "📊 Validation: $PASSED passed, $FAILED failed, $SKIPPED skipped."
  exit 1
else
  echo "📊 Validation: $PASSED passed, $FAILED failed, $SKIPPED skipped."
fi

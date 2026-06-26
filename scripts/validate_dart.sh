#!/usr/bin/env bash
# validate_dart.sh — re-run Dart clusters, compare hash, report PASS/FAIL
#
# Reads `.regret` files for Dart clusters, re-invokes the entry function with
# the recorded INPUT, recomputes the fingerprint, and reports PASS/FAIL with
# a diff (expected vs actual output and hash).
#
# Usage:
#   bash scripts/validate_dart.sh                    # validate all Dart .regret files
#   bash scripts/validate_dart.sh --cluster <id>     # validate one cluster
#   bash scripts/validate_dart.sh --fail-fast        # exit 1 on first FAIL
#   bash scripts/validate_dart.sh --update <id> --reason "..."  # re-capture (legit behavior change)
#   bash scripts/validate_dart.sh --quiet            # only print summary line
#   bash scripts/validate_dart.sh --manifest <path>  # override manifest path

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
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

QUIET=0
FAIL_FAST=0
CLUSTER_FILTER=""
UPDATE_TARGET=""
UPDATE_REASON=""

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
    --fail-fast)
      FAIL_FAST=1
      shift
      ;;
    --quiet)
      QUIET=1
      shift
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
      echo "Unknown arg: $1" >&2
      exit 1
      ;;
  esac
done
NODE_MANIFEST="$(node_path "$MANIFEST")"  # recompute after flag parsing (--manifest/--project may have changed MANIFEST)

if [[ -n "$UPDATE_TARGET" ]]; then
  if [[ -z "$UPDATE_REASON" ]]; then
    echo "❌ --update requires --reason" >&2
    echo "   Example: --update <id> --reason \"describe why behavior changed\"" >&2
    exit 1
  fi
  WORD_COUNT=$(echo "$UPDATE_REASON" | wc -w)
  if [[ $WORD_COUNT -lt 4 ]]; then
    echo "❌ --reason is too vague: \"$UPDATE_REASON\"" >&2
    echo "   Be specific. e.g. \"tax rate updated from 11% to 12% per new regulation\"" >&2
    exit 1
  fi
  if [[ "$UPDATE_TARGET" == *.calls.* ]]; then
    echo "❌ Cannot update callee contract \"$UPDATE_TARGET\" directly." >&2
    echo "   Update the parent instead." >&2
    exit 1
  fi
fi

if [[ ! -f "$MANIFEST" ]]; then
  echo "❌ regrets/manifest.json not found at $MANIFEST" >&2
  exit 1
fi

if ! command -v dart &> /dev/null; then
  echo "❌ Dart SDK not found on PATH. Install from https://dart.dev/get-dart" >&2
  exit 1
fi

# Collect Dart .regret files (recursive).
shopt -s nullglob globstar
REGRET_FILES=()
for f in "$REGRET_DIR"/**/*.regret; do
  # CRLF guard: git core.autocrlf=true (Windows default) rewrites .regret
  # files to CRLF on checkout. The line content becomes "stack: dart\r\n",
  # and grep's `$` anchor matches end-of-line BEFORE the \r, so
  # `^stack: dart$` fails to match `stack: dart\r` — every Dart .regret
  # file gets silently skipped, validate prints "No Dart .regret files
  # found." and exits 0 (silent success on an empty validation set).
  # A breaking refactor would NOT be caught. Stripping \r before grep
  # mirrors the CRLF guard already present in this file at line 162
  # (JS-side `content.replace(/\r\n/g, '\n')`) and in validate_kotlin.sh
  # (per-line `tr -d '\r'`).
  if ! tr -d '\r' < "$f" | grep -q '^stack: dart$'; then
    continue
  fi
  if [[ -n "$CLUSTER_FILTER" ]]; then
    # CRLF guard: same root cause as the stack: filter above —
    # `cluster: snake-case\r` would never equal "$CLUSTER_FILTER"
    # (which is "snake-case"), silently skipping the file under
    # --cluster <id> mode on a CRLF checkout.
    CID=$(grep -m1 '^cluster:' "$f" | sed 's/^cluster: *//' | tr -d '\r')
    if [[ "$CID" != "$CLUSTER_FILTER" ]]; then
      continue
    fi
  fi
  REGRET_FILES+=("$f")
done

if [[ ${#REGRET_FILES[@]} -eq 0 ]]; then
  echo "No Dart .regret files found."
  exit 0
fi

if [[ $QUIET -eq 0 ]]; then
  echo "🔍 Validating ${#REGRET_FILES[@]} Dart regret file(s)…"
fi

TMP_PKG="$(mktemp -d -t regret-dart-validate-XXXXXX)"
trap 'rm -rf "$TMP_PKG"' EXIT

cat > "$TMP_PKG/pubspec.yaml" <<'YAML'
name: regret_dart_validate
environment:
  sdk: ^3.0.0
dependencies:
  crypto: ^3.0.3
YAML

cp "$SCRIPT_DIR/fingerprint_dart.dart" "$TMP_PKG/fingerprint_dart.dart"
FINGERPRINT_HELPER_ABS="$TMP_PKG/fingerprint_dart.dart"

( cd "$TMP_PKG" && dart pub get >/dev/null 2>&1 ) || {
  echo "❌ dart pub get failed in $TMP_PKG" >&2
  exit 1
}

PASS_COUNT=0
FAIL_COUNT=0
UPDATE_COUNT=0

for regret_file in "${REGRET_FILES[@]}"; do
  # Parse the .regret file via node.
  PARSED=$(node -e "
    const fs = require('fs');
    // CRLF -> LF guard: git core.autocrlf=true (Windows default) rewrites
    // .regret files to CRLF on checkout, turning the separator into
    // '\\r\\n---\\r\\n', which the split below would not match otherwise
    // (same root cause as #522).
    const content = fs.readFileSync('$regret_file', 'utf8').replace(/\\r\\n/g, '\\n');
    const [metaSection, dataSection] = content.split('\\n---\\n');
    const meta = {};
    for (const line of metaSection.split('\\n')) {
      const idx = line.indexOf(': ');
      if (idx === -1) continue;
      const key = line.slice(0, idx);
      const val = line.slice(idx + 2).trim();
      if (key === 'watches') meta.watches = val.slice(1, -1).split(', ').filter(Boolean);
      else if (key === 'version') meta.version = Number(val);
      else meta[key] = val;
    }
    const lines = (dataSection || '').split('\\n');
    const inputLine = lines.find(l => l.startsWith('INPUT '));
    const outputLine = lines.find(l => l.startsWith('OUTPUT '));
    const hashLine = lines.find(l => l.startsWith('HASH '));
    let parsedInput = null, parsedOutput = null;
    if (inputLine) {
      const s = inputLine.replace(/^INPUT\\s+/, '');
      try { parsedInput = s === 'undefined' ? undefined : JSON.parse(s); } catch { parsedInput = null; }
    }
    if (outputLine) {
      const s = outputLine.replace(/^OUTPUT\\s+/, '');
      try { parsedOutput = s === 'undefined' ? undefined : JSON.parse(s); } catch { parsedOutput = null; }
    }
    const goldenHash = hashLine ? hashLine.replace(/^HASH\\s+/, '').trim() : null;
    console.log(JSON.stringify({
      cluster_id: meta.cluster,
      entry: meta.entry,
      watches: meta.watches || [],
      input: parsedInput,
      golden_output: parsedOutput,
      golden_hash: goldenHash,
    }));
  ")

  printf '%s' "$PARSED" > "$TMP_PKG/parsed.json"

  # Look up file + multiArgs from manifest for this cluster.
  node -e "
    const fs = require('fs');
    const m = JSON.parse(fs.readFileSync('$NODE_MANIFEST', 'utf8'));
    const parsed = JSON.parse(fs.readFileSync('$TMP_PKG/parsed.json', 'utf8'));
    const c = (m.clusters || []).find(c => c.id === parsed.cluster_id);
    if (!c) {
      console.error('Cluster ' + parsed.cluster_id + ' not found in manifest.');
      process.exit(2);
    }
    fs.writeFileSync('$TMP_PKG/cluster_meta.json', JSON.stringify({
      id: c.id,
      entry: c.entry,
      file: c.file,
      multiArgs: !!c.multiArgs,
      input: parsed.input,
      golden_output: parsed.golden_output,
      golden_hash: parsed.golden_hash,
    }));
  " || continue

  RUNNER="$TMP_PKG/validate_runner.dart"
  node "$SCRIPT_DIR/_dart_validate_gen.cjs" "$TMP_PKG/cluster_meta.json" "$RUNNER" "$FINGERPRINT_HELPER_ABS" >&2

  RAW_OUTPUT="$( cd "$TMP_PKG" && dart run --enable-asserts validate_runner.dart 2>/dev/null )" || true
  EXIT_CODE=${PIPESTATUS[0]:-$?}
  # Re-run with stderr visible only if the first run produced empty output
  # (capture: dart writes nothing to stdout on compile error → empty output).
  if [[ -z "$RAW_OUTPUT" ]]; then
    ERR_LOG="$TMP_PKG/dart_err.log"
    ( cd "$TMP_PKG" && dart run --enable-asserts validate_runner.dart 2>"$ERR_LOG" ) || true
    EXIT_CODE=$?
    if [[ -s "$ERR_LOG" ]]; then
      echo "❌ Dart runner failed for $(basename "$regret_file") (see below)" >&2
      head -10 "$ERR_LOG" >&2
      FAIL_COUNT=$((FAIL_COUNT + 1))
      if [[ $FAIL_FAST -eq 1 ]]; then
        exit 1
      fi
      continue
    fi
  fi

  if [[ $EXIT_CODE -ne 0 ]]; then
    echo "❌ FAIL  $regret_file  (runner exited $EXIT_CODE)" >&2
    FAIL_COUNT=$((FAIL_COUNT + 1))
    if [[ $FAIL_FAST -eq 1 ]]; then
      exit 1
    fi
    continue
  fi

  # Compare hashes.
  RESULT=$(printf '%s' "$RAW_OUTPUT" | node -e "
    const fs = require('fs');
    const cm = JSON.parse(fs.readFileSync('$TMP_PKG/cluster_meta.json', 'utf8'));
    const live = JSON.parse(require('fs').readFileSync(0,'utf8'));
    const pass = (live.hash === cm.golden_hash);
    console.log(JSON.stringify({
      pass: pass,
      cluster: cm.id,
      expected_hash: cm.golden_hash,
      actual_hash: live.hash,
      expected_output: cm.golden_output,
      actual_output: live.output,
      error: live.error,
    }));
  ")

  PASS=$(printf '%s' "$RESULT" | node -e "console.log(JSON.parse(require('fs').readFileSync(0,'utf8')).pass)")

  REGRET_CID=$(printf '%s' "$PARSED" | node -e "console.log(JSON.parse(require('fs').readFileSync(0,'utf8')).cluster_id)")

  if [[ "$PASS" == "true" ]]; then
    if [[ $QUIET -eq 0 ]]; then
      HASH_VAL=$(printf '%s' "$RESULT" | node -e "console.log(JSON.parse(require('fs').readFileSync(0,'utf8')).actual_hash)")
      echo "✅ PASS  $(basename "$regret_file")  hash=$HASH_VAL"
    fi
    PASS_COUNT=$((PASS_COUNT + 1))
  else
    # If --update is set and matches this cluster, re-capture instead of failing.
    if [[ -n "$UPDATE_TARGET" && "$UPDATE_TARGET" == "$REGRET_CID" ]]; then
      if [[ $QUIET -eq 0 ]]; then
        echo "♻️  --update $UPDATE_TARGET: re-capturing (reason: $UPDATE_REASON)"
      fi
      bash "$SCRIPT_DIR/capture_dart.sh" --cluster "$UPDATE_TARGET" --quiet
      UPDATE_COUNT=$((UPDATE_COUNT + 1))
      AUDIT_LOG="$REGRET_DIR/audit.log"
      {
        echo "$(date -Iseconds) UPDATE cluster=$UPDATE_TARGET reason=\"$UPDATE_REASON\" by=validate_dart.sh"
      } >> "$AUDIT_LOG"
    else
      echo "❌ FAIL  $(basename "$regret_file")" >&2
      printf '%s' "$RESULT" | node -e "
        const r = JSON.parse(require('fs').readFileSync(0,'utf8'));
        console.error('   cluster:        ' + r.cluster);
        console.error('   expected hash:  ' + r.expected_hash);
        console.error('   actual hash:    ' + r.actual_hash);
        console.error('   expected out:   ' + JSON.stringify(r.expected_output));
        console.error('   actual out:     ' + JSON.stringify(r.actual_output));
        if (r.error) console.error('   error:          ' + r.error);
      " >&2
      FAIL_COUNT=$((FAIL_COUNT + 1))
      if [[ $FAIL_FAST -eq 1 ]]; then
        exit 1
      fi
    fi
  fi
done

if [[ $QUIET -eq 0 ]]; then
  echo ""
  echo "📊 Dart validate: $PASS_COUNT passed, $FAIL_COUNT failed, $UPDATE_COUNT updated"
fi

if [[ $FAIL_COUNT -gt 0 ]]; then
  exit 1
fi
exit 0

#!/usr/bin/env bash
# verify_css_stack.sh — one-command end-to-end verifier for the CSS stack.
#
# Runs the full capture → validate cycle against the bundled fixture
# (proofs/css_demo) and asserts:
#   1. capture writes .regret files for all 4 clusters
#   2. validate (no code change) exits 0, prints PASS for all clusters
#   3. validate (breaking change to .cue-enter opacity) exits non-zero, FAIL
#   4. validate (comment-only change — non-breaking) exits 0, PASS
#   5. --cluster filter isolates a single cluster
#   6. cross-stack parity: CSS HASH === JS fingerprint() for the same I/O
#      (regression test for the 64-bit → 256-bit fingerprint fix)
#   7. @media declarations ARE captured (regression test for docs accuracy)
#
# Self-contained — no setup needed beyond Node.js + npm install.
# Skips with exit 77 if postcss is not installed.
#
# Usage:
#   bash scripts/verify_css_stack.sh
#   bash scripts/verify_css_stack.sh --quiet    # only print final summary
#
# Exits 0 if all checks pass, non-zero otherwise.

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SKILL_DIR="$(dirname "$SCRIPT_DIR")"
FIXTURE="$SKILL_DIR/proofs/css_demo"
DEMO_CSS="$FIXTURE/demo.css"

QUIET=0
if [[ "${1:-}" == "--quiet" ]]; then
  QUIET=1
fi

log() {
  if [[ "$QUIET" -eq 0 ]]; then
    echo "$@"
  fi
}

PASS_COUNT=0
FAIL_COUNT=0
record_pass() { PASS_COUNT=$((PASS_COUNT + 1)); }
record_fail() { FAIL_COUNT=$((FAIL_COUNT + 1)); }

# ─── Preflight: postcss must be installed ────────────────────────────────────
if ! node -e "require.resolve('postcss')" 2>/dev/null; then
  echo "⚠️  postcss is not installed. Run 'npm install' in the project root."
  echo "   Skipping verify_css_stack.sh."
  exit 77  # standard "skip" exit code
fi

log "ℹ️  Using: $(node --version) + postcss $(node -e "console.log(require('postcss/package.json').version)")"
log ""

# Backup demo.css so we can mutate + restore
cp "$DEMO_CSS" /tmp/demo.css.verify-backup

# ─── 1. capture — write .regret files for all 4 clusters ────────────────────
log "─── 1. capture — write .regret files for all 4 CSS clusters ───"

# Clean slate: remove .regret files so we know capture wrote them
rm -f "$FIXTURE/regrets/"*.regret

CAPTURE_OUT=$(node "$SCRIPT_DIR/capture_css.mjs" --manifest "$FIXTURE/regrets/manifest.json" 2>&1)
CAPTURE_EXIT=$?

if [[ $CAPTURE_EXIT -ne 0 ]]; then
  echo "❌ FAIL: capture_css.mjs exited $CAPTURE_EXIT"
  echo "$CAPTURE_OUT" | tail -20
  record_fail
else
  # Count .regret files written
  REGRET_COUNT=$(ls "$FIXTURE/regrets/"*.regret 2>/dev/null | wc -l)
  if [[ $REGRET_COUNT -eq 4 ]]; then
    log "  ✅ PASS: $REGRET_COUNT .regret files written (expected 4)"
    record_pass
  else
    echo "❌ FAIL: expected 4 .regret files, got $REGRET_COUNT"
    record_fail
  fi

  # Verify required fields present in each .regret file
  REQUIRED_FIELDS="cluster version fingerprint captured INPUT OUTPUT HASH"
  ALL_FIELDS_OK=1
  for f in "$FIXTURE/regrets/"*.regret; do
    for field in $REQUIRED_FIELDS; do
      if ! grep -q "^${field}" "$f" 2>/dev/null; then
        echo "❌ FAIL: $f missing field '$field'"
        ALL_FIELDS_OK=0
        break
      fi
    done
  done
  if [[ $ALL_FIELDS_OK -eq 1 ]]; then
    log "  ✅ PASS: all required fields present in all .regret files"
    record_pass
  else
    record_fail
  fi
fi
log ""

# ─── 2. validate (no code change) — exit 0, PASS ─────────────────────────────
log "─── 2. validate (no code change) — exit 0, PASS ───"

VALOUT=$(node "$SCRIPT_DIR/validate_css.mjs" --manifest "$FIXTURE/regrets/manifest.json" 2>&1)
VALEXIT=$?

if [[ $VALEXIT -eq 0 ]] && echo "$VALOUT" | grep -q "4/4 CSS clusters passed"; then
  log "  ✅ PASS: validate (no change) prints PASS for all 4 clusters, exit 0"
  record_pass
else
  echo "❌ FAIL: validate (no change) did not produce expected PASS (exit=$VALEXIT)"
  echo "$VALOUT" | tail -20
  record_fail
fi
log ""

# ─── 3. breaking change — validate exit non-zero, FAIL ───────────────────────
log "─── 3. breaking change (.cue-enter opacity 0 → 0.5) — validate exit non-zero, FAIL ───"

cp "$DEMO_CSS" /tmp/demo.css.pre-break
sed -i 's/opacity: 0;/opacity: 0.5;/' "$DEMO_CSS"

BREAKOUT=$(node "$SCRIPT_DIR/validate_css.mjs" --manifest "$FIXTURE/regrets/manifest.json" 2>&1)
BREAKEXIT=$?

# Restore immediately
cp /tmp/demo.css.pre-break "$DEMO_CSS"

if [[ $BREAKEXIT -ne 0 ]] && echo "$BREAKOUT" | grep -qE "FAIL.*cue-enter|cue-enter.*FAIL"; then
  log "  ✅ PASS: breaking change detected (FAIL cue-enter, exit non-zero)"
  record_pass
else
  echo "❌ FAIL: breaking change not detected (exit=$BREAKEXIT)"
  echo "$BREAKOUT" | tail -20
  record_fail
fi
log ""

# ─── 4. valid refactor (comment-only change) — exit 0, PASS ──────────────────
log "─── 4. valid refactor (add comment — no declaration changes) — exit 0, PASS ───"

cp "$DEMO_CSS" /tmp/demo.css.pre-comment
sed -i '1i\/* Updated 2026-06-21: regression test comment *\n' "$DEMO_CSS"

REFACTOROUT=$(node "$SCRIPT_DIR/validate_css.mjs" --manifest "$FIXTURE/regrets/manifest.json" 2>&1)
REFACTOREXIT=$?

# Restore immediately
cp /tmp/demo.css.pre-comment "$DEMO_CSS"

if [[ $REFACTOREXIT -eq 0 ]] && echo "$REFACTOROUT" | grep -q "4/4 CSS clusters passed"; then
  log "  ✅ PASS: comment-only change accepted (PASS, exit 0)"
  record_pass
else
  echo "❌ FAIL: comment-only change was rejected (exit=$REFACTOREXIT)"
  echo "$REFACTOROUT" | tail -20
  record_fail
fi
log ""

# ─── 5. --cluster filter isolates a single cluster ───────────────────────────
log "─── 5. --cluster filter isolates a single cluster ───"

FILTER_OUT=$(node "$SCRIPT_DIR/validate_css.mjs" --manifest "$FIXTURE/regrets/manifest.json" --cluster cue-enter 2>&1)
FILTER_EXIT=$?

if [[ $FILTER_EXIT -eq 0 ]] && echo "$FILTER_OUT" | grep -q "1/1 CSS clusters passed"; then
  log "  ✅ PASS: --cluster cue-enter isolates 1 cluster"
  record_pass
else
  echo "❌ FAIL: --cluster filter did not isolate 1 cluster (exit=$FILTER_EXIT)"
  echo "$FILTER_OUT" | tail -10
  record_fail
fi
log ""

# ─── 6. cross-stack parity — CSS HASH matches JS fingerprint() ───────────────
log "─── 6. cross-stack parity — CSS HASH matches JS fingerprint() (regression for 64-bit bug) ───"

PARITY_OUT=$(node --input-type=module -e "
import { fingerprint as jsFingerprint } from '$SKILL_DIR/scripts/fingerprint.js';
import { readFileSync } from 'fs';

const regretFiles = [
  '$FIXTURE/regrets/cue-enter.regret',
  '$FIXTURE/regrets/cue-hover-lift.regret',
  '$FIXTURE/regrets/cue-spinner.regret',
  '$FIXTURE/regrets/cue-enter-active.regret',
];
let all_match = true;
for (const path of regretFiles) {
  const content = readFileSync(path, 'utf8');
  const lines = content.split('\n');
  const sepIdx = lines.findIndex(l => l.trim() === '---');
  const dataLines = lines.slice(sepIdx + 1);
  let input = null, output = null, hash = null;
  for (const line of dataLines) {
    if (line.startsWith('INPUT ')) input = JSON.parse(line.substring(6));
    else if (line.startsWith('OUTPUT ')) output = JSON.parse(line.substring(7));
    else if (line.startsWith('HASH ')) hash = line.substring(5).trim();
  }
  const jsHash = jsFingerprint(input, output);
  const match = jsHash === hash;
  if (!match) all_match = false;
  console.log('  ' + path.split('/').pop() + ': CSS=' + hash + ' JS=' + jsHash + ' ' + (match ? '✅' : '❌'));
}
console.log(all_match ? 'ALL_MATCH' : 'MISMATCH');
" 2>&1)

if echo "$PARITY_OUT" | grep -q "ALL_MATCH"; then
  log "$PARITY_OUT"
  log "  ✅ PASS: CSS HASH === JS fingerprint() for all 4 clusters (was bug: 64-bit truncation)"
  record_pass
else
  echo "❌ FAIL: cross-stack parity mismatch (regression: 64-bit fingerprint bug is back)"
  echo "$PARITY_OUT"
  record_fail
fi
log ""

# ─── 7. @media declarations ARE captured (docs accuracy regression) ──────────
log "─── 7. @media declarations ARE captured (docs accuracy) ───"

MEDIA_TMP=$(mktemp -d)
cat > "$MEDIA_TMP/test.css" << 'EOF'
.foo {
  color: red;
}
@media (max-width: 600px) {
  .foo {
    color: blue;
  }
}
EOF
cat > "$MEDIA_TMP/manifest.json" << 'EOF'
{
  "clusters": [
    { "id": "foo", "entry": ".foo", "file": "test.css", "stack": "css" }
  ]
}
EOF

# Capture
node "$SCRIPT_DIR/capture_css.mjs" --manifest "$MEDIA_TMP/manifest.json" --quiet 2>&1
CAPTURE_MEDIA_OUT=$(cat "$MEDIA_TMP/foo.regret")

# Should have both "color: red" AND "color: blue" in OUTPUT
if echo "$CAPTURE_MEDIA_OUT" | grep -q "color: red" && echo "$CAPTURE_MEDIA_OUT" | grep -q "color: blue"; then
  log "  ✅ PASS: @media declarations ARE captured (color: red + color: blue both in OUTPUT)"
  record_pass
else
  echo "❌ FAIL: @media declarations NOT captured (docs say 'ignored', but actual behavior should capture them)"
  echo "$CAPTURE_MEDIA_OUT" | tail -10
  record_fail
fi

# Now: change .foo inside @media only — should FAIL
cat > "$MEDIA_TMP/test.css" << 'EOF'
.foo {
  color: red;
}
@media (max-width: 600px) {
  .foo {
    color: green;
  }
}
EOF

MEDIA_VAL_OUT=$(node "$SCRIPT_DIR/validate_css.mjs" --manifest "$MEDIA_TMP/manifest.json" 2>&1)
MEDIA_VAL_EXIT=$?

if [[ $MEDIA_VAL_EXIT -ne 0 ]] && echo "$MEDIA_VAL_OUT" | grep -q "FAIL"; then
  log "  ✅ PASS: change to @media-only declaration is detected as FAIL"
  record_pass
else
  echo "❌ FAIL: change to @media-only declaration was not detected (exit=$MEDIA_VAL_EXIT)"
  echo "$MEDIA_VAL_OUT" | tail -10
  record_fail
fi

rm -rf "$MEDIA_TMP"
log ""

# ─── Summary ─────────────────────────────────────────────────────────────────
echo ""
echo "═══════════════════════════════════════════════════════════════"
echo "  CSS stack verification: $PASS_COUNT passed, $FAIL_COUNT failed"
echo "═══════════════════════════════════════════════════════════════"
echo ""

# Restore demo.css (idempotent)
cp /tmp/demo.css.verify-backup "$DEMO_CSS" 2>/dev/null || true
rm -f /tmp/demo.css.verify-backup /tmp/demo.css.pre-break /tmp/demo.css.pre-comment

if [[ $FAIL_COUNT -eq 0 ]]; then
  exit 0
else
  exit 1
fi

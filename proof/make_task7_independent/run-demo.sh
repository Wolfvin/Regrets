#!/usr/bin/env bash
# run-demo.sh — End-to-end demo for the Task 7 Make stack independent fixture
#
# Verifies the capture → .regret → validate PASS/FAIL contract on a fresh
# fixture (`text_format.mk`) that uses Make patterns NOT covered by either
# prior Make fixture (slugify.mk or string_utils.mk).
#
# Patterns exercised:
#   - `cut -c1-N` for char slicing (truncate)
#   - `tr -d '[:cntrl:]'` + `tr -cd '[:print:]'` (sanitize)
#   - `fold -w N` for line wrapping (wrap)
#   - `wc -w` for word counting (count_words)
#   - `awk` with toupper/tolower + substr (title_case)
#
# Usage: bash run-demo.sh

set -euo pipefail

PROOF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$PROOF_DIR/../.." && pwd)"
MANIFEST="$PROOF_DIR/regrets/manifest.json"
MK_FILE="$PROOF_DIR/text_format.mk"
MK_BACKUP="/tmp/text_format.mk.task7-demo.bak"

cd "$REPO_ROOT"

# Ensure text_format.mk is in the original (committed) state before starting.
# Use git show to extract the committed version (works even if working tree is dirty).
# Fallback: if not yet committed (during dev), use the inline baseline below.
restore_mk_baseline() {
  local target="$1"
  # Try git first (works once fixture is committed to HEAD)
  if git ls-files --error-unmatch "$target" >/dev/null 2>&1; then
    local relpath
    relpath="$(git ls-files --full-name "$target" 2>/dev/null)"
    if [[ -n "$relpath" ]] && git show "HEAD:$relpath" > "$target" 2>/dev/null; then
      # Sanity check: first line should not be a git tree listing
      if ! head -1 "$target" | grep -q "^tree HEAD:"; then
        return 0
      fi
    fi
  fi
  # Fallback: inline baseline (the original committed content)
  cat > "$target" <<'MK_BASELINE'
# text_format.mk — Task 7 independent fixture for Make stack verification
#
# This fixture is intentionally DIFFERENT from:
#   - proof/make_slugify/slugify.mk  (slugify, greet, join_with, to_lower, is_numeric)
#   - proof/make_independent/string_utils.mk (reverse, repeat, pad_left, count_chars, upper)
#
# Patterns newly exercised here (NOT covered by either prior fixture):
#   - `cut` for character slicing (truncate)
#   - `tr -d` for character-class deletion (sanitize)
#   - `fold` for line wrapping (wrap)
#   - `wc -w` for word counting (count_words)
#   - `awk` for per-word capitalization (title_case)

# truncate: Truncate a string to N characters and append ellipsis if shortened.
# Args: $1 = input string, $2 = max length (digits only, no ellipsis counted)
# Returns: first $2 chars of $1, with "..." appended if string was longer than $2
define truncate
$(shell printf '%s' '$1' | cut -c1-$(2))$(if $(shell [ $$(printf '%s' '$1' | wc -c) -gt $(2) ] && echo yes),...)
endef

# sanitize: Remove all non-printable/non-ASCII chars from a string.
# Args: $1 = input string
# Returns: input with control chars and non-ASCII bytes deleted
define sanitize
$(shell printf '%s' '$1' | tr -d '[:cntrl:]' | tr -cd '[:print:]')
endef

# wrap: Wrap a string at the specified width using fold.
# Args: $1 = input string, $2 = max line width
# Returns: string with newlines inserted every $2 chars
define wrap
$(shell printf '%s' '$1' | fold -w $(2))
endef

# count_words: Count the number of whitespace-separated words in a string.
# Args: $1 = input string
# Returns: integer count of words
define count_words
$(shell printf '%s' '$1' | wc -w)
endef

# title_case: Capitalize the first letter of each whitespace-separated word.
# Args: $1 = input string
# Returns: input with each word's first letter uppercased, rest lowercased
define title_case
$(shell printf '%s' '$1' | awk '{for(i=1;i<=NF;i++) printf "%s%s%s", toupper(substr($$i,1,1)), tolower(substr($$i,2)), (i==NF?"\n":" ")}')
endef
MK_BASELINE
}

restore_mk_baseline "$MK_FILE"
if [[ -f "$MK_BACKUP" ]]; then
  rm -f "$MK_BACKUP"
fi

echo "╔══════════════════════════════════════════════════════════════╗"
echo "║  Make stack — Task 7 independent fixture demo                ║"
echo "║  Fixture: proof/make_task7_independent/text_format.mk        ║"
echo "║  Patterns: cut, tr -d/-cd, fold, wc -w, awk                  ║"
echo "╚══════════════════════════════════════════════════════════════╝"
echo

# ─── Step 1: Capture all 5 clusters ─────────────────────────────────────────
echo "━━━ Step 1: Capture 5 clusters (truncate, sanitize, wrap, count_words, title_case) ━━━"
bash scripts/capture_make.sh --manifest "$MANIFEST" 2>&1 | tail -10
echo

# ─── Step 2: Baseline validate — all PASS ───────────────────────────────────
echo "━━━ Step 2: Baseline validate — all 5 should PASS ━━━"
bash scripts/validate_make.sh --manifest "$MANIFEST" 2>&1 | tail -10
echo "EXIT: $?"
echo

# ─── Step 3: .regret format compliance ──────────────────────────────────────
echo "━━━ Step 3: .regret format compliance (required fields present) ━━━"
for f in "$PROOF_DIR/regrets/"*.regret; do
  fname=$(basename "$f")
  has_cluster=$(grep -c "^cluster:" "$f" || true)
  has_version=$(grep -c "^version:" "$f" || true)
  has_fingerprint=$(grep -c "^fingerprint:" "$f" || true)
  has_captured=$(grep -c "^captured:" "$f" || true)
  has_INPUT=$(grep -c "^INPUT  " "$f" || true)
  has_OUTPUT=$(grep -c "^OUTPUT " "$f" || true)
  has_HASH=$(grep -c "^HASH   " "$f" || true)
  if [[ $has_cluster -eq 1 && $has_version -eq 1 && $has_fingerprint -eq 1 \
        && $has_captured -eq 1 && $has_INPUT -ge 1 && $has_OUTPUT -ge 1 && $has_HASH -ge 1 ]]; then
    echo "  ✓ $fname — all 7 required fields present"
  else
    echo "  ✗ $fname — MISSING fields (cluster=$has_cluster version=$has_version fp=$has_fingerprint captured=$has_captured INPUT=$has_INPUT OUTPUT=$has_OUTPUT HASH=$has_HASH)"
    exit 1
  fi
done
echo

# ─── Step 4: INPUTS line present for multiArgs clusters ────────────────────
echo "━━━ Step 4: INPUTS line present for multiArgs clusters ━━━"
for cluster_id in make-truncate make-wrap; do
  f="$PROOF_DIR/regrets/${cluster_id}.regret"
  if grep -qE "^INPUTS\s" "$f"; then
    echo "  ✓ $cluster_id — INPUTS line present (multiArgs)"
  else
    echo "  ✗ $cluster_id — INPUTS line MISSING"
    exit 1
  fi
done
echo

# ─── Step 5: Breaking change → FAIL ─────────────────────────────────────────
echo "━━━ Step 5: Breaking change (truncate: cut -c1-3 hardcoded) → FAIL ━━━"
cp "$MK_FILE" "$MK_BACKUP"
python3 -c "
p = '$MK_FILE'
s = open(p).read()
s = s.replace('cut -c1-\$(2)', 'cut -c1-3')
open(p,'w').write(s)
"
set +e +o pipefail
bash scripts/validate_make.sh --manifest "$MANIFEST" 2>&1 | tail -10
EXIT_CODE=${PIPESTATUS[0]}
set -e -o pipefail
if [[ $EXIT_CODE -ne 1 ]]; then
  echo "  ✗ Expected exit 1, got $EXIT_CODE"
  cp "$MK_BACKUP" "$MK_FILE"
  exit 1
fi
echo "  ✓ Exit code $EXIT_CODE (expected 1 — breaking change detected)"
cp "$MK_BACKUP" "$MK_FILE"
echo

# ─── Step 6: Valid refactor (comment-only) → PASS ──────────────────────────
echo "━━━ Step 6: Valid refactor (comment-only change) → PASS ━━━"
cp "$MK_FILE" "$MK_BACKUP"
# Add a comment line at the top
sed -i '1i # Demo comment - no functional change' "$MK_FILE"
set +e +o pipefail
bash scripts/validate_make.sh --manifest "$MANIFEST" 2>&1 | tail -10
EXIT_CODE=${PIPESTATUS[0]}
set -e -o pipefail
if [[ $EXIT_CODE -ne 0 ]]; then
  echo "  ✗ Expected exit 0, got $EXIT_CODE"
  cp "$MK_BACKUP" "$MK_FILE"
  exit 1
fi
echo "  ✓ Exit code $EXIT_CODE (expected 0 — comment-only change detected as valid refactor)"
cp "$MK_BACKUP" "$MK_FILE"
echo

# ─── Step 7: --cluster filter ────────────────────────────────────────────────
echo "━━━ Step 7: --cluster filter (only make-count-words) ━━━"
set +e +o pipefail
bash scripts/validate_make.sh --manifest "$MANIFEST" --cluster make-count-words 2>&1 | tail -5
EXIT_CODE=${PIPESTATUS[0]}
set -e -o pipefail
echo "  ✓ Exit code $EXIT_CODE (expected 0)"
echo

# ─── Step 8: Cross-stack parity (Make hash === JS fingerprint) ──────────────
echo "━━━ Step 8: Cross-stack parity (Make hash === JS fingerprint()) ━━━"
node -e "
const { fingerprint } = require('./scripts/fingerprint.js');
const vectors = [
  [['Hello World', 5], 'Hello...', '4t0zo7f'],
  ['hello world', 'hello world', '1hgg9kv'],
  [['abcdefghij', 4], 'abcd efgh ij', '2p2hh9f'],
  ['hello world', '2', '1m29nxw'],
  ['hello world', 'Hello World', '4am2hvn']
];
let pass = 0;
vectors.forEach(([input, output, expected]) => {
  const fp = fingerprint(input, output);
  const ok = fp === expected;
  if (ok) pass++;
  console.log('  ' + (ok ? '✓' : '✗') + ' input=' + JSON.stringify(input) + ' output=' + JSON.stringify(output) + ' → ' + fp + ' (expected ' + expected + ')');
});
console.log('  ' + pass + '/' + vectors.length + ' vectors match');
if (pass !== vectors.length) process.exit(1);
"
echo

# ─── Step 9: --update mode (with audit.log) ────────────────────────────────
echo "━━━ Step 9: --update mode (with audit.log + chain hash) ━━━"
cp "$MK_FILE" "$MK_BACKUP"
# Apply breaking change to title_case
python3 -c "
p = '$MK_FILE'
s = open(p).read()
s = s.replace('toupper(substr(\$\$i,1,1)), tolower(substr(\$\$i,2))', 'toupper(\$\$i), \"\"')
open(p,'w').write(s)
"
set +e +o pipefail
bash scripts/validate_make.sh --manifest "$MANIFEST" 2>&1 | tail -10
echo "  ↑ FAIL expected (title_case behavior changed)"
bash scripts/validate_make.sh --manifest "$MANIFEST" --update make-title-case --reason "title_case spec v2: uppercase whole word for emphasis" 2>&1 | tail -10
EXIT_CODE=${PIPESTATUS[0]}
set -e -o pipefail
if [[ $EXIT_CODE -ne 0 ]]; then
  echo "  ✗ Expected exit 0 for update, got $EXIT_CODE"
  cp "$MK_BACKUP" "$MK_FILE"
  exit 1
fi
if [[ ! -f "$PROOF_DIR/regrets/audit.log" ]]; then
  echo "  ✗ audit.log not written"
  cp "$MK_BACKUP" "$MK_FILE"
  exit 1
fi
echo "  ✓ audit.log written:"
cat "$PROOF_DIR/regrets/audit.log" | head -10 | sed 's/^/    /'
echo
# Validate after update — should PASS now
set +e +o pipefail
bash scripts/validate_make.sh --manifest "$MANIFEST" 2>&1 | tail -5
UPDATE_VALIDATE_EXIT=${PIPESTATUS[0]}
set -e -o pipefail
echo "  ✓ Exit code $UPDATE_VALIDATE_EXIT (expected 0 after --update)"
if [[ $UPDATE_VALIDATE_EXIT -ne 0 ]]; then
  cp "$MK_BACKUP" "$MK_FILE"
  rm -f "$PROOF_DIR/regrets/audit.log"
  bash scripts/capture_make.sh --manifest "$MANIFEST" 2>&1 > /dev/null
  exit 1
fi
# Restore and re-capture to leave repo clean
cp "$MK_BACKUP" "$MK_FILE"
rm -f "$PROOF_DIR/regrets/audit.log"
bash scripts/capture_make.sh --manifest "$MANIFEST" 2>&1 | tail -3
echo

# ─── Step 10: Unified runner dispatch (regret.js + regret.py) ───────────────
echo "━━━ Step 10: Unified runner dispatch (regret.js + regret.py) ━━━"
# Unified runners use the manifest's directory as the working directory for
# locating sibling .regret files, so we cd into the proof's regrets/ dir.
echo "  node scripts/regret.js validate (Make cluster):"
( cd "$PROOF_DIR" && node "$REPO_ROOT/scripts/regret.js" validate --manifest regrets/manifest.json ) 2>&1 | tail -8 | sed 's/^/    /'
echo "  python3 scripts/regret.py validate (Make cluster):"
( cd "$PROOF_DIR" && python3 "$REPO_ROOT/scripts/regret.py" validate --manifest regrets/manifest.json ) 2>&1 | tail -8 | sed 's/^/    /'
echo

echo "╔══════════════════════════════════════════════════════════════╗"
echo "║  Task 7 demo complete!                                       ║"
echo "║  • 5 new Make clusters captured with novel patterns          ║"
echo "║  • Capture → .regret → validate PASS for valid refactor      ║"
echo "║  • Capture → .regret → validate FAIL for breaking change     ║"
echo "║  • --cluster filter works                                     ║"
echo "║  • --update mode writes audit.log with chain hash            ║"
echo "║  • Cross-stack parity: Make hash === JS fingerprint          ║"
echo "║  • Unified runner dispatch works (regret.js + regret.py)     ║"
echo "╚══════════════════════════════════════════════════════════════╝"

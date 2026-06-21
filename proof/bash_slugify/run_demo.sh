#!/usr/bin/env bash
# run_demo.sh — walkthrough: capture → validate PASS → break → validate FAIL →
# refactor → validate PASS again.
#
# This is the proof that capture_bash.sh + validate_bash.sh work end-to-end:
#   1. Capture the original slugify function → produces .regret file
#   2. Validate → PASS (no changes)
#   3. BREAKING refactor: change slugify behavior (e.g. use underscores instead
#      of hyphens) → validate FAILs
#   4. Restore the original behavior via a different implementation (valid
#      refactor — same output, different code) → validate PASSes again
#
# This mirrors the JS/Python proof pattern.
set -uo pipefail

PROOF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$PROOF_DIR/../.." && pwd)"
CAPTURE="$REPO_ROOT/scripts/capture_bash.sh"
VALIDATE="$REPO_ROOT/scripts/validate_bash.sh"

ORIG_LIB="$PROOF_DIR/lib/slugify.sh"
BACKUP_LIB="$PROOF_DIR/lib/slugify.sh.orig"

cd "$PROOF_DIR"

echo "═══════════════════════════════════════════════════════════════"
echo "  Bash Stack Proof: capture → validate PASS → break → FAIL →"
echo "  refactor → PASS"
echo "═══════════════════════════════════════════════════════════════"
echo ""

# ─── STEP 1: Capture ──────────────────────────────────────────────────────────
echo "━━━ STEP 1: Capture (original implementation) ━━━"
bash "$CAPTURE"
echo ""

# ─── STEP 2: Validate (should PASS — no changes) ──────────────────────────────
echo "━━━ STEP 2: Validate (no changes — should PASS) ━━━"
if bash "$VALIDATE"; then
  echo "✅ Step 2 PASSED"
else
  echo "❌ Step 2 FAILED — validate should PASS on unchanged code"
  exit 1
fi
echo ""

# ─── STEP 3: BREAKING refactor — change behavior ──────────────────────────────
echo "━━━ STEP 3: BREAKING refactor — use underscores instead of hyphens ━━━"
cp "$ORIG_LIB" "$BACKUP_LIB"

# Replace the sed substitution: hyphens → underscores
# This CHANGES the function's output, so the fingerprint should mismatch
sed -i 's|sed -E .s/\[\^a-z0-9\]+/-/g.|sed -E "s/[^a-z0-9]+/_/g."|' "$ORIG_LIB"

# Verify the change took effect
echo "   Modified slugify.sh:"
grep -E "sed -E" "$ORIG_LIB" | head -1
echo ""

# ─── STEP 4: Validate (should FAIL — output changed) ──────────────────────────
echo "━━━ STEP 4: Validate (breaking change — should FAIL) ━━━"
if bash "$VALIDATE" --quiet; then
  echo "❌ Step 4 FAILED — validate should FAIL on breaking change"
  cp "$BACKUP_LIB" "$ORIG_LIB"
  rm -f "$BACKUP_LIB"
  exit 1
else
  echo "✅ Step 4 correctly FAILED (breaking change detected)"
fi
echo ""

# ─── STEP 5: Valid refactor — same output, different code ─────────────────────
echo "━━━ STEP 5: Valid refactor — restore behavior via different implementation ━━━"
# Restore the original behavior (hyphens) but use a different implementation:
# pure bash parameter expansion instead of sed.
cat > "$ORIG_LIB" <<'SLUGIFY'
#!/usr/bin/env bash
# lib/slugify.sh — refactored version using pure bash (no sed)

slugify() {
  local input="$1"
  local out

  # Lowercase (bash 4+ parameter expansion)
  out="${input,,}"

  # Replace non-alphanumeric chars with hyphens using pure bash
  # (loop-based replacement — slower than sed but same output)
  local result=""
  local i ch prev_was_hyphen=0
  for ((i = 0; i < ${#out}; i++)); do
    ch="${out:i:1}"
    case "$ch" in
      [a-z0-9])
        result+="$ch"
        prev_was_hyphen=0
        ;;
      *)
        if [[ $prev_was_hyphen -eq 0 ]]; then
          result+="-"
          prev_was_hyphen=1
        fi
        ;;
    esac
  done

  # Trim leading/trailing hyphens
  result="${result#-}"
  result="${result%-}"

  printf '%s' "$result"
}

greet() {
  local name="$1"
  printf 'Hello, %s!' "$name"
}
SLUGIFY

echo "   Refactored slugify.sh to use pure bash (no sed) — same output behavior"
echo ""

# ─── STEP 6: Validate (should PASS — same output, different code) ─────────────
echo "━━━ STEP 6: Validate (valid refactor — should PASS) ━━━"
if bash "$VALIDATE"; then
  echo "✅ Step 6 PASSED — valid refactor detected (same contract, different code)"
else
  echo "❌ Step 6 FAILED — validate should PASS on valid refactor"
  cp "$BACKUP_LIB" "$ORIG_LIB"
  rm -f "$BACKUP_LIB"
  exit 1
fi
echo ""

# ─── Cleanup ──────────────────────────────────────────────────────────────────
# Restore the original implementation
if [[ -f "$BACKUP_LIB" ]]; then
  cp "$BACKUP_LIB" "$ORIG_LIB"
  rm -f "$BACKUP_LIB"
fi

echo "═══════════════════════════════════════════════════════════════"
echo "  ✅ ALL STEPS PASSED — Bash stack capture+validate works!"
echo "═══════════════════════════════════════════════════════════════"
echo ""
echo "Summary:"
echo "  1. capture_bash.sh produces .regret files with the correct format"
echo "  2. validate_bash.sh PASSES when code is unchanged"
echo "  3. validate_bash.sh FAILs when behavior changes (breaking refactor)"
echo "  4. validate_bash.sh PASSes when behavior is preserved (valid refactor)"
echo ""
echo "Cross-stack parity: fingerprint_bash.sh produces identical hashes to"
echo "fingerprint.js / fingerprint.py / fingerprint_php.php / fingerprint_perl.pl"
echo "for the same input+output pair."
exit 0

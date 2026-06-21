#!/usr/bin/env bash
# proof/ruby_slugify/run_demo.sh — demonstrate Regrets capture+validate cycle
# on the Ruby slugify example.
#
# This script:
#   1. Re-captures the baseline (golden) .regret files from the current slugify.rb.
#   2. Runs validate — must PASS.
#   3. Applies a VALID refactor (renames internal var, splits regex, removes
#      constant) — output for all inputs unchanged. Runs validate — must PASS.
#   4. Restores the original file. Runs validate — must PASS (sanity).
#   5. Applies a BREAKING refactor (hyphen → underscore in output) — output
#      changes for every non-trivial input. Runs validate — must FAIL.
#   6. Restores the original file. Runs validate — must PASS (sanity).
#
# Exits 0 if every phase produced the expected PASS/FAIL outcome, 1 otherwise.
#
# Run from the repo root:
#   bash proof/ruby_slugify/run_demo.sh
#
# Or from the proof dir:
#   bash run_demo.sh

set -eu

# Locate the proof dir regardless of where the script is invoked from.
PROOF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$PROOF_DIR"

REGRETS_REPO="$(cd "$PROOF_DIR/../.." && pwd)"
CAPTURE="$REGRETS_REPO/scripts/capture_ruby.rb"
VALIDATE="$REGRETS_REPO/scripts/validate_ruby.rb"

# Use whatever Ruby is on PATH. The CI environment installs ruby-root/ and
# exports LD_LIBRARY_PATH / RUBYLIB / PATH — see proof/ruby_slugify/README.md.
if ! command -v ruby >/dev/null 2>&1; then
  echo "❌ ruby not found on PATH"
  echo "   Install Ruby (apt install ruby / brew install ruby / rbenv install 3.3.x)"
  echo "   or see proof/ruby_slugify/README.md for the portable Ruby setup used in CI."
  exit 1
fi

LIB="lib/slugify.rb"
BACKUP="/tmp/slugify.rb.bak.$$.orig"
REFACTORED_VALID="/tmp/slugify.rb.bak.$$.valid"
REFACTORED_BREAKING="/tmp/slugify.rb.bak.$$.breaking"

trap 'rm -f "$BACKUP" "$REFACTORED_VALID" "$REFACTORED_BREAKING"' EXIT

# ─── Helper: run validate, return 0 if PASS, 1 if FAIL ────────────────────────
# Tolerates validate's non-zero exit when it correctly reports failures.
run_validate() {
  set +e
  ruby "$VALIDATE" --manifest ./manifest.json 2>&1 | tee /tmp/validate.out
  local pipe_status=("${PIPESTATUS[@]}")
  set -e
  # pipe_status[0] is ruby's exit; 0 = all clusters passed, 1 = at least one failed
  return "${pipe_status[0]}"
}

# ─── Stash the original file ──────────────────────────────────────────────────
cp "$LIB" "$BACKUP"

# ─── Phase 0: baseline capture + validate ─────────────────────────────────────
echo "═══ Phase 0: baseline capture + validate ═══"
ruby "$CAPTURE" --manifest ./manifest.json 2>&1 | tail -6
echo
run_validate 2>&1 | tail -5
if run_validate >/dev/null 2>&1; then
  echo "✅ Phase 0 PASS — baseline green"
else
  echo "❌ Phase 0 FAIL: baseline validate should PASS"
  exit 1
fi
echo

# ─── Phase 1: VALID refactor — behavior unchanged ────────────────────────────
# - Rename internal var `s` → `result`
# - Drop the SLUGIFY_HYPHEN constant, use literal "-"
# - Split the edge-strip regex into two .gsub calls
# All three changes are pure cosmetic refactors. Every input still produces
# the exact same output, so validate must PASS.
echo "═══ Phase 1: apply VALID refactor (rename var, split regex) ═══"
cat > "$REFACTORED_VALID" <<'RUBY'
# frozen_string_literal: true
# proof/ruby_slugify/lib/slugify.rb — REFACTORED (valid, behavior unchanged)

def slugify(text)
  result = text.to_s.downcase
  result = result.gsub(/[^a-z0-9]+/, '-')
  result = result.gsub(/^-+/, '')
  result = result.gsub(/-+$/, '')
  result
end

def slugify_batch(texts)
  texts.map { |t| slugify(t) }
end
RUBY

cp "$REFACTORED_VALID" "$LIB"
echo "Refactored lib/slugify.rb — diff:"
diff -u "$BACKUP" "$LIB" || true
echo
if run_validate 2>&1 | tail -5 && run_validate >/dev/null 2>&1; then
  echo "✅ Phase 1 PASS — valid refactor is green"
else
  echo "❌ Phase 1 FAIL: valid refactor should still PASS"
  cp "$BACKUP" "$LIB"
  exit 1
fi
echo

# ─── Restore + sanity check ───────────────────────────────────────────────────
cp "$BACKUP" "$LIB"
if ! run_validate >/dev/null 2>&1; then
  echo "❌ Sanity check FAIL: restoring original should PASS"
  exit 1
fi

# ─── Phase 2: BREAKING refactor — behavior changes ───────────────────────────
# Replace the hyphen with an underscore in the output. Every non-trivial input
# now produces a different output → fingerprint changes → validate MUST FAIL.
echo "═══ Phase 2: apply BREAKING refactor (hyphen → underscore) ═══"
cat > "$REFACTORED_BREAKING" <<'RUBY'
# frozen_string_literal: true
# proof/ruby_slugify/lib/slugify.rb — REFACTORED (BREAKING — output changed)

SLUGIFY_HYPHEN = '_'.freeze  # ← was '-'

def slugify(text)
  s = text.to_s.downcase
  s = s.gsub(/[^a-z0-9]+/, SLUGIFY_HYPHEN)
  s = s.gsub(/\A-+|-+\z/, '')
  s
end

def slugify_batch(texts)
  texts.map { |t| slugify(t) }
end
RUBY

cp "$REFACTORED_BREAKING" "$LIB"
echo "Refactored lib/slugify.rb — diff:"
diff -u "$BACKUP" "$LIB" || true
echo
run_validate 2>&1 | tail -10 || true
if run_validate >/dev/null 2>&1; then
  echo "❌ Phase 2 FAIL: breaking refactor should FAIL validate"
  cp "$BACKUP" "$LIB"
  exit 1
else
  echo "✅ Phase 2 PASS — breaking refactor correctly detected"
fi
echo

# ─── Restore + final sanity check ─────────────────────────────────────────────
cp "$BACKUP" "$LIB"
if ! run_validate >/dev/null 2>&1; then
  echo "❌ Final sanity check FAIL: restoring original should PASS"
  exit 1
fi

echo "═══ All phases passed ═══"
echo "  Phase 0 (baseline)            ✅ PASS"
echo "  Phase 1 (valid refactor)      ✅ PASS — Regrets stayed green"
echo "  Phase 2 (breaking refactor)   ✅ FAIL — Regrets caught the regression"
echo
echo "The .regret files in regrets/ are the golden contracts."
echo "Code is now back to the original — ready for a real refactor."

#!/usr/bin/env bash
# proof/nim_slugify/run_demo.sh — demonstrate Regrets capture+validate cycle
# on the Nim slugify example.
#
# This script:
#   1. Re-captures the baseline (golden) .regret files from the current slugify.nim.
#   2. Runs validate — must PASS.
#   3. Applies a VALID refactor (rename internal var, split char loop into helper)
#      — output for all inputs unchanged. Runs validate — must PASS.
#   4. Restores the original file. Runs validate — must PASS (sanity).
#   5. Applies a BREAKING refactor (hyphen → underscore in output) — output
#      changes for every non-trivial input. Runs validate — must FAIL.
#   6. Restores the original file. Runs validate — must PASS (sanity).
#
# Exits 0 if every phase produced the expected PASS/FAIL outcome, 1 otherwise.
#
# Run from the repo root:
#   bash proof/nim_slugify/run_demo.sh
#
# Or from the proof dir:
#   bash run_demo.sh
#
# Requires: Nim 2.x on PATH (or set NIM=/path/to/nim).

set -eu

PROOF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$PROOF_DIR"

REGRETS_REPO="$(cd "$PROOF_DIR/../.." && pwd)"
CAPTURE="$REGRETS_REPO/scripts/capture_nim.sh"
VALIDATE="$REGRETS_REPO/scripts/validate_nim.sh"

if ! command -v "${NIM:-nim}" >/dev/null 2>&1; then
  echo "❌ nim not found on PATH"
  echo "   Install Nim (https://nim-lang.org/install.html) or set NIM=/path/to/nim"
  exit 1
fi

LIB="lib/slugify.nim"
BACKUP="/tmp/slugify.nim.bak.$$.orig"
REFACTORED_VALID="/tmp/slugify.nim.bak.$$.valid"
REFACTORED_BREAKING="/tmp/slugify.nim.bak.$$.breaking"

trap 'rm -f "$BACKUP" "$REFACTORED_VALID" "$REFACTORED_BREAKING"' EXIT

# ─── Helper: run validate, return 0 if PASS, 1 if FAIL ────────────────────────
run_validate() {
  set +e
  bash "$VALIDATE" --manifest ./manifest.json 2>&1 | tee /tmp/validate.out
  local status=${PIPESTATUS[0]}
  set -e
  return "$status"
}

# ─── Stash the original file ──────────────────────────────────────────────────
cp "$LIB" "$BACKUP"

# ─── Phase 0: baseline capture + validate ─────────────────────────────────────
echo "═══ Phase 0: baseline capture + validate ═══"
bash "$CAPTURE" --manifest ./manifest.json 2>&1 | tail -8
echo
if run_validate 2>&1 | tail -5 && run_validate >/dev/null 2>&1; then
  echo "✅ Phase 0 PASS — baseline green"
else
  echo "❌ Phase 0 FAIL: baseline validate should PASS"
  exit 1
fi
echo

# ─── Phase 1: VALID refactor — behavior unchanged ────────────────────────────
# - Rename internal var `result` → `accum`
# - Extract the trailing-hyphen-strip into a separate `stripTrailingHyphen` proc
# - Replace the `SlugifyHyphen` constant with a literal '-'
# All three changes are pure cosmetic refactors. Every input still produces
# the exact same output, so validate must PASS.
echo "═══ Phase 1: apply VALID refactor (rename var, extract helper) ═══"
cat > "$REFACTORED_VALID" <<'NIM'
# proof/nim_slugify/lib/slugify.nim — REFACTORED (valid, behavior unchanged)

import std/[strutils, sequtils]

proc isAlphaNum(c: char): bool {.inline.} =
  (c >= 'a' and c <= 'z') or (c >= '0' and c <= '9')

# Helper extracted from slugify — strips a single trailing hyphen if present.
proc stripTrailingHyphen(s: var seq[char]) =
  if s.len > 0 and s[s.len - 1] == '-':
    s = s[0 ..< s.len - 1]

proc slugify*(text: string): string =
  let lowered = text.toLowerAscii()
  var accum: seq[char] = @[]
  var prevHyphen = true
  for c in lowered:
    if isAlphaNum(c):
      accum.add(c)
      prevHyphen = false
    else:
      if not prevHyphen:
        accum.add('-')
        prevHyphen = true
  accum.stripTrailingHyphen()
  result = accum.join("")

proc slugifyBatch*(texts: seq[string]): seq[string] =
  result = texts.map(slugify)
NIM

cp "$REFACTORED_VALID" "$LIB"
echo "Refactored lib/slugify.nim — diff:"
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
cat > "$REFACTORED_BREAKING" <<'NIM'
# proof/nim_slugify/lib/slugify.nim — REFACTORED (BREAKING — output changed)

import std/[strutils, sequtils]

const
  SlugifyHyphen = '_'  # ← was '-'

proc isAlphaNum(c: char): bool {.inline.} =
  (c >= 'a' and c <= 'z') or (c >= '0' and c <= '9')

proc slugify*(text: string): string =
  let lowered = text.toLowerAscii()
  var outChars: seq[char] = @[]
  var prevHyphen = true
  for c in lowered:
    if isAlphaNum(c):
      outChars.add(c)
      prevHyphen = false
    else:
      if not prevHyphen:
        outChars.add(SlugifyHyphen)
        prevHyphen = true
  if outChars.len > 0 and outChars[outChars.len - 1] == SlugifyHyphen:
    outChars = outChars[0 ..< outChars.len - 1]
  result = outChars.join("")

proc slugifyBatch*(texts: seq[string]): seq[string] =
  result = texts.map(slugify)
NIM

cp "$REFACTORED_BREAKING" "$LIB"
echo "Refactored lib/slugify.nim — diff:"
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

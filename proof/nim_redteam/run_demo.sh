#!/usr/bin/env bash
# proof/nim_redteam/run_demo.sh — red-team verification for the Nim stack.
#
# This fixture exercises patterns NOT covered by proof/nim_slugify/:
#   - int input → int output        (fibonacci)
#   - seq[int] input → int output   (sumSquares)
#   - seq[int] input → tuple output (maxPair) — requires the tuple `%` overload
#                                     added to scripts/fingerprint_nim.nim
#   - int input → int output, with raise on edge case (safeDivideByTwo)
#
# Phases:
#   0. Baseline capture + validate — must PASS.
#   1. VALID refactor (rename internal vars only, output unchanged) — must PASS.
#   2. BREAKING refactor (change algorithm output) — must FAIL.
#   3. Restore + sanity check — must PASS.
#
# Run: bash proof/nim_redteam/run_demo.sh
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

LIB="lib/redteam.nim"
BACKUP="/tmp/redteam.nim.bak.$$.orig"
REFACTORED_VALID="/tmp/redteam.nim.bak.$$.valid"
REFACTORED_BREAKING="/tmp/redteam.nim.bak.$$.breaking"

trap 'rm -f "$BACKUP" "$REFACTORED_VALID" "$REFACTORED_BREAKING"' EXIT

# ─── Helper: run validate, return 0 if PASS, 1 if FAIL ────────────────────────
run_validate() {
  set +e
  bash "$VALIDATE" --manifest ./manifest.json >/dev/null 2>&1
  local status=$?
  set -e
  return "$status"
}

cp "$LIB" "$BACKUP"

# ─── Phase 0: baseline capture + validate ─────────────────────────────────────
echo "═══ Phase 0: baseline capture + validate (4 clusters) ═══"
bash "$CAPTURE" --manifest ./manifest.json 2>&1 | tail -10
echo
if run_validate; then
  echo "✅ Phase 0 PASS — baseline green for all 4 clusters (int, seq[int], tuple output, raise-on-edge)"
else
  echo "❌ Phase 0 FAIL: baseline validate should PASS"
  exit 1
fi
echo

# ─── Phase 1: VALID refactor — rename internal vars only ──────────────────────
echo "═══ Phase 1: VALID refactor (rename internal vars: a→prev, b→cur, sorted→ordered) ═══"
cat > "$REFACTORED_VALID" <<'NIM'
# proof/nim_redteam/lib/redteam.nim — REFACTORED (valid, behavior unchanged)

import std/[algorithm, sequtils, strutils]

proc fibonacci*(n: int): int =
  if n < 0:
    raise newException(ValueError, "n must be non-negative")
  if n <= 1:
    return n
  var prev = 0
  var cur = 1
  for _ in 2..n:
    let nxt = prev + cur
    prev = cur
    cur = nxt
  result = cur

proc sumSquares*(xs: seq[int]): int =
  var acc = 0
  for x in xs:
    acc += x * x
  result = acc

proc maxPair*(xs: seq[int]): tuple[a: int, b: int] =
  if xs.len < 2:
    raise newException(ValueError, "need at least 2 elements")
  let ordered = xs.sorted(Descending)
  result = (ordered[0], ordered[1])

proc safeDivideByTwo*(n: int): int =
  if n == 0:
    raise newException(DivByZeroError, "cannot divide zero by two (just for testing)")
  result = n div 2
NIM

cp "$REFACTORED_VALID" "$LIB"
echo "Refactored lib/redteam.nim — diff:"
diff -u "$BACKUP" "$LIB" || true
echo
if run_validate; then
  echo "✅ Phase 1 PASS — valid refactor is green (output unchanged)"
else
  echo "❌ Phase 1 FAIL: valid refactor should still PASS"
  cp "$BACKUP" "$LIB"
  exit 1
fi
echo

# ─── Restore + sanity check ───────────────────────────────────────────────────
cp "$BACKUP" "$LIB"
if ! run_validate; then
  echo "❌ Sanity check FAIL: restoring original should PASS"
  exit 1
fi

# ─── Phase 2: BREAKING refactor — change fibonacci output ─────────────────────
echo "═══ Phase 2: BREAKING refactor (fibonacci: return n*2 instead of fib(n)) ═══"
cat > "$REFACTORED_BREAKING" <<'NIM'
# proof/nim_redteam/lib/redteam.nim — REFACTORED (BREAKING — fibonacci output changed)

import std/[algorithm, sequtils, strutils]

proc fibonacci*(n: int): int =
  if n < 0:
    raise newException(ValueError, "n must be non-negative")
  if n <= 1:
    return n
  # BREAKING: was proper fibonacci, now returns n*2
  result = n * 2

proc sumSquares*(xs: seq[int]): int =
  result = 0
  for x in xs:
    result += x * x

proc maxPair*(xs: seq[int]): tuple[a: int, b: int] =
  if xs.len < 2:
    raise newException(ValueError, "need at least 2 elements")
  let sorted = xs.sorted(Descending)
  result = (sorted[0], sorted[1])

proc safeDivideByTwo*(n: int): int =
  if n == 0:
    raise newException(DivByZeroError, "cannot divide zero by two (just for testing)")
  result = n div 2
NIM

cp "$REFACTORED_BREAKING" "$LIB"
echo "Refactored lib/redteam.nim — diff:"
diff -u "$BACKUP" "$LIB" || true
echo
bash "$VALIDATE" --manifest ./manifest.json 2>&1 | tail -10 || true
if run_validate; then
  echo "❌ Phase 2 FAIL: breaking refactor should FAIL validate"
  cp "$BACKUP" "$LIB"
  exit 1
else
  echo "✅ Phase 2 PASS — breaking refactor correctly detected (fibonacci failed, others still pass)"
fi
echo

# ─── Restore + final sanity check ─────────────────────────────────────────────
cp "$BACKUP" "$LIB"
if ! run_validate; then
  echo "❌ Final sanity check FAIL: restoring original should PASS"
  exit 1
fi

echo "═══ All phases passed ═══"
echo "  Phase 0 (baseline)            ✅ PASS — 4 clusters (int, seq[int], tuple, raise-on-edge)"
echo "  Phase 1 (valid refactor)      ✅ PASS — Regrets stayed green"
echo "  Phase 2 (breaking refactor)   ✅ FAIL — Regrets caught the regression in fibonacci"
echo
echo "Patterns verified (not covered by proof/nim_slugify/):"
echo "  - int → int               (fibonacci)"
echo "  - seq[int] → int          (sumSquares)"
echo "  - seq[int] → tuple[a,b]   (maxPair) — requires tuple % overload in fingerprint_nim.nim"
echo "  - int → int with raise    (safeDivideByTwo)"
echo
echo "Code is now back to the original — ready for a real refactor."

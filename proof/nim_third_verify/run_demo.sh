#!/usr/bin/env bash
# proof/nim_third_verify/run_demo.sh — third-party independent verification
# of the Nim stack, demonstrating the full Regrets capture → validate cycle
# with patterns NOT covered by proof/nim_slugify/ or proof/nim_redteam/.
#
# Phases:
#   0. Baseline capture + validate (must PASS)
#   1. Apply VALID refactor (rename internal var + extract helper — output
#      unchanged). Validate must PASS.
#   2. Apply BREAKING refactor (reverseRunes: reverse runes → reverse bytes;
#      isPalindrome: case-insensitive → case-sensitive flip). Validate must
#      FAIL for at least one cluster, exit non-zero.
#   3. Restore original. Validate must PASS (sanity).
#
# Plus cross-stack fingerprint parity check at the end.
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

LIB="lib/third_verify.nim"
BACKUP="/tmp/third_verify.nim.bak.$$.orig"

trap 'rm -f "$BACKUP"' EXIT

# ─── Helper: run validate, return 0 if PASS, 1 if FAIL ────────────────────────
run_validate() {
  set +e
  bash "$VALIDATE" --manifest ./manifest.json 2>&1 | tail -8
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
if run_validate >/dev/null 2>&1; then
  echo "✅ Phase 0 PASS — baseline green (5 clusters)"
else
  echo "❌ Phase 0 FAIL: baseline validate should PASS"
  exit 1
fi
echo

# ─── Phase 1: VALID refactor — behavior unchanged ────────────────────────────
# - Rename local `s` → `acc` in sumAndCount
# - Replace `result += x` with `result = result + x`
# - Extract `countElements` helper for sumAndCount
# All cosmetic — every input still produces the exact same output.
echo "═══ Phase 1: apply VALID refactor (rename var, extract helper) ═══"
cat > "$LIB" <<'NIM'
# proof/nim_third_verify/lib/third_verify.nim — REFACTORED (valid, behavior unchanged)
import std/[tables, strutils, sequtils, options, unicode, algorithm]

proc reverseRunes*(text: string): string =
  if text.len == 0:
    return ""
  let runes = text.toRunes()
  var reversedRunes: seq[Rune] = newSeqOfCap[Rune](runes.len)
  for i in countdown(runes.len - 1, 0):
    reversedRunes.add(runes[i])
  result = $reversedRunes

proc countElements*(xs: seq[int]): int =
  # Extracted helper — pure cosmetic refactor
  return xs.len

proc sumAndCount*(xs: seq[int]): tuple[sum, count: int] =
  if xs.len == 0:
    return (0, 0)
  var acc = 0  # renamed from `s`
  for x in xs:
    acc = acc + x  # was `s += x`
  result = (acc, countElements(xs))  # uses helper

proc frequencyPairs*(xs: seq[int]): seq[(int, int)] =
  if xs.len == 0:
    return @[]
  var counts: Table[int, int] = initTable[int, int]()
  for x in xs:
    if counts.hasKey(x):
      counts[x] = counts[x] + 1
    else:
      counts[x] = 1
  result = toSeq(counts.pairs())
  result.sort(proc(a, b: (int, int)): int = cmp(a[0], b[0]))

proc safeSqrt*(n: float): Option[float] =
  if n < 0.0:
    return none(float)
  if n == 0.0:
    return some(0.0)
  var x = n
  for _ in 0 ..< 30:
    x = 0.5 * (x + n / x)
  return some(x)

proc isPalindrome*(text: string): bool =
  if text.len <= 1:
    return true
  let runes = text.toRunes()
  var i = 0
  var j = runes.len - 1
  while i < j:
    if runes[i] != runes[j]:
      return false
    i += 1
    j -= 1
  return true
NIM

if run_validate >/dev/null 2>&1; then
  echo "✅ Phase 1 PASS — valid refactor kept Regrets green"
else
  echo "❌ Phase 1 FAIL: valid refactor should PASS"
  cp "$BACKUP" "$LIB"
  exit 1
fi
echo

# ─── Phase 2: BREAKING refactor — output changes ──────────────────────────────
# - sumAndCount: subtract 1 from sum (changes output for every non-empty input)
# - reverseRunes: byte-reverse instead of rune-reverse (breaks for unicode)
# - isPalindrome: always returns true (changes output for any non-palindrome)
# At least one of these will affect the captured FIRST input, causing validate
# to FAIL with exit non-zero. The captured first inputs are:
#   reverse-runes:  "abc"            → original "cba"   (byte-reverse also "cba" — no diff for ASCII)
#   sum-and-count:  [1,2,3,4,5]      → original (15, 5) (breaking → (14, 5) — DIFFERENT)
#   frequency-pairs:[1,2,2,3,3,3]    → original [(1,1),(2,2),(3,3)] (unchanged)
#   safe-sqrt:      2.0              → original some(1.414...) (unchanged)
#   is-palindrome:  "racecar"        → original true    (always-true also true — no diff for palindrome)
# So sum-and-count will trigger the FAIL.
echo "═══ Phase 2: apply BREAKING refactor (sum-1, byte-reverse, always-true palindrome) ═══"
cat > "$LIB" <<'NIM'
# proof/nim_third_verify/lib/third_verify.nim — REFACTORED (BREAKING — output changed)
import std/[tables, strutils, sequtils, options, unicode, algorithm]

proc reverseRunes*(text: string): string =
  # BREAKING: byte-reverse instead of rune-reverse (mangles unicode)
  if text.len == 0:
    return ""
  result = newString(text.len)
  for i in 0 ..< text.len:
    result[i] = text[text.len - 1 - i]

proc sumAndCount*(xs: seq[int]): tuple[sum, count: int] =
  # BREAKING: subtract 1 from sum (off-by-one bug)
  if xs.len == 0:
    return (0, 0)
  var s = 0
  for x in xs:
    s += x
  result = (s - 1, xs.len)  # was (s, xs.len)

proc frequencyPairs*(xs: seq[int]): seq[(int, int)] =
  if xs.len == 0:
    return @[]
  var counts: Table[int, int] = initTable[int, int]()
  for x in xs:
    if counts.hasKey(x):
      counts[x] = counts[x] + 1
    else:
      counts[x] = 1
  result = toSeq(counts.pairs())
  result.sort(proc(a, b: (int, int)): int = cmp(a[0], b[0]))

proc safeSqrt*(n: float): Option[float] =
  if n < 0.0:
    return none(float)
  if n == 0.0:
    return some(0.0)
  var x = n
  for _ in 0 ..< 30:
    x = 0.5 * (x + n / x)
  return some(x)

proc isPalindrome*(text: string): bool =
  # BREAKING: always returns true for non-empty (was: actual palindrome check)
  return text.len > 0
NIM

set +e
bash "$VALIDATE" --manifest ./manifest.json 2>&1 | tail -12
validate_status=${PIPESTATUS[0]}
set -e

if [ "$validate_status" -ne 0 ]; then
  echo "✅ Phase 2 PASS — breaking refactor correctly FAILed (exit non-zero)"
else
  echo "❌ Phase 2 FAIL: breaking refactor should FAIL"
  cp "$BACKUP" "$LIB"
  exit 1
fi
echo

# ─── Phase 3: restore + sanity ────────────────────────────────────────────────
echo "═══ Phase 3: restore original + sanity validate ═══"
cp "$BACKUP" "$LIB"
if run_validate >/dev/null 2>&1; then
  echo "✅ Phase 3 PASS — restored code validates clean"
else
  echo "❌ Phase 3 FAIL: restored code should PASS"
  exit 1
fi
echo

# ─── Phase 4: cross-stack parity ──────────────────────────────────────────────
echo "═══ Phase 4: cross-stack fingerprint parity (Nim vs JS) ═══"
if node verify-parity.mjs 2>&1 | tail -10; then
  echo "✅ Phase 4 PASS — Nim hash matches JS fingerprint for all 5 clusters"
else
  echo "❌ Phase 4 FAIL: cross-stack parity broken"
  exit 1
fi
echo

echo "═══ All phases passed ═══"
echo "  Phase 0 (baseline)            ✅ PASS — 5 clusters captured"
echo "  Phase 1 (valid refactor)      ✅ PASS — Regrets stayed green"
echo "  Phase 2 (breaking refactor)   ✅ FAIL — Regrets caught the regression"
echo "  Phase 3 (restore)             ✅ PASS — back to original"
echo "  Phase 4 (cross-stack parity)  ✅ PASS — Nim hash == JS fingerprint"
echo ""
echo "Patterns verified (NOT covered by proof/nim_slugify/ or proof/nim_redteam/):"
echo "  - string → string (rune-aware)     (reverseRunes)"
echo "  - seq[int] → tuple[sum, count]     (sumAndCount — aggregate, not extremes)"
echo "  - seq[int] → seq[(int, int)]       (frequencyPairs — seq of tuples)"
echo "  - float → Option[float]            (safeSqrt — exercises Option % overload)"
echo "  - string → bool                    (isPalindrome — predicate)"
echo ""
echo "Code is now back to the original — ready for a real refactor."

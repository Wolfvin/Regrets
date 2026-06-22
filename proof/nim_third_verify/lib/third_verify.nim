# proof/nim_third_verify/lib/third_verify.nim
#
# Third-party independent verification fixture for the Nim stack.
#
# This file is deliberately authored by a DIFFERENT worker session than the
# worker who wrote `scripts/capture_nim.sh` / `validate_nim.sh` /
# `fingerprint_nim.nim` and the existing `proof/nim_slugify/` and
# `proof/nim_redteam/` fixtures. Per CONTEXT.md "Lesson Learned":
#
#   "JALANKAN test nyata dengan pattern yang berbeda dari yang dipakai untuk
#    implementasi — jangan percaya klaim dari PR sebelumnya tanpa reproduce
#    sendiri."
#
# Pattern coverage matrix — deliberately distinct from existing Nim fixtures:
#
#   proof/nim_slugify/lib/slugify.nim:
#     - slugify(text: string): string                  # string -> string (ASCII-only)
#     - slugifyBatch(texts: seq[string]): seq[string]  # seq[str] -> seq[str]
#
#   proof/nim_redteam/lib/redteam.nim:
#     - fibonacci(n: int): int                         # int -> int
#     - sumSquares(xs: seq[int]): int                  # seq[int] -> int
#     - maxPair(xs: seq[int]): tuple[a, b: int]        # seq[int] -> tuple (extremes)
#     - safeDivideByTwo(n: int): int (raises)          # int -> int (raises)
#
# This fixture (third_verify.nim):
#     - reverseRunes(text: string): string             # string -> string (rune-aware)
#     - sumAndCount(xs: seq[int]): tuple[sum, count: int]  # seq[int] -> tuple (aggregate)
#     - frequencyPairs(xs: seq[int]): seq[(int, int)]  # seq[int] -> seq[(int, int)]
#     - safeSqrt(n: float): Option[float]              # float -> Option[float]
#     - isPalindrome(text: string): bool               # string -> bool
#
# All procs are top-level with `*` export. Each takes a single argument
# (the harness currently only supports single-arg procs — documented in
# proof/nim_redteam/lib/redteam.nim). Return types are chosen to exercise
# the tuple `%` overload (fingerprint_nim.nim line 31) and std/json's
# built-in `%` for Option[T] — neither of which is exercised by slugify.

import std/[tables, strutils, sequtils, options, unicode, algorithm]

# 1. Reverse a string code-point by code-point (rune-aware).
#    Output for "abc" -> "cba", for "héllo" -> "olléh" (preserves é, not bytes).
#    Implemented via `toRunes` so it's correct for non-BMP input too.
#    DIFFERENT from slugify: slugify is char-by-char ASCII; this is unicode-aware.
proc reverseRunes*(text: string): string =
  if text.len == 0:
    return ""
  let runes = text.toRunes()
  var reversedRunes: seq[Rune] = newSeqOfCap[Rune](runes.len)
  for i in countdown(runes.len - 1, 0):
    reversedRunes.add(runes[i])
  result = $reversedRunes

# 2. Sum and count of a seq[int].
#    Returns (sum, count) — aggregate, not extremes (maxPair returns extremes).
#    Empty seq returns (0, 0).
proc sumAndCount*(xs: seq[int]): tuple[sum, count: int] =
  if xs.len == 0:
    return (0, 0)
  var s = 0
  for x in xs:
    s += x
  result = (s, xs.len)

# 3. Frequency pairs for a seq[int] — returns seq of (value, count) sorted
#    by value ascending. Empty input returns empty seq.
#    DIFFERENT from redteam's maxPair: returns ALL distinct values with counts,
#    not just the top 2. Exercises seq-of-tuples serialization.
proc frequencyPairs*(xs: seq[int]): seq[(int, int)] =
  if xs.len == 0:
    return @[]
  var counts: Table[int, int] = initTable[int, int]()
  for x in xs:
    if counts.hasKey(x):
      counts[x] = counts[x] + 1
    else:
      counts[x] = 1
  # Sort by value ascending — deterministic output.
  result = toSeq(counts.pairs())
  result.sort(proc(a, b: (int, int)): int = cmp(a[0], b[0]))

# 4. Safe square root — returns None for negative input.
#    Returns some(sqrt(n)) for n >= 0.
#    Uses Newton's method (not std/math's sqrt) — exercises Option[T] return.
#    The harness's `%entrySym(...)` call uses std/json's built-in `%` for
#    Option[T] (Nim 1.4+) — verifies that overload works end-to-end.
proc safeSqrt*(n: float): Option[float] =
  if n < 0.0:
    return none(float)
  if n == 0.0:
    return some(0.0)
  var x = n
  for _ in 0 ..< 30:
    x = 0.5 * (x + n / x)
  return some(x)

# 5. Check if a string is a palindrome (case-sensitive, includes whitespace).
#    Empty string is a palindrome. Single char is a palindrome.
#    "racecar" -> true, "hello" -> false, "a man a plan a canal panama" -> false
#    (because of spaces — pure palindrome check, not sentence palindrome).
#    DIFFERENT from slugify: predicate, not transform.
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

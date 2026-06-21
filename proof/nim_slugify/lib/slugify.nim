# proof/nim_slugify/lib/slugify.nim
# A small, realistic URL-slug generator. Pure functions — no I/O, no globals,
# no random. Ideal regret cluster: behavior is fully determined by the input
# string, so the captured fingerprint is stable across runs.
#
# Two top-level procs are exported (with `*`):
#   slugify*(text: string): string
#   slugifyBatch*(texts: seq[string]): seq[string]
#
# This file is intentionally written in a "naive" first-pass style —
# readable, but with a couple of inlined character loops that can be extracted
# during a refactor without changing behavior. The .regret files in
# proof/nim_slugify/regrets/ are the golden contracts; any refactor that
# changes the output for the captured inputs will fail validate.

import std/[strutils, sequtils]

const
  SlugifyHyphen = '-'

proc isAlphaNum(c: char): bool {.inline.} =
  (c >= 'a' and c <= 'z') or (c >= '0' and c <= '9')

# Convert a string to a URL-safe slug.
#
# Algorithm:
#   1. Downcase the input.
#   2. Replace every run of non-[a-z0-9] characters with a single hyphen.
#   3. Strip leading and trailing hyphens.
#
# Edge cases:
#   - Empty input -> empty string.
#   - Input with no alphanumeric chars (e.g. "!!!") -> empty string.
#   - Unicode chars (é, 漢, emoji) are treated as non-alphanumeric and
#     collapsed into hyphens, then stripped if at the boundary.
proc slugify*(text: string): string =
  let lowered = text.toLowerAscii()
  var outChars: seq[char] = @[]
  var prevHyphen = true  # treat start as if we just saw a hyphen (so we strip leading)
  for c in lowered:
    if isAlphaNum(c):
      outChars.add(c)
      prevHyphen = false
    else:
      if not prevHyphen:
        outChars.add(SlugifyHyphen)
        prevHyphen = true
  # Strip trailing hyphen (if any)
  if outChars.len > 0 and outChars[outChars.len - 1] == SlugifyHyphen:
    outChars = outChars[0 ..< outChars.len - 1]
  result = outChars.join("")

# Apply `slugify` to every string in a seq, preserving order and length.
# Returns a new seq; the input seq is not mutated.
proc slugifyBatch*(texts: seq[string]): seq[string] =
  result = texts.map(slugify)

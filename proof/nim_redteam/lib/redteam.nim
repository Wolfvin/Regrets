# proof/nim_redteam/lib/redteam.nim
# Red-team fixture for the Nim stack — uses patterns NOT covered by the
# slugify demo to verify the harness handles them correctly:
#   - int input → int output (different from string-based slugify)
#   - seq[int] input → int output (different from seq[string])
#   - tuple output (different from string/seq[string])
#   - proc that raises an exception (trivial-input guard / error handling)
#   - proc with side-effect-y nature (uses mutable state) — args snapshot timing

import std/[algorithm, sequtils, strutils]

# 1. Fibonacci — int -> int (no string involved)
proc fibonacci*(n: int): int =
  if n < 0:
    raise newException(ValueError, "n must be non-negative")
  if n <= 1:
    return n
  var a = 0
  var b = 1
  for _ in 2..n:
    let c = a + b
    a = b
    b = c
  result = b

# 2. SumSquares — seq[int] -> int (no string involved)
proc sumSquares*(xs: seq[int]): int =
  result = 0
  for x in xs:
    result += x * x

# 3. MaxPair — seq[int] -> tuple[a: int, b: int] (returns tuple, not string)
# Returns the two largest values in descending order.
proc maxPair*(xs: seq[int]): tuple[a: int, b: int] =
  if xs.len < 2:
    raise newException(ValueError, "need at least 2 elements")
  let sorted = xs.sorted(Descending)
  result = (sorted[0], sorted[1])

# 4. SafeDivide — int division that raises on zero divisor.
#    Used to test how the harness handles a proc that throws on certain inputs.
proc safeDivide*(numerator: int; denominator: int): int =
  if denominator == 0:
    raise newException(DivByZeroError, "cannot divide by zero")
  result = numerator div denominator

# Note: safeDivide takes 2 args — current harness only supports single-arg procs.
# We expose a single-arg variant via closure for testing.
proc safeDivideByTwo*(n: int): int =
  if n == 0:
    raise newException(DivByZeroError, "cannot divide zero by two (just for testing)")
  result = n div 2

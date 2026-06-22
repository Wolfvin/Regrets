-- NumericUtils.hs — independent verification fixture for the Haskell stack.
--
-- This module deliberately uses DIFFERENT patterns from the bundled
-- StringUtils.hs fixture (tests/fixtures/haskell-example/) to avoid the
-- confirmation-bias trap documented in CONTEXT.md's "Lesson Learned":
--
--   "high test counts don't guarantee features actually work — red team
--    found callee wrapping was broken for the most common patterns
--    despite all unit tests passing, because tests were written with
--    the same pattern as the implementation"
--
-- Functions in this fixture exercise:
--   1. factorial     — recursion with pattern matching (not string ops)
--   2. gcd'          — Euclidean algorithm with guards (not arithmetic)
--   3. isPrime       — list comprehension + sqrt bound (not simple loops)
--   4. collatzLength — recursive sequence + accumulator (not direct recursion)
--   5. fibonacci     — tail-recursive with accumulator (different from
--                      the bundled fixture's reverseStr which is list ops)
--
-- These patterns (recursion, guards, list comprehensions, accumulators)
-- are core Haskell idioms NOT covered by the bundled fixture (which
-- focuses on string manipulation: slugify, countVowels, reverseStr).

module NumericUtils (factorial, gcd', isPrime, collatzLength, fibonacci) where

-- | Factorial using pattern matching (base case + recursive case)
factorial :: Integer -> Integer
factorial 0 = 1
factorial n
  | n < 0     = error "factorial: negative input"
  | otherwise = n * factorial (n - 1)

-- | Greatest common divisor using Euclidean algorithm with guards
gcd' :: Integer -> Integer -> Integer
gcd' a b
  | b == 0    = abs a
  | otherwise = gcd' b (a `mod` b)

-- | Primality test using list comprehension + square root bound
isPrime :: Integer -> Bool
isPrime n
  | n < 2     = False
  | n == 2    = True
  | even n    = False
  | otherwise = null [d | d <- [3, 5 .. floor (sqrt (fromIntegral n :: Double))], n `mod` d == 0]

-- | Collatz sequence length (recursive with implicit accumulator via where)
collatzLength :: Integer -> Integer
collatzLength 1 = 0
collatzLength n
  | even n    = 1 + collatzLength (n `div` 2)
  | otherwise = 1 + collatzLength (3 * n + 1)

-- | Fibonacci using tail recursion with accumulator
-- (Different from the typical "fib n = fib (n-1) + fib (n-2)" which is
-- exponential — this is O(n))
fibonacci :: Integer -> Integer
fibonacci n = fibAcc n 0 1
  where
    fibAcc 0 a _ = a
    fibAcc k a b = fibAcc (k - 1) b (a + b)

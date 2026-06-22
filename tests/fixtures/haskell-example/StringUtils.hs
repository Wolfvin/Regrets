-- StringUtils.hs — example Haskell module for the Haskell stack fixture.
--
-- Pure functions that are easy to fingerprint: deterministic output for a given
-- input, no side effects, no I/O.

module StringUtils (slugify, countVowels, reverseStr, add) where

import Data.Char (toLower, isAlphaNum)

-- | Slugify a string: lowercase, replace non-alphanumerics with hyphens,
-- collapse consecutive hyphens, trim leading/trailing hyphens.
slugify :: String -> String
slugify s = trimHyphens (collapseHyphens (map convert s))
  where
    convert c = if isAlphaNum c then toLower c else '-'
    -- Collapse consecutive hyphens into one using a simple recursion
    collapseHyphens [] = []
    collapseHyphens [x] = [x]
    collapseHyphens (x:y:xs)
      | x == '-' && y == '-' = collapseHyphens (x:xs)
      | otherwise = x : collapseHyphens (y:xs)
    trimHyphens = reverse . dropWhile (== '-') . reverse . dropWhile (== '-')

-- | Count vowels (a, e, i, o, u — case-insensitive) in a string.
countVowels :: String -> Int
countVowels = length . filter (`elem` "aeiouAEIOU")

-- | Reverse a string.
reverseStr :: String -> String
reverseStr = reverse

-- | Add two numbers (for multiArgs testing).
add :: Int -> Int -> Int
add = (+)

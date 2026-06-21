-- strings.lua — example Lua module for the Regrets Lua stack
--
-- Three pure functions used by tests/fixtures/lua-example/regrets/manifest.json
-- clusters. Pure: no I/O, no globals, no side effects — deterministic output
-- for a given input. Ideal fingerprint targets.

local M = {}

-- Reverse a string.
-- e.g. M.reverse("hello") == "olleh"
function M.reverse(s)
    return string.reverse(s)
end

-- Count vowels (a, e, i, o, u — case-insensitive) in a string.
-- e.g. M.count_vowels("hello") == 2
function M.count_vowels(s)
    local _, n = string.gsub(s, "[aeiouAEIOU]", "")
    return n
end

-- Is the string a palindrome? (reads the same forwards and backwards)
-- e.g. M.is_palindrome("level") == true
function M.is_palindrome(s)
    return s == M.reverse(s)
end

return M

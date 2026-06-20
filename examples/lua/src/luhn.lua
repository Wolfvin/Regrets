-- src/luhn.lua — Luhn checksum algorithm (pure Lua)
-- Refactor target for Regrets Lua stack demo.
--
-- Returns a module table with two functions:
--   M.checksum(num_str)  → integer check digit (0-9)
--   M.valid(num_str)     → boolean (true if num_str passes Luhn)
--
-- The algorithm: starting from the rightmost digit, double every second
-- digit. If the result is > 9, subtract 9. Sum all digits. The check digit
-- is (10 - (sum % 10)) % 10. A number is Luhn-valid if the sum of all
-- digits (including check digit) is divisible by 10.

local M = {}

-- Internal: compute the Luhn sum of all digits in num_str (treated as
-- already including the check digit).
local function luhn_sum(s)
  local sum = 0
  local n = #s
  for i = 1, n do
    local ch = s:sub(i, i)
    local d = assert(tonumber(ch, 10), 'non-digit in input: ' .. ch)
    -- Double every second digit from the right.
    -- Rightmost position = parity 0; second-from-right = parity 1 (doubled).
    local from_right = n - i  -- 0 for last char
    if from_right % 2 == 1 then
      d = d * 2
      if d > 9 then d = d - 9 end
    end
    sum = sum + d
  end
  return sum
end

--- Compute the Luhn check digit for a number string (input without check digit).
--- Returns an integer 0-9.
function M.checksum(num_str)
  if type(num_str) ~= 'string' then
    error('checksum expects a string, got ' .. type(num_str))
  end
  if #num_str == 0 then
    error('checksum expects a non-empty string')
  end
  -- Append a '0' to compute the sum of the payload, then derive the check digit.
  local sum = luhn_sum(num_str .. '0')
  return (10 - (sum % 10)) % 10
end

--- Return true if num_str (including check digit) passes the Luhn check.
function M.valid(num_str)
  if type(num_str) ~= 'string' then
    error('valid expects a string, got ' .. type(num_str))
  end
  if #num_str == 0 then
    return false
  end
  return luhn_sum(num_str) % 10 == 0
end

return M

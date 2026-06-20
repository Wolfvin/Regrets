-- scripts/sha2.lua — Pure-Lua SHA-256 implementation
--
-- Clean-room implementation of the SHA-256 secure hash algorithm
-- (FIPS 180-4, a public-domain United States government standard).
-- The algorithm itself is public domain; this implementation is
-- original Lua code written directly from the specification.
--
-- Compatibility: Lua 5.3+ (uses 64-bit integer subtype and bitwise
-- operators: &, |, ~, <<, >>, unary ~).
--
-- API:
--   local sha2 = require("sha2")
--   local hex = sha2.sha256("string")  → 64-char lowercase hex digest
--
-- No external dependencies. Returns a 64-character lowercase hex string,
-- identical to: echo -n "string" | sha256sum   (without the trailing -)

local sha2 = {}

local MASK32 = 0xFFFFFFFF

local function rrotate(x, n)
  -- Logical right rotation of a 32-bit integer.
  -- n is always in 1..31 for SHA-256, so (32 - n) is in 1..31 (no edge case).
  return ((x >> n) | (x << (32 - n))) & MASK32
end

-- SHA-256 round constants K[1..64]:
-- first 32 bits of the fractional parts of the cube roots of the first 64 primes.
local K = {
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
}

-- Initial hash values H0[1..8]:
-- first 32 bits of the fractional parts of the square roots of the first 8 primes.
local H0 = {
  0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
  0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
}

function sha2.sha256(str)
  local len = #str
  local bitlen = len * 8  -- total message length in bits (we support < 2^53 bytes; high 32 bits stay 0)

  -- Build the padded message as a byte array.
  local msg = { string.byte(str, 1, len) }
  msg[#msg + 1] = 0x80
  while (#msg % 64) ~= 56 do
    msg[#msg + 1] = 0x00
  end
  -- 64-bit big-endian bit length. Low 32 bits follow; high 32 bits are zero
  -- (messages up to ~512 MB are handled correctly; beyond that the high word
  -- would need to be set — not a concern for regret fingerprinting).
  for _ = 1, 4 do msg[#msg + 1] = 0 end
  for i = 4, 1, -1 do
    msg[#msg + 1] = (bitlen >> (8 * (i - 1))) & 0xFF
  end

  local h = { H0[1], H0[2], H0[3], H0[4], H0[5], H0[6], H0[7], H0[8] }

  for chunk = 1, #msg, 64 do
    -- Message schedule: w[1..64]
    local w = {}
    for i = 1, 16 do
      local j = chunk + (i - 1) * 4
      w[i] = (msg[j] << 24) | (msg[j + 1] << 16) | (msg[j + 2] << 8) | msg[j + 3]
    end
    for i = 17, 64 do
      local x15 = w[i - 15]
      local x2 = w[i - 2]
      local s0 = (rrotate(x15, 7) ~ rrotate(x15, 18) ~ (x15 >> 3))
      local s1 = (rrotate(x2, 17) ~ rrotate(x2, 19) ~ (x2 >> 10))
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) & MASK32
    end

    local a, b, c, d, e, f, g, hh = h[1], h[2], h[3], h[4], h[5], h[6], h[7], h[8]
    for i = 1, 64 do
      local S1 = rrotate(e, 6) ~ rrotate(e, 11) ~ rrotate(e, 25)
      local ch = (e & f) ~ ((~e) & g)
      local temp1 = (hh + S1 + ch + K[i] + w[i]) & MASK32
      local S0 = rrotate(a, 2) ~ rrotate(a, 13) ~ rrotate(a, 22)
      local maj = (a & b) ~ (a & c) ~ (b & c)
      local temp2 = (S0 + maj) & MASK32
      hh = g; g = f; f = e
      e = (d + temp1) & MASK32
      d = c; c = b; b = a
      a = (temp1 + temp2) & MASK32
    end

    h[1] = (h[1] + a) & MASK32
    h[2] = (h[2] + b) & MASK32
    h[3] = (h[3] + c) & MASK32
    h[4] = (h[4] + d) & MASK32
    h[5] = (h[5] + e) & MASK32
    h[6] = (h[6] + f) & MASK32
    h[7] = (h[7] + g) & MASK32
    h[8] = (h[8] + hh) & MASK32
  end

  local parts = {}
  for i = 1, 8 do
    parts[i] = string.format("%08x", h[i])
  end
  return table.concat(parts)
end

return sha2

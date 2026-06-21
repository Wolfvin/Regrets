# frozen_string_literal: true
# proof/ruby_verify/lib/verify_lib.rb
#
# Independent verification fixture for the Ruby Regrets stack (PR #354).
#
# The functions here are DELIBERATELY DIFFERENT from the ones in
# proof/ruby_slugify/lib/slugify.rb (slugify, slugify_batch) to avoid the
# confirmation-bias trap documented in CONTEXT.md "Lesson Learned":
# "test ditulis dengan pattern yang sama dengan implementasi".
#
# Each function targets a different Ruby idiom:
#   - crc32         : table-driven checksum (no Zlib.crc32 builtin)
#   - base64_encode : bitwise ops + lookup table (no Base64.encode64 builtin)
#   - levenshtein   : 2D DP matrix with two rolling rows
#   - is_valid_ipv4 : multi-delimiter parser + range check
#   - fnv1a         : multiply + XOR per byte
#
# Same algorithms as proof/c_verify/, proof/go_verify/, proof/rust_verify/,
# proof/php_verify/, proof/java_verify/ → enables 7-way cross-stack parity
# verification (Ruby == Java == PHP == Rust == Go == C == JS == Python).

# CRC32 (zlib/zip polynomial 0xEDB88320) of input string's bytes.
# Returns the standard 32-bit checksum (initial 0xFFFFFFFF, final XOR 0xFFFFFFFF).
# Implemented from scratch (not using Zlib.crc32) to exercise unsigned
# arithmetic + table initialization. Ruby integers are arbitrary precision,
# so no masking is needed.
def crc32(s)
  data = s.bytes
  table = Array.new(256) do |i|
    c = i
    8.times do
      if c & 1 == 1
        c = 0xEDB88320 ^ (c >> 1)
      else
        c = c >> 1
      end
    end
    c
  end
  crc = 0xFFFFFFFF
  data.each do |b|
    crc = table[(crc ^ b) & 0xFF] ^ (crc >> 8)
  end
  crc ^ 0xFFFFFFFF
end

# Base64-encode a string using standard base64 alphabet with '=' padding.
# Empty input returns "". Implemented from scratch (not using Base64.encode64
# or [str].pack('m0')) to exercise bit manipulation code paths.
def base64_encode(s)
  return '' if s.empty?
  alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
  data = s.bytes
  out = String.new(capacity: ((data.length + 2) / 3) * 4)
  i = 0
  while i < data.length
    b0 = data[i]
    b1 = (i + 1 < data.length) ? data[i + 1] : 0
    b2 = (i + 2 < data.length) ? data[i + 2] : 0
    triple = (b0 << 16) | (b1 << 8) | b2
    out << alphabet[(triple >> 18) & 0x3F]
    out << alphabet[(triple >> 12) & 0x3F]
    out << (i + 1 < data.length ? alphabet[(triple >> 6) & 0x3F] : '=')
    out << (i + 2 < data.length ? alphabet[triple & 0x3F] : '=')
    i += 3
  end
  out
end

# Levenshtein edit distance between two strings. Implemented from scratch
# (not using the 'text' gem or similar) to exercise 2D DP matrix code paths.
def levenshtein(a, b)
  la = a.length
  lb = b.length
  return lb if la == 0
  return la if lb == 0
  # Two rolling rows for O(min(la, lb)) space.
  if la < lb
    a, b = b, a
    la, lb = lb, la
  end
  prev = (0..lb).to_a
  curr = Array.new(lb + 1, 0)
  (1..la).each do |i|
    curr[0] = i
    (1..lb).each do |j|
      cost = (a.getbyte(i - 1) == b.getbyte(j - 1)) ? 0 : 1
      del = prev[j] + 1
      ins = curr[j - 1] + 1
      sub = prev[j - 1] + cost
      curr[j] = [del, ins, sub].min
    end
    prev, curr = curr, prev
  end
  prev[lb]
end

# Validate an IPv4 dotted-quad. Returns true iff s is a valid dotted-quad:
# exactly 4 octets 0-255 separated by single '.', no leading zeros (except
# "0" itself), no trailing junk.
def is_valid_ipv4(s)
  return false if s.nil? || s.empty?
  bytes = s.bytes
  octets = 0
  val = 0
  digits = 0
  i = 0
  while i < bytes.length
    c = bytes[i]
    if c >= 48 && c <= 57 # '0'..'9'
      return false if digits == 1 && val == 0 # leading zero
      return false if digits >= 3
      val = val * 10 + (c - 48)
      digits += 1
      return false if val > 255
    elsif c == 46 # '.'
      return false if digits == 0 # empty octet
      octets += 1
      return false if octets > 4
      # Next char must be a digit
      return false if i + 1 >= bytes.length || bytes[i + 1] < 48 || bytes[i + 1] > 57
      val = 0
      digits = 0
    else
      return false # invalid char
    end
    i += 1
  end
  return false if digits == 0
  octets += 1
  octets == 4
end

# FNV-1a 32-bit hash of input string's bytes. Different algorithm than
# CRC32 — exercises a different bit-manipulation pattern (multiply + XOR
# per byte). Ruby integers are arbitrary precision, so we mask with
# 0xFFFFFFFF to stay in unsigned 32-bit territory.
def fnv1a(s)
  offset_basis = 2166136261
  prime = 16777619
  h = offset_basis
  s.bytes.each do |b|
    h = (h ^ b) & 0xFFFFFFFF
    h = (h * prime) & 0xFFFFFFFF
  end
  h
end

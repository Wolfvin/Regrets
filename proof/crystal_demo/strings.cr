# strings.cr — example Crystal module for the Regrets Crystal stack.
#
# Pure functions used by proof/crystal_demo/regrets/manifest.json clusters.
# Pure: no I/O, no globals, no side effects — deterministic output for a
# given input. Ideal fingerprint targets.

# Reverse a string.
# e.g. reverse("hello") == "olleh"
def reverse(s : String) : String
  s.reverse
end

# Count vowels (a, e, i, o, u — case-insensitive) in a string.
# e.g. count_vowels("hello") == 2
def count_vowels(s : String) : Int32
  s.count("aeiouAEIOU")
end

# Sum of ASCII codes of characters in a string.
# e.g. ascii_sum("abc") == 294
def ascii_sum(s : String) : Int32
  sum = 0
  s.each_byte { |b| sum += b }
  sum
end

# Luhn checksum — verify a number string passes Luhn check.
# e.g. luhn_valid("79927398713") == true
def luhn_valid(num_str : String) : Bool
  sum = 0
  n = num_str.size
  n.times do |i|
    ch = num_str[i]
    d = ch - '0'
    from_right = n - i - 1
    if from_right % 2 == 1
      d = d * 2
      d -= 9 if d > 9
    end
    sum += d
  end
  sum % 10 == 0
end

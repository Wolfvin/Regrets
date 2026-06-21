# csv_field_count.awk — count CSV fields in a single line.
#
# Input: CSV line (e.g., '"hello, world",42,"quoted, field"')
# Output: field count (e.g., "3")
#
# Demonstrates awk's FPAT variable (gawk extension that splits on
# quoted CSV fields). Since we want POSIX awk compatibility, we
# manually parse the CSV line character-by-character.
#
# This is a pure function of the input — same input always produces
# the same field count.

BEGIN {
  getline line
  print csv_field_count(line)
}

function csv_field_count(s,  count, in_quotes, i, c, len) {
  count = 0
  if (length(s) == 0) return 0
  in_quotes = 0
  len = length(s)
  # Always at least 1 field if string is non-empty
  count = 1
  for (i = 1; i <= len; i++) {
    c = substr(s, i, 1)
    if (in_quotes) {
      if (c == "\"") {
        # Check for escaped quote ""
        if (i < len && substr(s, i + 1, 1) == "\"") {
          i++
        } else {
          in_quotes = 0
        }
      }
    } else {
      if (c == "\"") {
        in_quotes = 1
      } else if (c == ",") {
        count++
      }
    }
  }
  return count
}
